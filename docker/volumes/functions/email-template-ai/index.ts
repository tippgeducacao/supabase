import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { validarDocumentoIA, PROMPT_DOCUMENTO_IA } from "../_shared/emailBuilder/ai.ts";
import { criarHandlerEmailIA } from "./handler.ts";
import { criarRedeLinksEmailIA } from "./transporteLinks.ts";

// O runtime self-hosted não aplica config.toml por função: o handler autentica
// a sessão e autoriza o editor antes de consultar catálogo/chaves ou consumir IA.
Deno.serve(criarHandlerEmailIA({
  cliente: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } }),
  criarClienteUsuario: (token) => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false },
  }),
  redeLinks: criarRedeLinksEmailIA(Deno),
  // Mesma chave que o import de fotos de professor já usa. Sem ela o painel
  // simplesmente não anuncia a biblioteca do Drive, em vez de falhar ao usar.
  chaveDrive: Deno.env.get("GOOGLE_DRIVE_API_KEY") || undefined,
  validarDocumento: validarDocumentoIA,
  promptDocumento: PROMPT_DOCUMENTO_IA,
  urlPublica: Deno.env.get("SUPABASE_PUBLIC_URL") || Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site",
}));
