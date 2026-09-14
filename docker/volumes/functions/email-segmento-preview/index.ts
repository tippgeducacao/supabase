// A prévia usa a mesma seleção/deduplicação do dispatcher, sem enviar mensagens.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { resolverSegmentoEmail, type SegmentoEmail } from "../_shared/emailSegmentos.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (dados: unknown, status = 200) => new Response(JSON.stringify(dados), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = req.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token) return json({ error: "Entre no sistema para consultar segmentos." }, 401);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user || user.is_anonymous) return json({ error: "Sessão inválida. Entre novamente." }, 401);

    const { query, segmento_id } = await req.json();
    let segmento: SegmentoEmail;
    if (segmento_id) {
      // Mesma régua da policy segmentos_select_authenticated: qualquer usuário
      // autenticado pode consultar segmentos. Nenhum acesso anônimo à amostra.
      const { data, error } = await supabase.from("email_segmentos")
        .select("tipo,query_dinamica,contatos_estaticos").eq("id", segmento_id).maybeSingle();
      if (error) return json({ error: "Não foi possível carregar o segmento." }, 500);
      if (!data) return json({ error: "Segmento não encontrado." }, 404);
      segmento = data as SegmentoEmail;
    } else {
      segmento = { tipo: "dinamico", query_dinamica: query };
    }
    const contatos = await resolverSegmentoEmail(supabase, segmento);
    return json({ contagem: contatos.length, amostra: contatos.slice(0, 5).map(({ email, nome }) => ({ email, nome })) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Não foi possível consultar o segmento." }, 400);
  }
});
