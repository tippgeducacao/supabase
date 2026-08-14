// Cliente Resend — o motor de DISPARO do sistema (campanhas, automações, webhooks).
// A inbox e o e-mail 1:1 continuam no Gmail (_shared/gmail.ts); ver docs/E-mail e Caixas.md.
//
// Só a API HTTP, sem SDK: o edge-runtime self-hosted mata o worker em ~60s, então
// tudo aqui tem timeout curto e devolve erro estruturado em vez de estourar.

const RESEND_API = "https://api.resend.com";

export class ResendNaoConfigurado extends Error {
  constructor() {
    super("RESEND_API_KEY não configurada no ambiente das edge functions.");
    this.name = "ResendNaoConfigurado";
  }
}

export function resendApiKey(): string {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new ResendNaoConfigurado();
  return key;
}

export function temResend(): boolean {
  return !!Deno.env.get("RESEND_API_KEY");
}

export interface ResendResultado<T> {
  ok: boolean;
  status: number;
  /** true quando o Resend recusou por excesso de chamadas — o chamador deve pausar, não repetir. */
  rateLimited: boolean;
  /** nome do erro devolvido pelo Resend (ex.: invalid_idempotent_request) */
  codigo?: string;
  /** quantas tentativas foram gastas (1 = acertou de primeira) */
  tentativas?: number;
  data?: T;
  erro?: string;
}

/**
 * Modo seco: em vez de entregar de verdade, loga o payload e devolve um id fake.
 * Serve para testar campanha/automação sem queimar reputação nem incomodar ninguém.
 */
export function modoSeco(): boolean {
  const v = Deno.env.get("RESEND_DRY_RUN");
  return v === "1" || v === "true";
}

/** Limite documentado do Resend: 10 req/s por TIME (vale para todas as API keys juntas). */
export const RESEND_REQ_POR_SEGUNDO = 10;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Só repetimos o que tem chance real de mudar de resultado: excesso de requisições,
 * falha do lado do servidor e duas requisições concorrentes com a MESMA chave de
 * idempotência. `invalid_idempotent_request` (mesma chave, payload diferente) é bug
 * de quem chamou — repetir só repete o erro.
 */
function vaiTentarDeNovo(status: number, codigo?: string): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 409 && codigo === "concurrent_idempotent_requests") return true;
  return false;
}

async function chamar<T>(
  caminho: string,
  init: RequestInit & { timeoutMs?: number; idempotencyKey?: string; tentativas?: number } = {},
): Promise<ResendResultado<T>> {
  const { timeoutMs = 20_000, idempotencyKey, tentativas = 3, ...req } = init;

  let ultimo: ResendResultado<T> = { ok: false, status: 0, rateLimited: false, erro: "sem tentativa" };

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${RESEND_API}${caminho}`, {
        ...req,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${resendApiKey()}`,
          "Content-Type": "application/json",
          // Chave de idempotência: expira em 24h e aceita até 256 chars (doc do Resend).
          // É o que impede entrega dobrada quando o worker morre depois de enviar
          // mas antes de gravar o resultado.
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 256) } : {}),
          ...(req.headers ?? {}),
        },
      });

      const texto = await res.text();
      let corpo: unknown = null;
      try {
        corpo = texto ? JSON.parse(texto) : null;
      } catch {
        corpo = texto;
      }

      if (res.ok) {
        return { ok: true, status: res.status, rateLimited: false, data: corpo as T, tentativas: tentativa };
      }

      const detalhe = corpo as { message?: string; name?: string } | null;
      const codigo = detalhe?.name;
      ultimo = {
        ok: false,
        status: res.status,
        rateLimited: res.status === 429,
        codigo,
        tentativas: tentativa,
        erro: detalhe?.message ?? (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
      };

      if (tentativa >= tentativas || !vaiTentarDeNovo(res.status, codigo)) return ultimo;
    } catch (e) {
      const abortado = e instanceof DOMException && e.name === "AbortError";
      ultimo = {
        ok: false,
        status: abortado ? 504 : 0,
        rateLimited: false,
        tentativas: tentativa,
        erro: abortado ? `timeout de ${timeoutMs}ms falando com o Resend` : String(e),
      };
      if (tentativa >= tentativas) return ultimo;
    } finally {
      clearTimeout(t);
    }

    // Backoff exponencial + jitter. Curto de propósito: o edge-runtime self-hosted
    // mata o worker perto de 60s, então espera longa mataria o dispatcher inteiro.
    const base = 300 * Math.pow(3, tentativa - 1); // 300ms, 900ms
    await dormir(base + Math.random() * 250);
  }

  return ultimo;
}

