// onb-regua-dispatch
//
// O DISPARADOR da régua da integração do aluno: para cada candidato que o banco aponta, manda
// o passo da vez pelo número do Suporte ao Aluno (3250) e registra o que aconteceu. Executa a
// régua, e nada mais. Desenho em scratchpad/regua/desenho.md (Rafael, 12/09/2026); as tabelas
// e as RPCs estão na migration 20260912150000_onb_regua.sql.
//
// A DIVISÃO DE TRABALHO COM O BANCO (e por que ela é assim)
// Quem decide QUEM e QUANDO é o `onb_regua_candidatos`: permanência na etapa, ordem dos
// passos, modelo do D+13 pelo TCC do curso, variáveis resolvidas, janela de horário, pausa,
// modo teste, trava de 24 h da Meta e intervalo de nova tentativa. A edge não recalcula nada
// disso, senão viram duas réguas que um dia divergem. Sobra para cá o que o banco não alcança:
//   1. a listagem de modelos APROVADOS na Meta (a aprovação mora lá, não aqui);
//   2. o PDF do cronograma do D+1, que nasce na hora e por aluno;
//   3. o envio pela crm-whatsapp-send;
//   4. registrar o resultado por `onb_regua_registrar`, que grava e move a etapa.
// Candidato com acao='mover' é o passo que anda sem receber nada (passo sem modelo, ou D+5 de
// quem já interagiu): aí a edge só chama `onb_regua_mover`.
//
// OS TRÊS MODOS (onb_regua_config.modo, que nasce em 'teste' com a lista vazia, ou seja, parada)
//   simulacao → NUNCA envia. Grava 'simulado' com o payload inteiro que teria ido para a Meta.
//               ⚠️ gravar 'simulado' CONSOME o passo e MOVE o aluno de etapa, então a simulação
//               também só fala com quem está em `telefones_teste` (quem barra é o banco).
//   teste     → só fala com quem está em `telefones_teste`. O resto vira 'pulado:fora_do_teste',
//               com o telefone mascarado no log.
//   producao  → envia.
// O corpo do POST aceita { limite, modo } para rodar à mão. O `modo` do corpo só DESCE, e
// descer pelo corpo é ENSAIO: não envia, não grava e não move (ver modoEfetivo em ./regras.ts e
// a guarda de ensaio em processarCandidato, que precisa vir antes da chamada de envio).
//
// IDEMPOTÊNCIA, em quatro camadas
//   1. uma rodada por vez (`onb_regua_rodada_claim`): a conferência da camada 2 acontece ANTES
//      do envio, e entre as duas há a geração do PDF e a Meta. Sem a reserva, o tick de 5 em 5
//      minutos abre uma segunda rodada que lê o log ainda vazio e manda o mesmo passo de novo;
//   2. `onb_regua_candidatos` não devolve passo que já tem linha enviada/simulada;
//   3. esta edge confere `onb_regua_envios` de novo, por candidato, antes de mandar, e nunca
//      processa o mesmo (oportunidade, etapa) duas vezes na mesma rodada;
//   4. a unique parcial de `onb_regua_envios` é a rede embaixo das outras.
// O que NENHUMA delas cobre: o runtime matar a função entre o envio e o registro. Aí a mensagem
// saiu e não há linha, e o passo é tentado de novo no tick seguinte.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import {
  CONTA_SUPORTE_3250,
  componentsDoCorpo,
  ehFrequenciaDaMeta,
  formatoDoCabecalho,
  IDIOMA_TEMPLATE,
  iguaisTempoConstante,
  limiteDaRodada,
  mascararTelefone,
  modoEfetivo,
  MOTIVO,
  precisaDoCronograma,
  primeiraTrava,
  telefoneDeEnvio,
  valoresParaEnvio,
  type Candidato,
  type Modo,
} from './regras.ts';

