// Helpers compartilhados Gmail API
const CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID')!;
const CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET')!;

/**
 * Erros de OAuth — diferenciamos REVOGAÇÃO real (4xx permanente do Google) de
 * falhas TRANSITÓRIAS (rede, 5xx, 429). Antes, tudo era classificado como
 * revogado e a caixa era marcada token_revoked permanentemente em qualquer
 * blip de rede.
 */
export class OAuthRevokedError extends Error {
  constructor(detail: string) {
    super(`oauth_revoked: ${detail}`);
    this.name = 'OAuthRevokedError';
  }
}
export class OAuthTransientError extends Error {
  constructor(detail: string) {
    super(`oauth_transient: ${detail}`);
    this.name = 'OAuthTransientError';
  }
}

const REVOKED_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function refreshAccessToken(refreshToken: string) {
  // 3 tentativas (1 inicial + 2 retries em 1s e 4s) — só p/ erros transitórios.
  const delays = [1000, 4000];
  let lastDetail = '';
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
    } catch (netErr) {
      // fetch lançou (timeout, DNS, conexão recusada) → transitório, tenta de novo
      lastDetail = `network: ${(netErr as Error).message}`;
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
        continue;
      }
      throw new OAuthTransientError(lastDetail);
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        access_token: json.access_token as string,
        expires_in: json.expires_in as number,
      };
    }
    const errCode = String((json as { error?: unknown })?.error || '');
    // 4xx com error code de revogação real → falha permanente, NÃO retentar
    if (res.status >= 400 && res.status < 500 && REVOKED_ERROR_CODES.has(errCode)) {
      const desc = String((json as { error_description?: unknown })?.error_description || '');
      throw new OAuthRevokedError(`${errCode}${desc ? ': ' + desc : ''}`);
    }
    // 5xx, 429, ou 4xx sem código conhecido → transitório, tenta de novo
    lastDetail = `${res.status} ${errCode || 'unknown'}: ${JSON.stringify(json).slice(0, 300)}`;
    if (attempt < delays.length) {
      await sleep(delays[attempt]);
      continue;
    }
    throw new OAuthTransientError(lastDetail);
  }
  // Inalcançável, mas TS exige
  throw new OAuthTransientError(lastDetail || 'exceeded_retries');
}

export async function ensureToken(admin: any, integ: any) {
  const expiresAt = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
  if (integ.oauth_access_token && expiresAt - Date.now() > 60_000) return integ.oauth_access_token;
  if (!integ.oauth_refresh_token) throw new Error('no_refresh_token');
  const fresh = await refreshAccessToken(integ.oauth_refresh_token);
  const newExpiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
  await admin.from('calendar_integrations')
    .update({ oauth_access_token: fresh.access_token, oauth_token_expires_at: newExpiresAt })
    .eq('id', integ.id);
  return fresh.access_token;
}

export function base64UrlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + (4 - str.length % 4) % 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array | string): string {
  const str = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeText(data: string): string {
  return new TextDecoder('utf-8').decode(base64UrlDecode(data));
}

// RFC 2047: valor de header (Subject etc.) com acento vira encoded-word
// =?UTF-8?B?...?= — header cru é lido como ASCII/Latin-1 pelos clientes
// ("Rúmen" vira "RÃƒÂºmen"). ASCII puro passa reto (legível no raw).
export function encodeHeaderUtf8(value: string): string {
  const v = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(v)))}?=`;
}

// Display name do From/To: ASCII → quoted-string; com acento → encoded-word
// (encoded-word DENTRO de aspas não é decodificado pelos clientes).
export function encodeDisplayName(name: string): string {
  const v = String(name ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(v)) return `"${v.replace(/(["\\])/g, '\\$1')}"`;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(v)))}?=`;
}

interface ParsedPayload {
  html: string;
  text: string;
  attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
}

