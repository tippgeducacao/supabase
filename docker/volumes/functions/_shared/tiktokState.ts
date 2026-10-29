// `state` ASSINADO dos callbacks de OAuth do TikTok (29/10/2026).
//
// Por que existe: os callbacks (`tiktok-ads-oauth-callback`, `tiktok-perfil-oauth-callback`)
// são públicos por natureza — quem chega neles é o navegador voltando do TikTok, sem login.
// Antes, o `state` era fixo ("ppgvet") e o callback aceitava QUALQUER `auth_code`: quem tivesse
// o endereço podia autorizar a PRÓPRIA conta de TikTok e plantá-la como conta de anúncio ou
// como perfil que publica os posts da casa. Achado na validação de 28-29/10.
//
// Agora o link de autorização só nasce de uma ação LOGADA (marketing/diretoria), e o `state`
// leva prazo, quem pediu e um nonce, tudo assinado com HMAC-SHA256 usando o segredo do próprio
// app (TIKTOK_ADS_SECRET / TIKTOK_PERFIL_SECRET — só o servidor conhece). O callback confere a
// assinatura e o prazo ANTES de trocar o código, e o nonce vale UMA vez
// (`tiktok_oauth_states_usados`). Ver docs/SECURITY.md → "Edge functions: quem chama".
//
// Formato: <proposito>.<expira_ms base36>.<usuario>.<nonce>.<assinatura base64url>
// Sem import por URL: carrega no vitest (crypto.subtle existe no Deno e no Node).

export type PropositoState = "ads" | "perfil";

const enc = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function assinar(segredo: string, texto: string): Promise<string> {
  const chave = await crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", chave, enc.encode(texto)));
}

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function criarState(
  segredo: string,
  proposito: PropositoState,
  usuarioId: string,
  validadeMs: number,
  agoraMs = Date.now(),
): Promise<string> {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const nonce = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const corpo = `${proposito}.${(agoraMs + validadeMs).toString(36)}.${usuarioId}.${nonce}`;
  return `${corpo}.${await assinar(segredo, corpo)}`;
}

export type ConferenciaState =
  | { ok: true; usuarioId: string; nonce: string }
  | { ok: false; motivo: "ausente" | "invalido" | "vencido" };

export async function conferirState(
  segredo: string,
  proposito: PropositoState,
  state: string | null,
  agoraMs = Date.now(),
): Promise<ConferenciaState> {
  if (!state) return { ok: false, motivo: "ausente" };
  const partes = state.split(".");
  if (partes.length !== 5) return { ok: false, motivo: "invalido" };
  const [prop, exp, usuarioId, nonce, assinatura] = partes;
  if (prop !== proposito || !/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, motivo: "invalido" };
  const esperado = await assinar(segredo, `${prop}.${exp}.${usuarioId}.${nonce}`);
  if (!iguais(assinatura, esperado)) return { ok: false, motivo: "invalido" };
  // O prazo só é lido DEPOIS da assinatura: antes disso o número é de quem montou o link.
  if (!(parseInt(exp, 36) > agoraMs)) return { ok: false, motivo: "vencido" };
  return { ok: true, usuarioId, nonce };
}

// Tipo mínimo do cliente supabase-js: o import por URL ficaria fora do alcance do vitest.
// deno-lint-ignore no-explicit-any
type ClienteServico = { from: (tabela: string) => any };

/**
 * Gasta o nonce (uso único). A chave primária faz a reserva ser atômica. Devolve `devolver`
 * para quando a troca do código falhar DEPOIS da reserva: o link volta a valer e a pessoa
 * tenta de novo sem pedir outro. Erro que não seja "já usado" também recusa (fechado por padrão).
 */
export async function reservarState(
  admin: ClienteServico,
  proposito: PropositoState,
  conf: { usuarioId: string; nonce: string },
): Promise<{ ok: true; devolver: () => Promise<unknown> } | { ok: false; jaUsado: boolean }> {
  const { error } = await admin
    .from("tiktok_oauth_states_usados")
    .insert({ nonce: conf.nonce, proposito, usuario_id: /^[0-9a-f-]{36}$/.test(conf.usuarioId) ? conf.usuarioId : null });
  if (error) return { ok: false, jaUsado: error.code === "23505" };
  return { ok: true, devolver: () => admin.from("tiktok_oauth_states_usados").delete().eq("nonce", conf.nonce) };
}

export const MSG_JA_USADO =
  "Este link de conexão já foi usado (vale uma vez só). Se você recarregou a página, a conexão já está feita; senão, gere um novo pelo sistema.";

export const MSG_STATE: Record<"ausente" | "invalido" | "vencido", string> = {
  ausente: "Este endereço só funciona a partir do botão de conexão do sistema. Abra o sistema e gere o link de novo.",
  invalido: "Não reconheço este link de conexão. Gere um novo pelo sistema.",
  vencido: "Este link de conexão passou do prazo. Gere um novo pelo sistema.",
};
