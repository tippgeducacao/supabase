import { assinaturaResendValida } from "../_shared/resendSignature.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, svix-id, svix-timestamp, svix-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LIMITE_CORPO_BYTES = 256 * 1024;
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

interface DepsWebhookResend {
  segredo?: string;
  agoraMs?: number;
  supabase: {
    rpc: (nome: string, args: Record<string, unknown>) => PromiseLike<{
      data: unknown;
      error: { code?: string; message?: string } | null;
    }>;
  };
}

async function lerCorpo(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > LIMITE_CORPO_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function tratarEventoResend(req: Request, deps: DepsWebhookResend): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "método não permitido" }, 405);
  // Sem segredo nunca há modo permissivo: este endpoint pode bloquear destinatários.
  if (!deps.segredo?.trim()) return json({ error: "recebimento de eventos ainda não configurado" }, 503);

  let bruto: string | null;
  try {
    bruto = await lerCorpo(req);
  } catch {
    return json({ error: "corpo inválido" }, 400);
  }
  if (bruto === null) return json({ error: "corpo excede o limite permitido" }, 413);
  if (!(await assinaturaResendValida(bruto, req.headers, deps.segredo, deps.agoraMs))) {
    return json({ error: "assinatura inválida" }, 400);
  }

  let evento: Record<string, unknown>;
  try {
    evento = JSON.parse(bruto);
    if (!evento || typeof evento !== "object" || Array.isArray(evento)
      || typeof evento.type !== "string" || !evento.type || evento.type.length > 100
      || !evento.data || typeof evento.data !== "object" || Array.isArray(evento.data)) {
      return json({ error: "evento inválido" }, 400);
    }
  } catch {
    return json({ error: "corpo não é JSON" }, 400);
  }

  try {
    // Uma transação faz a deduplicação E os efeitos. Se a gravação da supressão ou
    // da métrica falhar, nada confirma o evento e o Resend pode entregá-lo de novo.
    const { data, error } = await deps.supabase.rpc("email_processar_evento_resend", {
      p_evento_id: req.headers.get("svix-id"),
      p_evento: evento,
    });
    if (error || !data || typeof data !== "object" || !("ok" in data) || data.ok !== true) {
      return json({ error: "não foi possível registrar o evento; tente novamente" }, 503);
    }
    return json(data);
  } catch {
    // O erro do banco pode incluir valores do payload; não devolver nem logar isso.
    return json({ error: "não foi possível registrar o evento; tente novamente" }, 503);
  }
}
