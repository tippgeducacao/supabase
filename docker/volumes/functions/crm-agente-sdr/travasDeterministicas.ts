// Travas determinísticas da Luna (29/09/2026, canário). As "regras de ouro" que moravam no prompt
// (horário e valor só das ferramentas, reunião só depois de criada) saíram do texto e viraram
// conferência em código: em vez de PEDIR para a IA não inventar, o sistema CONFERE e barra.
//
// Onde cada uma age:
//  · conferirHorarioDaFerramenta → ao CHAMAR confirmar_agendamento / remarcar_agendamento (tools.ts):
//    data, horário e vendedor têm de ser um slot devolvido por consulta_disponibilidade.
//  · horariosNaoOfertados, valoresInventados, afirmaReuniaoSemCriar → na FALA, antes do envio
//    (index.ts): 1ª vez volta para a IA corrigir; reincidência não é enviada.
// Tudo lê o histórico da rodada (os tool_result guardam o JSON da saída de cada ferramenta).
import type { Msg } from './historico.ts';

export type OpcaoAgenda = { data: string; horario: string; vendedor_id: string; vendedor_nome?: string };
export type ResultadoTrava = { ok: true } | { ok: false; motivo: string; mensagem: string };

/** Quantas consultas de agenda para trás valem como "oferecidas" (o lead pode escolher da anterior). */
const CONSULTAS_VALIDAS = 3;

