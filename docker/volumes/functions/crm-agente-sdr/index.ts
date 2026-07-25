// crm-agente-sdr — agente SDR "João" portado do n8n ("SDR v9.0 multi-agent Claude").
// Recebe o relay do crm-whatsapp-webhook (mesmo payload do CRM_N8N_INBOUND_URL),
// acumula mensagens em buffer Postgres, roteia validação×qualificador (ratchet),
// roda o loop agêntico (Sonnet + thinking + tools) e responde humanizado em chunks.
//
// Pipeline (espelho do fluxo principal do n8n):
//   guards (inbound, /excluirdados, iniciar_atendimento, pausa_ia)
//   → mídia (transcrição/análise Gemini) → buffer + lock por remotejid
//   → drain: persiste user msg → router (ratchet) → loop Claude/tools → chunks.
// Responde 200 imediatamente (o relay do gateway tem timeout de 10s) e processa
// em background via EdgeRuntime.waitUntil.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from './prompts.ts';
import { AGENTE_RECONTATO, montarDossieRecontato } from './prompts-recontato.ts';
import { AGENTE_CAMPANHA_DIRETA } from './prompts-campanha-direta.ts';
import { encontrarFormacao, extrairPrimeiroNome, montarContextoTemporal, montarPerguntaFormacao, renderPrompt } from './contexto.ts';
import { atualizarAgenteComRatchet, atualizarLead, buscarLead, carregarHistorico, criarLead, excluirDadosLead, gravarMensagem, limparParaRouter, sanitizarHistorico } from './historico.ts';
import { carregarTools, chamarAgentePrincipal, chamarRouter } from './agente.ts';
import { type CtxConversa, executarTool, montarToolResults } from './tools.ts';
import { prepararMensagem } from './midia.ts';
import { conversaTexto, enviarResposta, horariosInventados, removerRaciocinioVazado } from './saida.ts';
import { contaDoLead } from './conta.ts';
import { rodarEsteiraFollowup } from './followup.ts';
import { rodarEsteiraFollowupTemplate } from './followup-template.ts';
import { criarTelemetria, resumir, type Telemetria } from './eventos.ts';

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Opcional: se setado, o relay precisa apontar pra ...?token=<valor>.
const TOKEN = Deno.env.get('AGENTE_SDR_TOKEN') ?? '';
const LOCK_TTL_SEGUNDOS = 240; // mesmo TTL do lock Redis do n8n
const MAX_RODADAS_TOOLS = 8;   // trava de segurança (o n8n não limitava)

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// ── buffer/lock (Postgres no lugar do Redis) ────────────────────────────────

async function bufferInserir(remotejid: string, item: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('crm_agente_sdr_buffer').insert({ remotejid, payload: item });
  if (error) throw new Error(`buffer insert: ${error.message}`);
}

// Silêncio desde a última mensagem do buffer, em segundos (relógio do BANCO,
// imune a skew entre VPS e edge runtime). null = buffer vazio.
async function bufferSilencioSegundos(remotejid: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('crm_agente_sdr_buffer')
    .select('criado_em')
    .eq('remotejid', remotejid)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`buffer silencio: ${error.message}`);
  if (!data) return null;
  return (Date.now() - new Date(data.criado_em).getTime()) / 1000;
}

// Debounce configurável (crm_pipeline_settings.agente_sdr_delay_segundos):
// espera o lead ficar N segundos em silêncio antes de processar — mensagens
// que chegarem no meio entram no acúmulo e reiniciam a contagem.
async function carregarDelaySegundos(): Promise<number> {
  const { data } = await supabase
    .from('crm_pipeline_settings')
    .select('agente_sdr_delay_segundos')
    .eq('id', 1)
    .maybeSingle();
  const v = Number(data?.agente_sdr_delay_segundos);
  return Number.isFinite(v) && v >= 0 ? v : 45;
}

const ESPERA_MAXIMA_MS = 180_000; // lead "digitando" sem parar não segura a rodada pra sempre

async function aguardarSilencio(remotejid: string, delaySegundos: number, renovar: () => Promise<void>): Promise<number> {
  if (delaySegundos <= 0) return 0;
  const inicio = Date.now();
  while (true) {
    const silencio = await bufferSilencioSegundos(remotejid);
    if (silencio === null) return Date.now() - inicio;          // buffer esvaziou
    const faltaMs = (delaySegundos - silencio) * 1000;
    if (faltaMs <= 0) return Date.now() - inicio;               // silêncio atingido
    if (Date.now() - inicio > ESPERA_MAXIMA_MS) return Date.now() - inicio;
    await renovar();                                            // espera não pode perder o lock
    await new Promise((r) => setTimeout(r, Math.min(faltaMs, 5000)));
  }
}