// ---------------------------------------------------------------- envio

export interface ResendAnexo {
  filename: string;
  /** base64 puro, sem data-uri */
  content: string;
  content_type?: string;
}

export interface ResendEmail {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string | null;
  reply_to?: string | null;
  headers?: Record<string, string>;
  attachments?: ResendAnexo[];
  /** viram metadados no painel do Resend e voltam nos eventos do webhook */
  tags?: Array<{ name: string; value: string }>;
}

/** Monta o cabeçalho From no formato "Nome <email>", com o nome codificado se tiver acento. */
export function formatarFrom(nome: string | null | undefined, email: string): string {
  if (!nome) return email;
  const precisaEncode = /[^\x20-\x7E]/.test(nome);
  const nomeSeguro = precisaEncode
    ? `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(nome)))}?=`
    : `"${nome.replace(/"/g, "")}"`;
  return `${nomeSeguro} <${email}>`;
}

/**
 * O Resend só aceita nome/valor ASCII em `tags` — um valor com acento faz a API
 * devolver 422 e o e-mail inteiro não sai. Sanitiza em vez de arriscar.
 */
export function tagSegura(valor: string): string {
  return valor.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256);
}

/**
 * Chave de idempotência no formato <tipo-do-evento>/<id-da-entidade>.
 * Precisa ser ESTÁVEL entre tentativas do mesmo envio lógico — por isso deriva da
 * entidade (linha da fila, etapa do funil), nunca de timestamp ou uuid novo.
 */
export function chaveIdempotencia(tipo: string, id: string): string {
  return `${tipo}/${id}`.slice(0, 256);
}

export async function enviarEmail(
  email: ResendEmail,
  opcoes: { idempotencyKey?: string } = {},
): Promise<ResendResultado<{ id: string }>> {
  if (modoSeco()) {
    console.log("[resend:dry-run] envio simulado", JSON.stringify({
      from: email.from, to: email.to, subject: email.subject,
      idempotencyKey: opcoes.idempotencyKey, tamanho_html: email.html?.length ?? 0,
    }));
    return { ok: true, status: 200, rateLimited: false, tentativas: 1, data: { id: `dry-run-${crypto.randomUUID()}` } };
  }
  return await chamar<{ id: string }>("/emails", {
    method: "POST",
    body: JSON.stringify(email),
    idempotencyKey: opcoes.idempotencyKey,
  });
}

/**
 * Lote de até 100 e-mails numa chamada. Não aceita anexos.
 * ⚠️ Ainda NÃO está ligado ao email-campaign-dispatcher: hoje a vazão é limitada pelo
 * lote de 50 do cron de 1 min (~0,8 req/s), bem abaixo dos 10 req/s da API, então o
 * gargalo não é a API. Ligar isto exige pré-criar as linhas de `emails_enviados` e
 * renderizar por destinatário antes da chamada — ver docs/E-mail e Caixas.md.
 */
export async function enviarLote(
  emails: ResendEmail[],
  opcoes: { idempotencyKey?: string } = {},
): Promise<ResendResultado<{ data: Array<{ id: string }> }>> {
  if (modoSeco()) {
    console.log("[resend:dry-run] lote simulado", JSON.stringify({ quantidade: emails.length }));
    return {
      ok: true, status: 200, rateLimited: false, tentativas: 1,
      data: { data: emails.map(() => ({ id: `dry-run-${crypto.randomUUID()}` })) },
    };
  }
  return await chamar<{ data: Array<{ id: string }> }>("/emails/batch", {
    method: "POST",
    body: JSON.stringify(emails),
    timeoutMs: 30_000,
    idempotencyKey: opcoes.idempotencyKey,
  });
}

// ---------------------------------------------------------------- domínios

