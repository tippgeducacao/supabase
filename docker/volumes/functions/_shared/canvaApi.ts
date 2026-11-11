// Canva Connect API — o que a proposta B2B usa para abrir o .pptx JÁ DENTRO do Canva.
//
// Fluxo (docs/B2B — Construtor de Proposta.md → "Abrir com Canva"):
//   1. `canva` {acao:'conectar'} gera state + code_verifier (PKCE) e devolve a URL de autorização;
//   2. o Canva volta em `canva-oauth-callback` com ?code&state → troca por token (Basic auth);
//   3. `canva` recebe o .pptx, faz POST /v1/imports e a tela consulta o job até sair o edit_url.
//
// Sem import por URL de propósito: o vitest carrega este arquivo (canvaApi.test.ts).
//
// Fatos da API que custam caro se esquecidos:
//  • refresh token é de USO ÚNICO — cada renovação devolve um novo; grave-o ou perde a conexão;
//  • o code_verifier nunca vai ao navegador (fica em canva_conexoes_pendentes);
//  • o título do import vai em base64 (UTF-8) no cabeçalho Import-Metadata, até 50 caracteres;
//  • o edit_url vale 30 dias e só para quem importou.

export const CANVA_AUTORIZAR = "https://www.canva.com/api/oauth/authorize";
export const CANVA_API = "https://api.canva.com/rest/v1";
export const CANVA_CALLBACK_URI = "https://api.ppgeducacao.site/functions/v1/canva-oauth-callback";
/** design:content:write = criar e consultar o import; profile:read = "conectado como …". */
export const CANVA_ESCOPOS = "design:content:write profile:read";
export const MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export interface TokenCanva {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

/** Erro da API do Canva com o status HTTP (401/invalid_grant = reconectar). */
export class ErroCanva extends Error {
  constructor(public status: number, public codigo: string, mensagem: string) {
    super(mensagem);
  }
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** code_verifier de 128 caracteres (o máximo do RFC 7636) e o challenge S256. */
export async function gerarPkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  const verifier = b64url(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(hash) };
}

export function stateNovo(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function urlDeAutorizacao(clientId: string, state: string, challenge: string): string {
  const p = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: CANVA_ESCOPOS,
    response_type: "code",
    client_id: clientId,
    state,
    redirect_uri: CANVA_CALLBACK_URI,
  });
  // URLSearchParams escreve espaço como "+"; o Canva documenta "%20".
  return `${CANVA_AUTORIZAR}?${p.toString().replace(/\+/g, "%20")}`;
}

/** Título do design: até 50 caracteres (contados como o usuário vê), em base64 do UTF-8. */
export function tituloBase64(titulo: string): string {
  const limpo = Array.from(titulo.replace(/\s+/g, " ").trim() || "Proposta PPGVET").slice(0, 50).join("");
  const bytes = new TextEncoder().encode(limpo);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function lerErro(r: Response): Promise<ErroCanva> {
  const corpo = await r.json().catch(() => ({} as Record<string, unknown>));
  const codigo = String((corpo as any)?.code ?? (corpo as any)?.error ?? r.status);
  const msg = String((corpo as any)?.message ?? (corpo as any)?.error_description ?? `Canva respondeu ${r.status}`);
  return new ErroCanva(r.status, codigo, msg);
}

async function pedirToken(clientId: string, segredo: string, corpo: Record<string, string>): Promise<TokenCanva> {
  const r = await fetch(`${CANVA_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${segredo}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(corpo).toString(),
  });
  if (!r.ok) throw await lerErro(r);
  return (await r.json()) as TokenCanva;
}

export function trocarCodigoPorToken(clientId: string, segredo: string, code: string, verifier: string) {
  return pedirToken(clientId, segredo, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: CANVA_CALLBACK_URI,
  });
}

export function renovarToken(clientId: string, segredo: string, refreshToken: string) {
  return pedirToken(clientId, segredo, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function buscarNome(accessToken: string): Promise<string | null> {
  const r = await fetch(`${CANVA_API}/users/me/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return (j?.profile?.display_name as string) || null;
}

export interface JobCanva {
  id: string;
  status: "in_progress" | "success" | "failed";
  edit_url: string | null;
  erro: string | null;
}

function lerJob(j: any): JobCanva {
  const job = j?.job ?? {};
  const design = job?.result?.designs?.[0];
  return {
    id: String(job.id ?? ""),
    status: job.status ?? "in_progress",
    edit_url: design?.urls?.edit_url ?? null,
    erro: job?.error ? `${job.error.code ?? ""}: ${job.error.message ?? ""}`.trim() : null,
  };
}

export async function criarImport(accessToken: string, arquivo: ArrayBuffer, titulo: string): Promise<JobCanva> {
  const r = await fetch(`${CANVA_API}/imports`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Import-Metadata": JSON.stringify({ title_base64: tituloBase64(titulo), mime_type: MIME_PPTX }),
    },
    body: arquivo,
  });
  if (!r.ok) throw await lerErro(r);
  return lerJob(await r.json());
}

export async function consultarImport(accessToken: string, jobId: string): Promise<JobCanva> {
  const r = await fetch(`${CANVA_API}/imports/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw await lerErro(r);
  return lerJob(await r.json());
}
