// Linha WhatsApp dedicada (Uazapi) do assistente. Reusa o adapter provider-agnóstico
// _shared/waProviders.ts. NUNCA passa por crm-whatsapp-send / crm_whatsapp_messages / SAC.
import { getWaProvider } from "../_shared/waProviders.ts";

export interface LinhaWa {
  id: string;
  provider: string;
  server_url: string;
  instancia_externa_id: string | null;
  numero: string | null;
  token: string;
}

/** Carrega a linha ativa + token (segredo em tabela service_role-only). */
export async function carregarLinha(admin: any): Promise<LinhaWa | null> {
  const { data: linha } = await admin
    .from("assistente_wa_linha")
    .select("id, provider, server_url, instancia_externa_id, numero")
    .eq("ativo", true)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!linha?.server_url) return null;
  const { data: sec } = await admin
    .from("assistente_wa_secrets")
    .select("token")
    .eq("linha_id", linha.id)
    .maybeSingle();
  if (!sec?.token) return null;
  return { ...linha, token: sec.token } as LinhaWa;
}

export async function enviarTexto(linha: LinhaWa, numeroDigits: string, texto: string) {
  const provider = getWaProvider(linha.provider || "uazapi");
  return await provider.sendText(linha.server_url, linha.token, numeroDigits, texto);
}

export async function baixarAudio(linha: LinhaWa, externalId: string) {
  const provider = getWaProvider(linha.provider || "uazapi");
  return await provider.downloadMedia(linha.server_url, linha.token, externalId, { audioMp3: true });
}
