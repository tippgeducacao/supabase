// A IA abre a conversa de quem COMENTOU numa live (12/11/2026).
//
// O comentário já virava card no SAC (ver _shared/igComentarioDeLive.ts), mas a IA ficava
// de fora: "e pq a IA não respondeu eles?" (Gustavo, com a live no ar). A Meta deixa mandar
// UMA mensagem por comentário, só com a live no ar — então a abertura da IA para o direct
// (dois balões, pensados para responder o "Oii, tudo bem?" do ManyChat) não serve. A frase
// daqui é uma só, montada com o que o comercial já tinha aprovado, e foi aprovada pelo
// Gustavo em 12/11/2026 (`TEXTOS.aberturaComentarioDeLive`, em fluxo.ts).
//
// Quando a IA NÃO manda (o card continua com o SDR):
//   · conversa pausada (alguém do time respondeu) ou começada pelo time — quem já conversa
//     com um SDR não recebe a IA por cima (decisão do Gustavo, 12/11);
//   · o roteiro já passou da pergunta de formação: perguntar de novo a quem já disse o
//     curso, ou já passou o WhatsApp, seria andar para trás;
//   · a pessoa já recebeu uma resposta a comentário nas últimas 24h (dela ou do SDR): uma
//     abertura por pessoa, mesmo que comente dez vezes.
//
// Módulo puro (sem banco, sem rede): o que toca banco e Instagram está em index.ts.
import type { EtapaFluxo } from "./fluxo.ts";

/** Etapas em que a abertura ainda faz sentido: a pessoa não disse a formação. */
export const ETAPAS_QUE_ACEITAM_ABERTURA: readonly EtapaFluxo[] = ["boas_vindas", "pergunta_formacao"];

/** Por quanto tempo uma resposta a comentário vale como "já abri com esta pessoa". */
export const JANELA_ABERTURA_POR_COMENTARIO_MS = 24 * 60 * 60 * 1000;

export type DecisaoAbertura =
  | { abre: true }
  | { abre: false; motivo: "roteiro_em_andamento" | "ja_respondeu_comentario" };

export function decidirAberturaPorComentario(e: {
  etapa: string | null | undefined;
  jaRespondeuComentario: boolean;
}): DecisaoAbertura {
  const etapa = (e.etapa ?? "boas_vindas") as EtapaFluxo;
  if (!ETAPAS_QUE_ACEITAM_ABERTURA.includes(etapa)) return { abre: false, motivo: "roteiro_em_andamento" };
  if (e.jaRespondeuComentario) return { abre: false, motivo: "ja_respondeu_comentario" };
  return { abre: true };
}

/** Linha de `ig_mensagens` (saída nossa) → foi uma resposta a comentário que saiu? */
// deno-lint-ignore no-explicit-any
export function ehRespostaAComentario(m: any): boolean {
  return m?.direcao === "outbound" && m?.status_entrega !== "failed" && m?.metadata?.resposta_privada === true;
}