export function parsePayload(payload: any): ParsedPayload {
  const out: ParsedPayload = { html: '', text: '', attachments: [] };
  function walk(part: any) {
    if (!part) return;
    const mime = part.mimeType || '';
    const filename = part.filename || '';
    if (filename && part.body?.attachmentId) {
      out.attachments.push({
        filename,
        mimeType: mime,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    } else if (mime === 'text/html' && part.body?.data) {
      out.html += decodeText(part.body.data);
    } else if (mime === 'text/plain' && part.body?.data) {
      out.text += decodeText(part.body.data);
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(payload);
  if (!out.html && out.text) out.html = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${out.text.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!))}</pre>`;
  return out;
}

export function parseHeaders(headers: any[]): Record<string, string> {
  const h: Record<string, string> = {};
  for (const x of headers || []) h[x.name.toLowerCase()] = x.value;
  return h;
}

export function parseAddress(raw: string | undefined): { email: string; name: string } {
  if (!raw) return { email: '', name: '' };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { email: raw.trim().toLowerCase(), name: '' };
}

export function parseAddressList(raw: string | undefined): Array<{ email: string; name: string }> {
  if (!raw) return [];
  // Split simple - won't handle quoted commas perfectly but good enough
  return raw.split(',').map(s => parseAddress(s)).filter(a => a.email);
}

const EMAIL_RE = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;

export function isValidEmail(e: string): boolean {
  return EMAIL_RE.test((e || '').trim());
}

export function validateEmailList(list: string[] | undefined): { ok: string[]; invalid: string[] } {
  const ok: string[] = [];
  const invalid: string[] = [];
  for (const raw of list || []) {
    const e = (raw || '').trim();
    if (!e) continue;
    if (isValidEmail(e)) ok.push(e); else invalid.push(e);
  }
  return { ok, invalid };
}

/**
 * IMPORTANTE: só retorna true para revogação REAL (Google disse 4xx permanente)
 * ou ausência de refresh token. Falhas transitórias (rede, 5xx, 429) NÃO
 * caem aqui — devem ser tratadas separadamente como `isTransientAuthError`.
 */
export function isTokenRevokedError(err: unknown): boolean {
  if (err instanceof OAuthRevokedError) return true;
  const msg = (err as Error)?.message || '';
  // "token has been expired or revoked" é o error_description clássico do invalid_grant
  return /oauth_revoked|invalid_grant|invalid_client|unauthorized_client|token has been expired or revoked|no_refresh_token/i.test(msg);
}

export function isTransientAuthError(err: unknown): boolean {
  if (err instanceof OAuthTransientError) return true;
  const msg = (err as Error)?.message || '';
  return /oauth_transient/i.test(msg);
}

export function friendlyGmailError(err: unknown): string {
  const msg = (err as Error)?.message || String(err);
  if (isTokenRevokedError(err)) {
    return 'Conta do Gmail desconectada. Clique em "Reconectar Gmail" no topo da caixa de entrada e refaça o envio.';
  }
  if (isTransientAuthError(err)) {
    return 'Erro temporário ao validar a conexão com o Google. Aguarde alguns segundos e tente novamente.';
  }
  // gmail_send_failed: {...}
  const sendMatch = msg.match(/gmail_send_failed:\s*(\{[\s\S]+\})/);
  if (sendMatch) {
    try {
      const j = JSON.parse(sendMatch[1]);
      const detail = j?.error?.message || j?.message || '';
      if (/invalid to header|invalid recipient|address|email/i.test(detail)) {
        return `O Gmail rejeitou o destinatário: ${detail}`;
      }
      if (detail) return `Gmail recusou o envio: ${detail}`;
    } catch {}
  }
  const httpMatch = msg.match(/gmail_(\d{3}):\s*(.+)/);
  if (httpMatch) {
    return `Erro do Gmail (${httpMatch[1]}): ${httpMatch[2].slice(0, 200)}`;
  }
  return msg;
}

export async function markCaixaTokenRevoked(admin: any, caixaId: string) {
  try {
    await admin.from('email_caixas_conectadas').update({
      last_sync_error: 'token_revoked',
      last_sync_at: new Date().toISOString(),
    }).eq('id', caixaId);
  } catch (_) {}
}

/**
 * Marca erro transitório (não bloqueia próximas tentativas de sync, mas fica
 * visível como sinal de saúde).
 */
export async function markCaixaTransient(admin: any, caixaId: string) {
  try {
    await admin.from('email_caixas_conectadas').update({
      last_sync_error: 'transient',
      last_sync_at: new Date().toISOString(),
    }).eq('id', caixaId);
  } catch (_) {}
}
