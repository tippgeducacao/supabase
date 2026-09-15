import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { criarHandlerTesteEmail } from "./handler.ts";

Deno.serve(criarHandlerTesteEmail({
  cliente: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } }),
  urlSupabase: Deno.env.get("SUPABASE_URL")!,
}));
