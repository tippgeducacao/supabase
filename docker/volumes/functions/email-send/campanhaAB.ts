import { normalizarEmail } from "../_shared/supressao.ts";
import type { ClienteCampanhas } from "../email-campaign-dispatcher/handler.ts";

interface PedidoCampanha {
  contexto_tipo?: string; contexto_id?: string; campanha_envio_id?: string;
  destinatario_email: string; template_id?: string; remetente_id?: string; idempotencia_key?: string; idempotencia_janela_min?: number;
}
export interface ModeloCampanhaAB { id: string; assunto: string; corpo_html: string; corpo_texto: string | null; uso: "marketing" }

/** A cópia é buscada no banco, nunca aceita do corpo de uma chamada externa. */
export async function resolverModeloCampanhaAB(cliente: ClienteCampanhas, pedido: PedidoCampanha, interno: boolean): Promise<ModeloCampanhaAB | null> {
  const chaveCampanha = pedido.idempotencia_key?.startsWith("campanha:");
  if (pedido.contexto_tipo !== "campanha" && !chaveCampanha && !pedido.campanha_envio_id) return null;
  if (!interno || pedido.contexto_tipo !== "campanha" || !pedido.contexto_id || !chaveCampanha || pedido.idempotencia_janela_min) {
    throw new Error("O envio de campanha e sua chave são exclusivos do processamento da fila.");
  }
  const { data: campanha, error } = await cliente.from("email_campanhas").select("id,template_id,template_b_id,remetente_id,modelos_snapshot,status").eq("id", pedido.contexto_id).single();
  if (error || !campanha) throw new Error("Campanha não encontrada.");
  if (!["agendada", "enviando"].includes(campanha.status)) throw new Error("O envio da campanha está pausado ou encerrado.");
  const envioId = pedido.campanha_envio_id ?? pedido.idempotencia_key?.match(/^campanha:([0-9a-f-]{36})$/i)?.[1];
  if (!envioId || pedido.idempotencia_key !== `campanha:${envioId}`) throw new Error("Chave do envio de campanha inválida.");
  const { data: envio, error: erroEnvio } = await cliente.from("email_campanhas_envios")
    .select("campanha_id,contato_email,template_id,variante,status").eq("id", envioId).single();
  if (erroEnvio || !envio || envio.campanha_id !== campanha.id || envio.status !== "pendente"
    || normalizarEmail(envio.contato_email) !== normalizarEmail(pedido.destinatario_email)
    || (envio.template_id ?? campanha.template_id) !== pedido.template_id || campanha.remetente_id !== pedido.remetente_id
    || campanha.template_b_id && !["A", "B"].includes(envio.variante)) throw new Error("O pedido não corresponde ao destinatário e à variante registrados.");
  if (!campanha.template_b_id) return null;
  const modelo = campanha.modelos_snapshot?.[envio.variante] as ModeloCampanhaAB | undefined;
  if (!modelo || modelo.id !== envio.template_id || typeof modelo.assunto !== "string" || typeof modelo.corpo_html !== "string" || modelo.uso !== "marketing") {
    throw new Error("O conteúdo confirmado da variante está indisponível.");
  }
  return modelo;
}
