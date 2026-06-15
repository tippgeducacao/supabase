// Telemetria do agente SDR — grava a trilha de execução em crm_agente_sdr_eventos
// (a "visão de execuções" que o n8n dava, agora no banco e na aba de debug do CRM).
// Fire-and-forget: telemetria NUNCA derruba nem atrasa a rodada.

// deno-lint-ignore-file no-explicit-any
export type Telemetria = {
  rodadaId: string;
  registrar: (tipo: string, dados?: Record<string, unknown>, duracaoMs?: number, erro?: string) => void;
};

export function criarTelemetria(supabase: any, remotejid: string): Telemetria {
  const rodadaId = crypto.randomUUID();
  return {
    rodadaId,
    registrar(tipo, dados = {}, duracaoMs, erro) {
      try {
        supabase
          .from('crm_agente_sdr_eventos')
          .insert({
            remotejid,
            rodada_id: rodadaId,
            tipo,
            dados,
            duracao_ms: duracaoMs != null ? Math.round(duracaoMs) : null,
            erro: erro ?? null,
          })
          .then(({ error }: any) => {
            if (error) console.log(`[crm-agente-sdr] telemetria falhou (${tipo}): ${error.message}`);
          });
      } catch (e) {
        console.log(`[crm-agente-sdr] telemetria exception (${tipo}): ${(e as Error).message}`);
      }
    },
  };
}

// Encurta valores grandes pra caber legível na timeline de debug.
export function resumir(v: unknown, max = 1500): unknown {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return v;
  return s.length > max ? `${s.slice(0, max)}… [truncado ${s.length} chars]` : v;
}
