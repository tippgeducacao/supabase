// acesso: publico — webhook do Read AI; só grava com HMAC-SHA256 (X-Read-Signature) válido sobre o corpo cru
//
// Registra a reunião na aba Reuniões da empresa e guarda a entrega em `crm_readai_webhook_recebidos`.
// Chave de assinatura em app_secrets('READ_AI_SIGNING_KEY'); sem ela, responde 503 e não grava nada.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { tratarWebhookReadAi } from "./handler.ts";
import { processarReuniao } from "./processar.ts";
import { repoDoBanco } from "./repo.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve((req) =>
  tratarWebhookReadAi(req, {
    lerChaves: async () => {
      const { data, error } = await admin
        .from("app_secrets")
        .select("valor")
        .eq("chave", "READ_AI_SIGNING_KEY")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.valor ?? null;
    },
    processar: (payload) => processarReuniao(payload, repoDoBanco(admin)),
    gravar: async (registro) => {
      const { error } = await admin.from("crm_readai_webhook_recebidos").insert(registro);
      return { error };
    },
  })
);
