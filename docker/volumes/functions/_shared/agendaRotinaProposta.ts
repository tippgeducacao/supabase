// Régua PURA da proposta de rotinas da Agenda automática (piloto, 20/10/2026).
//
// A IA lê o relatório livre da pessoa e devolve rotinas estruturadas; ESTE arquivo é quem
// decide o que vale. Três garantias, testadas em agendaRotinaProposta.test.ts:
//  1. "Informado" só se o TRECHO citado existe de verdade no relatório. Trecho inventado
//     ou ausente rebaixa o campo para "suposição".
//  2. Campo ESSENCIAL (frequência/dias, horário de início da fixa, duração) nunca fica com
//     valor suposto: é apagado e vira pergunta. Não se inventa horário, frequência ou
//     duração como se a pessoa tivesse dito.
//  3. Tudo é saneado (tipos, faixas, tamanhos): a saída da IA é dado não confiável.
//
// Sem Deno nem React: roda no edge (agenda-rotina-interpretar) e no vitest.

export const CAMPOS_EVIDENCIA = ['frequencia', 'dias', 'horario', 'janela', 'duracao', 'prioridade'] as const;
export type CampoEvidencia = (typeof CAMPOS_EVIDENCIA)[number];
export type StatusEvidencia = 'informado' | 'suposicao' | 'faltando';

export interface Evidencia {
  campo: CampoEvidencia;
  status: StatusEvidencia;
  trecho: string | null;
}

export interface RotinaProposta {
  titulo: string;
  descricao: string | null;
  tipo: 'fixa' | 'flexivel' | 'indisponivel';
  frequencia: 'diaria' | 'semanal' | 'mensal' | null;
  intervalo: number;
  dias_semana: number[];
  dia_mes: number | null;
  so_dias_de_jornada: boolean;
  hora_inicio: string | null;
  janela_inicio: string | null;
  janela_fim: string | null;
  duracao_min: number | null;
  prioridade: 'urgent' | 'high' | 'normal' | 'low';
  pula_feriado: boolean;
  evidencias: Evidencia[];
}

export interface Pergunta {
  rotina: number | null; // índice 1-based na lista de rotinas; null = geral
  campo: string;
  pergunta: string;
}

export interface PropostaValidada {
  rotinas: RotinaProposta[];
  perguntas: Pergunta[];
  suposicoes: string[];
  fora_do_escopo: string[];
  duracao_padrao_tarefa_min: number | null;
  duracao_padrao_trecho: string | null;
  avisos_validacao: string[];
}

export const LIMITE_RELATORIO = 8000;
const MAX_ROTINAS = 40;
const MAX_PERGUNTAS = 20;

const nulavel = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/** JSON Schema da saída estruturada (output_config.format). Todo objeto fechado. */
export const SCHEMA_PROPOSTA = {
  type: 'object',
  additionalProperties: false,
  required: ['rotinas', 'perguntas', 'suposicoes', 'fora_do_escopo', 'duracao_padrao_tarefa_min', 'duracao_padrao_trecho'],
  properties: {
    rotinas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titulo', 'descricao', 'tipo', 'frequencia', 'intervalo', 'dias_semana', 'dia_mes', 'so_dias_de_jornada',
          'hora_inicio', 'janela_inicio', 'janela_fim', 'duracao_min', 'prioridade', 'evidencias'],
        properties: {
          titulo: { type: 'string', description: 'Nome curto da atividade, como a pessoa chamaria.' },
          descricao: nulavel({ type: 'string' }),
          tipo: { type: 'string', enum: ['fixa', 'flexivel', 'indisponivel'] },
          frequencia: nulavel({ type: 'string', enum: ['diaria', 'semanal', 'mensal'] }),
          intervalo: nulavel({ type: 'integer' }),
          dias_semana: { type: 'array', items: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6] } },
          dia_mes: nulavel({ type: 'integer' }),
          so_dias_de_jornada: { type: 'boolean' },
          hora_inicio: nulavel({ type: 'string', description: 'HH:MM, 24 h' }),
          janela_inicio: nulavel({ type: 'string', description: 'HH:MM, 24 h' }),
          janela_fim: nulavel({ type: 'string', description: 'HH:MM, 24 h' }),
          duracao_min: nulavel({ type: 'integer' }),
          prioridade: nulavel({ type: 'string', enum: ['urgent', 'high', 'normal', 'low'] }),
          evidencias: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['campo', 'status', 'trecho'],
              properties: {
                campo: { type: 'string', enum: [...CAMPOS_EVIDENCIA] },
                status: { type: 'string', enum: ['informado', 'suposicao', 'faltando'] },
                trecho: nulavel({ type: 'string', description: 'Cópia LITERAL do relatório que sustenta o valor.' }),
              },
            },
          },
        },
      },
    },
    perguntas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rotina', 'campo', 'pergunta'],
        properties: {
          rotina: nulavel({ type: 'integer' }),
          campo: { type: 'string' },
          pergunta: { type: 'string' },
        },
      },
    },
    suposicoes: { type: 'array', items: { type: 'string' } },
    fora_do_escopo: { type: 'array', items: { type: 'string' } },
    duracao_padrao_tarefa_min: nulavel({ type: 'integer' }),
    duracao_padrao_trecho: nulavel({ type: 'string' }),
  },
} as const;

