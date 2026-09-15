export interface LogIdempotente {
  id: string;
  status: string;
  provider?: string | null;
  provider_message_id?: string | null;
}

/** A janela é exclusiva de reenvios transacionais. Campanhas nunca trocam chave. */
export function permiteNovaChaveIdempotente(janela: number | undefined, contexto: string | undefined, chave: string): boolean {
  return Number.isFinite(janela) && (janela ?? 0) > 0 && contexto !== "campanha" && !chave.startsWith("campanha:");
}

export function conferirConsultaIdempotente(erro: unknown, log: (LogIdempotente & { contexto_tipo?: string; contexto_id?: string; destinatario_email?: string; template_id?: string }) | null,
  pedido: { contexto_tipo?: string; contexto_id?: string; destinatario_email: string; template_id?: string }) {
  if (erro) throw new Error("Não foi possível conferir a idempotência. Nenhum novo envio foi autorizado.");
  if (log && pedido.contexto_tipo === "campanha" && (log.contexto_tipo !== "campanha" || log.contexto_id !== pedido.contexto_id
    || log.destinatario_email?.trim().toLowerCase() !== pedido.destinatario_email.trim().toLowerCase() || log.template_id !== pedido.template_id)) {
    throw new Error("O log existente não corresponde ao envio desta campanha. Confira o registro antes de reenviar.");
  }
}

/** Repetir a requisição não transforma falha ou envio em andamento em sucesso. */
export function respostaEnvioExistente(log: LogIdempotente): { status: number; corpo: Record<string, unknown> } {
  const aceito = !!log.provider_message_id || ["enviado", "entregue", "aberto", "clicado"].includes(log.status);
  return {
    status: aceito ? 200 : 409,
    corpo: {
      ok: aceito, duplicado: true, id: log.id, log_id: log.id,
      provider: log.provider, provider_message_id: log.provider_message_id ?? null,
      ...(aceito ? {} : {
        error: "Este envio já foi registrado, mas a aceitação ainda não foi confirmada. Confira o log antes de reenviar.",
        codigo: "envio_existente_sem_confirmacao", status_envio: log.status,
      }),
    },
  };
}
