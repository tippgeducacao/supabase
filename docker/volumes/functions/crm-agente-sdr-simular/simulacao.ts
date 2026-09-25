// Núcleo do harness sem cliente de banco, credenciais ou transporte de mensagens.
// 08/09/2026: o histórico inicial reproduz a retomada após atendimento humano.
// Somente texto externo é aceito: tool_use/result e thinking só podem nascer do modelo.
import { sanitizarHistorico, type Msg } from '../crm-agente-sdr/historico.ts';
import type { Telemetria } from '../crm-agente-sdr/eventos.ts';
import type { ProvedorIA } from '../crm-agente-sdr/agente.ts';
import { modeloOpenaiPermitido } from '../crm-agente-sdr/modelosOpenai.ts';
import { contextoAulaPiloto, INSTRUCAO_AULA_PILOTO } from '../crm-agente-sdr/contextoAulaPiloto.ts';
import { avaliarEvidenciaSemGraduacao, bloqueioSemEvidenciaGraduacao } from '../crm-agente-sdr/evidenciaFormacao.ts';
import { respostaDoEncerramento, toolConcluida, type Encerramento } from '../crm-agente-sdr/encerramento.ts';
import { comPresenteNaDespedida } from '../crm-agente-sdr/escolaGratuita.ts';
import { confirmacaoDoResultado, falaEntregaConfirmacao, textoConfirmacaoAgendamento, type ConfirmacaoAgendamento } from '../crm-agente-sdr/confirmacaoAgendamento.ts';
import { AVISO_CONSULTA_REPETIDA, MemoriaDeConsultas } from '../crm-agente-sdr/consultaRepetida.ts';

export const MAX_TURNOS_SIMULACAO = 100;
export const MAX_CARACTERES_SIMULACAO = 200_000;
import type { AulaParaPrompt } from '../crm-agente-sdr/prompts-aula.ts';

// 16/09/2026: 'aula' = persona da aula gratuita (PRD — Persona por disparo). No harness
// ela substitui a abertura como a campanha direta; o fechamento segue com o qualificador.
export type Persona = 'validacao' | 'qualificador' | 'campanha_direta' | 'aula';
export type AgenteRouter = 'agente_validacao' | 'agente_qualificador';
export type MensagemTextual = { role: 'user' | 'assistant'; content: string };
/** 14/09/2026: o lead responde por OUTRO número da PPGVET (trocaDeNumero.ts). Só o 1º turno recebe a nota. */
export type TrocaDeNumeroSimulada = {
  /** Texto do template que saiu por este número antes da resposta (null = o lead escreveu por conta própria). */
  template: string | null;
  gap_min: number | null;
  conta_anterior: string | null;
  conta_atual: string | null;
  agendado: boolean;
};
export type EntradaSimulacao = {
  modo: 'principal' | 'followup';
  followup_stage: number;
  persona: Persona;
  mensagens: string[];
  historico_inicial: MensagemTextual[];
  usar_router: boolean;
  agente_atual: AgenteRouter | null;
  nome_lead: string;
  curso: string;
  formacao_academica: string;
  mocks: Record<string, unknown>;
  agente_override: string;
  sem_presente_escola: boolean;
  /** A pessoa JÁ tem a tag da Escola: o prompt leva o aviso (NOTA_JA_ESTA_NA_ESCOLA) no lugar do convite. */
  esta_na_escola: boolean;
  prompt_extra: string;
  troca_de_numero: TrocaDeNumeroSimulada | null;
  /** Dados da aula do convite (persona 'aula'); o "quando ocorre" é calculado pelo relógio real. */
  aula: AulaParaPrompt | null;
  /** Quem responde nesta simulação. 'deepseek' usa o endpoint compatível; a produção não tem essa chave. */
  provedor: 'anthropic' | 'deepseek' | 'openai';
  /** Nível de raciocínio do provedor openai nesta simulação (compara high × xhigh no mesmo deploy). */
  esforco: string | null;
  /** Substituição exclusiva deste ensaio, sem alterar o piloto nem o ambiente. */
  modelo_openai: string | null;
  /** A/B de 24/09/2026: devolve o raciocínio cifrado da Luna junto com o resultado das tools. */
  raciocinio_encadeado: boolean;
  /** Liga a ficha do atendimento (canário): bloco + instrução + trava do cronograma no mock. */
  ficha: boolean;
};