async function bufferDrenar(remotejid: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('crm_agente_sdr_buffer')
    .select('id, payload')
    .eq('remotejid', remotejid)
    .order('id', { ascending: true });
  if (error) throw new Error(`buffer select: ${error.message}`);
  if (!data?.length) return [];
  await supabase.from('crm_agente_sdr_buffer').delete().in('id', data.map((r: any) => r.id));
  return data.map((r: any) => r.payload);
}

async function lockClaim(remotejid: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('crm_agente_sdr_lock_claim', {
    p_remotejid: remotejid,
    p_ttl_segundos: LOCK_TTL_SEGUNDOS,
  });
  if (error) throw new Error(`lock claim: ${error.message}`);
  return data === true;
}

const lockRenovar = (remotejid: string) => async () => {
  await supabase.rpc('crm_agente_sdr_lock_renovar', { p_remotejid: remotejid, p_ttl_segundos: LOCK_TTL_SEGUNDOS });
};

async function lockSoltar(remotejid: string): Promise<void> {
  await supabase.from('crm_agente_sdr_lock').delete().eq('remotejid', remotejid);
}

// Rechecagem FRESCA da pausa da IA. O guard de entrada (Deno.serve) só lê pausa_ia
// UMA vez, na chegada do inbound; mas entre a chegada e o envio passam o debounce
// (agente_sdr_delay_segundos, hoje 45s) + a geração do LLM + o dribble de chunks —
// uma janela de até ~2min em que o atendente pode pausar a IA. Sem este recheck, a
// mensagem "em voo" saía mesmo depois da pausa (era a queixa dos SDRs). Lê só o flag.
async function iaPausada(remotejid: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('cliente_ppg_leads_sdr')
    .select('pausa_ia')
    .eq('remotejid', remotejid)
    .maybeSingle();
  if (error) {
    console.error(`[crm-agente-sdr] iaPausada ${remotejid}: ${error.message}`);
    return false; // em erro de leitura, não bloqueia (mantém o comportamento atual)
  }
  return data?.pausa_ia === true;
}

// Raciocínio simulado em <thinking>…</thinking> DENTRO do bloco de texto não pode
// ficar no histórico: o modelo lê o próprio turno anterior e repete o padrão na volta
// seguinte (auto-reforço). O envio já é protegido em saida.ts; aqui é a 2ª camada.
// ⚠️ Só troca o texto quando sobra conteúdo — bloco `text` VAZIO no histórico é 400 na
// Anthropic, então turno que era só raciocínio é gravado como veio (fiel, e nunca sai).
function semRaciocinioNoTexto(content: any): any {
  if (!Array.isArray(content)) return content;
  return content.map((b: any) => {
    if (b?.type !== 'text' || typeof b.text !== 'string') return b;
    const limpo = removerRaciocinioVazado(b.text);
    return limpo && limpo !== b.text ? { ...b, text: limpo } : b;
  });
}

// ALUNO MATRICULADO ⇒ a IA NÃO ATENDE, pausa e devolve pro humano.
// A IA comercial trata todo mundo como lead novo: com aluno ela qualifica, oferece horário e
// agenda reunião de VENDA — e, pressionada, inventa um motivo pra conversa (caso Hariadne,
// 2026-07-21: "essa conversa no meet é justamente com o monitor do seu curso, pra checar sua
// experiência" — isso não existe). A régua é a MESMA dos disparos (crm_e_aluno: segmento
// marcado como público-aluno OU matrícula real, por telefone canônico), então quem já não
// recebe disparo também não é atendido pela IA. Fail-OPEN: erro de leitura não bloqueia o
// atendimento (a régua é uma proteção, não pode virar apagão).
async function ehAlunoMatriculado(telefone: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('crm_e_aluno_telefone', { p_telefone: telefone });
  if (error) {
    console.error(`[crm-agente-sdr] crm_e_aluno_telefone ${telefone}: ${error.message}`);
    return false;
  }
  return data === true;
}

// ── persona CAMPANHA DIRETA (número de anúncio Click-to-WhatsApp) ───────────

// Allowlist de teste (crm_agente_sdr_config.teste_telefones, 8 últimos dígitos).
// Enquanto a conversação está sendo validada, a IA deste número responde APENAS a
// esses telefones — a campanha está NO AR e recebendo lead real o tempo todo, então
// ligar pra todo mundo antes de validar seria irreversível. Array vazio = sem trava.
// Fail-CLOSED de propósito: se a leitura falhar, não atende (o silêncio é reversível,
// uma resposta ruim a lead real não é).
async function permitidoNoTeste(telefone: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('crm_agente_sdr_config')
    .select('teste_telefones')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    console.error(`[crm-agente-sdr] allowlist de teste: ${error.message}`);
    return false;
  }
  const lista: string[] = data?.teste_telefones ?? [];
  if (!lista.length) return true; // sem trava = produção
  const sub8 = String(telefone).replace(/\D/g, '').slice(-8);
  return lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === sub8);
}

