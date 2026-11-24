export interface ReuniaoB2B {
  id: string;
  vendedor_id: string;
  data_agendamento: string;
  data_fim_agendamento: string | null;
  status: string;
  nome_empresa: string | null;
  produto_b2b: string | null;
  pos_graduacao_interesse: string | null;
  nome_decisor: string | null;
  link_reuniao: string | null;
  google_event_id: string | null;
  updated_at: string;
  /** E-mail do lead que recebe o convite do Google (24/11/2026). Ausente/null = sem convite. */
  convidado_email?: string | null;
}

/** Convidado da reunião, já normalizado; `null` quando não há (ou não é e-mail). */
export function convidadoDaReuniao(reuniao: Pick<ReuniaoB2B, 'convidado_email'>): string | null {
  const email = (reuniao.convidado_email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

export function reuniaoCancelada(status: string): boolean {
  return ['cancelado', 'cancelada', 'desmarcado', 'desmarcada', 'desqualificado', 'desqualificada'].includes(status.toLowerCase());
}

export function idEventoB2B(agendamentoId: string, userId: string, geracao = 0): string {
  // UUIDs sem hífen + prefixo usam exclusivamente o alfabeto base32hex do Google.
  return `ppgb2b${agendamentoId.replaceAll('-', '')}${userId.replaceAll('-', '')}g${geracao}`;
}

export function corpoEventoB2B(reuniao: ReuniaoB2B): Record<string, unknown> {
  const inicio = new Date(reuniao.data_agendamento);
  const fim = reuniao.data_fim_agendamento
    ? new Date(reuniao.data_fim_agendamento)
    : new Date(inicio.getTime() + 30 * 60_000);
  if (!Number.isFinite(inicio.getTime()) || !Number.isFinite(fim.getTime()) || fim <= inicio) {
    throw new Error('A reunião precisa ter início e fim válidos.');
  }
  const produto = reuniao.produto_b2b || reuniao.pos_graduacao_interesse;
  const convidado = convidadoDaReuniao(reuniao);
  return {
    summary: `Reunião B2B — ${reuniao.nome_empresa || 'Empresa'}${produto ? ` (${produto})` : ''}`,
    description: [
      'Reunião B2B agendada no PPGVET.',
      reuniao.nome_decisor ? `Contato: ${reuniao.nome_decisor}.` : '',
      reuniao.link_reuniao ? `Acessar reunião: ${reuniao.link_reuniao}` : '',
    ].filter(Boolean).join('\n'),
    location: reuniao.link_reuniao || '',
    start: { dateTime: inicio.toISOString(), timeZone: 'America/Sao_Paulo' },
    end: { dateTime: fim.toISOString(), timeZone: 'America/Sao_Paulo' },
    // `ppg_convidado` marca QUAL convidado o sistema pôs: trocar ou tirar o e-mail mexe só
    // nele, e os convidados que a dona da agenda acrescentou à mão ficam. Sem convite, a
    // chave nem existe — assim o conteúdo (e o hash) das reuniões antigas não muda.
    extendedProperties: { private: {
      ppg_agendamento_id: reuniao.id, ppg_responsavel_id: reuniao.vendedor_id,
      ...(convidado ? { ppg_convidado: convidado } : {}),
    } },
  };
}

type Participante = { email?: string; responseStatus?: string; [campo: string]: unknown };
type EventoComConvidados = {
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Participante[];
  extendedProperties?: { private?: Record<string, string | undefined> };
};

/**
 * Convidados que o evento deve ter, a partir do que JÁ está no Google: tira o convidado que o
 * sistema pôs antes (marca `ppg_convidado`), põe o atual e preserva o resto (inclusive a
 * resposta "sim/não" do próprio lead, quando o e-mail não mudou).
 * `gerido = false` ⇒ o sistema nunca convidou ninguém aqui: não mandar `attendees`, para não
 * apagar convidado posto à mão.
 */
export function convidadosDoEvento(existente: EventoComConvidados | null | undefined, convidado: string | null) {
  const anterior = (existente?.extendedProperties?.private?.ppg_convidado ?? '').trim().toLowerCase() || null;
  if (!anterior && !convidado) return { gerido: false as const, attendees: undefined, mudou: false, limparMarca: false };
  const atuais = existente?.attendees ?? [];
  const mesmo = (p: Participante, email: string | null) => !!email && (p.email ?? '').trim().toLowerCase() === email;
  const outros = atuais.filter(p => !mesmo(p, anterior) && !mesmo(p, convidado));
  const doConvidado = convidado ? (atuais.find(p => mesmo(p, convidado)) ?? { email: convidado }) : null;
  const attendees = doConvidado ? [...outros, doConvidado] : outros;
  const tinha = !!convidado && atuais.some(p => mesmo(p, convidado));
  const mudou = anterior !== convidado || (!!convidado && !tinha);
  return { gerido: true as const, attendees, mudou, limparMarca: !!anterior && !convidado };
}

/**
 * Quando o LEAD recebe e-mail do Google: convite novo, troca de convidado ou mudança de
 * HORÁRIO. Mudança de título/descrição/link (o Meet chega depois, o link é gravado no
 * sistema e o hash muda) atualiza em silêncio — sem isso o lead levaria 3 e-mails por reunião.
 */
export function avisarConvidado(
  existente: EventoComConvidados | null | undefined,
  corpo: { start?: { dateTime?: string }; end?: { dateTime?: string } },
  convidados: ReturnType<typeof convidadosDoEvento>,
): 'all' | 'none' {
  if (!convidados.gerido) return 'none';
  if (convidados.mudou) return 'all';
  if (!convidados.attendees?.length) return 'none';
  const instante = (v?: { dateTime?: string; date?: string }) => {
    const t = v?.dateTime ? new Date(v.dateTime).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };
  return instante(existente?.start) !== instante(corpo.start) || instante(existente?.end) !== instante(corpo.end)
    ? 'all' : 'none';
}

export async function hashConteudoB2B(corpo: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(corpo));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
