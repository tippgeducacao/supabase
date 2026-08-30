// crm-agente-rh — o agente de RH e Contratação da PPG.
//
// Recebe o relay do crm-whatsapp-webhook (mesmo payload que o João recebe), conversa com o
// candidato pelo número Administrativo PPG, coleta seis informações e grava nos campos do
// card. Quem move o card na esteira é a rh_funil_tick(); este aqui só conversa.
//
// SEPARADO DO JOÃO DE PROPÓSITO (decisão do Rafael, 2026-08-28): não importa uma linha de
// crm-agente-sdr, tem prompt, telemetria e trava próprios. Mexer aqui nunca pode arriscar o
// agente que fala com lead de venda o dia inteiro.
//
// OS QUATRO GATES, nesta ordem — o primeiro que falhar encerra e deixa rastro:
//   1. NÚMERO  — só o Administrativo PPG.
//   2. ORIGEM  — só quem entrou pela página de vagas (tem o campo da área preenchido).
//   3. ETAPA   — só as etapas da esteira e a Triagem. Entrevista em diante é humano.
//   4. JANELA  — só respondendo a quem escreveu. O agente NUNCA inicia conversa.
//
// Responde 200 na hora e processa em background: o relay do gateway desiste em 10s.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';
import { PROMPT_RH } from './prompt.ts';

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// A chave vem do env quando existe. ⚠️ `ANTHROPIC_API_KEY` do container está INVÁLIDA
// (401 em 29/08) — quem funciona é a do agente do João. E há uma chave boa guardada em
// `ai_api_keys`, que é o fallback: sem ele, trocar a chave exigiria redeploy.
let ANTHROPIC_KEY = Deno.env.get('AGENTE_RH_ANTHROPIC_KEY')
  ?? Deno.env.get('AGENTE_SDR_ANTHROPIC_KEY')
  ?? Deno.env.get('ANTHROPIC_API_KEY')
  ?? '';

async function chaveDoBanco(): Promise<string> {
  const { data } = await supabase
    .from('ai_api_keys').select('api_key')
    .eq('provider', 'anthropic').eq('is_active', true)
    .limit(1).maybeSingle();
  return (data?.api_key ?? '').trim();
}
const SEND_URL = `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`;

// ⚠️ Sonnet 5 recusa temperature≠default e budget_tokens (400). Nada de sampling aqui.
const MODELO = Deno.env.get('AGENTE_RH_MODEL') ?? 'claude-sonnet-5';

const CONTA_RH = Deno.env.get('AGENTE_RH_WA_ACCOUNT_ID') ?? '31d9a4ff-9606-4018-a2fb-ffb0155e099b';
const FUNIL_RH = '27ab7e60-7cbc-432a-b852-52597bf277b4';
const ETAPAS_PERMITIDAS = [
  'Inscrição Recebida', 'Contato 02', 'Contato 03', 'Contato 04',
  'Contato 05', 'Contato 06', 'Contato 07', 'Triagem Candidato',
];

const BUFFER_MS = 6000;        // quem manda 3 balões seguidos recebe UMA resposta
const LOCK_TTL_SEGUNDOS = 90;
const JANELA_HORAS = 24;
const MAX_HISTORICO = 40;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

const so8 = (t: string) => (t ?? '').replace(/\D/g, '').slice(-8);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evento(tipo: string, dados: Record<string, unknown> = {}) {
  try {
    await supabase.from('rh_agente_eventos').insert({
      telefone: (dados.telefone as string) ?? null,
      lead_id: (dados.lead_id as string) ?? null,
      oportunidade_id: (dados.oportunidade_id as string) ?? null,
      tipo,
      detalhe: dados,
    });
  } catch (e) {
    console.error('[crm-agente-rh] telemetria falhou:', e instanceof Error ? e.message : String(e));
  }
}

// ── Raciocínio nunca chega ao candidato ────────────────────────────────────
// Lição do agente do João: às vezes o modelo SIMULA o raciocínio dentro do bloco de
// texto, embrulhado em <thinking>. Instrução no prompt não resolve sempre; esta régua
// determinística resolve. Fica no funil por onde todo balão passa.
const TAGS = '(?:antml:)?(?:thinking|thought|thoughts|scratchpad|reasoning|reflection)';
export function limparResposta(texto: string): string {
  let t = texto ?? '';
  t = t.replace(new RegExp(`<${TAGS}[^>]*>[\\s\\S]*?</${TAGS}>`, 'gi'), '');
  t = t.replace(new RegExp(`</?${TAGS}[^>]*>`, 'gi'), '');
  return t.trim();
}