// Tools da vez. Na campanha direta a ABERTURA usa a persona própria (que tem a
// atualizar_dados_lead); no FECHAMENTO o qualificador segue idêntico ao dos outros
// números, só ganhando a atualizar_dados_lead — o lead pode corrigir o nome lá também.
// ⚠️ Ordem estável: os extras entram sempre no fim (a ordem das tools compõe o
// prefixo do prompt cache; ordem variável = cache miss silencioso).
async function toolsDaVez(agenteEfetivo: string, ehCampanha: boolean): Promise<any[]> {
  if (!ehCampanha) return await carregarTools(supabase, agenteEfetivo);
  if (agenteEfetivo === 'agente_validacao') return await carregarTools(supabase, 'agente_campanha_direta');
  const base = await carregarTools(supabase, agenteEfetivo);
  const extras = (await carregarTools(supabase, 'agente_campanha_direta'))
    .filter((t: any) => t?.name === 'atualizar_dados_lead');
  return [...base, ...extras];
}

// ── uma rodada do agente sobre um lote de mensagens drenadas ────────────────

async function rodadaAgente(remotejid: string, itens: any[], tel: Telemetria): Promise<void> {
  const inicioRodada = Date.now();
  tel.registrar('rodada_inicio', {
    mensagens: itens.map((i: any) => resumir(i.mensagem, 300)),
    arquivos: itens.filter((i: any) => i.arquivo).length,
  });
  // Contexto da CONVERSA: conta/lead/oportunidade vêm do último item do buffer QUE
  // TEM o campo — o POST de drenagem do reconciliador (drenar_orfao) chegava SEM
  // wa_account_id e, sendo o último do lote, zerava o ctx: a resposta caía na 1ª
  // conta ativa (get_crm_wa_account(NULL) = João) e a Meta rejeitava com 131047,
  // janela fechada NAQUELE número (caso Ananda, 2026-07-09). Fallback final da
  // conta: último INBOUND do lead — é onde a janela de 24h está aberta
  // (incluirRecontato: se o lead escreveu no número de recontato, sai por lá).
  const doUltimoCom = (campo: string): any =>
    [...itens].reverse().find((i: any) => i?.[campo] != null)?.[campo] ?? null;
  const telefone = String(remotejid).split('@')[0];
  const ctx: CtxConversa = {
    remotejid,
    telefone,
    waAccountId: doUltimoCom('wa_account_id') ??
      (await contaDoLead(supabase, telefone, { direcao: 'inbound', incluirRecontato: true })),
    leadId: doUltimoCom('lead_id'),
    oportunidadeId: doUltimoCom('oportunidade_id'),
  };

  let lead = await buscarLead(supabase, remotejid);
  if (!lead) {
    await criarLead(supabase, remotejid);
    lead = await buscarLead(supabase, remotejid);
  }
  // Reabriu a conversa: atualiza o relógio âncora e ZERA o estágio de follow-up
  // (se o lead esfriar de novo, a cadência recomeça do 1º toque — igual ao n8n,
  // onde o reset do timestamp_mensagem + dedup por estágio reiniciava a régua).
  // Zera também os flags da esteira de TEMPLATE (janela fechada): o lead respondeu,
  // a janela reabriu, então a cadência de template recomeça do zero se esfriar de novo.
  await atualizarLead(supabase, remotejid, {
    timestamp_mensagem: new Date().toISOString(),
    follow_up: null,
    template_1_dia: false, template_2_dia: false, template_3_dia: false, template_4_dia: false,
    template_5_dia: false, template_6_dia: false, template_7_dia: false,
    template_followup_em: null,
  });

  // Arquivos analisados viram mensagem própria; o texto acumulado vira UMA mensagem.
  for (const item of itens) {
    if (item.arquivo) await gravarMensagem(supabase, remotejid, { role: 'user', content: item.arquivo });
  }
  const conteudo = itens.map((i: any) => i.mensagem).filter(Boolean).join('\n');
  if (conteudo) await gravarMensagem(supabase, remotejid, { role: 'user', content: conteudo });

  // Contexto do lead + temporal (mesma montagem do node "normalizador").
  const formacaoNormalizada = encontrarFormacao(lead?.formacao_academica ?? '');
  const vars = {
    nome: extrairPrimeiroNome(lead?.nome),
    curso_interesse_original: lead?.curso_interesse_original ?? '',
    pergunta_formacao: montarPerguntaFormacao(formacaoNormalizada),
  };
  const contextoTemporal = montarContextoTemporal();

  // Persona: LEAD em modo_recontato manda (independe do número — espelha o gate de
  // entrada); senão vale a persona do número (relay/buffer). 'recontato' = no-show:
  // missão fixa (reabrir + remarcar), então NÃO passa pelo router validação×qualificador.
  // 'campanha_direta' = número de ANÚNCIO: mesma dupla validação×qualificador (mesmo
  // router, mesmo ratchet), só que a ABERTURA usa o prompt próprio, que COLETA nome →
  // curso → formação antes de checar elegibilidade (o lead vem sem cadastro nenhum).
  // ⚠️ A persona sai de `doUltimoCom`, NUNCA do último item cru: o POST de drenagem do
  // reconciliador (drenar_orfao) chega SEM agente_ia_persona e, sendo o último do lote,
  // zerava a persona pra 'qualificador' — o número de anúncio rodava o prompt de validação
  // padrão, sem pedir nome/formação (visto em 2026-07-25). É a MESMA armadilha que já
  // tinha derrubado a conta/lead/oportunidade do ctx (caso Ananda).
  const personaDoNumero = doUltimoCom('agente_ia_persona');
  const persona = lead?.modo_recontato === true || personaDoNumero === 'recontato'
    ? 'recontato'
    : personaDoNumero === 'campanha_direta' ? 'campanha_direta' : 'qualificador';
  const ehCampanha = persona === 'campanha_direta';
  let promptAgente: string;
  let tools: any[];
  let contextoEfetivo = contextoTemporal;
  let agenteEfetivo: string;

  if (persona === 'recontato') {
    agenteEfetivo = 'agente_recontato';
    promptAgente = renderPrompt(AGENTE_RECONTATO, vars);
    tools = await carregarTools(supabase, 'agente_recontato');
    const dossie = montarDossieRecontato(lead?.contexto_recontato);
    if (dossie) contextoEfetivo = `${contextoTemporal}\n\n${dossie}`;
    tel.registrar('router_decisao', {
      decidiu: 'agente_recontato',
      efetivo: 'agente_recontato',
      anterior: lead?.agente_atual ?? null,
      persona: 'recontato',
      dossie: dossie ? true : false,
    }, 0);
  } else {
    // Router (em erro, mantém o agente atual — não derruba a conversa).
    let proximo: 'agente_validacao' | 'agente_qualificador';
    const inicioRouter = Date.now();
    let routerFallback = false;
    try {
      proximo = await chamarRouter(limparParaRouter(await carregarHistorico(supabase, remotejid)));
    } catch (e) {
      console.error('[crm-agente-sdr] router falhou, mantendo agente atual:', e);
      routerFallback = true;
      proximo = lead?.agente_atual === 'agente_qualificador' ? 'agente_qualificador' : 'agente_validacao';
    }
    const agenteAtual = await atualizarAgenteComRatchet(supabase, remotejid, lead?.agente_atual ?? null, proximo);
    agenteEfetivo = agenteAtual;
    tel.registrar('router_decisao', {
      decidiu: proximo,
      efetivo: agenteAtual,
      anterior: lead?.agente_atual ?? null,
      fallback: routerFallback,
      persona,
    }, Date.now() - inicioRouter);
    const promptAbertura = ehCampanha ? AGENTE_CAMPANHA_DIRETA : AGENTE_VALIDACAO;
    promptAgente = renderPrompt(
      agenteAtual === 'agente_qualificador' ? AGENTE_QUALIFICADOR : promptAbertura,
      vars,
    );
    tools = await toolsDaVez(agenteAtual, ehCampanha);
  }
  const renovar = lockRenovar(remotejid);

  // Tools que pausam a IA por decisão do PRÓPRIO agente (pausa_ia, e o
  // temporizador_proxima_turma, que pausa via RPC). A despedida que acompanha
  // essas tools precisa sair MESMO com o flag de pausa já setado: o recheck de
  // pausa existe pra honrar pausa de ATENDENTE durante a geração, não pra
  // engolir a própria despedida do agente.
  const TOOLS_QUE_PAUSAM = new Set(['pausa_ia', 'temporizador_proxima_turma']);
  let pausouPorTool = false;
  let corrigiuHorario = false; // guarda de horário inventado: re-instrui só 1x

  // ── RETENÇÃO PENDENTE ⇒ DESLIGA AS ESTEIRAS (2026-07-14) ──────────────────
  // Quando o lead demonstra desinteresse, o prompt manda fazer UMA pergunta de
  // retenção (a oferta da PRÓXIMA TURMA) antes de pausar — e o agente fica
  // esperando a resposta, sem pausar. Só que, sem resposta, o lead continuava
  // elegível às esteiras: o follow-up de janela aberta cutucava em 15 min (caso
  // Lucas, 2026-07-14: o lead mandou áudio dizendo que não é o momento — "tô com
  // a neném pequena" — e 16 min depois recebeu "a neném foi crescendo um pouco e
  // vc conseguiu respirar mais?"). Enquanto a retenção estiver pendente, NINGUÉM
  // cutuca: `followup_ativado=false` desliga a esteira de janela aberta E a de
  // template (as duas gateiam por esse flag). A conversa segue normal se o lead
  // responder — o inbound não é bloqueado (isso é esteira, não pausa).
  // Espelho da guarda determinística em followup.ts (`retencaoPendente`).
  // ⚠️ Casa a OFERTA de retenção ("te chame quando abrir a próxima turma"), NUNCA
  // "próxima turma" solta — o template de abertura do disparo fala em "vagas da
  // próxima turma" e um regex frouxo desligaria a esteira de lead normal.
  const RE_RETENCAO = /(te cham\w*|te avis\w*)[^.?!]{0,40}pr[óo]xima turma/i;
  const suspenderEsteirasSeRetencao = async (texto: string) => {
    if (!RE_RETENCAO.test(texto)) return;
    await atualizarLead(supabase, remotejid, { followup_ativado: false });
    tel.registrar('esteiras_suspensas', { motivo: 'retencao_pendente' });
  };

  // Loop agêntico: igual ao n8n, o histórico é relido do banco a cada volta.
  for (let rodada = 0; rodada < MAX_RODADAS_TOOLS; rodada++) {
    const messages = sanitizarHistorico(await carregarHistorico(supabase, remotejid));
    const inicioLlm = Date.now();
    const resp = await chamarAgentePrincipal({ promptAgente, contextoTemporal: contextoEfetivo, messages, tools });
    // OUTPUT da IA (não o prompt): o que o modelo gerou nesta volta — raciocínio
    // (thinking), resposta crua (text) e as tools que ELA decidiu chamar.
    const blocosResp = (resp.content ?? []) as any[];
    const iaTexto = blocosResp.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const iaPensamento = blocosResp.filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('\n').trim();
    const iaTools = blocosResp
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ nome: b.name, input: resumir(b.input, 600) }));
    tel.registrar('llm_chamada', {
      volta: rodada + 1,
      agente: agenteEfetivo,
      modelo: resp.model ?? null,
      stop_reason: resp.stop_reason ?? null,
      tokens_entrada: resp.usage?.input_tokens ?? null,
      tokens_saida: resp.usage?.output_tokens ?? null,
      // Sonnet 5 adaptativo: o TEXTO do thinking vem criptografado (vazio+signature),
      // mas o usage expõe quanto ele pensou — única observabilidade restante.
      tokens_pensamento: resp.usage?.output_tokens_details?.thinking_tokens ?? null,
      cache_lido: resp.usage?.cache_read_input_tokens ?? null,
      cache_escrito: resp.usage?.cache_creation_input_tokens ?? null,
      blocos: blocosResp.map((b) => b.type),
      pensamento: iaPensamento ? resumir(iaPensamento, 2000) : undefined,
      texto: iaTexto ? resumir(iaTexto, 2000) : undefined,
      tools_decididas: iaTools.length ? iaTools : undefined,
    }, Date.now() - inicioLlm);
    await gravarMensagem(supabase, remotejid, { role: 'assistant', content: semRaciocinioNoTexto(resp.content) });

    const toolUses = (resp.content ?? []).filter((b: any) => b.type === 'tool_use');
    if (toolUses.length) {
      await renovar();
      const outputs: Record<string, unknown>[] = [];
      for (const tu of toolUses) {
        // uma function por vez, em ordem (idem "executa uma function por vez")
        const inicioTool = Date.now();
        const output = await executarTool(supabase, tu, ctx);
        tel.registrar('tool_exec', {
          tool: tu.name,
          input: resumir(tu.input, 800),
          output: resumir(output, 1200),
        }, Date.now() - inicioTool);
        outputs.push(output);
      }
      await gravarMensagem(supabase, remotejid, { role: 'user', content: montarToolResults(outputs) });
      if (toolUses.some((tu: any) => TOOLS_QUE_PAUSAM.has(tu.name))) {
        pausouPorTool = true;
        // O prompt manda a despedida vir NA MESMA resposta da tool de pausa;
        // sem este envio ela era descartada pelo `continue` e a rodada acabava
        // muda pro lead (caso Claudia, 2026-07-06). Sem recheck de pausa aqui:
        // a pausa é a que o próprio agente acabou de aplicar.
        if (iaTexto) {
          await enviarResposta(ctx, iaTexto, renovar, tel);
          tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: true }, Date.now() - inicioRodada);
          return;
        }
      }
      continue;
    }

    const texto = (resp.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    if (texto) {
      // Regra de ouro nº 2 em CÓDIGO (caso Marcello 2026-07-23): oferta de horário
      // que não apareceu em lugar NENHUM da conversa (consulta_disponibilidade,
      // fala do lead, turnos anteriores) = slot INVENTADO — o Sonnet 5 fez isso em
      // resposta-reflexo, oferecendo inclusive horários já passados. Re-instrui o
      // modelo 1x (turno interno + volta do loop); na reincidência, não envia.
      const inventados = horariosInventados(texto, conversaTexto(messages));
      if (inventados.length && !corrigiuHorario) {
        corrigiuHorario = true;
        tel.registrar('horario_inventado', { horarios: inventados, acao: 'reinstruido', texto: resumir(texto, 600) });
        await gravarMensagem(supabase, remotejid, {
          role: 'user',
          content: '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada ao lead: ela oferece horário(s) ' +
            `(${inventados.join(', ')}) que não vieram de consulta_disponibilidade nesta conversa — é proibido inventar ` +
            'horário (Regra de ouro nº 2). Refaça agora: rode consulta_disponibilidade e ofereça SÓ o que ela devolver, ' +
            'ou responda sem citar horário específico. Não mencione esta correção ao lead.',
        });
        continue;
      }
      if (inventados.length) {
        tel.registrar('horario_inventado', { horarios: inventados, acao: 'descartado', texto: resumir(texto, 600) });
        tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: false }, Date.now() - inicioRodada);
        return;
      }
      // Última checagem antes de falar: a geração do LLM (com tools) pode ter levado
      // dezenas de segundos; se o atendente pausou nesse meio, NÃO envia. O recheck
      // entre chunks (passado a enviarResposta) cobre a pausa durante o dribble.
      // EXCEÇÃO: pausa aplicada pelo PRÓPRIO agente nesta rodada (pausouPorTool)
      // não engole a despedida — o recheck é pra pausa de atendente.
      if (!pausouPorTool && await iaPausada(remotejid)) {
        tel.registrar('envio_abortado_pausa', { onde: 'antes_envio', motivo: 'IA pausada durante a geração' });
      } else {
        await suspenderEsteirasSeRetencao(texto);
        await enviarResposta(ctx, texto, renovar, tel, pausouPorTool ? undefined : () => iaPausada(remotejid));
      }
    }
    tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: Boolean(texto) }, Date.now() - inicioRodada);
    return;
  }
  tel.registrar('erro', { onde: 'loop' }, Date.now() - inicioRodada, `limite de ${MAX_RODADAS_TOOLS} rodadas de tools atingido`);
  console.error(`[crm-agente-sdr] ${remotejid}: limite de ${MAX_RODADAS_TOOLS} rodadas de tools atingido.`);
}

