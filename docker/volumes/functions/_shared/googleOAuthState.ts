// `state` ASSINADO do OAuth do Google (agenda + Gmail) — 12/11/2026.
//
// Por que existe: o callback da `google-calendar-oauth` é público por natureza (quem chega nele
// é o navegador voltando do Google, sem login). O `state` era só base64 de
// `{ integration_id, user_id, mode }`, sem assinatura, e o callback gravava os tokens na linha
// `calendar_integrations` que o `state` apontasse. Quem soubesse o id de uma integração montava
// a autorização com a PRÓPRIA conta Google (o client_id é público) e plantava os tokens dele por
// cima da agenda/caixa de e-mail da casa — e-mails do motor Gmail e eventos com dado de lead
// passariam pela conta de fora. Achado na varredura de 12/11/2026 (docs/SECURITY.md).
//
// Agora o `state` só nasce do START logado, leva prazo, e é assinado com HMAC-SHA256 usando o
// client secret do Google (só o servidor conhece). O callback confere assinatura e prazo ANTES
// de trocar o código. Mesmo desenho do `tiktokState.ts`.
//
// Formato: <payload base64url>.<assinatura base64url>, payload = JSON { i, u, m, n, e }.
// Sem import por URL: carrega no vitest (crypto.subtle existe no Deno e no Node).

export type ModoOAuthGoogle = "email" | "calendar" | "full";

export interface StateGoogle {
  /** id da linha em calendar_integrations */
  i: string;
  /** usuário logado que pediu a conexão */
  u: string;
  m: ModoOAuthGoogle;
  /** nonce */
  n: string;
  /** expira em (ms desde a época) */
  e: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlDeBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesDeB64url(texto: string): Uint8Array {
  const b64 = texto.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (texto.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function assinar(segredo: string, texto: string): Promise<string> {
  const chave = await crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64urlDeBytes(new Uint8Array(await crypto.subtle.sign("HMAC", chave, enc.encode(texto))));
}

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function criarStateGoogle(
  segredo: string,
  dados: { integrationId: string; usuarioId: string; modo: ModoOAuthGoogle },
  validadeMs = 15 * 60 * 1000,
  agoraMs = Date.now(),
): Promise<string> {
  if (!segredo) throw new Error("segredo do state ausente");
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const payload: StateGoogle = {
    i: dados.integrationId,
    u: dados.usuarioId,
    m: dados.modo,
    n: Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""),
    e: agoraMs + validadeMs,
  };
  const corpo = b64urlDeBytes(enc.encode(JSON.stringify(payload)));
  return `${corpo}.${await assinar(segredo, corpo)}`;
}

export type ConferenciaStateGoogle =
  | { ok: true; state: StateGoogle }
  | { ok: false; motivo: "ausente" | "invalido" | "vencido" };

export async function conferirStateGoogle(
  segredo: string,
  stateRaw: string | null,
  agoraMs = Date.now(),
): Promise<ConferenciaStateGoogle> {
  if (!stateRaw) return { ok: false, motivo: "ausente" };
  if (!segredo) return { ok: false, motivo: "invalido" };
  const partes = stateRaw.split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, motivo: "invalido" };
  const [corpo, assinatura] = partes;
  if (!iguais(assinatura, await assinar(segredo, corpo))) return { ok: false, motivo: "invalido" };
  let st: StateGoogle;
  try {
    st = JSON.parse(dec.decode(bytesDeB64url(corpo)));
  } catch {
    return { ok: false, motivo: "invalido" };
  }
  if (!st || typeof st.i !== "string" || typeof st.u !== "string" || typeof st.e !== "number") {
    return { ok: false, motivo: "invalido" };
  }
  // O prazo só é lido DEPOIS da assinatura: antes disso o número é de quem montou o link.
  if (!(st.e > agoraMs)) return { ok: false, motivo: "vencido" };
  const m: ModoOAuthGoogle = st.m === "email" || st.m === "calendar" ? st.m : "full";
  return { ok: true, state: { ...st, m } };
}
