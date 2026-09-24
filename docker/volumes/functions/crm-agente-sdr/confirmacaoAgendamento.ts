// Confirmação de agendamento garantida em código (24/09/2026).
//
// Depois que `confirmar_agendamento` cria a reunião, o lead PRECISA receber data, monitor e
// link — a reunião já existe na agenda do monitor, mesmo que a fala do modelo falhe. Medido
// em 14 dias de produção (206 agendamentos): 2 terminaram sem nenhuma fala (canal barrou a
// resposta como bastidor, 19 e 21/09) e 10 saíram sem o link ("show", "fechado então, terça
// às 19h", e duas vezes lixo interno "</antmlpar … System note" em 15/09). No simulador a
// Luna ficou calada depois de agendar em 4 de 8 conversas.
//
// O texto é o mesmo formato que o prompt do qualificador manda usar ("Horário reservado pra
// você"), com os dados que a própria tool devolveu. Módulo puro: sem banco, sem envio.

export type ConfirmacaoAgendamento = { data: string; monitor: string; link: string };

/** Vai no `resultado` da tool: a Luna segue o retorno ao pé da letra (visto em 19/09). */
export const INSTRUCAO_ENVIAR_CONFIRMACAO = 'Envie AGORA ao lead a confirmação no formato "Horário reservado pra você", '
  + 'com esta data, este monitor e este link exatamente como estão aqui — ele ainda não recebeu nada sobre a reunião.';

/**
 * `resultado` da tool, lido pelo modelo e pelo webchat. ⚠️ O link FECHA a linha: o webchat
 * extrai com /link:\s*(\S+)/ (crm-webchat/guardas.ts), e um ". Envie…" colado viraria parte
 * do link. A instrução vai na linha de baixo.
 */
export function resultadoConfirmacao(agendamentoId: string, c: ConfirmacaoAgendamento): string {
  return `Agendamento confirmado. id: ${agendamentoId}, data: ${c.data}, monitor: ${c.monitor}, link: ${c.link}\n`
    + INSTRUCAO_ENVIAR_CONFIRMACAO;
}

export function textoConfirmacaoAgendamento(c: ConfirmacaoAgendamento): string {
  return [
    'Horário reservado pra você:',
    `📅 ${c.data}`,
    `👨‍💼 Monitor ${c.monitor}`,
    // Sem link devolvido pela agenda, a linha sai: link inventado manda o lead pra sala errada.
    ...(c.link ? [`🔗 Link do meet: ${c.link}`] : []),
    '',
    'Se você não conseguir comparecer me avisa com 2h de antecedência para eu remanejar esse horário '
      + 'e qualquer dúvida é só me chamar por aqui.',
  ].join('\n');
}

/** Só um agendamento de fato criado (id + dados estruturados) gera confirmação pendente. */
export function confirmacaoDoResultado(output: unknown): ConfirmacaoAgendamento | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  const c = o.confirmacao as Record<string, unknown> | undefined;
  if (typeof o.agendamento_id !== 'string' || !o.agendamento_id || !c || typeof c !== 'object') return null;
  const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const data = texto(c.data);
  const monitor = texto(c.monitor);
  if (!data || !monitor) return null;
  return { data, monitor, link: texto(c.link) };
}

/**
 * A fala enviada já entrega a reunião? Com link, só vale se o link estiver nela; sem link,
 * basta citar o monitor (o modelo não tinha link para dar).
 */
export function falaEntregaConfirmacao(fala: string, c: ConfirmacaoAgendamento): boolean {
  if (c.link) return fala.includes(c.link);
  return fala.toLowerCase().includes(c.monitor.toLowerCase());
}