const FN = 'onb-regua-dispatch';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
/** Token próprio para o POST manual, quando não se quer passar a chave de serviço na mão. */
const TOKEN_PROPRIO = Deno.env.get('ONB_REGUA_TOKEN') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Teto de espera de cada chamada de rede. Sem isso, uma delas pendurada segura a rodada inteira
 * (a reserva de onb_regua_rodada_claim vence e o tick seguinte entra por cima) e ainda deixa o
 * candidato no limbo entre "mensagem entregue" e "linha gravada".
 */
const TIMEOUT_MS = { templates: 20_000, cronograma: 45_000, envio: 30_000 } as const;

/** Prazo da reserva da rodada. Menor que o tick de 5 min, para a régua nunca ficar presa. */
const RESERVA_SEGUNDOS = 240;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

type Admin = ReturnType<typeof createClient>;

let adminCache: Admin | null = null;
function adminClient(): Admin {
  if (!adminCache) {
    adminCache = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminCache;
}

/**
 * A chave de serviço que o BANCO conhece (`_get_service_role_key()`) NÃO é a mesma que o
 * container das edges tem no env: medido em 219 contra 180 caracteres em 31/08/2026. Quem
 * chama aqui é o `onb_regua_tick` por pg_net, com a chave do banco. Sem aceitar as duas, a
 * chamada voltaria 200 com "não autorizado" e a régua simplesmente não sairia, calada, que é
 * exatamente como o evento da entrevista sumiu do Google Calendar.
 */
let chaveDoBancoCache: string | null | undefined;
let chaveDoBancoFalhouEm = 0;
/** Quanto tempo uma falha de leitura da chave fica valendo antes de tentar de novo. */
const REPETIR_CHAVE_APOS_MS = 2 * 60 * 1000;
async function chaveDeServicoDoBanco(admin: Admin): Promise<string | null> {
  // Guardar a FALHA para sempre é o pior jeito de errar aqui: a primeira chamada depois do
  // deploy (ou logo depois de um `notify pgrst, 'reload schema'`) pode cair num PostgREST que
  // ainda não conhece a RPC, e o isolate inteiro passaria a recusar o cron com 401, calado, até
  // ser reciclado. Sucesso fica em cache para sempre; falha, só por alguns minutos.
  if (typeof chaveDoBancoCache === 'string') return chaveDoBancoCache;
  if (chaveDoBancoCache === null && Date.now() - chaveDoBancoFalhouEm < REPETIR_CHAVE_APOS_MS) {
    return null;
  }
  try {
    const { data, error } = await admin.rpc('_get_service_role_key');
    chaveDoBancoCache = !error && typeof data === 'string' && data.length > 20 ? data : null;
    if (chaveDoBancoCache === null) {
      chaveDoBancoFalhouEm = Date.now();
      console.log(`[${FN}] _get_service_role_key não respondeu chave utilizável: ${error?.message ?? 'vazio'}`);
    }
  } catch (e) {
    chaveDoBancoCache = null;
    chaveDoBancoFalhouEm = Date.now();
    console.log(`[${FN}] _get_service_role_key falhou:`, e instanceof Error ? e.message : String(e));
  }
  return chaveDoBancoCache;
}

/** Chave de serviço (do container OU do banco) ou o token próprio. Sem isso, 401. */
async function autorizado(req: Request, admin: Admin): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (SERVICE_ROLE && iguaisTempoConstante(token, SERVICE_ROLE)) return true;
  if (TOKEN_PROPRIO && iguaisTempoConstante(token, TOKEN_PROPRIO)) return true;
  const doBanco = await chaveDeServicoDoBanco(admin);
  return !!doBanco && iguaisTempoConstante(token, doBanco);
}

/**
 * Nomes de modelo APROVADOS na conta, direto da Meta (reusa a crm-whatsapp-templates, que já
 * pagina os 200+ templates da WABA). Uma consulta por rodada.
 *
 * Devolve null quando a Meta não responde: aí a trava do modelo não é aplicada, porque
 * derrubar a régua inteira por instabilidade da Meta é pior do que deixar ela recusar um
 * disparo isolado (que vira 'erro' e é tentado de novo depois de retentar_apos_horas).
 */
