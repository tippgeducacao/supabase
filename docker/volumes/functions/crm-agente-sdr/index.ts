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
import { pausaVigente } from './pausa.ts';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from './prompts.ts';
import { AGENTE_RECONTATO, montarDossieRecontato } from './prompts-recontato.ts';
import { AGENTE_CAMPANHA_DIRETA } from './prompts-campanha-direta.ts';
import { AGENTE_AULA, type AulaParaPrompt, montarVarsAula } from './prompts-aula.ts';
import { comBlocoDaEscola, comLinkPedido, comPresenteNaDespedida, jaTemOPresente, LINK_ESCOLA_GRATUITA } from './escolaGratuita.ts';
import { respostaDoEncerramento, toolConcluida, type Encerramento } from './encerramento.ts';
import { confirmacaoDoResultado, falaEntregaConfirmacao, textoConfirmacaoAgendamento, type ConfirmacaoAgendamento } from './confirmacaoAgendamento.ts';
import { blocoPerguntasRecentes } from './perguntasRecentes.ts';
import { comContinuidadeWebchat } from './continuidadeWebchat.ts';
import { encontrarFormacao, extrairPrimeiroNome, montarContextoTemporal, montarPerguntaFormacao, notaDoCurso, notaDoNome, renderPrompt } from './contexto.ts';
import { atualizarAgenteComRatchet, atualizarLead, avaliarFimDoHistorico, buscarLead, carregarHistorico, comEntradaPendente, criarLead, excluirDadosLead, gravarMensagem, limparParaRouter, sanitizarHistorico } from './historico.ts';
import { carregarTools, chamarAgentePrincipal, chamarRouter, provedorOpenai, type MetadadosRespostaRouter, type ProvedorIA } from './agente.ts';
import { type CtxConversa, executarTool, montarToolResults } from './tools.ts';
import { carregarStatusMateriais } from './envioMateriais.ts';
import { carregarFicha, detectarPedidoDeCronograma, marcarPerguntasDaFicha, registrarNaJornada } from './fichaAtendimento.ts';
import { comGanchoDoLote } from './ganchoLote.ts';
import { blocoConviteAgenda } from './contexto.ts';
import { prepararMensagem } from './midia.ts';
import { persistirEntradasDoLote, registrarEntrada } from './historicoEntradaPausa.ts';
import { aguardarAudiosDoHistorico, contarAudiosPendentes } from './sincronizacaoAudio.ts';
import { conversaTexto, enviarResposta, horariosInventados, humanizarTexto, removerRaciocinioVazado } from './saida.ts';
import { configurarVoz } from './envioVoz.ts';
import { selecionarProvedorDoLead } from './pilotoOpenai.ts';
import { contextoAulaPiloto, INSTRUCAO_AULA_PILOTO } from './contextoAulaPiloto.ts';
import { PRAZO_MODELO_PILOTO_MS, RESPOSTA_MODELO_INDISPONIVEL } from './prazoModelo.ts';
import { contaDoLead, dadosDaConta, personaDaConta } from './conta.ts';
import { rodarEsteiraFollowup } from './followup.ts';
import { contextoEspecialidadeCannabis } from './especialidadeCannabis.ts';
import { rodarEsteiraFollowupTemplate } from './followup-template.ts';
import { criarTelemetria, resumir, type Telemetria } from './eventos.ts';
import { carregarModoTrocaNumero, carregarSinalTrocaDeNumero, comNotaNoContexto, comNotaParaRouter, notaTrocaDeNumero, resumoDoSinal, sinalInerte, type SinalTrocaDeNumero } from './trocaDeNumero.ts';
import { enviarComAberturaNumero, NOTA_ABERTURA_CONTROLADA } from './aberturaTrocaNumero.ts';

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Opcional: se setado, o relay precisa apontar pra ...?token=<valor>.
const TOKEN = Deno.env.get('AGENTE_SDR_TOKEN') ?? '';
const LOCK_TTL_SEGUNDOS = 240; // mesmo TTL do lock Redis do n8n
const MAX_RODADAS_TOOLS = 8;   // trava de segurança (o n8n não limitava)
// Números que têm agente próprio: o João nunca responde por eles, venha a mensagem de onde vier
// (relay, reconciliador, drenagem de buffer). 'aluno' = assistente pedagógico; 'rh' = agente de RH.
const PERSONAS_DE_OUTRO_AGENTE = new Set(['aluno', 'rh']);

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
// mensagem "em voo" saía mesmo depois da pausa (era a queixa dos SDRs). Lê o flag e o
// prazo (pausa_ia_ate): pausa de 10 min vencida conta como IA ligada sem esperar o cron.
async function iaPausada(remotejid: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('cliente_ppg_leads_sdr')
    .select('pausa_ia, pausa_ia_ate')
    .eq('remotejid', remotejid)
    .maybeSingle();
  if (error) {
    console.error(`[crm-agente-sdr] iaPausada ${remotejid}: ${error.message}`);
    return false; // em erro de leitura, não bloqueia (mantém o comportamento atual)
  }
  return pausaVigente(data);
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

// ── Qual modelo atende ESTE lead ─────────────────────────────────────────────
// Canário da GPT-5.6 Luna (18/09/2026): só os telefones listados em
// `crm_agente_sdr_config.luna_telefones` saem pela OpenAI; todo o resto segue na Anthropic.
// Falha fechada para o lado SEGURO: sem chave, com erro de leitura ou coluna ausente, o lead
// fica no Claude — trocar de modelo nunca pode ser o motivo de alguém ficar sem resposta.
// Escopo do canário: router + loop principal + correção do canal. Matriz de elegibilidade
// (verificar_compatibilidade_curso) continua na Anthropic; follow-up usa a mesma seleção.
async function provedorDoLead(telefone: string): Promise<ProvedorIA | null> {
  return selecionarProvedorDoLead(supabase, telefone);
}

// Debounce do canário da Luna (pedido do usuário, 18/09/2026): quem está em `luna_telefones`
// espera `luna_delay_segundos` (5 s por padrão) em vez dos 45 s da produção — rápido para
// testar no próprio WhatsApp, mas sem o zero dos telefones de teste, que faz cada mensagem
// virar uma rodada e a 2ª atropelar a geração da 1ª. `null` = não é do canário (ou erro de
// leitura): vale a regra de sempre.
async function delayDoCanarioLuna(telefone: string): Promise<number | null> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('luna_telefones, luna_delay_segundos').eq('id', 1).maybeSingle();
    if (error) return null;
    const lista: string[] = data?.luna_telefones ?? [];
    const sub8 = String(telefone).replace(/\D/g, '').slice(-8);
    if (!sub8 || !lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === sub8)) return null;
    // `Number(null)` é 0: valor ausente não pode virar "sem debounce" por acidente.
    const bruto = data?.luna_delay_segundos;
    const v = bruto == null ? NaN : Number(bruto);
    return Number.isFinite(v) && v >= 0 && v <= 120 ? v : 5;
  } catch {
    return null;
  }
}

// Tools da vez. Na campanha direta a ABERTURA usa a persona própria (que tem a
// atualizar_dados_lead); no FECHAMENTO o qualificador segue idêntico ao dos outros
// números, só ganhando a atualizar_dados_lead — o lead pode corrigir o nome lá também.
// ⚠️ Ordem estável: os extras entram sempre no fim (a ordem das tools compõe o
// prefixo do prompt cache; ordem variável = cache miss silencioso).
async function toolsDaVez(agenteEfetivo: string, ehCampanha: boolean, provedor: ProvedorIA | null): Promise<any[]> {
  if (!ehCampanha) return await carregarTools(supabase, agenteEfetivo, provedor);
  if (agenteEfetivo === 'agente_validacao') return await carregarTools(supabase, 'agente_campanha_direta', provedor);
  const base = await carregarTools(supabase, agenteEfetivo, provedor);
  const extras = (await carregarTools(supabase, 'agente_campanha_direta', provedor))
    .filter((t: any) => t?.name === 'atualizar_dados_lead');
  return [...base, ...extras];
}