// ── Anthropic com retry ────────────────────────────────────────────────────
async function chamarClaude(body: Record<string, unknown>): Promise<any> {
  let ultimo = '';
  let tentouBanco = false;
  for (let i = 1; i <= 4; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return await res.json();
    ultimo = `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`;
    // Chave do env inválida: busca a do banco UMA vez e repete. É o caso real de 29/08.
    if (res.status === 401 && !tentouBanco) {
      tentouBanco = true;
      const doBanco = await chaveDoBanco();
      if (doBanco && doBanco !== ANTHROPIC_KEY) { ANTHROPIC_KEY = doBanco; continue; }
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    if (i < 4) await dormir(2500);
  }
  throw new Error(`Anthropic: ${ultimo}`);
}

// A tool existe para o modelo ENTREGAR dado estruturado, não para decidir nada. Todos os
// campos são opcionais: ele grava o que já conseguiu, quando conseguiu, sem esperar o fim.
const TOOL_DADOS = {
  name: 'salvar_dados_candidato',
  description:
    'Grava no cadastro do candidato o que você já apurou nesta conversa. Chame sempre que ' +
    'descobrir uma informação nova, mesmo que ainda falte o resto. Nunca invente: só preencha ' +
    'o que a pessoa disse de verdade.',
  input_schema: {
    type: 'object',
    properties: {
      cidade: { type: 'string', description: 'Cidade onde a pessoa mora hoje.' },
      conhece_alguem: { type: 'string', description: 'Quem ela conhece que trabalha ou trabalhou na PPG. "não" se não conhece.' },
      habilidades: { type: 'string', description: 'As 3 principais habilidades, separadas por vírgula.' },
      mudanca: { type: 'string', description: 'Só quando mora fora de Ampére: se teria disponibilidade de mudança.' },
    },
    additionalProperties: false,
  },
} as const;

// Contrapeso do `ignorar_nao_perturbe`: o funil de RH deixa de honrar o "não perturbe"
// COMERCIAL, então o candidato precisa de um jeito de mandar parar que valha de verdade.
// Isto escreve em `crm_bloqueio_whatsapp`, que barra TODOS os motores, RH incluído.
const TOOL_PARAR = {
  name: 'encerrar_contato',
  description:
    'Use quando a pessoa pedir para não ser mais procurada, disser que não tem interesse na ' +
    'vaga ou mandar parar de mandar mensagem. Não use por desânimo passageiro nem por demora ' +
    'em responder: só quando ela pedir de forma clara.',
  input_schema: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'O que ela disse, nas palavras dela.' },
    },
    required: ['motivo'],
    additionalProperties: false,
  },
} as const;

async function bloquearContato(telefone: string, leadId: string, opId: string, motivo: string) {
  // A canonização do telefone fica no BANCO (fn_canon_ddd8). Calcular aqui grava um `canon`
  // que a guarda não reconhece: o bloqueio existiria na tabela e não barraria nada.
  const { data: ok } = await supabase
    .rpc('rh_agente_bloquear_contato', { p_telefone: telefone, p_motivo: motivo ?? '' });
  await evento('contato_encerrado', { telefone, lead_id: leadId, oportunidade_id: opId, motivo, ok });
}

// Confere se um nome citado pelo candidato é de alguém da equipe HOJE.
// ⚠️ A RPC devolve BOOLEAN e nada mais — fin_colaboradores tem salário, vale e PIX, e o
// agente não pode falar o que nunca recebeu. Também não distingue "nunca trabalhou" de
// "já saiu": as duas voltam false, porque contar que fulano é ex-colaborador é informação
// sobre um terceiro que não autorizou nada.
const TOOL_COLABORADOR = {
  name: 'conferir_colaborador',
  description:
    'Use quando o candidato citar o nome de alguém que trabalharia na PPG. Responde apenas ' +
    'se existe alguém com esse nome na equipe HOJE. Não traz cargo, setor, salário nem ' +
    'contato — essa informação não existe para você.',
  input_schema: {
    type: 'object',
    properties: { nome: { type: 'string', description: 'O nome como o candidato escreveu.' } },
    required: ['nome'],
    additionalProperties: false,
  },
} as const;