export interface ResendDominio {
  id: string;
  name: string;
  status: string; // not_started | pending | verified | failed | temporary_failure
  region?: string;
  records?: Array<{
    record: string;
    name: string;
    type: string;
    value: string;
    ttl?: string;
    priority?: number;
    status?: string;
  }>;
}

export function criarDominio(nome: string, regiao = "sa-east-1") {
  return chamar<ResendDominio>("/domains", {
    method: "POST",
    body: JSON.stringify({ name: nome, region: regiao }),
  });
}

export function obterDominio(id: string) {
  return chamar<ResendDominio>(`/domains/${id}`, { method: "GET" });
}

export function listarDominios() {
  return chamar<{ data: ResendDominio[] }>("/domains", { method: "GET" });
}

/** Pede ao Resend para reconferir o DNS agora (o status atualiza de forma assíncrona). */
export function verificarDominio(id: string) {
  return chamar<{ id: string }>(`/domains/${id}/verify`, { method: "POST" });
}

/** Normaliza os records do Resend para o formato que a tela de Domínios já espera. */
export function dnsRecordsParaTela(dom: ResendDominio) {
  return (dom.records ?? []).map((r) => ({
    tipo: r.type,
    nome: r.name,
    valor: r.value,
    ttl: r.ttl ?? "Auto",
    prioridade: r.priority ?? null,
    status: r.status ?? null,
    finalidade: r.record, // SPF | DKIM | DMARC
  }));
}

// ---------------------------------------------------------------- webhook

/** Comparação de tempo constante — não vaza o segredo byte a byte. */
function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface CabecalhosSvix {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Verificação da assinatura Svix (o padrão que o Resend usa nos webhooks).
 * Fica aqui, e não dentro do index.ts, para poder ser testada sem subir o Deno.serve.
 *
 * `agoraMs` é injetável só para o teste conseguir simular evento velho.
 */
export async function assinaturaSvixValida(
  cabecalhos: CabecalhosSvix,
  corpoBruto: string,
  segredo: string,
  agoraMs: number = Date.now(),
): Promise<boolean> {
  const { id, timestamp, signature } = cabecalhos;
  if (!id || !timestamp || !signature) return false;

  // Janela de 5 min: barra replay de um evento capturado.
  const idadeSeg = Math.abs(agoraMs / 1000 - Number(timestamp));
  if (!Number.isFinite(idadeSeg) || idadeSeg > 300) return false;

  const bruto = segredo.startsWith("whsec_") ? segredo.slice(6) : segredo;
  let chave: CryptoKey;
  try {
    chave = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(bruto), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return false; // segredo malformado não valida nada
  }

  const digest = await crypto.subtle.sign(
    "HMAC",
    chave,
    new TextEncoder().encode(`${id}.${timestamp}.${corpoBruto}`),
  );
  const esperado = btoa(String.fromCharCode(...new Uint8Array(digest)));

  // O header traz uma ou mais assinaturas: "v1,<b64> v1,<b64>".
  return signature.split(" ").some((parte) => igualSeguro(parte.split(",")[1] ?? "", esperado));
}

// ---------------------------------------------------------------- descadastro

/**
 * Token de descadastro sem estado: HMAC do e-mail. Evita uma tabela de tokens e
 * funciona igual para campanha e transacional. O link só descadastra o e-mail que
 * ele assina — não dá para descadastrar terceiros adivinhando id.
 */
async function chaveHmac(): Promise<CryptoKey> {
  const segredo = Deno.env.get("EMAIL_UNSUB_SECRET") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function assinarDescadastro(email: string): Promise<string> {
  const chave = await chaveHmac();
  const assinatura = await crypto.subtle.sign(
    "HMAC",
    chave,
    new TextEncoder().encode(email.toLowerCase().trim()),
  );
  return [...new Uint8Array(assinatura)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function conferirDescadastro(email: string, token: string): Promise<boolean> {
  return igualSeguro(await assinarDescadastro(email), token);
}

export async function linkDescadastro(baseUrl: string, email: string): Promise<string> {
  const token = await assinarDescadastro(email);
  return `${baseUrl}/functions/v1/email-descadastro?e=${encodeURIComponent(email)}&t=${token}`;
}