/** Minúsculas, sem acento, espaços colapsados, aspas/travessões unificados. */
export function normalizarTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** O trecho citado existe no relatório? (comparação tolerante a acento/caixa/espaço) */
export function trechoNoRelatorio(trecho: string | null | undefined, relatorioNormalizado: string): boolean {
  if (!trecho) return false;
  const t = normalizarTexto(trecho).replace(/^["'.,;:\-\s]+|["'.,;:\-\s]+$/g, '');
  return t.length >= 2 && relatorioNormalizado.includes(t);
}

const texto = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

const inteiro = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** "9h", "09:00", "9:5" → "09:00"/"09:05"; o resto → null. */
export function hora(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^([01]?\d|2[0-3])(?::([0-5]\d))?$/) ?? v.trim().match(/^([01]?\d|2[0-3])h(?:([0-5]\d))?$/i);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${(m[2] ?? '00').padStart(2, '0')}`;
}

const minutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const ROTULO_CAMPO: Record<CampoEvidencia, string> = {
  frequencia: 'a frequência',
  dias: 'os dias',
  horario: 'o horário de início',
  janela: 'a faixa de horário',
  duracao: 'a duração aproximada',
  prioridade: 'a prioridade',
};

/**
 * Valida e saneia a saída da IA contra o relatório ORIGINAL. Nunca lança: entrada
 * irreconhecível vira proposta vazia com aviso (a pessoa ainda pode montar à mão).
 */
export function validarProposta(bruto: unknown, relatorio: string): PropostaValidada {
  const avisos: string[] = [];
  const rel = normalizarTexto(relatorio);
  const obj = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto as Record<string, unknown> : {};
  const lista = Array.isArray(obj.rotinas) ? obj.rotinas : [];
  if (!Array.isArray(obj.rotinas)) avisos.push('A resposta não trouxe a lista de rotinas.');
  if (lista.length > MAX_ROTINAS) avisos.push(`A resposta trouxe ${lista.length} rotinas; ficaram as ${MAX_ROTINAS} primeiras.`);

  const perguntas: Pergunta[] = [];
  const rotinas: RotinaProposta[] = [];

  for (const item of lista.slice(0, MAX_ROTINAS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const titulo = texto(r.titulo, 160);
    if (!titulo) {
      avisos.push('Uma rotina sem nome foi descartada.');
      continue;
    }
    const idx = rotinas.length + 1;

    // Evidências: uma por campo; a última palavra é do relatório, não da IA.
    const evs = new Map<CampoEvidencia, Evidencia>();
    for (const e of Array.isArray(r.evidencias) ? r.evidencias : []) {
      if (!e || typeof e !== 'object') continue;
      const ev = e as Record<string, unknown>;
      const campo = CAMPOS_EVIDENCIA.find((c) => c === ev.campo);
      if (!campo || evs.has(campo)) continue;
      let status: StatusEvidencia = ev.status === 'informado' || ev.status === 'suposicao' ? ev.status : 'faltando';
      const trecho = texto(ev.trecho, 300);
      if (status === 'informado' && !trechoNoRelatorio(trecho, rel)) {
        status = 'suposicao';
        avisos.push(`"${titulo}": ${ROTULO_CAMPO[campo]} foi marcado como informado, mas o trecho citado não está no seu texto — tratado como suposição.`);
      }
      evs.set(campo, { campo, status, trecho: status === 'informado' ? trecho : (trecho && trechoNoRelatorio(trecho, rel) ? trecho : null) });
    }
    const statusDe = (c: CampoEvidencia): StatusEvidencia => evs.get(c)?.status ?? 'faltando';
    const marcarFaltando = (c: CampoEvidencia) => evs.set(c, { campo: c, status: 'faltando', trecho: null });

    const tipo = r.tipo === 'fixa' || r.tipo === 'indisponivel' ? r.tipo : 'flexivel';
    let frequencia = r.frequencia === 'diaria' || r.frequencia === 'semanal' || r.frequencia === 'mensal' ? r.frequencia : null;
    let dias = Array.isArray(r.dias_semana)
      ? [...new Set(r.dias_semana.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    let diaMes = inteiro(r.dia_mes, 1, 31);
    let horaInicio = hora(r.hora_inicio);
    let janelaIni = hora(r.janela_inicio);
    let janelaFim = hora(r.janela_fim);
    let duracao = inteiro(r.duracao_min, 5, 720);
    const intervalo = inteiro(r.intervalo, 1, 12) ?? 1;
    let prioridade = r.prioridade === 'urgent' || r.prioridade === 'high' || r.prioridade === 'low' ? r.prioridade : 'normal';
    if (r.prioridade == null && statusDe('prioridade') !== 'faltando') marcarFaltando('prioridade');

    // Essencial suposto = apagado e perguntado. Frequência e dias andam juntos.
    const essencialOk = (c: CampoEvidencia) => statusDe(c) === 'informado';
    if (!frequencia || !essencialOk('frequencia')) {
      frequencia = null;
      marcarFaltando('frequencia');
    }
    // "Toda semana" não diz QUAL dia: os dias precisam de evidência própria.
    if (frequencia === 'semanal') {
      if (dias.length === 0 || !essencialOk('dias')) {
        dias = [];
        marcarFaltando('dias');
      }
    } else {
      dias = [];
    }
    if (frequencia === 'mensal' && (!diaMes || !essencialOk('dias'))) {
      diaMes = null;
      marcarFaltando('dias');
    }
    if (frequencia !== 'mensal') diaMes = null;
    if (tipo !== 'flexivel') {
      if (!horaInicio || !essencialOk('horario')) {
        horaInicio = null;
        marcarFaltando('horario');
      }
    } else {
      horaInicio = null;
    }
    if (!duracao || !essencialOk('duracao')) {
      duracao = null;
      marcarFaltando('duracao');
    }
    // Janela é opcional: pode ficar como suposição VISÍVEL; inválida some.
    if (!janelaIni || !janelaFim || minutos(janelaFim) <= minutos(janelaIni)) {
      if (janelaIni || janelaFim) avisos.push(`"${titulo}": a faixa de horário veio incompleta e foi ignorada.`);
      janelaIni = null;
      janelaFim = null;
      evs.delete('janela');
    }
    if (prioridade !== 'normal' && statusDe('prioridade') === 'faltando') prioridade = 'normal';

    for (const c of CAMPOS_EVIDENCIA) {
      const necessario = c === 'frequencia' || c === 'duracao' || (c === 'horario' && tipo !== 'flexivel')
        || (c === 'dias' && (frequencia === 'semanal' || frequencia === 'mensal'));
      if (necessario && statusDe(c) === 'faltando') {
        perguntas.push({
          rotina: idx,
          campo: c,
          pergunta: c === 'dias' && frequencia === 'mensal'
            ? `Em que dia do mês acontece "${titulo}"?`
            : c === 'dias' ? `Em quais dias da semana acontece "${titulo}"?`
              : c === 'frequencia' ? `Com que frequência acontece "${titulo}"?`
                : c === 'horario' ? `Que horas começa "${titulo}"?`
                  : `Quanto tempo, aproximadamente, leva "${titulo}"?`,
        });
      }
    }

    rotinas.push({
      titulo,
      descricao: texto(r.descricao, 1000),
      tipo,
      frequencia,
      intervalo,
      dias_semana: dias,
      dia_mes: diaMes,
      so_dias_de_jornada: r.so_dias_de_jornada === true && frequencia === 'diaria',
      hora_inicio: horaInicio,
      janela_inicio: janelaIni,
      janela_fim: janelaFim,
      duracao_min: duracao,
      prioridade,
      pula_feriado: true,
      evidencias: CAMPOS_EVIDENCIA.filter((c) => evs.has(c)).map((c) => evs.get(c)!),
    });
  }

  // Perguntas gerais da IA (ex.: restrição vaga) entram depois das obrigatórias, sem repetir campo.
  for (const p of Array.isArray(obj.perguntas) ? obj.perguntas : []) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    const pergunta = texto(q.pergunta, 300);
    if (!pergunta) continue;
    const rotina = inteiro(q.rotina, 1, rotinas.length);
    const campo = texto(q.campo, 40) ?? 'geral';
    if (perguntas.some((x) => x.rotina === rotina && x.campo === campo)) continue;
    perguntas.push({ rotina, campo, pergunta });
  }

  const duracaoPadrao = inteiro(obj.duracao_padrao_tarefa_min, 5, 480);
  const trechoPadrao = texto(obj.duracao_padrao_trecho, 300);
  const padraoValido = duracaoPadrao !== null && trechoNoRelatorio(trechoPadrao, rel);
  if (duracaoPadrao !== null && !padraoValido) {
    avisos.push('A duração padrão para tarefas sem estimativa não está no seu texto e não foi usada.');
  }

  return {
    rotinas,
    perguntas: perguntas.slice(0, MAX_PERGUNTAS),
    suposicoes: (Array.isArray(obj.suposicoes) ? obj.suposicoes : []).map((s) => texto(s, 300)).filter((s): s is string => !!s).slice(0, 20),
    fora_do_escopo: (Array.isArray(obj.fora_do_escopo) ? obj.fora_do_escopo : []).map((s) => texto(s, 300)).filter((s): s is string => !!s).slice(0, 20),
    duracao_padrao_tarefa_min: padraoValido ? duracaoPadrao : null,
    duracao_padrao_trecho: padraoValido ? trechoPadrao : null,
    avisos_validacao: avisos.slice(0, 30),
  };
}

const NOMES_DIA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'] as const;
const ABREV_DIA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

type Cfg = { periodo1_inicio?: string; periodo1_fim?: string; periodo2_inicio?: string; periodo2_fim?: string } | null | undefined;
interface Jornada {
  manha_inicio?: string; manha_fim?: string; tarde_inicio?: string; tarde_fim?: string;
  dias_trabalho?: string; dias_personalizados?: unknown;
  dias_horarios?: Record<string, Cfg>; segunda_sexta?: Cfg; sabado?: Cfg;
}

/**
 * Períodos de trabalho num dia da semana — espelho de obterPeriodosHorarioNoDia
 * (src/utils/horarioUtils.ts) e de agenda_auto_periodos_jornada (SQL). Sem padrão inventado.
 */
export function periodosDaJornada(ht: unknown, dow: number): { inicio: string; fim: string }[] {
  if (!ht || typeof ht !== 'object') return [];
  const h = ht as Jornada;
  const deCfg = (cfg: Cfg) => {
    const out: { inicio: string; fim: string }[] = [];
    if (cfg?.periodo1_inicio && cfg?.periodo1_fim) out.push({ inicio: cfg.periodo1_inicio, fim: cfg.periodo1_fim });
    if (cfg?.periodo2_inicio && cfg?.periodo2_fim) out.push({ inicio: cfg.periodo2_inicio, fim: cfg.periodo2_fim });
    return out;
  };
  if (h.manha_inicio) {
    if (dow < 1 || dow > 5) return [];
    return deCfg({ periodo1_inicio: h.manha_inicio, periodo1_fim: h.manha_fim, periodo2_inicio: h.tarde_inicio, periodo2_fim: h.tarde_fim });
  }
  const nome = NOMES_DIA[dow];
  if (h.dias_horarios && typeof h.dias_horarios === 'object') {
    const cfg = h.dias_horarios[nome];
    if (!cfg?.periodo1_inicio || !cfg?.periodo1_fim) return [];
    return deCfg(cfg);
  }
  const trabalha = h.dias_trabalho === 'segunda_sabado' ? dow >= 1 && dow <= 6
    : h.dias_trabalho === 'personalizado' ? Array.isArray(h.dias_personalizados) && h.dias_personalizados.includes(nome)
      : false;
  if (!trabalha) return [];
  return deCfg(dow === 6 ? h.sabado : h.segunda_sexta);
}

/** "seg–sex 08:30–12:00, 13:00–17:30 · sáb 08:00–12:00" (ou null sem jornada legível). */
export function resumoJornada(ht: unknown): string | null {
  const grupos: { dias: number[]; texto: string }[] = [];
  for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
    const p = periodosDaJornada(ht, dow);
    if (!p.length) continue;
    const t = p.map((x) => `${x.inicio}–${x.fim}`).join(', ');
    const ult = grupos[grupos.length - 1];
    if (ult && ult.texto === t && ult.dias[ult.dias.length - 1] === (dow === 0 ? 6 : dow - 1)) ult.dias.push(dow);
    else grupos.push({ dias: [dow], texto: t });
  }
  if (!grupos.length) return null;
  return grupos
    .map((g) => `${g.dias.length > 2 ? `${ABREV_DIA[g.dias[0]]}–${ABREV_DIA[g.dias[g.dias.length - 1]]}` : g.dias.map((d) => ABREV_DIA[d]).join(', ')} ${g.texto}`)
    .join(' · ');
}

/** Remove qualquer tentativa de fechar a moldura de dados dentro do relatório. */
export function emoldurarRelatorio(relatorio: string): string {
  const limpo = relatorio.slice(0, LIMITE_RELATORIO).replace(/<\/?\s*relatorio\s*>/gi, '');
  return `<relatorio>\n${limpo}\n</relatorio>`;
}