async function templatesAprovados(contaId: string): Promise<Set<string> | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wa_account_id: contaId, action: 'list' }),
      signal: AbortSignal.timeout(TIMEOUT_MS.templates),
    });
    const resp = await r.json().catch(() => ({}));
    const lista = Array.isArray((resp as { templates?: unknown })?.templates)
      ? (resp as { templates: Record<string, unknown>[] }).templates
      : null;
    if (!r.ok || !lista) {
      console.log(`[${FN}] listagem de modelos indisponível; a trava de aprovação fica de fora nesta rodada`);
      return null;
    }
    return new Set(
      lista
        .filter((t) => String(t?.status ?? '').toUpperCase() === 'APPROVED')
        .map((t) => String(t?.name ?? '')),
    );
  } catch (e) {
    console.log(`[${FN}] listagem de modelos falhou:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

type Cronograma =
  | { ok: true; url: string; filename: string; aulasFuturas: number }
  | { ok: false; motivo: string };

/**
 * O D+1 leva o PDF do cronograma da turma no cabeçalho, gerado na hora pela
 * generate-cronograma-aluno-pdf (POST por oportunidade, com a chave de serviço do container:
 * edge chamando edge lê o mesmo env).
 *
 * Só manda com ok e com aula futura: PDF de turma que já acabou, ou de turma sem cronograma
 * publicado, é pior do que não mandar nada. Esse é o caminho B, 'pulado:sem_cronograma'. E a
 * conferência tem de ser aqui, não no crm-whatsapp-send: lá um 4xx da origem abre alerta
 * crítico em Saúde da conta, agrupado por URL, e cada aluno tem a sua.
 */
async function conferirCronograma(oportunidadeId: string): Promise<Cronograma> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/generate-cronograma-aluno-pdf`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oportunidade_id: oportunidadeId }),
      signal: AbortSignal.timeout(TIMEOUT_MS.cronograma),
    });
    const resp = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || resp?.ok !== true) {
      return { ok: false, motivo: String(resp?.code ?? `http_${r.status}`) };
    }
    const futuras = Number(resp?.aulas_futuras ?? 0);
    if (!Number.isFinite(futuras) || futuras <= 0) return { ok: false, motivo: 'sem_aula_futura' };
    const url = String(resp?.url ?? '').trim();
    if (!url) return { ok: false, motivo: 'sem_url' };
    return {
      ok: true,
      url,
      filename: String(resp?.filename ?? '').trim() || 'cronograma.pdf',
      aulasFuturas: futuras,
    };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

type Status = 'enviado' | 'simulado' | 'pulado' | 'erro';

type Linha = {
  oportunidade_id: string;
  etapa_id: string;
  dia: number | null;
  etapa: string | null;
  acao: string;
  template: string | null;
  telefone: string;
  status: string;
  motivo: string | null;
  wa_message_id: string | null;
  movido?: boolean;
};

function linhaBase(cand: Candidato, status: string, motivo: string | null = null): Linha {
  return {
    oportunidade_id: cand.oportunidade_id,
    etapa_id: cand.etapa_id,
    dia: cand.dia ?? null,
    etapa: cand.etapa_nome ?? null,
    acao: String(cand.acao ?? 'enviar'),
    template: String(cand.template_nome ?? '') || null,
    telefone: mascararTelefone(cand.telefone),
    status,
    motivo,
    wa_message_id: null,
  };
}

type ContextoRodada = {
  modo: Modo;
  /** Rodada pedida à mão com o modo rebaixado: não grava, não move, não envia. */
  ensaio: boolean;
  telefonesTeste: (string | null)[];
  aprovados: Set<string> | null;
  conta: string;
};