export function validarEntradaSimulacao(valor: unknown): EntradaSimulacao {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('payload inválido');
  if (JSON.stringify(valor).length > MAX_CARACTERES_SIMULACAO) throw new Error('limite de 200000 caracteres excedido');
  const body = valor as Record<string, unknown>;
  const modo = body.modo ?? 'principal';
  if (modo !== 'principal' && modo !== 'followup') throw new Error('modo inválido');
  const persona = body.persona ?? 'campanha_direta';
  if (typeof persona !== 'string' || !['validacao', 'qualificador', 'campanha_direta', 'aula'].includes(persona)) throw new Error('persona inválida');
  const provedor = body.provedor ?? 'anthropic';
  if (provedor !== 'anthropic' && provedor !== 'deepseek' && provedor !== 'openai') throw new Error('provedor inválido');
  const esforco = body.esforco ?? null;
  const modeloOpenai = body.modelo_openai ?? null;
  if (modeloOpenai !== null && (provedor !== 'openai' || !modeloOpenaiPermitido(modeloOpenai))) {
    throw new Error('modelo_openai só aceita gpt-5.6-luna ou gpt-6-luna com provedor openai');
  }
  if (esforco !== null && (provedor !== 'openai' || !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(esforco as string))) {
    throw new Error('esforco só vale com provedor openai: none, low, medium, high, xhigh ou max');
  }
  if (body.raciocinio_encadeado !== undefined && (typeof body.raciocinio_encadeado !== 'boolean' || (body.raciocinio_encadeado && provedor !== 'openai'))) {
    throw new Error('raciocinio_encadeado deve ser booleano e só vale com provedor openai');
  }
  let aulaSimulada: AulaParaPrompt | null = null;
  if (body.aula !== undefined && body.aula !== null) {
    const a = body.aula as Record<string, unknown>;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('aula deve ser um objeto');
    if (typeof a.titulo !== 'string' || !a.titulo.trim()) throw new Error('aula.titulo deve conter texto não vazio');
    if (typeof a.inicio_em !== 'string' || Number.isNaN(new Date(a.inicio_em).getTime())) throw new Error('aula.inicio_em deve ser uma data ISO válida');
    const opcional = (v: unknown, campo: string): string | null => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') throw new Error(`aula.${campo} deve ser texto`);
      return v;
    };
    aulaSimulada = {
      titulo: a.titulo, inicio_em: a.inicio_em, tema: opcional(a.tema, 'tema'), link: opcional(a.link, 'link'),
      certificado_instrucoes: opcional(a.certificado_instrucoes, 'certificado_instrucoes'),
      certificado_link: opcional(a.certificado_link, 'certificado_link'),
      monitor_nome: opcional(a.monitor_nome, 'monitor_nome'), curso_nome: opcional(a.curso_nome, 'curso_nome'),
    };
  }
  if (persona === 'aula' && !aulaSimulada) throw new Error('persona aula exige o objeto aula');
  const mensagens = body.mensagens ?? (modo === 'followup' ? [] : undefined);
  if (!Array.isArray(mensagens) || (modo === 'principal' && !mensagens.length)) throw new Error('mensagens[] obrigatório');
  if (body.historico_inicial !== undefined && !Array.isArray(body.historico_inicial)) throw new Error('historico_inicial deve ser um array');
  const historico = (body.historico_inicial ?? []) as unknown[];
  if (historico.length + mensagens.length > MAX_TURNOS_SIMULACAO) throw new Error('limite de 100 turnos excedido');
  const stage = body.followup_stage ?? 1;
  if (!Number.isInteger(stage) || Number(stage) < 1 || Number(stage) > 7) throw new Error('followup_stage deve ser inteiro de 1 a 7');
  if (modo === 'followup') {
    if (!historico.length || mensagens.length) throw new Error('followup exige histórico inicial e nenhuma nova mensagem');
    if (body.usar_router || body.agente_override || body.prompt_extra || body.sem_presente_escola || body.esta_na_escola) {
      throw new Error('followup não aceita router, override ou alteração de prompt');
    }
  }
  const texto = (v: unknown, campo: string, obrigatorio = false): string => {
    if (v === undefined && !obrigatorio) return '';
    if (typeof v !== 'string' || (obrigatorio && !v.trim())) throw new Error(`${campo} deve conter texto não vazio`);
    return v;
  };
  const historicoInicial = historico.map((v): MensagemTextual => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('turno inválido no histórico');
    const m = v as Record<string, unknown>;
    if (m.role !== 'user' && m.role !== 'assistant') throw new Error('role deve ser user ou assistant');
    // Não aceitar metadados/blocos de API trazidos por quem chamou o endpoint.
    if (Object.keys(m).some((k) => k !== 'role' && k !== 'content')) throw new Error('histórico aceita somente role e content');
    return { role: m.role, content: texto(m.content, 'content', true) };
  });
  for (const campo of ['usar_router', 'sem_presente_escola', 'esta_na_escola', 'ficha']) {
    if (body[campo] !== undefined && typeof body[campo] !== 'boolean') throw new Error(`${campo} deve ser booleano`);
  }
  if (body.agente_atual != null && body.agente_atual !== 'agente_validacao' && body.agente_atual !== 'agente_qualificador') {
    throw new Error('agente_atual inválido');
  }
  if (body.mocks != null && (typeof body.mocks !== 'object' || Array.isArray(body.mocks))) throw new Error('mocks deve ser objeto');
  let trocaDeNumero: TrocaDeNumeroSimulada | null = null;
  if (body.troca_de_numero != null) {
    const t = body.troca_de_numero;
    if (typeof t !== 'object' || Array.isArray(t)) throw new Error('troca_de_numero deve ser objeto');
    if (modo === 'followup') throw new Error('followup não aceita troca_de_numero');
    const o = t as Record<string, unknown>;
    const chaves = ['template', 'gap_min', 'conta_anterior', 'conta_atual', 'agendado'];
    if (Object.keys(o).some((k) => !chaves.includes(k))) throw new Error(`troca_de_numero aceita somente ${chaves.join(', ')}`);
    if (o.gap_min != null && (typeof o.gap_min !== 'number' || !Number.isFinite(o.gap_min) || o.gap_min < 0)) throw new Error('troca_de_numero.gap_min deve ser número >= 0');
    if (o.agendado !== undefined && typeof o.agendado !== 'boolean') throw new Error('troca_de_numero.agendado deve ser booleano');
    trocaDeNumero = {
      template: texto(o.template ?? undefined, 'troca_de_numero.template').trim() || null,
      gap_min: o.gap_min == null ? null : Number(o.gap_min),
      conta_anterior: texto(o.conta_anterior ?? undefined, 'troca_de_numero.conta_anterior').trim() || null,
      conta_atual: texto(o.conta_atual ?? undefined, 'troca_de_numero.conta_atual').trim() || null,
      agendado: o.agendado === true,
    };
  }
  return {
    modo,
    followup_stage: Number(stage),
    persona: persona as Persona,
    mensagens: mensagens.map((m) => texto(m, 'mensagens[]', true)),
    historico_inicial: historicoInicial,
    usar_router: body.usar_router === true,
    agente_atual: (body.agente_atual as AgenteRouter | null) ?? null,
    nome_lead: texto(body.nome_lead, 'nome_lead'),
    curso: texto(body.curso, 'curso'),
    formacao_academica: texto(body.formacao_academica, 'formacao_academica'),
    mocks: (body.mocks as Record<string, unknown>) ?? {},
    agente_override: texto(body.agente_override, 'agente_override').trim(),
    sem_presente_escola: body.sem_presente_escola === true,
    esta_na_escola: body.esta_na_escola === true,
    prompt_extra: texto(body.prompt_extra, 'prompt_extra').trim(),
    troca_de_numero: trocaDeNumero,
    aula: aulaSimulada,
    provedor,
    esforco: esforco as string | null,
    modelo_openai: modeloOpenai as string | null,
    raciocinio_encadeado: body.raciocinio_encadeado === true,
    ficha: body.ficha === true,
  };
}

