import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { criarHandlerImportarMaterialEmailIA } from "./handler.ts";
import { criarRedeMaterialEmailIA } from "./transporte.ts";

// Auth e autorização são verificadas no handler também no runtime self-hosted.
Deno.serve(criarHandlerImportarMaterialEmailIA(
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } }),
  criarRedeMaterialEmailIA(Deno),
));
