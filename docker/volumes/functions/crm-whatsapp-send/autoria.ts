import { canonicalBrClassificacao, classificaTelefone, digitosParaEnvio } from "../_shared/telefone.ts";

type RegistroAgendado = {
  criado_por: string | null; telefone: string; status: string;
  automacao_id: string | null; execucao_id: string | null;
};
type BancoAgendada = {
  from(tabela: string): {
    select(colunas: string): {
      eq(coluna: string, valor: string): {
        maybeSingle(): PromiseLike<{ data: RegistroAgendado | null; error: unknown }>;
      };
    };
  };
};
type BancoAutoria = {
  rpc(nome: string, parametros: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

// Compara identidade BR, sem alterar o destino do envio. DDD 55 sem DDI e a
// variante com o nono dígito precisam casar entre cadastro e sender atualizado.
function identidadeTelefone(telefone: string): string | null {
  return classificaTelefone(telefone) === "br"
    ? canonicalBrClassificacao(telefone)
    : digitosParaEnvio(telefone);
}

// 08/09/2026: o cron usa service_role, mas uma mensagem agendada manualmente
// continua sendo fala do vendedor. A autoria vem do registro, nunca de um nome
// arbitrário no body; fluxos/automações continuam fora dessa classificação.
export async function autorDaMensagemAgendada(
  admin: BancoAgendada,
  envio: { serviceRole: boolean; mensagemId: unknown; telefone: string; origem: string | null; fluxoId?: unknown; automacaoId?: unknown },
): Promise<string | null> {
  if (!envio.serviceRole || typeof envio.mensagemId !== "string"
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(envio.mensagemId)
    || (envio.origem && envio.origem !== "humano") || envio.fluxoId || envio.automacaoId) return null;

  const { data, error } = await admin.from("crm_mensagens_agendadas")
    .select("criado_por, telefone, status, automacao_id, execucao_id")
    .eq("id", envio.mensagemId).maybeSingle();
  if (error) throw new Error("Não foi possível confirmar a autoria da mensagem agendada.");
  if (!data?.criado_por || data.status !== "enviando" || data.automacao_id || data.execucao_id
    || identidadeTelefone(data.telefone) !== identidadeTelefone(envio.telefone)) return null;
  return data.criado_por;
}

// A confirmação pode chegar depois do eco fromMe. O merge é atômico no banco,
// preserva transcrição já salva e corrige a origem sem inserir outra mensagem.
export async function confirmarAutoriaAposEco(
  admin: BancoAutoria,
  envio: { erro: { code?: string } | null; aceito: boolean; waMessageId: string | null; conexaoId: string; metadata: Record<string, unknown> },
): Promise<void> {
  if (envio.erro?.code !== "23505" || !envio.aceito || !envio.waMessageId) return;
  const { data, error } = await admin.rpc("crm_sdr_confirmar_autoria_saida", {
    p_wa_message_id: envio.waMessageId,
    p_wa_conexao_id: envio.conexaoId,
    p_metadata: { ...envio.metadata, origem: envio.metadata.origem || "sistema" },
  });
  if (error || data !== true) throw new Error("Não foi possível confirmar a autoria do eco de saída.");
}