// Recusa do provedor sem o corpo cru: só status e os campos estruturados do erro
// (ex.: `param: "input[7]"`), o bastante para achar o item mal formado no A/B.
export function diagnosticoDoProvedor(erro: unknown): Record<string, unknown> | null {
  const m = /^(OpenAI|Anthropic|deepseek): HTTP (\d{3}): ([\s\S]*)$/.exec(String((erro as Error)?.message ?? ''));
  if (!m) return null;
  const campo = (v: unknown) => typeof v === 'string' ? v.slice(0, 120) : null;
  try {
    const corpo = JSON.parse(m[3])?.error ?? {};
    return { provedor: m[1], status: Number(m[2]), tipo: campo(corpo.type), param: campo(corpo.param), codigo: campo(corpo.code) };
  } catch {
    return { provedor: m[1], status: Number(m[2]) };
  }
}

// Agenda do ensaio, espelho de consulta_disponibilidade (crm-agente-sdr/tools.ts) + sdr-api
// (janelaDeDataPeriodo). Regras que o mock já tinha e continuam: datas FUTURAS calculadas na
// hora (o mock fixo em "30/07" venceu e o agente reconsultava em loop), só DIA ÚTIL (sábado
// só tem manhã e o agente rejeitava 15h, com razão) e UM vendedor por padrão — a agenda é a do
// dono do contato; `mocks.disponibilidade = 'pool'` devolve vários (fallback e webchat).
// Novo (24/09/2026): com `data_desejada`, a janela é SÓ aquele dia, recortada por
// `horario_inicio_desejado` (dali até o fim do dia) ou pelo período — manhã 0–12h,
// tarde 12–19h, noite 19–24h; dia sem horário devolve o mesmo texto de agenda vazia da tool.
export function disponibilidadeSimulada(entrada: unknown, mocksDoEnsaio: unknown, agora: Date = new Date()): string {
  const input = (entrada ?? {}) as Record<string, unknown>;
  const mocks = (mocksDoEnsaio ?? {}) as Record<string, unknown>;
  const fuso = 'America/Sao_Paulo';
  const isoSP = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const semanaCurta = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: fuso, weekday: 'short' }).format(d);
  const proximoUtil = (dias: number) => {
    const d = new Date(agora.getTime() + dias * 86_400_000);
    while (semanaCurta(d) === 'Sat' || semanaCurta(d) === 'Sun') d.setTime(d.getTime() + 86_400_000);
    return d;
  };
  const pool = mocks.disponibilidade === 'pool';
  const semanaDe = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, weekday: 'long' }).format(d).replace('-feira', '');
  // 'realista' (25/09/2026, duelo em amostra nova): a agenda enxuta abaixo não tem nada HOJE, no
  // sábado nem à noite — o Sonnet procurou "hoje à tarde" até esgotar as voltas em 7 de 40 casos,
  // contra 1 limite de voltas em 6.033 rodadas reais de 7 dias. Aqui: hoje (o que não passou) e os
  // próximos 4 dias, manhã/tarde/noite, sábado só manhã, domingo nada. Sem data: os 4 primeiros.
  const agenda = mocks.disponibilidade === 'realista'
    ? (() => {
      const agoraSP = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(new Date(agora.getTime() + 30 * 60_000));
      const slots: { data: string; hora: string; rotulo: string; vid: string; nome: string; semana: string }[] = [];
      for (let dias = 0; dias <= 4; dias++) {
        const d = new Date(agora.getTime() + dias * 86_400_000);
        const dow = semanaCurta(d);
        if (dow === 'Sun') continue;
        for (const hora of ['09:00', '10:30', '11:30', '14:00', '15:30', '17:00', '19:00', '19:30', '20:30']) {
          if (dow === 'Sat' && hora >= '12:00') continue;
          if (dias === 0 && hora <= agoraSP) continue;
          const [h, m] = hora.split(':');
          slots.push({ data: isoSP(d), hora, rotulo: `${Number(h)}h${m === '00' ? '' : m}`, vid: 'v1', nome: 'Ana', semana: semanaDe(d) });
        }
      }
      return slots;
    })()
    : ([
      [1, '15:00', '15h', 'v1', 'Ana'],
      [1, '16:30', '16h30', pool ? 'v2' : 'v1', pool ? 'Bruno' : 'Ana'],
      [2, '10:00', '10h', pool ? 'v3' : 'v1', pool ? 'Carla' : 'Ana'],
    ] as const).map(([dias, hora, rotulo, vid, nome]) => {
      const d = proximoUtil(dias);
      return { data: isoSP(d), hora, rotulo, vid, nome, semana: semanaDe(d) };
    });

  const hoje = isoSP(agora);
  const dataPedida = String(input.data_desejada ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dataPedida) && dataPedida < hoje) {
    return `⚠️ A data consultada (${dataPedida}) JÁ PASSOU. HOJE é ${hoje}. Refaça a consulta com a data de HOJE ou uma futura — `
      + 'e, se você afirmou outra data/dia da semana ao lead, corrija com naturalidade usando o HOJE informado aqui (nunca insista na data errada).';
  }
  let janela = mocks.disponibilidade === 'realista' && !dataPedida ? agenda.slice(0, 4) : agenda;
  if (dataPedida) {
    const inicio = String(input.horario_inicio_desejado ?? '').trim().slice(0, 5);
    const periodo = String(input.periodo_desejado ?? '').trim().toLowerCase();
    const [de, ate] = /^\d{2}:\d{2}$/.test(inicio) ? [inicio, '23:59']
      : periodo === 'manhã' || periodo === 'manha' ? ['00:00', '12:00']
      : periodo === 'tarde' ? ['12:00', '19:00']
      : periodo === 'noite' ? ['19:00', '23:59']
      : ['00:00', '23:59'];
    janela = agenda.filter((s) => s.data === dataPedida && s.hora >= de && s.hora <= ate);
  }
  if (!janela.length) {
    return `Nenhum horário disponível para a conversa com o monitor no período solicitado. Isso não informa nem altera o horário de aula ou evento. (Referência: HOJE é ${hoje}.)`;
  }
  const lista = janela.map((s) => `- ${s.rotulo} de ${s.semana}, dia ${s.data} (vendedor_id: ${s.vid}, nome: ${s.nome})`).join('\n');
  const conteudo = `Horários disponíveis para a conversa com o monitor (Brasília):\n${lista}\n`
    + '(O dia da semana informado acima é o correto — use-o exatamente, não recalcule.)\n'
    + 'Ao apresentar as opções, diga que são para a conversa com o monitor. Não são horários de aula ou evento e não alteram a programação do convite. Só ofereça após aceite específico para essa conversa.';
  // Graduação ainda não verificada ⇒ o horário é OPÇÃO, não combinado (caso Matheus
  // 2026-08-08). Liga com `mocks.formacao_nao_verificada: true`.
  return mocks.formacao_nao_verificada
    ? conteudo + '\n⚠️ A graduação deste lead ainda NÃO foi verificada. Se ele já propôs ou escolheu '
      + 'um dia e horário que apareceu disponível, preserve essa preferência e pergunte somente a formação/conclusão que falta, sem pedir outra escolha. '
      + 'Se ainda não escolheu, apresente opções. NÃO responda como se estivesse fechado ("show, 10h30 então"): '
      + 'a elegibilidade precisa ser verificada ANTES de confirmar a reunião.'
    : conteudo;
}

