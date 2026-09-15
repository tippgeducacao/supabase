import type { ClienteCampanhas } from "./handler.ts";

/** Não basta um JWT anon válido: o agendamento envia seu segredo privado do Vault. */
export async function autenticarDispatcher(req: Request, cliente: Pick<ClienteCampanhas, "rpc">, chaveServico: string): Promise<boolean> {
  if (chaveServico && req.headers.get("Authorization") === `Bearer ${chaveServico}`) return true;
  const segredo = req.headers.get("x-email-cron-secret");
  if (!segredo || !/^[a-f0-9]{64}$/i.test(segredo)) return false;
  try {
    const { data, error } = await cliente.rpc("email_campanha_validar_cron", { p_segredo: segredo });
    return !error && data === true;
  } catch { return false; }
}
