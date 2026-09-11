export interface LogIdempotente {
  id: string;
  status: string;
  provider?: string | null;
  provider_message_id?: string | null;
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