// Replay (25/09/2026): a agenda REAL daquele atendimento, levada ao dia que o modelo pediu. O
// replay roda dias depois ("amanhã" já é outra data): devolver o dia antigo contradiz o pedido
// (a Luna repetiu a consulta até esgotar as voltas) e a agenda sintética não tem noite (o Sonnet
// procurou noite 6 vezes e ficou mudo — 8 silêncios que a produção não tem). Mantém HORÁRIOS e
// vendedores reais, com a data e o dia da semana pedidos, recortados como a sdr-api (período ou
// horário de início; sábado só manhã; hoje só o que ainda não passou). Domingo, data passada ou
// nada no recorte ⇒ null (o chamador cai na agenda sintética).
export function agendaRealNoDia(real: string, entrada: unknown, agora: Date = new Date()): string | null {
  const input = (entrada ?? {}) as Record<string, unknown>;
  const data = String(input.data_desejada ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return null;
  const fuso = 'America/Sao_Paulo';
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
  if (data < hoje) return null;
  const dia = new Date(`${data}T12:00:00-03:00`);
  const curta = new Intl.DateTimeFormat('en-US', { timeZone: fuso, weekday: 'short' }).format(dia);
  if (curta === 'Sun') return null;
  const semana = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, weekday: 'long' }).format(dia);

  let texto = real;
  try {
    const j = JSON.parse(real);
    if (typeof j?.resultado === 'string') texto = j.resultado;
  } catch { /* resposta real em texto simples */ }

  const inicio = String(input.horario_inicio_desejado ?? '').trim().slice(0, 5);
  const periodo = String(input.periodo_desejado ?? '').trim().toLowerCase();
  let [de, ate] = /^\d{2}:\d{2}$/.test(inicio) ? [inicio, '23:59']
    : periodo === 'manhã' || periodo === 'manha' ? ['00:00', '12:00']
    : periodo === 'tarde' ? ['12:00', '19:00']
    : periodo === 'noite' ? ['19:00', '23:59']
    : ['00:00', '23:59'];
  if (curta === 'Sat' && ate > '12:00') ate = '12:00';
  const jaPassou = data === hoje
    ? new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hour12: false }).format(agora)
    : '';

  const vistos = new Set<string>();
  const linhas: string[] = [];
  for (const linha of texto.split('\n')) {
    const m = linha.match(/^- (\d{1,2})h(\d{2})? de [^,]+, dia \d{4}-\d{2}-\d{2}(.*)$/);
    if (!m) continue;
    const hora = `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`;
    if (hora < de || hora > ate || (jaPassou && hora <= jaPassou) || vistos.has(hora + m[3])) continue;
    vistos.add(hora + m[3]);
    linhas.push(`- ${m[1]}h${m[2] ?? ''} de ${semana}, dia ${data}${m[3]}`);
  }
  if (!linhas.length) return null;
  return `Horários disponíveis para a conversa com o monitor (Brasília):\n${linhas.join('\n')}\n`
    + '(O dia da semana informado acima é o correto — use-o exatamente, não recalcule.)\n'
    + 'Ao apresentar as opções, diga que são para a conversa com o monitor. Não são horários de aula ou evento e não alteram a programação do convite. Só ofereça após aceite específico para essa conversa.';
}

