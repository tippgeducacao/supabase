import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type { WaStatus } from "./waProviders.ts";

interface MetadadosStatusWa {
  numero?: string | null;
  qrcode?: string | null;
  paircode?: string | null;
}

/**
 * O banner usa ultimo_status_em como identidade da queda (2026-09-11). Repetir
 * o mesmo status em webhook/polling não pode trocar esse horário: isso reabria
 * o alerta que o usuário já tinha fechado no OK.
 *
 * A comparação acontece no UPDATE, e não numa leitura anterior: dois eventos
 * iguais concorrentes devem registrar uma única transição. O refresh separado
 * de número/QR também confere o estado, para não limpar o QR de uma reconexão
 * que começou enquanto o evento anterior de "conectado" estava sendo tratado.
 */
export async function atualizarStatusWaConexao(
  admin: SupabaseClient,
  conexaoId: string,
  status: WaStatus,
  metadados: MetadadosStatusWa = {},
): Promise<boolean> {
  const patchMetadados = { ...metadados };
  if (status === "conectado") {
    patchMetadados.qrcode = null;
    patchMetadados.paircode = null;
  }

  const { data, error } = await admin.from("wa_conexoes")
    .update({
      ...patchMetadados,
      status_conexao: status,
      ultimo_status_em: new Date().toISOString(),
    })
    .eq("id", conexaoId)
    .neq("status_conexao", status)
    .select("id");
  if (error) throw new Error(`Falha ao atualizar status da linha: ${error.message}`);
  if (data?.length) return true;

  // Mesmo estado ainda pode trazer número/QR novos. Nunca regrava status nem
  // horário aqui, inclusive se outra requisição mudou a linha entre os UPDATEs.
  if (Object.keys(patchMetadados).length > 0) {
    const { error: erroMetadados } = await admin.from("wa_conexoes")
      .update(patchMetadados)
      .eq("id", conexaoId)
      .eq("status_conexao", status);
    if (erroMetadados) throw new Error(`Falha ao atualizar dados da linha: ${erroMetadados.message}`);
  }
  return false;
}