// ── uma rodada do agente sobre um lote de mensagens drenadas ────────────────

async function rodadaAgente(remotejid: string, itens: any[], tel: Telemetria): Promise<void> {
  const inicioRodada = Date.now();
  // 08/09/2026: a pausa pode ter capturado parte do lote antes da drenagem.
  // Essas falas já são contexto; despausar não autoriza respondê-las por replay.
  itens = await persistirEntradasDoLote(supabase, remotejid, itens);
  if (!itens.length) {
    tel.registrar('envio_abortado_pausa', { onde: 'historico_entrada', motivo: 'lote sem entrada ativa' });
    return;
  }
  const conteudo = itens.map((item: any) => item.mensagem).filter(Boolean).join('\n');
  tel.registrar('rodada_inicio', {
    mensagens: itens.map((i: any) => resumir(i.mensagem, 300)),
    arquivos: itens.filter((i: any) => i.arquivo).length,
    wa_account_id: [...itens].reverse().find((i: any) => i?.wa_account_id != null)?.wa_account_id ?? null,
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
  // No piloto de voz a preparação pode ser cancelada por uma entrada nova.
  // A fala final só passa a ser memória depois de pelo menos um envio aceito.
  // `let`: se o provedor alternativo falhar no meio da rodada, o resto dela volta para o Claude.
  let provedor = await provedorDoLead(telefone);
  let registrarFalaAposEnvio = Boolean(configurarVoz(telefone, (nome) => Deno.env.get(nome), provedor?.nome));
  if (provedor) tel.registrar('provedor_ia', { provedor: provedor.nome, modelo: provedor.formato === 'openai' ? provedor.modelo : null, motivo: 'canario_luna_telefones' });
  const ctx: CtxConversa = {
    remotejid,
    telefone,
    waAccountId: doUltimoCom('wa_account_id') ??
      (await contaDoLead(supabase, telefone, { direcao: 'inbound', incluirRecontato: true })),
    leadId: doUltimoCom('lead_id'),
    oportunidadeId: doUltimoCom('oportunidade_id'),
    // Ficha do atendimento (19/09/2026) acompanha o canário da Luna — o "novo agente" do
    // usuário: só esse lead tem a ficha, a instrução e a trava do cronograma (fichaAtendimento.ts).
    ...(provedor ? { ficha: { inicioRodada: new Date(inicioRodada).toISOString() } } : {}),
  };

  let lead = await buscarLead(supabase, remotejid);
  // O nome vai no ctx pra servir de último recurso no agendamento (ver o payload em
  // tools.ts): sem lead ativo e sem nome, o sdr-api devolve 422 e a reunião não nasce.
  ctx.nome = (lead?.nome as string | null) ?? null;
  if (!lead) {
    await criarLead(supabase, remotejid);
    lead = await buscarLead(supabase, remotejid);
  }
  // Ficha (canário): o clique em "Receber Cronograma" (936 em 30 dias) ou o pedido em texto fica
  // anotado na jornada ANTES de o modelo falar — é o que a ficha usa para cobrar a coleta.
  if (ctx.ficha) {
    const pedido = detectarPedidoDeCronograma(itens);
    if (pedido) {
      try {
        await registrarNaJornada(supabase, telefone, (j) => ({
          ...j, cronograma: { ...(j.cronograma ?? {}), pedido_em: new Date().toISOString(), pedido_por: pedido },
        }));
        tel.registrar('cronograma_pedido', { por: pedido });
      } catch (e) {
        tel.registrar('erro', { onde: 'jornada_cronograma_pedido' }, undefined, String((e as Error)?.message ?? e));
      }
    }
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

  // 14/09/2026 — TROCA DE NÚMERO: o lead pode estar escrevendo por OUTRO número da PPGVET
  // (respondeu a um template de disparo/cadência de um número que nunca conversou com ele)
  // enquanto a memória, que é uma só por telefone, traz a conversa do número anterior — e o
  // modelo cobrava aqui o horário "combinado" lá. O sinal é determinístico (crm_whatsapp_messages
  // sabe a conta de cada mensagem); o que fazer com ele depende do modo na config. Regra, casos
  // de borda e a nota em trocaDeNumero.ts.
  const modoTroca = await carregarModoTrocaNumero(supabase, telefone);
  const aberturaControlada = modoTroca === 'ativo' && provedor?.nome === 'openai' && ctx.canal !== 'webchat';
  registrarFalaAposEnvio ||= aberturaControlada;
  const contasNoLote = new Set(itens.map((i: any) => i?.wa_account_id).filter(Boolean)).size;
  const sinalTroca: SinalTrocaDeNumero = modoTroca === 'off'
    ? sinalInerte(ctx.waAccountId ?? null, contasNoLote, 'desligado')
    : await carregarSinalTrocaDeNumero(supabase, { telefone, contaAtual: ctx.waAccountId, itens, contasNoLote,
      somenteSaidas: aberturaControlada });

  // Contexto do lead + temporal (mesma montagem do node "normalizador").
  const formacaoNormalizada = encontrarFormacao(lead?.formacao_academica ?? '');
  const vars: Record<string, string> = {
    nome: extrairPrimeiroNome(lead?.nome),
    curso_interesse_original: lead?.curso_interesse_original ?? '',
    pergunta_formacao: montarPerguntaFormacao(formacaoNormalizada),
  };
  // PERSONA AULA (16/09/2026, PRD — Persona por disparo): o disparo grava `contexto_campanha`
  // no lead do SDR. Com persona 'aula' e aula cadastrada em crm_aulas, a ABERTURA usa o
  // prompt da aula com os dados dela (quando ocorre, link, pós vinculada); o fechamento
  // segue com o qualificador, pelo mesmo router e ratchet. Lead sem contexto = tudo como antes.
  // Falha ao carregar a aula NÃO cala o agente: cai na persona padrão e registra o motivo.
  const campanha = (lead?.contexto_campanha ?? null) as { persona?: string; aula_id?: string; origem?: string } | null;
  const aulaPiloto = Boolean(ctx.ficha && campanha?.persona === 'aula' && !lead?.modo_recontato && doUltimoCom('agente_ia_persona') !== 'recontato');
  let aulaDaCampanha: AulaParaPrompt | null = null;
  if (campanha?.persona === 'aula' && campanha.aula_id) {
    try {
      const { data, error } = await supabase
        .from('crm_aulas')
        .select('titulo, tema, inicio_em, link, certificado_link, certificado_instrucoes, monitor_nome, cursos(nome)')
        .eq('id', campanha.aula_id)
        .eq('ativo', true)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data) {
        aulaDaCampanha = {
          titulo: data.titulo, tema: data.tema ?? null, inicio_em: data.inicio_em, link: data.link ?? null,
          certificado_instrucoes: data.certificado_instrucoes ?? null, monitor_nome: data.monitor_nome ?? null,
          certificado_link: data.certificado_link ?? null,
          curso_nome: data.cursos?.nome ?? null,
        };
      } else {
        tel.registrar('persona_aula_sem_aula', { aula_id: campanha.aula_id });
      }
    } catch (e) {
      console.error('[crm-agente-sdr] aula da campanha não carregou; persona padrão:', e);
      tel.registrar('persona_aula_sem_aula', { aula_id: campanha.aula_id, erro: String((e as Error)?.message ?? e) });
    }
  }
  // Na aula, a pós do lead é a pós VINCULADA à aula (vazia quando a aula não tem pós).
  if (aulaDaCampanha) Object.assign(vars, montarVarsAula(aulaDaCampanha));
  // O nome volta AQUI, a cada turno, e não só no cabeçalho do prompt (ver notaDoNome).
  const contextoTemporal = montarContextoTemporal() + notaDoNome(vars.nome) + notaDoCurso(vars.curso_interesse_original)
    + (provedor?.nome === 'openai' ? contextoEspecialidadeCannabis(vars.curso_interesse_original) : '');

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
  // 'aula' (16/09/2026) = lead com contexto_campanha de aula e aula carregada acima: mesma
  // dupla validação×qualificador da validação, só que a abertura usa o prompt da aula.
  // O no-show (recontato) continua vencendo: é um processo em andamento, com dossiê.
  const personaDoNumero = doUltimoCom('agente_ia_persona');
  const persona = lead?.modo_recontato === true || personaDoNumero === 'recontato'
    ? 'recontato'
    : aulaDaCampanha || aulaPiloto ? 'aula'
    : personaDoNumero === 'campanha_direta' ? 'campanha_direta' : 'qualificador';
  const ehCampanha = persona === 'campanha_direta';
  // Só o modo 'ativo' muda comportamento; 'sombra' registra o que faria. Recontato tem missão
  // fixa e dossiê próprio. No piloto também recebe a abertura, mas conserva o ratchet.
  const aplicarTroca = modoTroca === 'ativo' && sinalTroca.trocou && (persona !== 'recontato' || aberturaControlada);
  // Ratchet do agente_atual ignorado SÓ nesta rodada e SÓ sem reunião confirmada: o router
  // decide de novo vendo a fronteira; reunião marcada é fato e mantém o fechamento.
  const agenteAnterior: string | null = aplicarTroca && persona !== 'recontato' && lead?.agendado !== true ? null : (lead?.agente_atual ?? null);
  let notaTroca: string | null = null;
  if (aplicarTroca) {
    const [contaAtual, contaAnterior] = await Promise.all([
      dadosDaConta(supabase, sinalTroca.contaAtual),
      dadosDaConta(supabase, sinalTroca.contaAnterior),
    ]);
    notaTroca = notaTrocaDeNumero(sinalTroca, { atual: contaAtual, anterior: contaAnterior }, { agendado: lead?.agendado === true, aberturaControlada });
  }
  if (modoTroca !== 'off' && (sinalTroca.trocou || sinalTroca.contasNoLote > 1)) {
    tel.registrar('troca_de_numero', {
      ...resumoDoSinal(sinalTroca),
      modo: modoTroca,
      aplicado: aplicarTroca,
      ratchet_ignorado: agenteAnterior !== (lead?.agente_atual ?? null),
      agente_atual_antes: lead?.agente_atual ?? null,
      agendado: lead?.agendado === true,
      persona,
    });
  }
  // O router é uma chamada paga como as outras (1 por rodada, histórico inteiro): sem
  // este registro o painel "Uso de IA" ficava ~US$ 40 abaixo da fatura num dia de pico
  // (15/09/2026). `volta: 0` + `agente: 'router'` separam do loop principal.
  const registrarUsoRouter = (m: MetadadosRespostaRouter) => tel.registrar('llm_chamada', {
    volta: 0,
    agente: 'router',
    provedor: provedor?.nome ?? 'anthropic',
    modelo: m.model ?? null,
    raciocinio_encadeado: m.raciocinio_encadeado === true,
    raciocinios_reenviados: m.raciocinios_reenviados ?? 0,
    tokens_entrada: m.usage?.input_tokens ?? null,
    tokens_saida: m.usage?.output_tokens ?? null,
    cache_lido: m.usage?.cache_read_input_tokens ?? null,
    cache_escrito: m.usage?.cache_creation_input_tokens ?? null,
  });
  let promptAgente: string;
  let tools: any[];
  // A nota vai no bloco de contexto temporal: relido a cada volta, fora do prefixo cacheado.
  let contextoEfetivo = comNotaNoContexto(contextoTemporal, notaTroca);
  if (aberturaControlada) contextoEfetivo += '\n\n' + NOTA_ABERTURA_CONTROLADA;
  // Canário (19/09/2026): o fecho do convite ("ainda hoje" × "amanhã cedo") vem do relógio, não do
  // modelo — vai junto do contexto temporal, fora do cache, relido a cada volta.
  if (ctx.ficha && !aulaPiloto) contextoEfetivo = `${contextoEfetivo}\n\n${blocoConviteAgenda()}`;
  if (aulaPiloto) contextoEfetivo += contextoAulaPiloto(aulaDaCampanha);
  if (persona === 'aula' && campanha?.origem === 'convite_base') {
    contextoEfetivo += '\n\nORIGEM DA CAMPANHA: convite enviado à base. Receber esse convite não comprova inscrição. Não diga que ele se inscreveu nem pergunte por que se cadastrou sem ele confirmar. Pergunte o que chamou a atenção no tema ou sua relação com a área.';
  }
  let agenteEfetivo: string;

  if (persona === 'recontato') {
    agenteEfetivo = 'agente_recontato';
    promptAgente = renderPrompt(AGENTE_RECONTATO, vars);
    tools = await carregarTools(supabase, 'agente_recontato', provedor);
    const dossie = montarDossieRecontato(lead?.contexto_recontato);
    if (dossie) contextoEfetivo = `${contextoTemporal}\n\n${dossie}`;
    tel.registrar('router_decisao', {
      decidiu: 'agente_recontato',
      efetivo: 'agente_recontato',
      anterior: lead?.agente_atual ?? null,
      persona: 'recontato',
      dossie: dossie ? true : false,
    }, 0);
  } else if (ehCampanha) {
    // ⚠️ NA CAMPANHA DIRETA O ROUTER NÃO DECIDE A ABERTURA (decisão do usuário
    // 2026-07-25). O lead de anúncio SEMPRE entra na COLETA (nome → curso → formação):
    // deixar o router escolher abre a porta pra ele mandar direto pro qualificador —
    // que assume horário já escolhido — e a coleta nunca acontecer, que é justamente o
    // motivo desta persona existir. O router segue consultado só pra PROMOVER ao
    // fechamento, e a promoção só vale DEPOIS que nome E formação já foram coletados.
    // O ratchet continua valendo: promovido a qualificador, não volta pra abertura.
    const coletaFeita = Boolean(
      String(lead?.nome ?? '').trim() && String(lead?.formacao_academica ?? '').trim(),
    );
    let agenteAtual = agenteAnterior === 'agente_qualificador' ? 'agente_qualificador' : 'agente_validacao';
    let decidiu: string = agenteAtual;
    const consultarRouter = agenteAtual !== 'agente_qualificador' && coletaFeita;
    const inicioRouter = Date.now();
    if (consultarRouter) {
      try {
        decidiu = await chamarRouter(limparParaRouter(comNotaParaRouter(await carregarHistorico(supabase, remotejid), notaTroca)), registrarUsoRouter, provedor);
        if (decidiu === 'agente_qualificador') agenteAtual = 'agente_qualificador';
      } catch (e) {
        console.error('[crm-agente-sdr] router (campanha direta) falhou, mantendo a abertura:', e);
      }
    }
    await atualizarLead(supabase, remotejid, { agente_atual: agenteAtual });
    agenteEfetivo = agenteAtual;
    tel.registrar('router_decisao', {
      decidiu,
      efetivo: agenteAtual,
      anterior: lead?.agente_atual ?? null,
      persona,
      coleta_feita: coletaFeita,
      router_consultado: consultarRouter,
      troca_numero: sinalTroca.trocou,
      ratchet_ignorado: agenteAnterior !== (lead?.agente_atual ?? null),
    }, Date.now() - inicioRouter);
    promptAgente = renderPrompt(
      agenteAtual === 'agente_qualificador' ? AGENTE_QUALIFICADOR : AGENTE_CAMPANHA_DIRETA,
      vars,
    );
    tools = await toolsDaVez(agenteAtual, true, provedor);
  } else {
    // Router (em erro, mantém o agente atual — não derruba a conversa).
    let proximo: 'agente_validacao' | 'agente_qualificador';
    const inicioRouter = Date.now();
    let routerFallback = false;
    try {
      proximo = await chamarRouter(limparParaRouter(comNotaParaRouter(await carregarHistorico(supabase, remotejid), notaTroca)), registrarUsoRouter, provedor);
    } catch (e) {
      console.error('[crm-agente-sdr] router falhou, mantendo agente atual:', e);
      routerFallback = true;
      proximo = agenteAnterior === 'agente_qualificador' ? 'agente_qualificador' : 'agente_validacao';
    }
    const agenteAtual = await atualizarAgenteComRatchet(supabase, remotejid, agenteAnterior, proximo);
    agenteEfetivo = agenteAtual;
    tel.registrar('router_decisao', {
      decidiu: proximo,
      efetivo: agenteAtual,
      anterior: lead?.agente_atual ?? null,
      fallback: routerFallback,
      troca_numero: sinalTroca.trocou,
      ratchet_ignorado: agenteAnterior !== (lead?.agente_atual ?? null),
      persona,
    }, Date.now() - inicioRouter);
    // (campanha_direta não cai aqui — tem branch próprio, sem router na abertura)
    // Persona aula: a abertura é o prompt da aula com as tools de `agente_aula` (as mesmas
    // 9 da validação); o fechamento é o qualificador de sempre.
    const abrirComAula = persona === 'aula' && agenteAtual !== 'agente_qualificador';
    promptAgente = renderPrompt(
      agenteAtual === 'agente_qualificador' ? AGENTE_QUALIFICADOR : abrirComAula ? AGENTE_AULA : AGENTE_VALIDACAO,
      vars,
    );
    tools = await carregarTools(supabase, abrirComAula ? 'agente_aula' : agenteAtual, provedor);
  }
  // PRESENTE DA ESCOLA (2026-08-05): conversa que acaba sem reunião leva o convite da
  // biblioteca gratuita junto da despedida. Apensado AQUI, no ponto único onde o prompt
  // já foi renderizado, para valer nas QUATRO personas sem editar o prompts.ts (gerado
  // pela extração do n8n). Régua e link em escolaGratuita.ts.
  // ...MENOS pra quem já está dentro da Escola: aí o bloco vira o aviso de que ela já tem
  // acesso. A RPC casa por telefone canônico (o 9º dígito diverge à vontade entre
  // `leads.whatsapp` e o remotejid) e custa ~6ms, varrendo as linhas DA TAG e não `leads`.
  // Falha de rede aqui NÃO pode calar o agente: no erro, assume "não está na Escola" e o
  // convite volta ao comportamento antigo, que é o lado seguro dessa moeda.
  let estaNaEscola = false;
  try {
    const { data, error } = await supabase.rpc('crm_esta_na_escola', { p_remotejid: remotejid });
    if (error) throw new Error(error.message);
    estaNaEscola = data === true;
  } catch (e) {
    tel.registrar('erro', { onde: 'crm_esta_na_escola' }, undefined, String((e as Error)?.message ?? e));
  }
  promptAgente = comBlocoDaEscola(promptAgente, estaNaEscola);
  // Conversa que veio do CHAT DO SITE: o agente precisa saber que o canal mudou, senão
  // fala como se ainda estivesse lá ("já te mandei pelo whats", dito NO whats).
  promptAgente = comContinuidadeWebchat(promptAgente, lead?.veio_do_webchat_em);
  // Canário (19/09/2026): gancho do "primeiro lote promocional" no lugar da "secretaria", a 2ª
  // abordagem com o nome e o CONVITE DE AGENDA (ganchoLote.ts). Produção segue com o texto antigo.
  if (ctx.ficha && !aulaPiloto) {
    const gancho = comGanchoDoLote(promptAgente, { nome: vars.nome, curso: vars.curso_interesse_original });
    promptAgente = gancho.prompt;
    tel.registrar('gancho_lote', gancho.trocas);
  }
  const renovar = lockRenovar(remotejid);
  // 22/09/2026: candidato local, só no canário OpenAI já selecionado pelo telefone.
  // Consulta o provedor na HORA da saída: fallback para Claude conserva o legado.
  let respostaOperacional = false;
  const fracionamentoAtual = () => respostaOperacional || (ctx.ficha && provedor?.nome === 'openai' && provedor.formato === 'openai')
    ? 'codigo' as const : 'modelo' as const;

  // Tools que pausam a IA por decisão do PRÓPRIO agente (pausa_ia, e o
  // temporizador_proxima_turma, que pausa via RPC). A despedida que acompanha
  // essas tools precisa sair MESMO com o flag de pausa já setado: o recheck de
  // pausa existe pra honrar pausa de ATENDENTE durante a geração, não pra
  // engolir a própria despedida do agente.
  const TOOLS_QUE_PAUSAM = new Set(['pausa_ia', 'temporizador_proxima_turma']);
  // ⚠️ ENCERRAR ≠ PAUSAR. `agendar_retorno` também termina o atendimento (o lead volta
  // perto da formatura / no prazo que pediu) e a despedida vem NA MESMA volta da tool —
  // mas ela NÃO pausa a IA, então o recheck de pausa continua valendo pra ela.
  // Caso Matheus (2026-08-08): o modelo escreveu a mensagem CERTA ("como ainda falta um
  // caminho pra concluir a graduação, no momento não dá pra seguir… vou te procurar mais
  // pra frente") e ela foi ENGOLIDA pelo `continue`, porque só as tools de PAUSA tinham
  // o envio. O lead ficou com "Show, 10h30 então" como última informação e no dia
  // seguinte mandou "Bom dia" esperando a reunião. Medido: 33 de 238 rodadas com
  // agendar_retorno (13,9%) terminaram MUDAS em 30 dias.
  const TOOLS_QUE_ENCERRAM = new Set([...TOOLS_QUE_PAUSAM, 'agendar_retorno']);
  let pausouPorTool = false;
  let encerrouPorTool = false;
  let retornoPorFormatura = false;
  // Guardado como OBJETO (tool + input), não como boolean: quem decide o presente da Escola
  // precisa saber o MOTIVO — "pediu ligação" e "desistiu" encerram a rodada do mesmo jeito
  // e merecem tratamento oposto. Ver mereceOPresente() em escolaGratuita.ts.
  let encerramento: Encerramento | null = null;

  // Quando a tool de pausa vem SEM texto junto, o loop dá mais uma volta pro modelo
  // escrever a despedida — e é EXATAMENTE nessa volta que ele, sem nada a dizer,
  // responde ao SISTEMA ("sem nova mensagem do lead", "*sem resposta necessária*").
  // Proibir sem dar o que fazer não funciona com LLM, então a instrução chega no
  // momento exato, COM a despedida-exemplo. Vai anexada ao contexto temporal (que já
  // muda a cada minuto ⇒ não custa cache) e é EFÊMERA: não é gravada no histórico,
  // então não polui as rodadas seguintes nem vira turno que o modelo reinterprete.
  // ⚠️ A despedida-exemplo daqui carrega o PRESENTE DA ESCOLA (2026-08-05): na telemetria,
  // a esmagadora maioria das pausas vem SEM texto junto, então é NESTA volta que a última
  // mensagem ao lead nasce — sem o convite aqui, o presente simplesmente não sairia.
  // ⚠️ A despedida-exemplo daqui MUDA conforme a pessoa já tenha ou não acesso à Escola:
  // pedir "despeça-se COM o presente" a quem já está dentro é instruir o erro na origem, e
  // aí nenhuma guarda de saída resolve — ela só apagaria o que o modelo acabou de escrever.
  const INSTRUCAO_POS_PAUSA = '[SISTEMA — você acabou de encerrar/pausar este atendimento. '
    + 'NÃO relate isso e NÃO descreva o estado do atendimento.]\n'
    + (estaNaEscola
      ? 'Se você ainda NÃO se despediu nesta conversa, escreva SÓ a despedida curta ao lead, '
        + 'por exemplo: "tranquilo, agradeço sua preferência pelo Grupo PPG e fico à disposição '
        + 'se precisar no futuro."\n'
        + '⛔ Esta pessoa JÁ tem acesso à Escola de Especialização — NÃO ofereça a biblioteca '
        + 'gratuita e NÃO mande o link.\n'
      : 'Se você ainda NÃO se despediu nesta conversa, escreva SÓ a despedida curta ao lead, JÁ COM o '
        + 'presente da Escola (a conversa acabou sem reunião), por exemplo: '
        + '"tranquilo, agradeço sua preferência pelo Grupo PPG e fico à disposição se precisar no futuro. '
        + 'antes de te deixar ir: a ppgvet tem uma biblioteca de conteúdo aberta e totalmente gratuita, '
        + 'com mais de 10 cursos, artigos, e-books, aulas abertas de pós e certificados. '
        + 'é um presente da ppgvet educação pra vc, aproveita: ' + LINK_ESCOLA_GRATUITA + '"\n'
        + 'Se você JÁ mandou o convite da Escola nesta conversa, não repita — mande só a despedida.\n')
    + 'Se a despedida já foi enviada, responda com texto vazio.\n'
    + 'NUNCA escreva frases como "sem nova mensagem do lead", "*sem resposta necessária*", '
    + '"atendimento pausado" ou "nenhuma ação necessária": elas são enviadas ao WhatsApp do lead.';
  // Retorno agendado por FORMATURA: o lead segue interessado e volta a ser elegível quando
  // se formar — a despedida é OUTRA (não é "agradeço a preferência"), e precisa dizer POR QUE
  // não dá agora. Sem isso o lead não entende que a pós exige graduação concluída e, se um
  // horário chegou a ser oferecido, fica esperando a reunião (caso Matheus).
  const INSTRUCAO_POS_RETORNO = '[SISTEMA — você acabou de agendar o retorno deste lead pra perto '
    + 'da formatura dele. NÃO relate isso e NÃO descreva o estado do atendimento.]\n'
    + 'Escreva SÓ a mensagem ao lead, deixando DUAS coisas claras com as suas palavras: '
    + '(1) a pós é lato sensu e a matrícula exige a GRADUAÇÃO CONCLUÍDA, então agora ainda não dá; '
    + '(2) vc vai procurá-lo quando ele estiver terminando o curso.\n'
    + 'Se vc ofereceu ou combinou algum HORÁRIO de reunião nesta conversa, desfaça de forma '
    + 'explícita ("não vou marcar aquele horário que falei") — senão ele fica esperando uma '
    + 'reunião que não vai acontecer.\n'
    + 'Feche com o presente da Escola (a conversa acabou sem reunião), a menos que vc já tenha '
    + 'mandado o convite nesta conversa.\n'
    + 'Nunca mencione a data-limite, "prazo" ou "elegibilidade". Se a mensagem já foi enviada, '
    + 'responda com texto vazio.';
  // ── LEVA SÓ DE REAÇÃO (2026-08-06, caso Peterson) ─────────────────────────
  // O lead reage com 👍 e não escreve nada. O agente acorda, não tem o que dizer
  // e RELATA ao sistema ("nenhuma resposta necessária, o lead apenas reagiu com
  // um emoji") — 35 balões desses em 15 dias, 6 dos 8 últimos com reação como
  // gatilho. Não adianta proibir: LLM não produz vazio de forma confiável, ele
  // PREENCHE. Então a instrução dá um ALVO CURTO pra ele acertar, no momento exato
  // (mesmo padrão da INSTRUCAO_POS_PAUSA — efêmera, anexada ao contexto temporal,
  // fora do prefixo cacheado, nunca gravada no histórico).
  // ⚠️ Reação NÃO é sempre "nada a dizer": quando responde uma PERGUNTA nossa
  // (o caso Peterson era 👍 em "passando só pra confirmar nossa reunião às 17h"),
  // ela é um SIM e o fluxo tem que seguir. Por isso a instrução ramifica.
  // ⚠️ SEM emoji nos exemplos: o prompt do João proíbe emoji fora da confirmação
  // final — sugerir "👍" aqui brigaria com a régua de voz dele.
  const RE_SO_REACAO = /^\[reacao\]/;
  const levaSoReacao = conteudo.trim().length > 0
    && conteudo.split('\n').map((l) => l.trim()).filter(Boolean).every((l) => RE_SO_REACAO.test(l));
  const INSTRUCAO_REACAO = '[SISTEMA — o lead NÃO escreveu nada: ele apenas REAGIU com um emoji '
    + 'à sua última mensagem. Isso é o "ok" dele.]\n'
    + 'Se a sua última mensagem tinha uma PERGUNTA ou pedia confirmação, trate a reação como um SIM '
    + 'e siga o fluxo normalmente (confirme e siga adiante).\n'
    + 'Se NÃO havia pergunta pendente, mande SÓ uma confirmação curtíssima e informal, no seu tom: '
    + '"beleza", "é nois", "combinado", "show", "tmj". No máximo 3 palavras, sem pergunta nova, '
    + 'sem recomeçar assunto e sem repetir o que já foi combinado.\n'
    + 'NUNCA descreva a situação ("o lead apenas reagiu", "nenhuma resposta necessária", '
    + '"sem ação necessária"): esse texto é enviado ao WhatsApp dele.';
  if (levaSoReacao) tel.registrar('leva_so_reacao', { conteudo: conteudo.slice(0, 40) });
  let corrigiuHorario = false; // guarda de horário inventado: re-instrui só 1x
  let corrigiuVazio = false;   // resposta 100% bastidor: pede de novo 1x antes de calar
  let corrigiuSilencio = false; // silêncio explícito com pergunta do lead no ar: pede a fala 1x
  // CONFIRMAÇÃO DE AGENDAMENTO EM CÓDIGO (24/09/2026): a reunião criada por confirmar_agendamento
  // já existe na agenda do monitor — o lead não pode ficar sem data, monitor e link porque a fala
  // do modelo falhou (calou, foi barrada como bastidor ou saiu sem o link). Ver
  // confirmacaoAgendamento.ts para os casos medidos. Respeita pausa de atendente.
  let confirmacaoPendente: ConfirmacaoAgendamento | null = null;
  const enviarConfirmacaoEmCodigo = async (motivo: string): Promise<boolean> => {
    const pendente = confirmacaoPendente;
    confirmacaoPendente = null;
    if (!pendente) return false;
    if (!pausouPorTool && await iaPausada(remotejid)) {
      tel.registrar('envio_abortado_pausa', { onde: 'confirmacao_agendamento', motivo: 'IA pausada durante a geração' });
      return false;
    }
    const textoConfirmacao = textoConfirmacaoAgendamento(pendente);
    tel.registrar('confirmacao_agendamento_em_codigo', { motivo, com_link: Boolean(pendente.link) });
    if (!aberturaControlada) await gravarMensagem(supabase, remotejid, { role: 'assistant', content: textoConfirmacao });
    const enviada = await enviarComAberturaNumero({
      banco: supabase, telefone, interacaoId: tel.rodadaId, texto: humanizarTexto(textoConfirmacao),
      sinal: aberturaControlada && aplicarTroca ? sinalTroca : null,
      registrar: (tipo, dados) => tel.registrar(tipo, dados),
      enviar: (fala, controle) => enviarResposta(ctx, fala, renovar, tel,
        pausouPorTool ? undefined : () => iaPausada(remotejid), undefined,
        aberturaControlada ? 'codigo' : fracionamentoAtual(), controle),
    });
    if (aberturaControlada && enviada.envio.aceitos) {
      await gravarMensagem(supabase, remotejid, { role: 'assistant', content: enviada.texto });
    }
    return true;
  };
  // SILÊNCIO INDEVIDO (21/09/2026, teste do usuário): o lead perguntou "mais cedo?", o modelo consultou
  // a agenda duas vezes e fechou a volta com responder_ao_cliente VAZIO — a conversa travou sem erro
  // nenhum. Silêncio só é resposta válida quando a rodada encerrou por tool (a despedida já saiu) ou
  // quando o lote era só reação. Fora disso, a fala é pedida de novo, uma vez.
  const CORRECAO_SILENCIO =
    '[CORRECAO_INTERNA_AUTO_IGNORE] Você encerrou esta volta SEM mandar mensagem, mas o lead acabou de escrever e ' +
    'está esperando resposta. Silêncio aqui trava a conversa. Responda agora à última mensagem dele, na voz do João, ' +
    'usando os resultados das ferramentas que você já tem nesta conversa (se consultou a agenda, ofereça os horários ' +
    'que ela devolveu; se não há o que ele pediu, diga isso em uma frase e ofereça o mais próximo). ' +
    'Não mencione esta correção ao lead.';

  // ── SILÊNCIO NÃO É RESPOSTA (2026-08-12, medido no harness) ─────────────────
  // Quando a limpeza de saída derruba a mensagem INTEIRA (era só narração), o
  // agente ficava mudo — em 2 de 50 rodadas do cenário Carolina a última fala do
  // lead ficou sem resposta. Calar é melhor que vazar, mas é o pior dos dois
  // resultados aceitáveis: o lead falou e ninguém respondeu. Agora pedimos a
  // mensagem DE NOVO, uma vez, dizendo o que estava errado — mesma mecânica da
  // trava de horário inventado. Se a segunda também vier só de bastidor, aí sim
  // silêncio (a rodada fica no Debug do Agente com `resposta_vazia_reinstruida`).
  const CORRECAO_VAZIO =
    '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada: ela era inteiramente ' +
    'raciocínio/relatório de bastidor, e depois da limpeza não sobrou NADA para o lead ler. ' +
    'O texto barrado foi:\n"""\n%TEXTO%\n"""\n' +
    'Escreva agora a mensagem que o lead vai LER, na voz do João, começando direto na primeira ' +
    'palavra dela. Nada de comentar a conversa, o roteiro, as tentativas de contorno, o que você ' +
    'decidiu ou o que vai fazer; nada de falar do lead na terceira pessoa ("ele", "ela", "o lead") ' +
    '— fale COM a pessoa. Se o certo aqui é se despedir, mande só a despedida. ' +
    'Não mencione esta correção ao lead.';

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
    const [historico, contextoEntregaMateriais, ficha] = await Promise.all([
      carregarHistorico(supabase, remotejid),
      carregarStatusMateriais(supabase, ctx),
      // Relida a cada volta: a tool da volta anterior pode ter preenchido a coleta.
      ctx.ficha ? carregarFicha(supabase, ctx) : Promise.resolve(null),
    ]);
    if (ctx.ficha && rodada === 0) {
      if (ficha) {
        tel.registrar('ficha_atendimento', {
          grupo: ficha.avaliacao.grupo, cadastro: ficha.entrada.cadastro,
          falta: ficha.avaliacao.faltaParaCronograma, libera_cronograma: ficha.avaliacao.liberaCronograma,
          ja_perguntou: ficha.avaliacao.jaPerguntou, coleta: ficha.entrada.jornada.coleta ?? null,
          objecoes: ficha.entrada.jornada.objecoes ?? null, cronograma: ficha.entrada.jornada.cronograma ?? null,
          proximo_passo: ficha.avaliacao.proximoPasso,
        });
        // "Pergunta uma vez" é marcada DEPOIS do envio, pelo texto que saiu (marcarPerguntasDaFicha):
        // a rodada pode ser consumida por uma objeção e a pergunta não acontecer (18/09, 16:52).
      } else {
        // Leitura falhou: a volta segue sem a ficha (e sem a instrução dela). Não é erro da
        // rodada — o lead é respondido do mesmo jeito; fica visível no Debug como estado.
        tel.registrar('ficha_atendimento', { disponivel: false, motivo: 'leitura falhou; a volta seguiu sem a ficha' });
      }
    }
    let messages = sanitizarHistorico(historico);
    // Só na 1ª volta: depois de uma tool o último turno é sempre o tool_result (user).
    if (rodada === 0) {
      const fim = avaliarFimDoHistorico(messages);
      if (fim === 'humano_respondeu') {
        // Um vendedor respondeu o lead dentro da espera do João: a vez já foi atendida.
        tel.registrar('humano_respondeu_antes', { motivo: 'a última fala do histórico é de um atendente' });
        tel.registrar('rodada_fim', { voltas_llm: 0, respondeu: false, motivo: 'humano_respondeu_antes' }, Date.now() - inicioRodada);
        return;
      }
      if (fim === 'entrada_antes_da_ultima_fala') {
        messages = comEntradaPendente(messages, conteudo);
        tel.registrar('entrada_reapresentada', { motivo: 'lead escreveu enquanto a fala anterior da IA era gravada' });
      }
    }
    // Evidência vem das falas carregadas pelo servidor, nunca do motivo da tool.
    ctx.historicoConversa = historico;
    const contextoComMateriais = contextoEfetivo;
    const instrucaoEncerramento = retornoPorFormatura ? INSTRUCAO_POS_RETORNO : INSTRUCAO_POS_PAUSA;
    const inicioLlm = Date.now();
    tel.registrar('llm_inicio', { volta: rodada + 1, provedor: provedor?.nome ?? 'anthropic' });
    const baseFicha = aulaPiloto ? `DADOS COLETADOS (não são um roteiro): ${JSON.stringify(ficha?.entrada ?? {})}` : ficha?.texto;
    const pedidoPrincipal = {
      promptAgente,
      contextoEntregaMateriais,
      // Sem o bloco (leitura falhou), a instrução também fica de fora: ela aponta para ele.
      // Perguntas já feitas + respostas vêm do histórico a cada volta (perguntasRecentes.ts).
      contextoFicha: baseFicha ? [baseFicha, blocoPerguntasRecentes(messages)].filter(Boolean).join('\n\n') : undefined,
      comFicha: Boolean(ficha) || aulaPiloto,
      ...(aulaPiloto ? { instrucaoFicha: INSTRUCAO_AULA_PILOTO } : {}),
      // Encerramento vence reação: a despedida é o que importa nessa volta.
      contextoTemporal: encerrouPorTool
        ? `${contextoComMateriais}\n\n${instrucaoEncerramento}`
        : levaSoReacao
          ? `${contextoComMateriais}\n\n${INSTRUCAO_REACAO}`
          : contextoComMateriais,
      messages,
      // A ação terminal já concluiu: esta volta só pode redigir a resposta.
      // Não permitir pausar/arquivar/agendar outra vez para tentar escrever o adeus.
      // Piloto: falta confirmação do lead ou a matriz já falhou ⇒ esta volta
      // só redige a pergunta/resposta; não repete cinco consultas sem saldo.
      tools: encerrouPorTool || (ctx.ficha && (ctx.compatibilidadeIndisponivel || ctx.perguntaFormacaoPendente)) ? [] : tools,
    };
    let resp: any;
    try {
      resp = await chamarAgentePrincipal({ ...pedidoPrincipal, provedor });
    } catch (e) {
      // Provedor alternativo fora do ar (ou recusando o pedido) NÃO pode calar o João: a volta
      // é refeita no Claude e o resto da rodada fica nele. As tools são as mesmas — a tabela
      // da OpenAI já guarda o texto efetivo, no mesmo contrato interno.
      if (!provedor && !ctx.ficha) throw e;
      // O motivo vai em `dados`, não em `erro`: a rodada foi RECUPERADA, e erro preenchido a
      // pintaria de vermelho na tela de Debug mesmo com o lead respondido.
      try {
        if (!provedor) throw e;
        tel.registrar('provedor_ia_fallback', { de: provedor.nome, para: 'anthropic', volta: rodada + 1, motivo: String((e as Error)?.message ?? e).slice(0, 500) });
        provedor = null;
        resp = await chamarAgentePrincipal({ ...pedidoPrincipal, provedor: null,
          ...(ctx.ficha ? { prazoModeloMs: PRAZO_MODELO_PILOTO_MS } : {}) });
      } catch (falhaReserva) {
        if (!ctx.ficha) throw falhaReserva;
        // A reserva também pode estar indisponível (ex.: sem saldo). Uma frase
        // operacional segue as guardas normais de pausa/aceite, sem outra IA,
        // sem áudio e sem afirmar que tools ou agendamento deram certo.
        provedor = null;
        respostaOperacional = true;
        tel.registrar('modelo_indisponivel', { volta: rodada + 1, resposta_operacional: true });
        resp = { content: [{ type: 'text', text: RESPOSTA_MODELO_INDISPONIVEL }], stop_reason: 'end_turn',
          origem: 'indisponibilidade_modelo', usage: { input_tokens: 0, output_tokens: 0 } };
      }
    }
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
      provedor: provedor?.nome ?? 'anthropic',
      agente: agenteEfetivo,
      modelo: resp.model ?? null,
      raciocinio_encadeado: resp.raciocinio_encadeado === true,
      raciocinios_reenviados: resp.raciocinios_reenviados ?? 0,
      stop_reason: resp.stop_reason ?? null,
      canal_resposta: resp.canal_resposta ?? null,
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
    // Silêncio explícito ou canal bloqueado não gera assistant vazio no histórico
    // (além de não ter sido enviado, content: [] é inválido no próximo replay).
    if (blocosResp.length && (!registrarFalaAposEnvio || blocosResp.some((b) => b.type === 'tool_use'))) {
      await gravarMensagem(supabase, remotejid, { role: 'assistant', content: semRaciocinioNoTexto(resp.content) });
    }

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
        if (tu.name === 'confirmar_agendamento') confirmacaoPendente = confirmacaoDoResultado(output) ?? confirmacaoPendente;
        outputs.push(output);
      }
      await gravarMensagem(supabase, remotejid, { role: 'user', content: montarToolResults(outputs) });
      // Uma tentativa bloqueada não pausou nem encerrou. Também não pode enviar
      // a despedida gerada junto da inferência: a próxima volta recebe a recusa.
      const toolsConcluidas = toolUses.filter((_: any, i: number) => toolConcluida(outputs[i]));
      if (toolsConcluidas.some((tu: any) => TOOLS_QUE_ENCERRAM.has(tu.name))) {
        encerrouPorTool = true;
        if (toolsConcluidas.some((tu: any) => TOOLS_QUE_PAUSAM.has(tu.name))) pausouPorTool = true;
        retornoPorFormatura = toolsConcluidas.some(
          (tu: any) => tu.name === 'agendar_retorno' && tu.input?.tipo === 'formatura',
        );
        const tuFim = toolsConcluidas.find((tu: any) => TOOLS_QUE_ENCERRAM.has(tu.name));
        if (tuFim) encerramento = { tool: tuFim.name, input: (tuFim.input ?? {}) as Record<string, unknown> };
        if (outputs.some((output) => !toolConcluida(output))) continue;
        // 14/09/2026, Adriana: o text junto de pausa_ia era análise livre, e o
        // filtro retirava só algumas frases. Texto de tool_use NUNCA é resposta.
        // Encerramentos conhecidos têm despedida determinística, preservando o
        // adeus mesmo se o modelo escreveu só bastidor ou nenhum texto.
        const despedida = respostaDoEncerramento(encerramento);
        if (despedida) {
          const comPresente = comPresenteNaDespedida(despedida, encerramento, conversaTexto(messages), estaNaEscola);
          if (comPresente.anexou) tel.registrar('presente_escola_anexado', { onde: 'despedida_com_tool' });
          tel.registrar('despedida_deterministica', { tool: encerramento?.tool });
          if (!aberturaControlada) await gravarMensagem(supabase, remotejid, { role: 'assistant', content: comPresente.texto });
          const despedidaEnviada = await enviarComAberturaNumero({
            banco: supabase, telefone, interacaoId: tel.rodadaId, texto: humanizarTexto(comPresente.texto),
            sinal: aberturaControlada && aplicarTroca ? sinalTroca : null,
            registrar: (tipo, dados) => tel.registrar(tipo, dados),
            enviar: (fala, controle) => enviarResposta(ctx, fala, renovar, tel,
              pausouPorTool ? undefined : () => iaPausada(remotejid), undefined,
              aberturaControlada ? 'codigo' : fracionamentoAtual(), controle),
          });
          if (aberturaControlada && despedidaEnviada.envio.aceitos) {
            await gravarMensagem(supabase, remotejid, { role: 'assistant', content: despedidaEnviada.texto });
          }
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
    // Reunião criada e o modelo calado ou barrado (19 e 21/09): a confirmação sai em código,
    // sem gastar outra volta pedindo a fala.
    if (!texto && confirmacaoPendente) {
      const enviou = await enviarConfirmacaoEmCodigo('silencio_apos_agendamento');
      tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: enviou }, Date.now() - inicioRodada);
      return;
    }
    if (!texto && !encerrouPorTool && !levaSoReacao && !corrigiuSilencio) {
      corrigiuSilencio = true;
      tel.registrar('silencio_indevido_reinstruido', { canal: resp.canal_resposta ?? null, volta: rodada + 1 });
      await gravarMensagem(supabase, remotejid, { role: 'user', content: CORRECAO_SILENCIO });
      continue;
    }
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
        // ⚠️ A correção é CIRÚRGICA: só o horário está errado, o resto da mensagem
        // não (caso Carolina 2026-08-12). A lead objetou preço, o modelo respondeu
        // com a quebra certa ("é justamente isso que a condição especial resolve")
        // e fechou com "mais cedo ou mais perto das 19h?" — o 19h caiu aqui, a
        // mensagem inteira foi descartada, e como a reinstrução só falava de
        // horário o modelo reescreveu SÓ a logística: "consigo hoje às 17h, 17h30
        // ou 19h. qual fica melhor?". A quebra de objeção evaporou junto com o
        // rascunho e a lead levou um balão robótico em cima de uma dor de dinheiro.
        // Por isso o texto barrado volta no corpo da correção, com ordem explícita
        // de preservar o conteúdo e trocar SÓ os horários.
        await gravarMensagem(supabase, remotejid, {
          role: 'user',
          content: '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada ao lead: ela oferece horário(s) ' +
            `(${inventados.join(', ')}) que não vieram de consulta_disponibilidade nesta conversa — é proibido inventar ` +
            'horário (Regra de ouro nº 2). O texto barrado foi:\n' +
            `"""\n${resumir(texto, 600)}\n"""\n` +
            'Refaça agora PRESERVANDO todo o conteúdo dele que não é horário — em especial a quebra de objeção, o ' +
            'acolhimento e o argumento que você já tinha construído. A ÚNICA coisa que muda são os horários: rode ' +
            'consulta_disponibilidade e ofereça SÓ o que ela devolver, ou repita a mesma mensagem sem citar horário ' +
            'específico. Não corte a mensagem pra "só perguntar o horário", e não mencione esta correção ao lead.',
        });
        continue;
      }
      if (inventados.length) {
        tel.registrar('horario_inventado', { horarios: inventados, acao: 'descartado', texto: resumir(texto, 600) });
        const enviou = await enviarConfirmacaoEmCodigo('fala_descartada_apos_agendamento');
        tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: enviou }, Date.now() - inicioRodada);
        return;
      }
      // Resposta que só existia como bastidor: pede de novo em vez de calar.
      if (!humanizarTexto(texto) && !corrigiuVazio) {
        corrigiuVazio = true;
        tel.registrar('resposta_vazia_reinstruida', { onde: 'resposta', texto: resumir(texto, 600) });
        await gravarMensagem(supabase, remotejid, {
          role: 'user',
          content: CORRECAO_VAZIO.replace('%TEXTO%', resumir(texto, 600)),
        });
        continue;
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
        // É AQUI que a maioria das despedidas nasce: a esmagadora maioria das pausas vem
        // sem texto junto, então o loop dá mais uma volta só pra escrever o adeus.
        const comPresente = comPresenteNaDespedida(texto, encerramento, conversaTexto(messages), estaNaEscola);
        if (comPresente.anexou) tel.registrar('presente_escola_anexado', { onde: 'despedida_pos_pausa' });
        // Quem PEDE o link da Escola recebe o link (caso Leandro, 2026-09-11): o bloco de
        // quem já está dentro proibia mandar, e o modelo respondia "continua ativo" sem o
        // endereço. O prompt abriu a exceção; aqui é a garantia. Só acrescenta.
        const comLink = comLinkPedido(
          comPresente.texto, conteudo, estaNaEscola || jaTemOPresente(conversaTexto(messages)),
        );
        if (comLink.anexou) tel.registrar('link_escola_reenviado', { pedido: resumir(conteudo, 200) });
        const { envio, texto: textoEnviado } = await enviarComAberturaNumero({
          banco: supabase, telefone, interacaoId: tel.rodadaId, texto: humanizarTexto(comLink.texto),
          sinal: aberturaControlada && aplicarTroca ? sinalTroca : null,
          registrar: (tipo, dados) => tel.registrar(tipo, dados),
          enviar: (fala, controle) => enviarResposta(ctx, fala, renovar, tel, pausouPorTool ? undefined : () => iaPausada(remotejid),
          encerrouPorTool ? undefined : {
            supabase, origem: 'conversa', historico, iniciadaEm: inicioRodada,
            provedorResposta: provedor?.nome === 'openai' && provedor.formato === 'openai' ? 'openai' : 'anthropic',
            interacaoId: tel.rodadaId,
            referenciaMensagemId: doUltimoCom('msg_id') ?? undefined,
            interrompido: () => iaPausada(remotejid),
          }, aberturaControlada ? 'codigo' : fracionamentoAtual(), controle),
        });
        if (registrarFalaAposEnvio && envio?.aceitos) {
          await gravarMensagem(supabase, remotejid, { role: 'assistant', content: textoEnviado });
        }
        if (registrarFalaAposEnvio && !envio?.aceitos) {
          tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: false, motivo: envio?.estado ?? 'envio_sem_aceite' }, Date.now() - inicioRodada);
          return;
        }
        // A fala saiu, mas sem o link ("show", "fechado então, terça às 19h" — 10 de 206 em 14 dias):
        // a confirmação completa vai logo depois, em código.
        if (confirmacaoPendente && !falaEntregaConfirmacao(textoEnviado ?? comLink.texto, confirmacaoPendente)) {
          await enviarConfirmacaoEmCodigo('fala_sem_link');
        }
        confirmacaoPendente = null;
        // Ficha: o que o João acabou de perguntar vira estado — "pergunta uma vez" da coleta e a
        // pergunta da pós só contam quando a pergunta saiu de fato no texto enviado.
        if (ctx.ficha && ficha) {
          try {
            const marcas = await marcarPerguntasDaFicha(supabase, telefone, ficha, comLink.texto);
            if (marcas.length) tel.registrar('ficha_pergunta_feita', { marcas });
          } catch (e) {
            console.error('[crm-agente-sdr] jornada (perguntas):', (e as Error)?.message ?? e);
          }
        }
      }
    }
    tel.registrar('rodada_fim', { voltas_llm: rodada + 1, respondeu: Boolean(texto) }, Date.now() - inicioRodada);
    return;
  }
  await enviarConfirmacaoEmCodigo('limite_de_voltas');
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
      // 16/09/2026: telefone da allowlist de teste (crm_agente_sdr_config.teste_telefones) roda
      // SEM debounce, para o harness real não esperar 45 s por turno. Produção segue o config.
      // 18/09/2026: o canário da Luna tem o debounce DELE (vence a regra do telefone de teste).
      const delaySegundos = (await delayDoCanarioLuna(remotejid.replace(/\D/g, '')))
        ?? ((await permitidoNoTeste(remotejid.replace(/\D/g, ''))) ? 0 : await carregarDelaySegundos());
      const renovar = lockRenovar(remotejid);
      // Drena até esvaziar: cada lote espera o silêncio do debounce antes de
      // processar; mensagens que chegarem durante a rodada entram na próxima.
      while (true) {
        const esperouMs = await aguardarSilencio(remotejid, delaySegundos, renovar);
        const audio = await aguardarAudiosDoHistorico({
          contar: () => contarAudiosPendentes(supabase, remotejid),
          pausada: () => iaPausada(remotejid),
          renovar,
        });
        if (audio.pendentes || audio.esperouMs >= 2000) {
          telPrep.registrar('sincronizacao_audio', { estado: audio.estado, pendentes: audio.pendentes }, audio.esperouMs);
        }
        // Sem apagar o lote: ao liberar o lock, a drenagem de órfãos pode retomá-lo.
        if (audio.estado === 'aguardando') break;
        // Entradas novas durante a transcrição também precisam do debounce.
        if (audio.estado === 'pronto' && audio.esperouMs >= 2000) {
          await aguardarSilencio(remotejid, delaySegundos, renovar);
        }
        const itens = await bufferDrenar(remotejid);
        if (!itens.length) break;
        // Pausou durante o debounce (45s)? Não gera nem responde esta leva — o lead
        // fica registrado no histórico mas a IA não fala (defesa em profundidade barata).
        if (audio.estado === 'pausado' || await iaPausada(remotejid)) {
          await persistirEntradasDoLote(supabase, remotejid, itens, true);
          criarTelemetria(supabase, remotejid).registrar('envio_abortado_pausa', {
            onde: 'pos_debounce', mensagens_preservadas: itens.length,
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
    // Uma falha ao baixar/transcrever pode ocorrer depois de o vendedor pausar.
    // Preserva a origem (áudio pendente entra na fila) sem chamar o modelo novamente.
    try {
      if (await iaPausada(remotejid)) {
        await registrarEntrada(supabase, remotejid, { msg_id: payload.id }, { pausaObservada: true });
      }
    } catch { console.error('[crm-agente-sdr] não foi possível preservar entrada durante pausa'); }
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
  // Persona do assistente pedagógico (Suporte ao Aluno): quem atende é o crm-agente-aluno.
  // Sem esta tranca, a persona que o SDR não conhece cairia no 'qualificador' mais abaixo e o
  // João venderia pós para quem já é aluno. O webhook já desvia; isto é a segunda tranca.
  if (payload?.agente_ia_persona === 'aluno') return json({ ok: true, skip: 'persona_de_outro_agente' });
  // A persona do payload só existe no relay do webhook, que já desvia. O reconciliador reinjeta
  // SEM ela (só com o wa_account_id), e é aí que o João responderia pela 3250 ou pela linha do
  // RH se a allowlist dele (20260911233300) não estiver aplicada. Então quem manda é a persona
  // gravada na CONTA. Leitura que falha não barra (a conta fica sem persona): o João não para.
  if (PERSONAS_DE_OUTRO_AGENTE.has((await personaDaConta(supabase, payload?.wa_account_id)) ?? '')) {
    return json({ ok: true, skip: 'persona_de_outro_agente' });
  }
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
  // O CRM captura a chegada durante pausa; esta conferência cobre a pausa aplicada
  // entre a persistência no webhook e o relay. Também barra replay após despausar.
  // Campanha direta pode ainda criar o lead abaixo. Não rejeitar sua primeira
  // mensagem só porque o CRM existe antes do cadastro SDR.
  if (lead) {
    try {
      const memoria = await registrarEntrada(supabase, payload.remotejid, { msg_id: payload.id }, {
        pausaObservada: pausaVigente(lead),
      });
      if (memoria.estado === 'contato_invalido') return json({ ok: true, skip: 'origem_contato_invalido' });
      if (memoria.estado === 'pausa') return json({ ok: true, skip: 'mensagem_recebida_em_pausa' });
      if (memoria.remotejid) payload.remotejid = memoria.remotejid;
    } catch {
      return json({ error: 'historico_entrada_indisponivel' }, 503);
    }
  }
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
  if (pausaVigente(lead)) return json({ ok: true, skip: 'pausa_ia' });

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