// Somente contagens conhecidas saem no diagnóstico; nunca a resposta crua do provedor.
export function extrairUso(usage: unknown): Record<string, number> {
  const resultado: Record<string, number> = {};
  if (!usage || typeof usage !== 'object') return resultado;
  for (const campo of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const valor = (usage as Record<string, unknown>)[campo];
    if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) resultado[campo] = valor;
  }
  // Só a CONTAGEM de raciocínio (já inclusa em output_tokens), nunca o conteúdo.
  const detalhes = (usage as Record<string, unknown>).output_tokens_details;
  const pensamento = detalhes && typeof detalhes === 'object' ? (detalhes as Record<string, unknown>).thinking_tokens : undefined;
  if (typeof pensamento === 'number' && Number.isFinite(pensamento) && pensamento >= 0) resultado.thinking_tokens = pensamento;
  return resultado;
}

type BlocoModelo = { type: string; text?: string; id?: string; name?: string; input?: unknown; [campo: string]: unknown };
type Rodada = { promptAgente: string; contextoTemporal: string; tools: unknown[]; agente: string; comFicha?: boolean; instrucaoFicha?: string };
export type DependenciasSimulacao = {
  prepararRodada: (messages: Msg[], turno: number) => Promise<Rodada>;
  chamarPrincipal: (opts: {
    promptAgente: string; contextoTemporal: string; tools: unknown[]; messages: Msg[]; contextoFicha?: string; comFicha?: boolean; instrucaoFicha?: string;
  }) => Promise<{
    content?: BlocoModelo[]; model?: string; usage?: unknown; stop_reason?: string;
    raciocinio_encadeado?: boolean; raciocinios_reenviados?: number;
  }>;
  mockTool: (nome: string, input: unknown) => Promise<string>;
  humanizar: (texto: string) => string;
  /** Decora apenas a fala final (ex.: abertura de troca), com estado local do ensaio. */
  prepararFala?: (texto: string) => string;
  /** Ficha do atendimento da VOLTA (não do turno): a tool da volta anterior pode ter mudado a coleta, como na produção. */
  fichaDaVolta?: (messages: Msg[]) => string | undefined;
  /** Texto final do João no turno (o que o lead leria): a ficha anota as perguntas feitas, como na produção. */
  aoResponder?: (texto: string) => void;
};