const normHora = (h: unknown) => {
  const m = String(h ?? '').trim().match(/^(\d{1,2}):?(\d{2})?$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2] ?? '00'}` : String(h ?? '').trim();
};

/** Saídas de ferramenta guardadas no histórico (tool_result com o JSON), da mais antiga à mais nova. */
export function resultadosDeFerramenta(historico: readonly Msg[]): Record<string, unknown>[] {
  const saida: Record<string, unknown>[] = [];
  for (const m of historico) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Record<string, unknown>[]) {
      if (b?.type !== 'tool_result') continue;
      const c = typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? (b.content as Record<string, unknown>[]).map((x) => String(x?.text ?? '')).join('') : '';
      try {
        const o = JSON.parse(c);
        if (o && typeof o === 'object' && !Array.isArray(o)) saida.push(o as Record<string, unknown>);
      } catch { /* resultado em texto livre: não é de agenda */ }
    }
  }
  return saida;
}

/** Slots das últimas consultas de agenda desta conversa. null = nenhuma consulta. */
export function opcoesDeAgenda(historico: readonly Msg[]): OpcaoAgenda[] | null {
  const consultas = resultadosDeFerramenta(historico).filter((r) => Array.isArray(r.slots_raw));
  if (!consultas.length) return null;
  return consultas.slice(-CONSULTAS_VALIDAS).flatMap((r) => (r.slots_raw as Record<string, unknown>[]).map((s) => ({
    data: String(s.data ?? ''), horario: normHora(s.horario), vendedor_id: String(s.vendedor_id ?? ''),
    ...(s.vendedor_nome ? { vendedor_nome: String(s.vendedor_nome) } : {}),
  })));
}

/**
 * Slots a partir da resposta da consulta de agenda, para o simulador: o JSON do executor real (replay
 * de conversa, com `slots_raw`) ou o TEXTO do mock sintético ("- 15h30 de quinta, dia 2026-10-01
 * (vendedor_id: 7, nome: Ana)"), que segue o mesmo formato das linhas do executor real.
 */
export function slotsDoTextoDeAgenda(resposta: string): OpcaoAgenda[] {
  let texto = String(resposta ?? '');
  try {
    const j = JSON.parse(texto);
    if (Array.isArray(j?.slots_raw)) return opcoesDeAgenda(historicoDeConsultas([j.slots_raw])) ?? [];
    if (typeof j?.resultado === 'string') texto = j.resultado;
  } catch { /* texto puro */ }
  return [...texto.matchAll(/^- (\d{1,2})h(\d{2})? de [^,\n]+, dia (\d{4}-\d{2}-\d{2}) \(vendedor_id: ([^,)]+), nome: ([^)]*)\)/gm)]
    .map((m) => ({ data: m[3], horario: `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`, vendedor_id: m[4].trim(), vendedor_nome: m[5].trim() }));
}

/** Histórico mínimo com as consultas feitas (para conferir fora do agente, ex.: no simulador). */
export function historicoDeConsultas(consultas: readonly unknown[][]): Msg[] {
  return consultas.map((slots) => ({
    role: 'user', content: [{ type: 'tool_result', tool_use_id: 'consulta', content: JSON.stringify({ slots_raw: slots }) }],
  }));
}

function listaDeOpcoes(opcoes: OpcaoAgenda[]): string {
  if (!opcoes.length) return '(a última consulta não trouxe horário livre)';
  return opcoes.slice(-9).map((o) => `- ${o.data} ${o.horario} · vendedor_id ${o.vendedor_id}${o.vendedor_nome ? ` (${o.vendedor_nome})` : ''}`).join('\n');
}

/**
 * Ao agendar/remarcar: o horário precisa ser um slot que a agenda devolveu (data + horário + vendedor)
 * e ainda estar no futuro. `vendedorObrigatorio` = false no remarcar sem vendedor (mantém o atual).
 */
export function conferirHorarioDaFerramenta(
  input: { data_escolhida?: unknown; horario_escolhido?: unknown; vendedor_id?: unknown },
  historico: readonly Msg[],
  opts: { vendedorObrigatorio: boolean; agora?: Date },
): ResultadoTrava {
  const opcoes = opcoesDeAgenda(historico);
  const data = String(input.data_escolhida ?? '').trim();
  const hora = normHora(input.horario_escolhido);
  const vendedor = input.vendedor_id == null || String(input.vendedor_id).trim() === '' ? null : String(input.vendedor_id).trim();
  const recusa = (motivo: string, porque: string): ResultadoTrava => ({
    ok: false, motivo,
    mensagem: `NÃO FEITO: ${porque} Nada foi agendado. Use exatamente um horário da lista abaixo (data, horário e vendedor_id), `
      + `ou rode consulta_disponibilidade de novo para o dia que o lead pediu. Não diga ao lead que está marcado.\n`
      + `Opções das últimas consultas de agenda:\n${listaDeOpcoes(opcoes ?? [])}`,
  });
  if (!opcoes) return recusa('sem_consulta', 'nenhuma consulta de agenda foi feita nesta conversa.');
  const mesmoHorario = opcoes.filter((o) => o.data === data && o.horario === hora);
  if (!mesmoHorario.length) return recusa('horario_fora_da_consulta', `${data} ${hora} não veio de nenhuma consulta de agenda.`);
  if (vendedor !== null && !mesmoHorario.some((o) => o.vendedor_id === vendedor)) {
    return recusa('vendedor_diferente', `${data} ${hora} existe, mas com outro vendedor (vendedor_id ${mesmoHorario.map((o) => o.vendedor_id).join(' ou ')}), não ${vendedor}.`);
  }
  if (vendedor === null && opts.vendedorObrigatorio) return recusa('sem_vendedor', 'faltou o vendedor_id do horário escolhido.');
  const inicio = Date.parse(`${data}T${hora}:00-03:00`);
  if (!Number.isFinite(inicio) || inicio <= (opts.agora ?? new Date()).getTime()) {
    return recusa('horario_passou', `${data} ${hora} já passou.`);
  }
  return { ok: true };
}

// ── Na fala ────────────────────────────────────────────────────────────────────
const RE_HORA = /\b(\d{1,2})(?::(\d{2})|h(\d{2})?)\b/gi;
function horarios(texto: string): Set<string> {
  const out = new Set<string>();
  for (const m of texto.matchAll(RE_HORA)) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2] ?? m[3] ?? '0', 10);
    if (h <= 23 && min <= 59) out.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Texto das falas do LEAD. Não conta resultado de ferramenta nem turno interno: a correção que volta
 * para a IA ([CORRECAO_INTERNA_AUTO_IGNORE]) é gravada como `user` e CITA o texto barrado — contada
 * como fala do lead, o horário/valor inventado passaria na segunda tentativa.
 */
function falasDoLeadTexto(historico: readonly Msg[]): string {
  const doLead = (t: string) => !/AUTO_IGNORE\]/.test(t);
  return historico.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? (doLead(m.content) ? m.content : '')
    : Array.isArray(m.content) ? (m.content as Record<string, unknown>[]).filter((b) => b?.type === 'text' && doLead(String(b.text ?? '')))
      .map((b) => String(b.text ?? '')).join('\n') : '')
    .join('\n');
}

/**
 * Horários que a fala OFERECE (tem pergunta) e que não saíram das últimas consultas de agenda, nem da
 * boca do lead, nem de um agendamento real. Mais estrita que horariosInventados (saida.ts), que
 * aceitava qualquer horário que já tivesse aparecido na conversa, inclusive de consulta antiga.
 */
export function horariosNaoOfertados(resposta: string, historico: readonly Msg[]): string[] {
  if (!resposta.includes('?')) return [];
  const semDuracao = resposta.replace(/\b\d{1,2}h\s+de\s+anteced\w*/gi, '').replace(/\b(24|48)h\b/gi, '');
  const oferecidos = horarios(semDuracao);
  if (!oferecidos.size) return [];
  const permitidos = new Set<string>();
  for (const o of opcoesDeAgenda(historico) ?? []) permitidos.add(o.horario);
  for (const h of horarios(falasDoLeadTexto(historico))) permitidos.add(h);
  for (const r of resultadosDeFerramenta(historico)) {
    if (r.agendamento_id || r.confirmacao) for (const h of horarios(JSON.stringify(r))) permitidos.add(h);
  }
  return [...oferecidos].filter((h) => !permitidos.has(h));
}

const RE_DINHEIRO = /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|R\$\s?\d+(?:,\d{1,2})?|\b\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*reais\b/gi;
const centavos = (t: string) => {
  const n = t.replace(/R\$|reais/gi, '').trim().replace(/\./g, '').replace(',', '.');
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
};

/** Valores em dinheiro na fala que não vieram de nenhuma ferramenta nem do lead. */
export function valoresInventados(resposta: string, historico: readonly Msg[]): string[] {
  const achados = [...resposta.matchAll(RE_DINHEIRO)].map((m) => m[0].trim());
  if (!achados.length) return [];
  const fontes = resultadosDeFerramenta(historico).map((r) => JSON.stringify(r)).join('\n') + '\n' + falasDoLeadTexto(historico);
  const permitidos = new Set([...fontes.matchAll(RE_DINHEIRO)].map((m) => centavos(m[0])).filter(Number.isFinite));
  return achados.filter((a) => !permitidos.has(centavos(a)));
}

const RE_AFIRMA_MARCADA = [
  /\b(reuni[aã]o|conversa|hor[aá]rio|encaixe)\b[^.?!\n]{0,40}\b(est[aá]|t[aá]|ficou|foi|fica|j[aá])\s+(confirmad|marcad|agendad|reservad|garantid)[oa]/i,
  /\b(confirmad|marcad|agendad|reservad)[oa]s?\b[^.?!\n]{0,25}\b(sua|a|nossa)\s+(reuni[aã]o|conversa)/i,
  /\b(j[aá]\s+)?(marquei|agendei|reservei|confirmei)\b/i,
  /meet\.google\.com\//i,
];

/**
 * A fala diz que a reunião está marcada (ou manda link do Meet) sem nenhum agendamento criado:
 * nem nesta conversa (confirmar/remarcar com sucesso) nem antes (lead já agendado).
 */
export function afirmaReuniaoSemCriar(resposta: string, historico: readonly Msg[], leadJaAgendado: boolean): boolean {
  if (leadJaAgendado) return false;
  if (resultadosDeFerramenta(historico).some((r) => r.agendamento_id)) return false;
  return RE_AFIRMA_MARCADA.some((re) => re.test(resposta));
}

/** Correção interna (não vai ao lead): diz o que foi barrado e manda refazer preservando o resto. */
export function correcaoDaFala(motivo: 'valor' | 'reuniao', texto: string, detalhe: string): string {
  const porque = motivo === 'valor'
    ? `cita valor(es) (${detalhe}) que não vieram de nenhuma ferramenta nesta conversa. Valor só sai do retorno de envia_informacoes: rode envia_informacoes ou fale sem citar número`
    : 'diz que a reunião está marcada/confirmada (ou manda link), mas nenhum agendamento foi criado. Reunião só existe depois que confirmar_agendamento retorna sucesso: se o lead escolheu horário, confira elegibilidade e agende; senão, não afirme que está marcado';
  return '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada ao lead: ela ' + porque + '. O texto barrado foi:\n'
    + `"""\n${texto.slice(0, 600)}\n"""\n`
    + 'Refaça agora PRESERVANDO todo o resto do conteúdo (acolhimento, quebra de objeção, argumento). '
    + 'Mude só o trecho barrado e não mencione esta correção ao lead.';
}
