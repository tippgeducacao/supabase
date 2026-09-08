import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { validarDocumentoIA, PROMPT_DOCUMENTO_IA } from "../_shared/emailBuilder/ai.ts";
import { criarHandlerEmailIA } from "./handler.ts";

// O runtime self-hosted não aplica config.toml por função: o handler autentica
// a sessão e autoriza o editor antes de consultar catálogo/chaves ou consumir IA.
Deno.serve(criarHandlerEmailIA({
  cliente: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } }),
  validarDocumento: validarDocumentoIA,
  promptDocumento: PROMPT_DOCUMENTO_IA,
  urlPublica: Deno.env.get("SUPABASE_PUBLIC_URL") || Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site",
}));
