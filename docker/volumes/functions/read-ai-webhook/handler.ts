// Webhook do Read AI: confere a assinatura no corpo CRU, registra a reunião na empresa (processar.ts)
// e guarda o que chegou. Mapa: docs/CRM Comercial.md → "Read AI".
import type { ResultadoProcesso } from "./processar.ts";

export const LIMITE_CORPO_BYTES = 5 * 1024 * 1024;

/**
 * Modo teste: o webhook é pessoal e o Read manda TODAS as reuniões da conta (entrevista, reunião
 * interna…). Até a etapa 2 ligar reunião a empresa, só é guardada a que tem esta marca no título;
 * o resto é descartado sem salvar.
 */
export const MARCA_TESTE = "zz teste";

export interface RegistroReadAi {
  session_id: string | null;
  evento: string | null;
  corpo_sha256: string;
  assinatura_formato: string;
  payload: Record<string, unknown>;
  situacao?: ResultadoProcesso["situacao"] | "erro";
  empresa_id?: string | null;
  atividade_id?: string | null;
}

export interface DepsReadAi {
  /** Valor de app_secrets('READ_AI_SIGNING_KEY'): uma ou várias chaves, separadas por vírgula ou linha. */
  lerChaves: () => Promise<string | null>;
  gravar: (registro: RegistroReadAi) => Promise<{ error: { message?: string; code?: string } | null }>;
  processar: (payload: Record<string, unknown>) => Promise<ResultadoProcesso>;
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

const emHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const emBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

/**
 * A documentação do Read diz "HMAC-SHA256 do corpo cru com a chave", mas não confirmamos se a chave
 * entra como texto ou decodificada de base64, nem se a assinatura vem em hex ou base64. As quatro
 * combinações exigem conhecer a chave; o formato que bater fica gravado para apertarmos depois.
 */
function formasDaChave(chave: string): Array<[string, Uint8Array]> {
  const formas: Array<[string, Uint8Array]> = [["texto", new TextEncoder().encode(chave)]];
  if (chave.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(chave)) {
    formas.push(["base64", Uint8Array.from(atob(chave), (c) => c.charCodeAt(0))]);
  }
  return formas;
}

export async function conferirAssinatura(
  corpo: Uint8Array,
  recebida: string,
  chaves: string[],
): Promise<string | null> {
  const assinatura = recebida.trim().replace(/^sha256=/i, "");
  for (const chave of chaves) {
    for (const [forma, bytes] of formasDaChave(chave)) {
      const k = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, corpo));
      if (iguais(assinatura.toLowerCase(), emHex(mac))) return `chave-${forma}/hex`;
      if (iguais(assinatura, emBase64(mac))) return `chave-${forma}/base64`;
    }
  }
  return null;
}

async function lerCorpo(req: Request): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length")) > LIMITE_CORPO_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    tamanho += value.byteLength;
    if (tamanho > LIMITE_CORPO_BYTES) {
      await reader.cancel();
      return null;
    }
    partes.push(value);
  }
  const bytes = new Uint8Array(tamanho);
  let posicao = 0;
  for (const parte of partes) {
    bytes.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return bytes;
}

export async function tratarWebhookReadAi(req: Request, deps: DepsReadAi): Promise<Response> {
  if (req.method !== "POST") return json({ erro: "metodo_nao_permitido" }, 405);

  const assinatura = req.headers.get("x-read-signature");
  if (!assinatura) return json({ erro: "sem_assinatura" }, 401);

  try {
    const chaves = ((await deps.lerChaves()) ?? "").split(/[\s,;]+/).filter(Boolean);
    // 503 e não 200: o Read tenta de novo, então a entrega não se perde enquanto a chave não é salva.
    if (chaves.length === 0) return json({ erro: "chave_nao_configurada", modo: "teste" }, 503);

    const corpo = await lerCorpo(req);
    if (corpo === null) return json({ erro: "corpo_grande_demais" }, 413);

    const formato = await conferirAssinatura(corpo, assinatura, chaves);
    if (!formato) {
      console.warn(`[read-ai-webhook] assinatura não confere (assinatura ${assinatura.length} car., corpo ${corpo.length} bytes)`);
      return json({ erro: "assinatura_invalida" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(corpo));
    } catch {
      return json({ erro: "json_invalido" }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({ erro: "json_invalido" }, 400);

    const dados = payload as Record<string, unknown>;
    const titulo = typeof dados.title === "string" ? dados.title : "";
    if (!titulo.toLowerCase().includes(MARCA_TESTE)) {
      // Só os NOMES dos campos vão para o log: se o título não vier em `title`, o teste mostra onde está.
      console.warn(`[read-ai-webhook] ignorada (modo teste); campos: ${Object.keys(dados).join(",").slice(0, 300)}`);
      return json({ ok: true, ignorada: true });
    }

    const texto = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : null);
    // Falha ao registrar na ficha não pode perder a entrega: guarda com "erro" e devolve 500.
    let resultado: ResultadoProcesso | null = null;
    let falha: unknown = null;
    try {
      resultado = await deps.processar(dados);
    } catch (e) {
      falha = e;
    }

    const { error } = await deps.gravar({
      situacao: resultado?.situacao ?? "erro",
      empresa_id: resultado?.empresa_id ?? null,
      atividade_id: resultado?.atividade_id ?? null,
      session_id: texto(dados.session_id),
      evento: texto(dados.trigger),
      corpo_sha256: emHex(new Uint8Array(await crypto.subtle.digest("SHA-256", corpo))),
      assinatura_formato: formato,
      payload: dados,
    });
    if (error) throw new Error(error.message ?? error.code ?? "falha ao gravar");
    if (falha) throw falha;

    return json({ ok: true });
  } catch (e) {
    console.error("[read-ai-webhook]", e instanceof Error ? e.message : e);
    return json({ erro: "falha_interna" }, 500);
  }
}
