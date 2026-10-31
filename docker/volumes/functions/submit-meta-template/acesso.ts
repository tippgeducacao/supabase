import { AcessoNegado } from "../_shared/acessoRegra.ts";

export async function exigirPedagogico(cliente: any, usuarioId: string): Promise<void> {
  const { data, error } = await cliente.rpc("user_can_access_pedagogico", { _user_id: usuarioId });
  if (error) throw new AcessoNegado(503, "Não foi possível conferir o acesso ao Pedagógico.");
  if (data !== true) throw new AcessoNegado(403, "Sem permissão para os templates do Pedagógico.");
}

// Reenvio preserva a conta dona. Troca explícita só para as contas do domínio configuradas
// no servidor, incluindo a migração; um UUID no corpo não escolhe qualquer credencial da casa.
export function contaAutorizada(
  solicitada: unknown, dona: string | null, padrao: string | null, configuradas: string[],
): string {
  if (solicitada != null && (typeof solicitada !== "string" || !solicitada)) {
    throw new AcessoNegado(403, "Conta de WhatsApp não autorizada.");
  }
  const conta = (solicitada as string | undefined) ?? dona ?? padrao;
  if (!conta || (conta !== dona && conta !== padrao && !configuradas.includes(conta))) {
    throw new AcessoNegado(403, "Conta de WhatsApp não autorizada para este template.");
  }
  return conta;
}