export async function executarSimulacao(entrada: EntradaSimulacao, deps: DependenciasSimulacao) {
  const messages: Msg[] = entrada.historico_inicial.map((m) => ({ ...m }));
  const transcript: Record<string, unknown>[] = [];
  const chamadas: Record<string, unknown>[] = [];
  const limites: { turno: number; motivo: string }[] = [];
  let agente = '';

  for (const [indice, msgLead] of entrada.mensagens.entries()) {
    const turno = indice + 1;
    messages.push({ role: 'user', content: msgLead });
    transcript.push({ quem: 'lead', texto: msgLead, turno });
    const rodada = await deps.prepararRodada(messages, turno);
    agente = rodada.agente;
    let encerrou = false;
    // Espelho do index.ts: reunião criada neste turno que a fala do modelo não entregou.
    let confirmacaoPendente: ConfirmacaoAgendamento | null = null;
    const publicarConfirmacao = (motivo: string) => {
      if (!confirmacaoPendente) return;
      const fala = deps.humanizar(textoConfirmacaoAgendamento(confirmacaoPendente));
      const final = deps.prepararFala?.(fala) ?? fala;
      transcript.push({ quem: 'joao', texto: final, turno, confirmacao_em_codigo: motivo });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: final }] });
      confirmacaoPendente = null;
    };
    const consultasDoTurno = rodada.comFicha ? new MemoriaDeConsultas() : null;
    for (let volta = 0; volta < 6; volta++) {
      const contextoFicha = deps.fichaDaVolta?.(sanitizarHistorico(messages));
      const resp = await deps.chamarPrincipal({
        ...rodada, tools: encerrou ? [] : rodada.tools, messages: sanitizarHistorico(messages),
        ...(contextoFicha ? { contextoFicha } : {}),
      });
      chamadas.push({ turno, volta: volta + 1, agente, modelo: resp.model ?? null, usage: extrairUso(resp.usage), stop_reason: resp.stop_reason ?? null,
        raciocinio_encadeado: resp.raciocinio_encadeado === true, raciocinios_reenviados: resp.raciocinios_reenviados ?? 0 });
      const blocos = resp.content ?? [];
      const textoCru = blocos.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      let texto = deps.humanizar(textoCru);
      const toolUses = blocos.filter((b): b is BlocoModelo & { id: string; name: string } =>
        b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string');
      if (!toolUses.length && texto) texto = deps.prepararFala?.(texto) ?? texto;
      const pausasBloqueadas = new Set(toolUses.filter((tu) => tu.name === 'pausa_ia'
        && (tu.input as Record<string, unknown> | undefined)?.tipo === 'sem_graduacao'
        && !avaliarEvidenciaSemGraduacao(messages).autorizada).map((tu) => tu.id));
      // Thinking permanece só na memória necessária para a cadeia ativa de tools.
      if (blocos.length) messages.push({ role: 'assistant', content: !toolUses.length && deps.prepararFala && texto
        ? [{ type: 'text', text: texto }] : blocos });
      // 14/09/2026: texto junto de tool_use é intermediário, mesmo sem tags de
      // raciocínio. Só a resposta final pode aparecer como fala do João no ensaio.
      if (!toolUses.length && (texto || texto !== textoCru)) transcript.push({
        quem: 'joao', texto, turno,
        ...(texto !== textoCru ? { saida_filtrada: true, silenciado: !texto } : {}),
      });
      if (!toolUses.length) {
        if (texto) deps.aoResponder?.(texto);
        if (confirmacaoPendente && (!texto || !falaEntregaConfirmacao(texto, confirmacaoPendente))) {
          publicarConfirmacao(texto ? 'fala_sem_link' : 'silencio_apos_agendamento');
        }
        confirmacaoPendente = null;
        break;
      }

      const results = [];
      const toolsConcluidas: Encerramento[] = [];
      for (const tu of toolUses) {
        const bloqueadoPelaGuarda = pausasBloqueadas.has(tu.id);
        // Espelho do index.ts (canário): consulta idêntica já feita neste turno não executa de novo.
        const repetida = !bloqueadoPelaGuarda && (consultasDoTurno?.repetida(tu.name, tu.input) ?? false);
        const resultado = bloqueadoPelaGuarda ? JSON.stringify(bloqueioSemEvidenciaGraduacao(tu.id))
          : repetida ? JSON.stringify({ resultado: AVISO_CONSULTA_REPETIDA })
          : await deps.mockTool(tu.name, tu.input);
        let retornoTool: Record<string, unknown> = { resultado };
        // Retorno estruturado do mock também pode recusar uma ação; tentar pausar
        // não significa que ela foi concluída (mesmo contrato do executor real).
        try {
          const objeto = JSON.parse(resultado);
          if (objeto && typeof objeto === 'object' && !Array.isArray(objeto)) retornoTool = objeto;
        } catch { /* Mocks legados devolvem texto simples. */ }
        const bloqueado = bloqueadoPelaGuarda || retornoTool.status === 'bloqueado';
        if (tu.name === 'confirmar_agendamento' && !bloqueado) confirmacaoPendente = confirmacaoDoResultado(retornoTool) ?? confirmacaoPendente;
        transcript.push({ quem: 'tool', nome: tu.name, input: tu.input, resultado, simulado: true, turno, ...(bloqueado ? { bloqueado: true } : {}) });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: resultado });
        if (!bloqueado && toolConcluida(retornoTool)) toolsConcluidas.push({ tool: tu.name, input: (tu.input ?? {}) as Record<string, unknown> });
      }
      messages.push({ role: 'user', content: results });
      encerrou ||= toolsConcluidas.some((tu) => ['pausa_ia', 'temporizador_proxima_turma', 'agendar_retorno'].includes(tu.tool));
      // A despedida conhecida vem da mesma régua pura de produção, nunca do texto
      // intermediário do modelo. Motivo desconhecido ganha outra volta para responder.
      const encerramento = toolsConcluidas.find((tu) => respostaDoEncerramento(tu));
      const despedida = encerramento ? respostaDoEncerramento(encerramento) : null;
      if (despedida && toolsConcluidas.length === toolUses.length) {
        const conversaPublicada = [
          ...entrada.historico_inicial.map((m) => m.content),
          ...transcript.filter((m) => m.quem === 'lead' || m.quem === 'joao').map((m) => String(m.texto ?? '')),
        ].join('\n');
        const comPresente = entrada.sem_presente_escola ? despedida : comPresenteNaDespedida(
          despedida, encerramento!, conversaPublicada, entrada.esta_na_escola,
        ).texto;
        const humanizado = deps.humanizar(comPresente);
        const textoFinal = humanizado ? deps.prepararFala?.(humanizado) ?? humanizado : humanizado;
        if (textoFinal) {
          transcript.push({ quem: 'joao', texto: textoFinal, turno });
          messages.push({ role: 'assistant', content: [{ type: 'text', text: textoFinal }] });
        }
        break;
      }
      if (volta === 5) limites.push({ turno, motivo: 'limite de 6 chamadas do agente atingido' });
    }
    publicarConfirmacao('limite_de_voltas');
  }
  return {
    ok: true, modo: 'principal', persona: entrada.persona, agente, transcript,
    tools_chamadas: transcript.filter((t) => t.quem === 'tool').map((t) => t.nome),
    chamadas, limites_atingidos: limites, historico_inicial_turnos: entrada.historico_inicial.length,
  };
}

