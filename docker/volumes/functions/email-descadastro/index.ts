// Edge Function: email-descadastro
// Alvo do link "Descadastrar" e do cabeçalho List-Unsubscribe dos disparos.
//
// Sem estado: o token é um HMAC do próprio e-mail (_shared/resend.ts), então não há
// tabela de tokens e o link só descadastra o endereço que ele assina.
//
// Aceita GET (clique humano) e POST (one-click do Gmail/Yahoo, que exigem
// List-Unsubscribe-Post desde 2024 de quem manda volume).
//
// A lógica vive em `handler.ts`, testável sem subir o Deno.serve.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, pagina, tratarDescadastro } from "./handler.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return await tratarDescadastro(req, { supabase });
  } catch (e) {
    console.error("email-descadastro", e);
    return pagina("Não deu certo", "Tente novamente em instantes.", false);
  }
});