/**
 * Grava o passo. É o `onb_regua_registrar` que decide mover a etapa (ele chama o
 * `onb_regua_mover`), e ele só move quando o passo SAIU: passo com erro fica onde está e é
 * tentado de novo depois de retentar_apos_horas.
 */
async function registrar(
  admin: Admin,
  cand: Candidato,
  ctx: ContextoRodada,
  status: Status,
  motivo: string | null,
  payload: Record<string, unknown> | null,
  telefone: string | null,
  waMessageId: string | null = null,
): Promise<Linha> {
  const linha = linhaBase(cand, status, motivo);
  linha.wa_message_id = waMessageId;
  if (ctx.ensaio) {
    // Ensaio pedido pelo corpo: o resultado vai só na resposta HTTP. Gravar 'simulado' por
    // cima de uma régua em produção queimaria a unique e o aluno nunca receberia o passo.
    linha.motivo = motivo ? `${motivo} (ensaio)` : 'ensaio';
    return linha;
  }
  const { data, error } = await admin.rpc('onb_regua_registrar', {
    p_oportunidade_id: cand.oportunidade_id,
    p_etapa_id: cand.etapa_id,
    p_status: status,
    p_motivo: motivo,
    p_telefone: telefone ?? cand.telefone ?? null,
    p_template_nome: String(cand.template_nome ?? '') || null,
    p_payload: payload ?? {},
    p_wa_message_id: waMessageId,
  });
  if (error) {
    console.log(`[${FN}] onb_regua_registrar recusou ${cand.oportunidade_id}/${cand.etapa_id}:`, error.message);
    linha.motivo = `${motivo ?? status}|registro_falhou:${error.message}`;
    return linha;
  }
  const r = (data ?? {}) as Record<string, unknown>;
  linha.movido = (r?.mover as Record<string, unknown>)?.movido === true;
  // Registro recusado por já existir depois de ENVIAR quer dizer que a unique pegou tarde
  // demais: o aluno recebeu duas vezes. Fica gritado, é o único erro daqui que ele enxerga.
  if (r?.ok === false && status === 'enviado') {
    console.log(`[${FN}] ATENÇÃO: envio duplicado detectado pela unique em ${cand.oportunidade_id}/${cand.etapa_id}`);
    linha.motivo = `${motivo ?? ''}|ja_registrado`;
  }
  return linha;
}

/** Já existe passo enviado ou simulado deste aluno nesta etapa? Camada 2 da idempotência. */
async function jaSaiu(admin: Admin, cand: Candidato): Promise<boolean> {
  const { data, error } = await admin
    .from('onb_regua_envios')
    .select('id')
    .eq('oportunidade_id', cand.oportunidade_id)
    .eq('etapa_id', cand.etapa_id)
    .in('status', ['enviado', 'simulado'])
    .limit(1)
    .maybeSingle();
  if (error) {
    // Não dá para conferir: não manda. Errar para menos aqui é um passo atrasado 5 minutos;
    // errar para mais é mensagem repetida na cara do aluno.
    console.log(`[${FN}] não foi possível conferir envios de ${cand.oportunidade_id}:`, error.message);
    return true;
  }
  return !!data;
}