const CAMPO_POR_CHAVE: Record<string, string> = {
  cidade: '_rh_cidade',
  conhece_alguem: '_rh_conhece_alguem',
  habilidades: '_rh_habilidades',
  mudanca: '_rh_mudanca',
};

async function gravarDados(leadId: string, dados: Record<string, string>): Promise<string[]> {
  const gravados: string[] = [];
  for (const [chave, alias] of Object.entries(CAMPO_POR_CHAVE)) {
    const valor = (dados?.[chave] ?? '').toString().trim();
    if (!valor) continue;
    const { data: campo } = await supabase
      .from('crm_campos').select('id').eq('alias', alias).maybeSingle();
    if (!campo?.id) continue;

    const { data: existente } = await supabase
      .from('crm_campo_valores').select('id')
      .eq('lead_id', leadId).eq('campo_id', campo.id).maybeSingle();

    if (existente?.id) {
      await supabase.from('crm_campo_valores')
        .update({ value_text: valor, updated_at: new Date().toISOString() }).eq('id', existente.id);
    } else {
      await supabase.from('crm_campo_valores')
        .insert({ lead_id: leadId, campo_id: campo.id, value_text: valor });
    }
    gravados.push(alias);
  }
  return gravados;
}

async function enviar(telefone: string, texto: string, leadId: string | null, opId: string | null) {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone, tipo: 'text', conteudo: texto,
      wa_account_id: CONTA_RH, lead_id: leadId, oportunidade_id: opId,
    }),
  });
  if (!res.ok) throw new Error(`crm-whatsapp-send HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function processar(payload: any) {
  const telefone: string = payload?.telefone ?? '';
  const msgId: string = payload?.id ?? '';
  const fone8 = so8(telefone);
  if (!fone8) return;

  // GATE 1 já passou no handler (número). Idempotência antes de qualquer coisa cara.
  const { error: errDup } = await supabase
    .from('rh_agente_processadas').insert({ wa_message_id: msgId, telefone });
  if (errDup) { await evento('pulado:duplicada', { telefone, msgId }); return; }

  await evento('recebido', { telefone, msgId, conteudo: String(payload?.conteudo ?? '').slice(0, 200) });

  const { data: pegou } = await supabase.rpc('rh_agente_lock_claim', {
    p_telefone: fone8, p_ttl_segundos: LOCK_TTL_SEGUNDOS,
  });
  if (!pegou) { await evento('pulado:lock', { telefone }); return; }

  const ehFollowup = payload?.motivo === 'followup';

  try {
    // Buffer: dá tempo de a pessoa terminar de escrever antes de responder.
    // Na cutucada não existe ninguém digitando do outro lado, então não espera.
    if (!ehFollowup) await dormir(BUFFER_MS);

    // ── Lead, card e etapa, em três consultas simples ────────────────────
    // Sem embed do PostgREST de propósito: join por nome de relacionamento quebra calado
    // se a FK for renomeada, e aqui "quebrar calado" significa o candidato sem resposta.
    // A busca do card mora no BANCO (rh_agente_card_por_telefone), não aqui.
    // Duas razões, as duas descobertas em produção:
    //   • o MESMO telefone tem dezenas de leads duplicados e só um tem card no RH;
    //   • `leads.whatsapp` guarda o número FORMATADO ("46 99932-1082"), então filtrar por
    //     `ilike '%<8 dígitos>'` no cliente deixava de fora justamente o dono do card.
    // No SQL a comparação é por dígitos, que é a régua canônica do resto do sistema.
    const { data: achado } = await supabase
      .rpc('rh_agente_card_por_telefone', { p_telefone: telefone });
    const card = Array.isArray(achado) ? achado[0] : achado;
    if (!card?.oportunidade_id) { await evento('pulado:sem_card', { telefone }); return; }

    const leadId = card.lead_id as string;
    const lead = { nome: card.lead_nome as string | null };
    const etapa = (card.etapa_nome as string) ?? '';

    // GATE 3 — etapa.
    if (!ETAPAS_PERMITIDAS.includes(etapa)) {
      await evento('pulado:etapa', { telefone, lead_id: leadId, oportunidade_id: card.oportunidade_id, etapa });
      return;
    }

    // GATE 2 — origem: só quem veio da página de vagas tem o campo da área.
    const { data: campoArea } = await supabase
      .from('crm_campos').select('id').eq('alias', '_contratacao_em_qual_area').maybeSingle();
    // Sem o campo cadastrado não dá para afirmar a origem de ninguém. Falha FECHADO:
    // é melhor o agente calar do que conversar com quem não é candidato. (E `.eq` com
    // string vazia estouraria na hora, por uuid inválido.)
    if (!campoArea?.id) {
      await evento('pulado:sem_campo_area', { telefone, lead_id: leadId, oportunidade_id: card.oportunidade_id });
      return;
    }
    const { data: temArea } = await supabase
      .from('crm_campo_valores').select('id')
      .eq('lead_id', leadId).eq('campo_id', campoArea.id).maybeSingle();
    if (!temArea) {
      await evento('pulado:origem', { telefone, lead_id: leadId, oportunidade_id: card.oportunidade_id });
      return;
    }

    // ── Histórico da conversa NESTE número ───────────────────────────────
    // ⚠️ O filtro por TELEFONE é obrigatório aqui. Sem ele, o agente enxerga a conversa de
    // todos os candidatos daquele número e responde com o contexto da pessoa errada.
    // O ilike casa os últimos 8 dígitos, que é a régua de telefone do resto do sistema
    // (imune ao 9º dígito, ao DDI e à formatação).
    const { data: msgs } = await supabase
      .from('crm_whatsapp_messages')
      .select('direcao, conteudo, created_at, telefone')
      .eq('wa_account_id', CONTA_RH)
      .ilike('telefone', `%${fone8}`)
      .order('created_at', { ascending: false })
      .limit(120);

    const conversa = (msgs ?? [])
      .filter((m: any) => (m.conteudo ?? '').trim() && so8(m.telefone) === fone8)
      .reverse()
      .slice(-MAX_HISTORICO);

    // GATE 4 — janela: só respondemos quem escreveu nas últimas 24h.
    const ultimoInbound = [...conversa].reverse().find((m: any) => m.direcao === 'inbound');
    const idadeH = ultimoInbound
      ? (Date.now() - new Date(ultimoInbound.created_at).getTime()) / 3_600_000
      : Infinity;
    if (idadeH > JANELA_HORAS) {
      await evento('pulado:janela', { telefone, lead_id: leadId, oportunidade_id: card.oportunidade_id, idadeH });
      return;
    }

    const messages = conversa.map((m: any) => ({
      role: m.direcao === 'inbound' ? 'user' : 'assistant',
      content: String(m.conteudo).slice(0, 4000),
    }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      messages.push({ role: 'user', content: String(payload?.conteudo ?? '').slice(0, 4000) });
    }

    // ── Claude ───────────────────────────────────────────────────────────
    const contexto =
      `\n\nCONTEXTO DESTE CANDIDATO (não repita de volta para ele, use para conversar):\n` +
      `- Nome no cadastro: ${lead.nome ?? 'não informado'}\n` +
      `- Área que ele escolheu na página: ${card.titulo ?? 'não informada'}\n` +
      `- Etapa atual: ${etapa}` +
      (ehFollowup
        ? `\n\nATENÇÃO: esta mensagem é uma RETOMADA, não uma resposta. A pessoa parou de ` +
          `responder no meio da conversa e ninguém escreveu nada novo. Mande UMA mensagem ` +
          `curta, leve e sem cobrança, retomando exatamente de onde parou — cite o que ` +
          `faltava, se faltava algo. Nada de "você está aí?" nem de repetir o que já foi dito. ` +
          `Se a conversa já tinha terminado bem, com tudo coletado, responda apenas a palavra ` +
          `PULAR e mais nada.`
        : '');

    let resposta = '';
    let textoAntesDaFerramenta = '';
    let dadosGravados: string[] = [];
    let rodada = 0;
    const historico: any[] = [...messages];

    while (rodada < 4) {
      rodada++;
      const r = await chamarClaude({
        model: MODELO,
        max_tokens: 1024,
        thinking: { type: 'disabled' },
        system: [{ type: 'text', text: PROMPT_RH + contexto, cache_control: { type: 'ephemeral' } }],
        messages: historico,
        tools: [TOOL_DADOS, TOOL_PARAR, TOOL_COLABORADOR],
      });

      const blocos = r?.content ?? [];
      const texto = blocos.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      const usos = blocos.filter((b: any) => b.type === 'tool_use');

      if (usos.length) {
        // ⚠️ SÓ os blocos de ferramenta entram no histórico — nunca o texto que veio
        // junto deles. Esse texto AINDA NÃO foi enviado ao candidato; deixá-lo aqui
        // faz o modelo acreditar que já falou, e a rodada seguinte vira um retoque do
        // que ele acha que disse: "Fico no aguardo da sua resposta sobre a mudança"
        // sem nunca ter perguntado, "Fico aguardando o currículo" sem nunca ter
        // pedido, "Qualquer outra dúvida é só falar" em cima de uma pergunta direta
        // do candidato. Nos três casos a mensagem BOA era justamente a que estava
        // aqui e foi descartada (Luciano e Carlize, 30/08/2026).
        historico.push({ role: 'assistant', content: usos });
        const results: any[] = [];
        for (const u of usos) {
          if (u.name === 'conferir_colaborador') {
            const { data: eh } = await supabase
              .rpc('rh_agente_conhece_colaborador', { p_nome: u.input?.nome ?? '' });
            results.push({
              type: 'tool_result', tool_use_id: u.id,
              content: eh === true
                ? 'sim, está na equipe hoje'
                : 'não há ninguém com esse nome na equipe hoje — NÃO comente nada sobre isso, apenas siga a conversa',
            });
            continue;
          }
          if (u.name === 'encerrar_contato') {
            await bloquearContato(telefone, leadId, card.oportunidade_id, u.input?.motivo ?? '');
            results.push({ type: 'tool_result', tool_use_id: u.id, content: 'ok, não procuramos mais' });
            continue;
          }
          const gravou = await gravarDados(leadId, u.input ?? {});
          dadosGravados = [...dadosGravados, ...gravou];
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `ok, gravei: ${gravou.join(', ') || 'nada novo'}` });
        }
        historico.push({ role: 'user', content: results });
        // Rede de segurança: se a rodada final não escrever nada, vale o que ele
        // escreveu antes da ferramenta — melhor a mensagem boa do que o silêncio.
        if (texto && !textoAntesDaFerramenta) textoAntesDaFerramenta = texto;
        continue;
      }
      resposta = texto || textoAntesDaFerramenta;
      break;
    }

    resposta = limparResposta(resposta);
    // Saída de emergência da cutucada: se o próprio modelo achar que não há o que retomar,
    // é melhor o silêncio do que uma mensagem sem motivo.
    if (ehFollowup && /^pular\.?$/i.test(resposta.trim())) {
      await evento('followup_dispensado', { telefone, lead_id: leadId, oportunidade_id: card.oportunidade_id });
      return;
    }
    if (!resposta) {
      await evento('erro', { telefone, lead_id: leadId, oportunidade_id: card.oportunidade_id, motivo: 'resposta vazia' });
      return;
    }

    await enviar(telefone, resposta, leadId, card.oportunidade_id);
    await evento(ehFollowup ? 'followup_enviado' : 'respondido', {
      telefone, lead_id: leadId, oportunidade_id: card.oportunidade_id, etapa,
      campos: dadosGravados, rodadas: rodada, tamanho: resposta.length,
    });
  } catch (e) {
    await evento('erro', { telefone, motivo: e instanceof Error ? e.message : String(e) });
    console.error('[crm-agente-rh]', e);
  } finally {
    await supabase.rpc('rh_agente_lock_liberar', { p_telefone: fone8 });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return json({ erro: 'use POST' }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch { return json({ erro: 'json inválido' }, 400); }

  // GATE 1 — número. Silencioso: mensagem de outro número não é problema, é rotina.
  if (payload?.wa_account_id !== CONTA_RH) return json({ ok: true, pulado: 'numero' });
  if (payload?.direcao !== 'inbound' || payload?.from_me === true) return json({ ok: true, pulado: 'nao_inbound' });
  if (!ANTHROPIC_KEY) ANTHROPIC_KEY = await chaveDoBanco();
  if (!ANTHROPIC_KEY) { await evento('erro', { motivo: 'sem ANTHROPIC key' }); return json({ ok: true, pulado: 'sem_chave' }); }

  const tarefa = processar(payload);
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(tarefa);
  else await tarefa;
  return json({ ok: true });
});