// ── processamento completo de um inbound (roda em background) ───────────────

async function processarInbound(payload: any): Promise<void> {
  const remotejid: string = payload.remotejid;
  let telAtual: Telemetria | null = null;
  // Telemetria do pré-processamento (transcrição/análise de mídia). Só vira uma
  // execução visível se a mídia registrar algum nó (texto puro não gera nada) ou
  // se cair no catch — então não polui a lista com rodadas vazias.
  const telPrep = criarTelemetria(supabase, remotejid);
  try {
    // Mídia é tratada ANTES do buffer (transcrição/análise), como no n8n.
    const tratada = await prepararMensagem(payload, telPrep);
    await bufferInserir(remotejid, {
      ...tratada,
      msg_id: payload.id,
      timestamp: payload.timestamp,
      wa_account_id: payload.wa_account_id ?? null,
      agente_ia_persona: payload.agente_ia_persona ?? null,
      lead_id: payload.lead_id ?? null,
      oportunidade_id: payload.oportunidade_id ?? null,
    });

    if (!(await lockClaim(remotejid))) return; // quem segura o lock drena o buffer

    try {
      const delaySegundos = await carregarDelaySegundos();
      const renovar = lockRenovar(remotejid);
      // Drena até esvaziar: cada lote espera o silêncio do debounce antes de
      // processar; mensagens que chegarem durante a rodada entram na próxima.
      while (true) {
        const esperouMs = await aguardarSilencio(remotejid, delaySegundos, renovar);
        const itens = await bufferDrenar(remotejid);
        if (!itens.length) break;
        // Pausou durante o debounce (45s)? Não gera nem responde esta leva — o lead
        // fica registrado no histórico mas a IA não fala (defesa em profundidade barata).
        if (await iaPausada(remotejid)) {
          criarTelemetria(supabase, remotejid).registrar('envio_abortado_pausa', {
            onde: 'pos_debounce', mensagens_descartadas: itens.length,
          });
          break;
        }
        telAtual = criarTelemetria(supabase, remotejid);
        if (delaySegundos > 0) {
          telAtual.registrar('debounce', { config_s: delaySegundos, mensagens_acumuladas: itens.length }, esperouMs);
        }
        await rodadaAgente(remotejid, itens, telAtual);
      }
    } finally {
      await lockSoltar(remotejid);
    }
  } catch (e) {
    console.error(`[crm-agente-sdr] erro processando ${remotejid}:`, e);
    (telAtual ?? telPrep).registrar(
      'erro',
      { onde: 'processarInbound', stack: resumir((e as Error).stack ?? '', 1500) },
      undefined,
      (e as Error).message,
    );
    try { await lockSoltar(remotejid); } catch { /* melhor esforço */ }
  }
}

