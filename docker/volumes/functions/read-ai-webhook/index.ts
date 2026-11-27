// acesso: publico — webhook do Read AI; só grava com HMAC-SHA256 (X-Read-Signature) válido sobre o corpo cru
//
// Etapa 1 da integração: guarda o que o Read manda em `crm_readai_webhook_recebidos` (só service role).
// Chave de assinatura em app_secrets('READ_AI_SIGNING_KEY'); sem ela, responde 503 e não grava nada.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { tratarWebhookReadAi } from "./handler.ts";

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
    gravar: async (registro) => {
      const { error } = await admin.from("crm_readai_webhook_recebidos").insert(registro);
      return { error };
    },
  })
);
