// Access token de conta de serviço Google (JWT RS256 → oauth2/token), sem biblioteca.
// Usado pela google-crm-conversoes (Data Manager) e pela mkt-ga4-relatorio (GA4 Data API), com a
// mesma chave do vault ('google_datamanager_sa', conta gsc-claude@claudecode-512217).
// Sem Deno.* de propósito: roda também no vitest e no Node.

export interface ContaDeServico {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function tokenDaContaDeServico(sa: ContaDeServico, escopo: string): Promise<string> {
  const agora = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
  const enc = new TextEncoder();
  const cab = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const carga = b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: escopo, aud, iat: agora, exp: agora + 3600 })));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, enc.encode(`${cab}.${carga}`)));
  const resp = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${cab}.${carga}.${b64url(assinatura)}`,
    }),
  });
  const r = await resp.json().catch(() => ({}));
  if (!resp.ok || !r.access_token) throw new Error(`token Google: HTTP ${resp.status} ${r.error_description || r.error || ""}`);
  return r.access_token as string;
}
