/**
 * Regras puras da página /meu-atendimento/<token> (cadência por pós, e-mails v2 — 27/11/2026).
 * Ficam fora do `index.ts` para serem testadas sem o runtime da edge.
 */

/** 122 hex: lead (32) + modelo de e-mail (32) + card (32) + opção (2) + assinatura (24). */
export const TOKEN_OK = /^[0-9a-f]{122}$/;

export type AcaoPagina = "abrir" | "registrar";

export function acaoValida(valor: unknown): valor is AcaoPagina {
  return valor === "abrir" || valor === "registrar";
}

/** O que o link pede, lido do próprio token (a opção fica nos 2 hex antes da assinatura). */
export function tipoDoToken(token: string): "cronograma" | "resposta" | null {
  if (!TOKEN_OK.test(token)) return null;
  return token.slice(96, 98) === "00" ? "cronograma" : "resposta";
}

/**
 * Depois de registrar, vale a pena acordar o despachante do WhatsApp agora (em vez de esperar o
 * minuto do cron)? Só quando o clique realmente pôs mensagem na fila e a fila está curta: num
 * disparo em massa, uma segunda rodada em paralelo dobraria o ritmo e esbarraria no limite da Meta.
 */
export const FILA_CURTA_ATE = 40;
export function deveAcordarDespachante(resposta: { ok?: unknown; enviou?: unknown; repetido?: unknown }, naFila: number | null): boolean {
  if (resposta.ok !== true || resposta.enviou !== true || resposta.repetido === true) return false;
  return naFila !== null && naFila >= 1 && naFila <= FILA_CURTA_ATE;
}

/** Só o que a página usa sai da edge — nada de id, e-mail ou telefone inteiro. */
export function respostaDaPagina(dados: unknown): Record<string, unknown> {
  const d = (dados && typeof dados === "object" ? dados : {}) as Record<string, unknown>;
  if (d.ok !== true) return { ok: false, motivo: typeof d.motivo === "string" ? d.motivo : "link_invalido" };
  const texto = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const crono = (d.cronograma && typeof d.cronograma === "object" ? d.cronograma : {}) as Record<string, unknown>;
  const resp = (d.resposta && typeof d.resposta === "object" ? d.resposta : null) as Record<string, unknown> | null;
  // O valor INTEIRO tem de casar: cortar antes de conferir deixaria passar "99991082" como "9999".
  const exato = (v: unknown, formato: RegExp) => (typeof v === "string" && formato.test(v) ? v : "");
  const https = (v: unknown) => (typeof v === "string" && /^https:\/\/[^\s"'<>]{1,500}$/.test(v) ? v : null);
  return {
    ok: true,
    tipo: d.tipo === "cronograma" ? "cronograma" : "resposta",
    primeiro_nome: texto(d.primeiro_nome, 40),
    telefone_final: exato(d.telefone_final, /^[0-9]{4}$/),
    pos_nome: texto(d.pos_nome, 120),
    assina_nome: texto(d.assina_nome, 40),
    assina_whatsapp: exato(d.assina_whatsapp, /^55[0-9]{10,11}$/),
    cronograma: {
      url: https(crono.url),
      capa: https(crono.capa),
      paginas: typeof crono.paginas === "number" && crono.paginas > 0 ? crono.paginas : null,
    },
    resposta: resp
      ? { rotulo: texto(resp.rotulo, 160), tom: ["interesse", "agora_nao", "encerrar"].includes(String(resp.tom)) ? resp.tom : "interesse" }
      : null,
  };
}