export type DependenciasFollowupSimulado = {
  gerar: (banco: unknown, lead: Record<string, unknown>, stage: number, tel: Telemetria, history: Msg[], materiais?: string,
    opcoes?: { provedor: ProvedorIA; contexto: string }) => Promise<{ message: string; final_answer: string; provedorResposta?: string; perguntaCarreira?: { escopo: string; pergunta_id: string } }>;
  humanizar: (texto: string) => string;
  provedor?: ProvedorIA | null;
};

export async function executarFollowupSimulado(entrada: EntradaSimulacao, deps: DependenciasFollowupSimulado) {
  if (entrada.modo !== 'followup') throw new Error('modo followup obrigatório');
  // gerarFollowup hoje só precisa de modelo + histórico. Se ganhar qualquer acesso
  // ao banco no futuro, este ensaio falha fechado antes de ler/gravar dados reais.
  const bancoBloqueado = new Proxy({}, { get() { throw new Error('banco indisponível na simulação de followup'); } });
  const eventos: Record<string, unknown>[] = [];
  const tel: Telemetria = {
    rodadaId: 'simulacao-followup-sem-persistencia',
    registrar(tipo, dados = {}, duracaoMs) {
      if (tipo !== 'llm_chamada') return;
      const evento: Record<string, unknown> = { tipo };
      for (const campo of ['volta', 'stage', 'tentativa', 'tokens_entrada', 'tokens_saida', 'cache_lido', 'cache_escrito']) {
        const valor = dados[campo];
        if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) evento[campo] = valor;
      }
      for (const campo of ['agente', 'modelo', 'stop_reason']) {
        if (typeof dados[campo] === 'string') evento[campo] = dados[campo];
      }
      if (typeof duracaoMs === 'number' && Number.isFinite(duracaoMs) && duracaoMs >= 0) evento.duracao_ms = duracaoMs;
      eventos.push(evento);
    },
  };
  const aula = entrada.persona === 'aula' ? entrada.aula : null;
  const jornada = entrada.mocks?.jornada && typeof entrada.mocks.jornada === 'object' ? entrada.mocks.jornada as Record<string, unknown> : {};
  const contexto = '\n\nDADOS JÁ COLETADOS (não perguntar de novo): ' + JSON.stringify(jornada.coleta ?? {})
    + (aula ? '\n\n' + INSTRUCAO_AULA_PILOTO + contextoAulaPiloto(aula) : '');
  const resultado = await deps.gerar(bancoBloqueado, {
    remotejid: 'simulacao-followup-sem-destino',
    nome: entrada.nome_lead,
    curso_interesse_original: aula ? aula.curso_nome ?? '' : entrada.curso,
    formacao_academica: entrada.formacao_academica,
    jornada,
  }, entrada.followup_stage, tel, entrada.historico_inicial.map((m) => ({ ...m })), '', deps.provedor ? { provedor: deps.provedor, contexto } : undefined);
  const message = deps.humanizar(resultado.message);
  return {
    ok: true, modo: 'followup', agente: 'followup',
    message, final_answer: resultado.final_answer,
    ...(resultado.provedorResposta ? { provedorResposta: resultado.provedorResposta } : {}),
    ...(resultado.perguntaCarreira ? { pergunta_carreira: resultado.perguntaCarreira } : {}),
    transcript: message ? [{ quem: 'joao', texto: message }] : [],
    tools_chamadas: [], routers: [], eventos,
    historico_inicial_turnos: entrada.historico_inicial.length,
    followup_stage: entrada.followup_stage,
    ...(message !== resultado.message ? { saida_filtrada: true } : {}),
  };
}
