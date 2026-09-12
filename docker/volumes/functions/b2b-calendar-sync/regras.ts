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
    extendedProperties: { private: { ppg_agendamento_id: reuniao.id, ppg_responsavel_id: reuniao.vendedor_id } },
  };
}

export async function hashConteudoB2B(corpo: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(corpo));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
