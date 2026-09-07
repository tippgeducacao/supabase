import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

export class ErroAcessoMimosa extends Error {
  constructor(public code: string, message: string, public status: number, public retryAfter?: number) {
    super(message);
  }
}

export interface PayloadMimosa {
  acao: "gerar" | "aprovar" | "vincular_agendamento";
  lead_id?: string;
  analise_id?: string;
  agendamento_id?: string | null;
  tipo?: "pre_reuniao" | "pos_sem_venda" | "pos_com_venda";
  versao_anterior?: number;
  lead_snapshot?: Record<string, string | null>;
  dados?: Record<string, string | null>;
  conteudo_final?: string;
  editado?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32_768;
const invalido = () => new ErroAcessoMimosa("BAD_REQUEST", "Dados inválidos para a análise.", 400);

export function bearerMimosa(req: Request): string {
  const token = req.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) throw new ErroAcessoMimosa("UNAUTHENTICATED", "Entre no sistema para usar a Mimosa.", 401);
  return token;
}

export async function usuarioMimosa(cliente: SupabaseClient, token: string): Promise<string> {
  const { data, error } = await cliente.auth.getUser(token);
  if (error || !data.user?.id || data.user.is_anonymous) {
    throw new ErroAcessoMimosa("UNAUTHENTICATED", "Sessão inválida. Entre novamente no sistema.", 401);
  }
  return data.user.id;
}

/** Limita os bytes de verdade, inclusive quando Content-Length foi omitido. */
export async function payloadMimosa(req: Request): Promise<PayloadMimosa> {
  const excedido = () => new ErroAcessoMimosa("PAYLOAD_TOO_LARGE", "A análise excedeu o tamanho permitido.", 413);
  if (Number(req.headers.get("Content-Length")) > MAX_BODY_BYTES) throw excedido();
  const reader = req.body?.getReader();
  if (!reader) throw invalido();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); throw excedido(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let p: PayloadMimosa;
  try { p = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalido(); }
  if (!p || typeof p !== "object" || Array.isArray(p) || !["gerar", "aprovar", "vincular_agendamento"].includes(p.acao)) throw invalido();
  for (const campo of ["lead_id", "analise_id", "agendamento_id"] as const) {
    if (p[campo] != null && (typeof p[campo] !== "string" || !UUID.test(p[campo]))) throw invalido();
  }
  if (p.acao === "gerar" && !p.lead_id) throw invalido();
  if (p.acao !== "gerar" && !p.analise_id) throw invalido();
  if (p.acao === "vincular_agendamento" && !p.agendamento_id) throw invalido();
  if (p.tipo != null && !["pre_reuniao", "pos_sem_venda", "pos_com_venda"].includes(p.tipo)) throw invalido();
  if (p.versao_anterior != null && (!Number.isInteger(p.versao_anterior) || p.versao_anterior < 0 || p.versao_anterior > 10000)) throw invalido();
  for (const campo of ["lead_snapshot", "dados"] as const) {
    const obj = p[campo];
    if (obj != null && (typeof obj !== "object" || Array.isArray(obj) || Object.values(obj).some(v => v !== null && typeof v !== "string"))) throw invalido();
  }
  if (p.conteudo_final != null && typeof p.conteudo_final !== "string") throw invalido();
  if (p.editado != null && typeof p.editado !== "boolean") throw invalido();
  // null não deve atravessar os defaults dos objetos de contexto do gerador.
  return { ...p, tipo: p.tipo ?? "pre_reuniao", lead_snapshot: p.lead_snapshot ?? {}, dados: p.dados ?? {} };
}

/** As RPCs só aceitam service_role; o UUID vem exclusivamente do Auth verificado. */
export async function autorizarMimosa(admin: SupabaseClient, usuarioId: string, p: PayloadMimosa): Promise<void> {
  const { data, error } = await admin.rpc("mimosa_autorizar_acao", {
    p_usuario_id: usuarioId, p_acao: p.acao, p_lead_id: p.lead_id ?? null,
    p_agendamento_id: p.agendamento_id ?? null, p_analise_id: p.analise_id ?? null,
  });
  if (error) throw new ErroAcessoMimosa("ACCESS_UNAVAILABLE", "Não foi possível verificar o acesso. Tente novamente.", 503);
  if (data?.permitido !== true) throw new ErroAcessoMimosa("FORBIDDEN", "Você não tem permissão para esta análise ou reunião.", 403);
  const { data: cota, error: erroCota } = await admin.rpc("mimosa_consumir_cota", { p_usuario_id: usuarioId, p_acao: p.acao });
  // Falha no contador também bloqueia: nunca gastar tokens sem conseguir reservar cota.
  if (erroCota || typeof cota?.permitido !== "boolean") throw new ErroAcessoMimosa("LIMIT_UNAVAILABLE", "Não foi possível verificar o limite de uso. Tente novamente.", 503);
  if (!cota.permitido) throw new ErroAcessoMimosa("RATE_LIMIT", "Limite de uso da Mimosa atingido. Aguarde para tentar novamente.", 429, Math.max(1, Number(cota.retry_after) || 60));
}