async function processarCandidato(admin: Admin, cand: Candidato, ctx: ContextoRodada): Promise<Linha> {
  // acao='mover': o passo não manda nada (passo sem modelo, ou D+5 de quem já interagiu).
  // Quem sabe se já deu o tempo é o banco; aqui só se pede o movimento.
  if (String(cand.acao ?? '') === 'mover') {
    const linha = linhaBase(cand, 'movido', cand.motivo ?? null);
    if (ctx.ensaio) return linha;
    const { data, error } = await admin.rpc('onb_regua_mover', { p_oportunidade_id: cand.oportunidade_id });
    if (error) {
      linha.status = 'erro';
      linha.motivo = `mover_falhou:${error.message}`;
      return linha;
    }
    const r = (data ?? {}) as Record<string, unknown>;
    linha.movido = r?.movido === true;
    if (!linha.movido) linha.motivo = String(r?.motivo ?? 'nao_moveu');
    return linha;
  }

  const telefoneEnvio = telefoneDeEnvio(cand.telefone);
  const template = String(cand.template_nome ?? '').trim();
  const trava = primeiraTrava(cand, {
    modo: ctx.modo,
    telefonesTeste: ctx.telefonesTeste,
    aprovados: ctx.aprovados,
    telefoneEnvio,
    jaEnviado: await jaSaiu(admin, cand),
  });

  if (trava?.motivo === MOTIVO.ja_enviado) {
    // Não registra nada: o passo já tem a linha dele, e o cron volta a cada 5 minutos.
    return linhaBase(cand, 'ja_enviado');
  }

  if (trava) {
    const motivo = trava.detalhe ? `${trava.motivo}:${trava.detalhe}` : trava.motivo;
    if (trava.motivo === MOTIVO.fora_do_teste) {
      console.log(`[${FN}] modo teste: ${mascararTelefone(cand.telefone)} fora da lista, passo D+${cand.dia ?? '?'} pulado`);
    }
    return await registrar(admin, cand, ctx, 'pulado', motivo, { modo: ctx.modo, dia: cand.dia ?? null }, telefoneEnvio);
  }

  // As travas já conferiram os valores; aqui eles só são materializados (função pura).
  const vals = valoresParaEnvio(cand.valores, cand.variaveis);
  if (!vals.ok) {
    return await registrar(admin, cand, ctx, 'pulado', `${MOTIVO.sem_variavel}:${vals.faltando}`, null, telefoneEnvio);
  }

  // Cabeçalho de mídia: o do D+1 nasce agora, do cronograma da turma; o dos outros passos vem
  // cadastrado no próprio passo (onb_regua_passos.midia_url).
  let cabecalho: { url: string; formato: string; filename?: string } | null = null;
  if (precisaDoCronograma(cand)) {
    const pdf = await conferirCronograma(cand.oportunidade_id);
    if (!pdf.ok) {
      return await registrar(
        admin, cand, ctx, 'pulado', `${MOTIVO.sem_cronograma}:${pdf.motivo}`,
        { modo: ctx.modo, dia: cand.dia ?? null, turma_id: cand.turma_id ?? null }, telefoneEnvio,
      );
    }
    cabecalho = { url: pdf.url, formato: 'DOCUMENT', filename: pdf.filename };
  } else {
    const formato = formatoDoCabecalho(cand.cabecalho);
    const url = String(cand.midia_url ?? '').trim();
    if (formato && url) {
      cabecalho = { url, formato, filename: String(cand.midia_nome ?? '').trim() || undefined };
    }
  }

  const payload: Record<string, unknown> = {
    wa_account_id: ctx.conta,
    telefone: telefoneEnvio,
    tipo: 'template',
    template_name: template,
    template_lang: IDIOMA_TEMPLATE,
    template_components: componentsDoCorpo(vals.valores),
    ...(cabecalho
      ? {
        header_media_url: cabecalho.url,
        header_media_format: cabecalho.formato,
        ...(cabecalho.filename ? { header_media_filename: cabecalho.filename } : {}),
      }
      : {}),
    ...(cand.lead_id ? { lead_id: cand.lead_id } : {}),
    oportunidade_id: cand.oportunidade_id,
    origem: 'automacao',
  };

  // Daqui para a frente sai mensagem de verdade, e estes dois não mandam nada:
  //   · SIMULAÇÃO da config: grava 'simulado' com o payload inteiro que teria ido para a Meta;
  //   · ENSAIO (modo rebaixado pelo corpo do POST): nem grava, o resultado vai só na resposta.
  // A guarda do ensaio precisa estar AQUI, e não só dentro do registrar: com a config em produção
  // e { modo: 'teste' } no corpo, quem passasse na lista de teste chegava ao crm-whatsapp-send,
  // recebia a mensagem e não deixava linha nenhuma em onb_regua_envios; o tick seguinte mandava
  // tudo de novo.
  if (ctx.modo === 'simulacao' || ctx.ensaio) {
    return await registrar(admin, cand, ctx, 'simulado', null, payload, telefoneEnvio);
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS.envio),
    });
    const resp = (await r.json().catch(() => ({}))) as Record<string, unknown>;

    if (!r.ok || resp?.error || resp?.success !== true) {
      const erro = String(resp?.error ?? `falha no envio (status ${r.status})`);
      // Recusa por ritmo de mensagem daquela pessoa (131049/131050) é passo ADIADO, não passo com
      // erro: nada está errado com o número nem com o modelo, e a próxima tentativa sai depois de
      // retentar_apos_horas. A crm-whatsapp-send não devolve mais nada parecido com `skipped`: a
      // trava de "1 template por 24 h" foi removida de lá a pedido do diretor, e a única que
      // sobrou no caminho da régua é a do onb_regua_candidatos.
      if (ehFrequenciaDaMeta(erro)) {
        return await registrar(
          admin, cand, ctx, 'pulado', `${MOTIVO.frequencia_meta}:${erro}`, payload, telefoneEnvio,
        );
      }
      return await registrar(admin, cand, ctx, 'erro', erro, payload, telefoneEnvio);
    }

    return await registrar(
      admin, cand, ctx, 'enviado', null, payload, telefoneEnvio,
      typeof resp?.wa_message_id === 'string' ? resp.wa_message_id : null,
    );
  } catch (e) {
    return await registrar(
      admin, cand, ctx, 'erro', e instanceof Error ? e.message : String(e), payload, telefoneEnvio,
    );
  }
}

