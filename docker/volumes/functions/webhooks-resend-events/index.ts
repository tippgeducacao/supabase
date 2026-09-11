// Público por necessidade do Resend, autenticado pela assinatura Svix no corpo cru.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { tratarEventoResend } from "./handler.ts";

Deno.serve((req) => tratarEventoResend(req, {
  supabase: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
  segredo: Deno.env.get("RESEND_WEBHOOK_SECRET"),
}));
