import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export class ErroAcessoEnvioEmail extends Error {
  constructor(public status: number, public code: string, mensagem: string) { super(mensagem); }
}
/** O runtime self-hosted não lê verify_jwt por função. Toda entrada precisa
 * validar a identidade ANTES de consultar modelos/remetentes ou reservar envios.
 * Chamadas transacionais internas conservam a chave exata de serviço (15/09/2026). */
export async function autorizarEnvioEmail(cliente: SupabaseClient, authorization: string | null, opcoes: { chaveServico?: string; permitirInterno?: boolean } = {}): Promise<{ usuarioId: string | null; interno: boolean; authorization: string }> {
  const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) throw new ErroAcessoEnvioEmail(401, "UNAUTHENTICATED", "Entre no sistema para enviar e-mails.");
  if (opcoes.permitirInterno && opcoes.chaveServico && token === opcoes.chaveServico) return { usuarioId: null, interno: true, authorization: `Bearer ${token}` };
  let usuarioId: string;
  try {
    const { data, error } = await cliente.auth.getUser(token);
    if (error || !data.user?.id || data.user.is_anonymous) throw new ErroAcessoEnvioEmail(401, "UNAUTHENTICATED", "Sessão inválida. Entre novamente para enviar e-mails.");
    usuarioId = data.user.id;
  } catch (e) {
    if (e instanceof ErroAcessoEnvioEmail) throw e;
    throw new ErroAcessoEnvioEmail(503, "ACCESS_UNAVAILABLE", "Não foi possível verificar sua sessão. Tente novamente.");
  }
  try {
    // Mesma régua do resto do E-mail Marketing: perfil ativo e admin, diretor ou liberado
    // nominalmente em `email_marketing_gestores` (09/10/2026 — o Marco, do Marketing).
    const { data: pode, error } = await cliente.rpc("email_marketing_pode_gerir", { p_usuario: usuarioId });
    if (error) throw new ErroAcessoEnvioEmail(503, "ACCESS_UNAVAILABLE", "Não foi possível verificar sua permissão de envio. Tente novamente.");
    if (pode !== true) throw new ErroAcessoEnvioEmail(403, "FORBIDDEN", "Você não tem permissão para enviar modelos ou testes de e-mail.");
  } catch (e) {
    if (e instanceof ErroAcessoEnvioEmail) throw e;
    throw new ErroAcessoEnvioEmail(503, "ACCESS_UNAVAILABLE", "Não foi possível verificar sua permissão de envio. Tente novamente.");
  }
  return { usuarioId, interno: false, authorization: `Bearer ${token}` };
}
export function conferirContaEnvioEmail(usuarioEsperado: unknown, usuarioId: string | null): void {
  if (usuarioEsperado !== undefined && usuarioEsperado !== usuarioId) throw new ErroAcessoEnvioEmail(409, "ACCOUNT_CHANGED", "A conta mudou durante a preparação. Reabra o envio na conta atual.");
}