async function rodar(req: Request): Promise<Response> {
  const admin = adminClient();
  if (!(await autorizado(req, admin))) {
    // Log obrigatório, sem o token: a recusa da chamada do cron é justamente a falha que some
    // calada (o pg_net registra 200 e ninguém percebe que a régua parou de sair).
    const tam = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim().length;
    console.log(
      `[${FN}] recusado: token de ${tam} caracteres não bate com a chave do container, com o token da régua nem com a do banco (banco respondeu chave: ${chaveDoBancoCache ? 'sim' : 'não'})`,
    );
    return json({ ok: false, code: 'nao_autorizado', error: 'envie a chave de serviço ou o token da régua' }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const limite = limiteDaRodada(body?.limite);

  const { data: cfg, error: erroCfg } = await admin
    .from('onb_regua_config')
    .select('*')
    .limit(1)
    .maybeSingle();
  if (erroCfg) return json({ ok: false, code: 'sem_config', error: erroCfg.message }, 500);
  if (!cfg) return json({ ok: false, code: 'sem_config', error: 'a régua não tem linha de configuração' }, 500);
  const config = cfg as Record<string, unknown>;
  const { modo, pedido, rebaixado, ensaio } = modoEfetivo(config?.modo, body?.modo);

  // Freio de mão e janela de horário valem para a rodada inteira. O gate de verdade é o do
  // banco (o candidatos devolve zero linhas nos dois casos); isto aqui é só para quem chamou
  // à mão saber POR QUE nada saiu, em vez de receber uma lista vazia sem explicação.
  if (config?.pausado === true) {
    return json({ ok: true, modo, parado: 'pausado', processados: 0, resultados: [] });
  }
  const { data: janela } = await admin.rpc('onb_regua_janela_ok');
  if (janela === false) {
    return json({ ok: true, modo, parado: 'fora_da_janela', processados: 0, resultados: [] });
  }

  // UMA RODADA POR VEZ. A rodada pode durar mais que o tick de 5 minutos (cada candidato pode
  // gerar um PDF e esperar a Meta), e a segunda rodada leria o log ainda vazio do aluno que a
  // primeira está mandando: mensagem repetida na cara dele. O ensaio não reserva nada, porque
  // não manda e não grava, e reservar atrapalharia a rodada de verdade.
  let reservou = false;
  if (!ensaio) {
    const { data: reserva, error: erroReserva } = await admin.rpc('onb_regua_rodada_claim', {
      p_segundos: RESERVA_SEGUNDOS,
    });
    if (erroReserva) {
      return json({ ok: false, code: 'reserva_indisponivel', error: erroReserva.message }, 500);
    }
    if (reserva !== true) {
      console.log(`[${FN}] rodada anterior ainda em andamento; esta foi dispensada`);
      return json({ ok: true, modo, parado: 'rodada_em_andamento', processados: 0, resultados: [] });
    }
    reservou = true;
  }

  try {
    const { data: candidatos, error: erroCand } = await admin.rpc('onb_regua_candidatos', {
      p_limite: limite,
    });
    if (erroCand) {
      return json({ ok: false, code: 'candidatos_indisponiveis', error: erroCand.message }, 500);
    }
    const lista = (Array.isArray(candidatos) ? candidatos : []) as Candidato[];
    if (!lista.length) {
      return json({ ok: true, modo, ...(ensaio ? { ensaio: true } : {}), processados: 0, resultados: [] });
    }

    const conta = String(lista[0]?.wa_account_id ?? config?.wa_account_id ?? CONTA_SUPORTE_3250);
    const ctx: ContextoRodada = {
      modo,
      ensaio,
      telefonesTeste: Array.isArray(config?.telefones_teste) ? (config.telefones_teste as string[]) : [],
      // Em simulação nada sai, mas a listagem continua valendo: é ela que mostra no ensaio qual
      // passo cairia por modelo ainda não aprovado.
      aprovados: await templatesAprovados(conta),
      conta,
    };

    const resultados: Linha[] = [];
    const vistos = new Set<string>();
    for (const cand of lista) {
      if (!cand?.oportunidade_id || !cand?.etapa_id) continue;
      const chave = `${cand.oportunidade_id}:${cand.etapa_id}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      resultados.push(await processarCandidato(admin, cand, ctx));
    }

    return json(resumoDaRodada(resultados, { modo, ensaio, pedido, rebaixado, limite }));
  } finally {
    // Solta a reserva mesmo se algo estourou no meio: quem depende do vencimento do prazo perde
    // até 4 minutos de régua por um erro que já acabou.
    if (reservou) {
      const { error } = await admin.rpc('onb_regua_rodada_liberar');
      if (error) console.log(`[${FN}] não consegui liberar a reserva da rodada:`, error.message);
    }
  }
}

function resumoDaRodada(
  resultados: Linha[],
  ctx: { modo: Modo; ensaio: boolean; pedido: Modo | null; rebaixado: boolean; limite: number | null },
): Record<string, unknown> {
  const { modo, ensaio, pedido, rebaixado, limite } = ctx;
  const contar = (status: string) => resultados.filter((r) => r.status === status).length;
  const resumo = {
    ok: true,
    modo,
    ...(ensaio ? { ensaio: true } : {}),
    ...(pedido && rebaixado ? { modo_pedido: pedido, modo_rebaixado: true } : {}),
    ...(limite ? { limite } : {}),
    processados: resultados.length,
    enviados: contar('enviado'),
    simulados: contar('simulado'),
    pulados: contar('pulado'),
    erros: contar('erro'),
    ja_enviados: contar('ja_enviado'),
    movidos: resultados.filter((r) => r.movido === true).length,
    resultados,
  };
  console.log(
    `[${FN}] modo=${modo}${ensaio ? ' (ensaio)' : ''} processados=${resumo.processados} enviados=${resumo.enviados} simulados=${resumo.simulados} pulados=${resumo.pulados} erros=${resumo.erros} movidos=${resumo.movidos}`,
  );
  return resumo;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, code: 'metodo_invalido', error: 'use POST' }, 405);
  try {
    return await rodar(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[${FN}] fatal:`, msg);
    return json({ ok: false, code: 'erro_interno', error: msg }, 500);
  }
});