// ── entrada ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = new URL(req.url);

  // Esteira de follow-up de JANELA ABERTA: disparada pelo cron (mode=followup),
  // não é um inbound. Varre os leads devidos e reabre as conversas que esfriaram.
  // Auth por SEGREDO COMPARTILHADO no banco (crm_agente_sdr_config.followup_secret),
  // enviado pelo cron no header x-followup-key. No self-hosted o service_role do
  // pg_net NÃO bate com o SUPABASE_SERVICE_ROLE_KEY do container, então não dá pra
  // autenticar por service_role; o segredo do banco resolve (e o front não lê, RLS
  // bloqueia). Vem ANTES da checagem do token de inbound. ?wait=1 roda síncrono
  // (teste manual vê estatísticas); sem isso, background + 200 na hora.
  if (url.searchParams.get('mode') === 'followup') {
    const { data: cfg } = await supabase
      .from('crm_agente_sdr_config')
      .select('followup_secret')
      .eq('id', 1)
      .maybeSingle();
    const segredo = cfg?.followup_secret ?? '';
    if (!segredo || req.headers.get('x-followup-key') !== segredo) {
      return json({ error: 'unauthorized' }, 401);
    }
    const limiteParam = Number(url.searchParams.get('limite'));
    const trabalho = rodarEsteiraFollowup(supabase, Number.isFinite(limiteParam) && limiteParam > 0 ? limiteParam : undefined);
    if (url.searchParams.get('wait') === '1') {
      return json({ ok: true, esteira: 'followup', ...(await trabalho) });
    }
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(trabalho);
    else await trabalho;
    return json({ ok: true, esteira: 'followup', modo: 'background' });
  }

  // Esteira de TEMPLATE (janela fechada): mesma auth da janela aberta. O cron chama
  // em vários horários do dia; o módulo espalha o envio por lead e respeita a trava
  // de 24h. ?wait=1 roda síncrono (vê estatísticas); ?hora=<0-23> força a hora do
  // tick (teste); ?limite=<n> limita os leads do tick.
  if (url.searchParams.get('mode') === 'followup-template') {
    const { data: cfg } = await supabase
      .from('crm_agente_sdr_config')
      .select('followup_secret')
      .eq('id', 1)
      .maybeSingle();
    const segredo = cfg?.followup_secret ?? '';
    if (!segredo || req.headers.get('x-followup-key') !== segredo) {
      return json({ error: 'unauthorized' }, 401);
    }
    const limiteParam = Number(url.searchParams.get('limite'));
    // ⚠️ Number(null) === 0 — sem o guard de presença, tick SEM ?hora= rodava com
    // hora forçada 0 (= 21h BRT, fora de toda janela) e os crons naturais nunca
    // enviavam nada (bug pego em 2026-07-06, tarde inteira com devidos=0).
    const horaRaw = url.searchParams.get('hora');
    const horaParam = horaRaw === null ? NaN : Number(horaRaw);
    // ?cadeia=<n>: nº da rodada encadeada — a esteira se re-invoca em lotes de 300
    // até drenar os devidos do tick (encadearProximaRodada no followup-template.ts).
    const cadeiaRaw = url.searchParams.get('cadeia');
    const cadeiaParam = cadeiaRaw === null ? NaN : Number(cadeiaRaw);
    const trabalho = rodarEsteiraFollowupTemplate(supabase, {
      limite: Number.isFinite(limiteParam) && limiteParam > 0 ? limiteParam : undefined,
      horaUtc: Number.isFinite(horaParam) ? horaParam : undefined,
      cadeia: Number.isFinite(cadeiaParam) && cadeiaParam > 0 ? cadeiaParam : undefined,
    });
    if (url.searchParams.get('wait') === '1') {
      return json({ ok: true, esteira: 'followup-template', ...(await trabalho) });
    }
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(trabalho);
    else await trabalho;
    return json({ ok: true, esteira: 'followup-template', modo: 'background' });
  }

  if (TOKEN && url.searchParams.get('token') !== TOKEN) return json({ error: 'unauthorized' }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: 'payload inválido' }, 400); }

  // Guards de entrada (mesma ordem do n8n).
  if (payload?.direcao !== 'inbound' || payload?.from_me === true) return json({ ok: true, skip: 'nao_inbound' });
  if (!payload?.remotejid || !payload?.telefone) return json({ error: 'remotejid/telefone obrigatórios' }, 400);

  // Comando de reset usado nos testes (/excluirdados): apaga lead + mensagens.
  if (String(payload.conteudo ?? '').trim() === '/excluirdados') {
    await excluirDadosLead(supabase, payload.remotejid);
    await supabase.from('crm_agente_sdr_buffer').delete().eq('remotejid', payload.remotejid);
    return json({ ok: true, reset: true });
  }

  // Gate de atendimento. A persona é decidida pelo LEAD primeiro, depois pelo número:
  //  - lead com modo_recontato=true → persona 'recontato' em QUALQUER número (um disparo
  //    de no-show pode sair por um número qualificador, ex.: João IA SDR — quem responde
  //    lá também precisa do prompt de recontato, não do fluxo de lead novo).
  //  - número 'recontato' com lead FORA do modo → skip (NUNCA roda o qualificador nesse
  //    número — leads carregam iniciar_atendimento=true global, então sem esse gate o
  //    qualificador responderia comparecidos/leads antigos).
  //  - número 'qualificador' (padrão): atende quem tem iniciar_atendimento (lead novo).
  //  - número 'campanha_direta' (anúncio): o lead NUNCA passou por webhook de LP, então
  //    não existe em cliente_ppg_leads_sdr e cairia em 'sem_iniciar_atendimento' — ou seja,
  //    a IA nunca falaria com ninguém da campanha. Aqui o próprio clique no anúncio é o
  //    opt-in, então o lead é semeado na hora (respeitando não-perturbe e pausa).
  const ehCampanhaDireta = payload.agente_ia_persona === 'campanha_direta';
  if (ehCampanhaDireta && !(await permitidoNoTeste(payload.telefone))) {
    return json({ ok: true, skip: 'fora_da_allowlist_teste' });
  }

  let lead = await buscarLead(supabase, payload.remotejid);
  if (lead?.modo_recontato !== true) {
    if (payload.agente_ia_persona === 'recontato') return json({ ok: true, skip: 'fora_do_modo_recontato' });
    if (ehCampanhaDireta) {
      if (lead?.nao_perturbe === true) return json({ ok: true, skip: 'nao_perturbe' });
      if (!lead) {
        await criarLead(supabase, payload.remotejid); // nasce com iniciar_atendimento = true (default)
        lead = await buscarLead(supabase, payload.remotejid);
      } else if (lead.iniciar_atendimento !== true) {
        await atualizarLead(supabase, payload.remotejid, { iniciar_atendimento: true });
        lead.iniciar_atendimento = true;
      }
    }
    if (!lead || lead.iniciar_atendimento !== true) return json({ ok: true, skip: 'sem_iniciar_atendimento' });
  }
  if (lead.pausa_ia === true) return json({ ok: true, skip: 'pausa_ia' });

  // Já é ALUNO? A IA não fala com aluno — pausa (uma vez) e o humano assume. Nas próximas
  // mensagens dele o guard de pausa_ia acima já corta, então isto roda no máximo 1×.
  if (await ehAlunoMatriculado(payload.telefone)) {
    await supabase.rpc('crm_set_pausa_ia', {
      p_telefone: payload.telefone,
      p_pausa: true,
      p_motivo: 'Contato é aluno matriculado — atendimento com um humano',
    });
    criarTelemetria(supabase, payload.remotejid).registrar('skip_aluno_matriculado', {
      telefone: payload.telefone,
      motivo: 'contato é aluno matriculado — IA pausada, atendimento humano',
    });
    return json({ ok: true, skip: 'aluno_matriculado' });
  }

  const trabalho = processarInbound(payload);
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(trabalho);
  } else {
    await trabalho;
  }
  return json({ ok: true });
});
