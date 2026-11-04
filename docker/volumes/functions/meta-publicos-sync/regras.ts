// Regras PURAS da edge meta-publicos-sync (sem rede, testáveis no vitest).
// A edge em si está em ./index.ts; o porquê de cada regra está lá e em
// docs/Marketing — Mídia Paga.md → "Públicos do CRM na Meta".

/** Esquema fixo das linhas. A Meta exige o MESMO esquema em todos os lotes de uma sessão. */
export const ESQUEMA = ["EMAIL", "PHONE", "FN", "LN", "COUNTRY"] as const;

/** Limite documentado por chamada em /users e /usersreplace. */
export const LOTE_META = 10000;

export type Linha = [string, string, string, string, string];

export interface Lote {
  linhas: Linha[];
  batch_seq: number;
  last_batch_flag: boolean;
}

/** Divide as linhas em lotes de no máximo `tamanho`, numerados a partir de 1, com só o último marcado. */
export function dividirEmLotes(linhas: Linha[], tamanho = LOTE_META): Lote[] {
  if (!Number.isInteger(tamanho) || tamanho < 1) throw new Error("tamanho de lote inválido");
  const lotes: Lote[] = [];
  for (let i = 0; i < linhas.length; i += tamanho) {
    lotes.push({ linhas: linhas.slice(i, i + tamanho), batch_seq: lotes.length + 1, last_batch_flag: false });
  }
  if (lotes.length) lotes[lotes.length - 1].last_batch_flag = true;
  return lotes;
}

/** Corpo (formulário) de um lote para POST /{audiencia}/users ou /{audiencia}/usersreplace. */
export function corpoDoLote(lote: Lote, sessao: number, total: number, token: string): URLSearchParams {
  const corpo = new URLSearchParams();
  corpo.set("payload", JSON.stringify({ schema: ESQUEMA, data: lote.linhas }));
  corpo.set(
    "session",
    JSON.stringify({
      session_id: sessao,
      batch_seq: lote.batch_seq,
      last_batch_flag: lote.last_batch_flag,
      estimated_num_total: total,
    }),
  );
  corpo.set("access_token", token);
  return corpo;
}

/**
 * Identificador da sessão de envio: inteiro positivo e único na conta. A Meta aceita 64 bits;
 * ficamos abaixo do inteiro seguro do JavaScript para o número não mudar ao virar JSON.
 */
export function novaSessao(agora = Date.now(), aleatorio = Math.random()): number {
  return agora * 1000 + Math.floor(aleatorio * 1000);
}

type ErroGraph = {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
};

/** Mensagem legível de um erro da Graph API: o texto para o usuário quando houver, e os códigos. */
export function mensagemDeErroMeta(corpo: unknown, status: number): string {
  const e = (corpo as { error?: ErroGraph } | null)?.error;
  if (!e) return `HTTP ${status} sem corpo de erro`;
  const texto = [e.error_user_title, e.error_user_msg || e.message].filter(Boolean).join(": ");
  const codigos = [
    e.code != null ? `código ${e.code}` : null,
    e.error_subcode != null ? `subcódigo ${e.error_subcode}` : null,
  ].filter(Boolean).join(", ");
  return `${texto || "erro sem mensagem"}${codigos ? ` (${codigos})` : ""}`.slice(0, 500);
}

/**
 * O que fazer com um público de LISTA nesta rodada.
 *  - já tem id no catálogo  → atualizar por /usersreplace (não reinicia o aprendizado dos conjuntos)
 *  - existe na conta com o mesmo nome (rodada anterior caiu antes de gravar o id) → adotar e
 *    substituir o conteúdo, que é desconhecido
 *  - não existe → criar e fazer a 1ª carga por /users (ainda não está em conjunto nenhum)
 */
export function acaoDaLista(
  idNoCatalogo: string | null,
  idNaConta: string | undefined,
): { acao: "criar" | "adotar" | "atualizar"; endpoint: "users" | "usersreplace" } {
  if (idNoCatalogo) return { acao: "atualizar", endpoint: "usersreplace" };
  if (idNaConta) return { acao: "adotar", endpoint: "usersreplace" };
  return { acao: "criar", endpoint: "users" };
}

/** Especificação do semelhante: fração (0,01 = 1%) e país, no formato da Meta. */
export function especificacaoSemelhante(semelhanca: number, pais: string): string {
  if (!(semelhanca >= 0.01 && semelhanca <= 0.2)) throw new Error("semelhança fora de 1% a 20%");
  if (!/^[A-Z]{2}$/.test(pais)) throw new Error("país fora do formato ISO de 2 letras");
  return JSON.stringify({ ratio: Math.round(semelhanca * 100) / 100, country: pais });
}
