// Comentário de LIVE do Instagram → conversa (12/11/2026).
//
// Pedido do Gustavo, com a live da @ppgvet_oficial no ar ("Manda \"Pós\" aqui no chat e
// receba a condição exclusiva!"): "quero o comentário da live, quero que nasça a conversa".
// Até então o webhook só guardava `live_comments` no log cru — cinco pessoas comentaram
// "Pós" e nenhuma virou card.
//
// Como nasce: o comentário entra em `ig_mensagens` como mensagem DA PESSOA (tipo
// `live_comment`), e o gatilho de sempre (`trg_ig_mensagens_espelhar_sac`) cria o contato,
// a conversa e o card no SAC. O `from.id` do comentário é o MESMO IGSID das DMs (conferido
// com a @laura_camilotti: o id do comentário bate com o de `ig_perfis`), então quem já
// conversou com a gente cai na conversa que já tem.
//
// ⚠️ O que a Meta deixa fazer com um comentário de live (Private Replies):
//   · UMA mensagem por comentário, mandada por `recipient: { comment_id }`;
//   · SÓ enquanto a live está no ar — acabou a transmissão, não dá mais;
//   · a resposta privada NÃO abre a janela de 24h: só dá para continuar quando a pessoa
//     responder no direct.
// Por isso o comentário não conta como "última DM da pessoa" para a janela (ig-enviar) nem
// rouba a vez de uma DM de verdade no ig-agente.
//
// Módulo puro (sem banco, sem rede): teste em igComentarioDeLive.test.ts.

/** `ig_mensagens.tipo` do comentário de live. */
export const TIPO_COMENTARIO_DE_LIVE = "live_comment";
/** Tipos de entrada que NÃO são DM da pessoa: não abrem janela nem disputam a vez. */
export const TIPOS_QUE_NAO_SAO_DM = ["reaction", TIPO_COMENTARIO_DE_LIVE] as const;
/** Filtro pronto para o supabase-js: `.not("tipo", "in", FILTRO_NAO_SAO_DM)`. */
export const FILTRO_NAO_SAO_DM = `(${TIPOS_QUE_NAO_SAO_DM.join(",")})`;

// O rótulo vai no próprio texto: o atendente precisa VER que é comentário de live (e não
// DM) antes de responder, e o SAC mostra o conteúdo como ele está gravado.
export const ROTULO_COMENTARIO_DE_LIVE = "🔴 Comentou na live";

/** Chave de deduplicação em `ig_mensagens.mid` (a Meta reenvia webhook). */
export function midDoComentarioDeLive(commentId: string): string {
  return `live_comment:${commentId}`;
}

export function textoDoComentarioDeLive(texto: string | null | undefined): string {
  const t = String(texto ?? "").trim();
  return t ? `${ROTULO_COMENTARIO_DE_LIVE}: ${t}` : ROTULO_COMENTARIO_DE_LIVE;
}

export type LinhaComentarioDeLive = {
  conta_id: string;
  ig_user_id: string;
  contato_igsid: string;
  contato_username: string | null;
  direcao: "inbound";
  tipo: typeof TIPO_COMENTARIO_DE_LIVE;
  conteudo: string;
  mid: string;
  anexos: never[];
  metadata: {
    origem: "lead";
    is_echo: false;
    live_comment: true;
    comment_id: string;
    media_id: string | null;
    texto: string | null;
  };
};

/**
 * O `value` de um evento `live_comments` → a linha de `ig_mensagens`, ou null quando não
 * deve nascer conversa: conta não cadastrada, evento sem id/autor, ou comentário da
 * PRÓPRIA conta (a PPGVET comentando na própria live).
 */
// deno-lint-ignore no-explicit-any
export function linhaDoComentarioDeLive(contaId: string | null, igUserId: string, value: any): LinhaComentarioDeLive | null {
  const commentId = String(value?.id ?? "").trim();
  const autor = String(value?.from?.id ?? "").trim();
  if (!contaId || !commentId || !autor) return null;
  if (autor === igUserId) return null;
  const texto = String(value?.text ?? "").trim() || null;
  return {
    conta_id: contaId,
    ig_user_id: igUserId,
    contato_igsid: autor,
    contato_username: String(value?.from?.username ?? "").trim() || null,
    direcao: "inbound",
    tipo: TIPO_COMENTARIO_DE_LIVE,
    conteudo: textoDoComentarioDeLive(texto),
    mid: midDoComentarioDeLive(commentId),
    anexos: [],
    metadata: {
      origem: "lead",
      is_echo: false,
      live_comment: true,
      comment_id: commentId,
      media_id: value?.media?.id ? String(value.media.id) : null,
      texto,
    },
  };
}
