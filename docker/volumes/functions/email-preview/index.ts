// Edge Function: email-preview
// Compila um documento no SERVIDOR e devolve o HTML — §7 do spec.
//
// Só é possível porque o compilador é TS puro, sem DOM e sem dependência: o MESMO
// arquivo que o construtor usa no navegador roda aqui. Era exatamente isto que o
// mjml-browser impedia (precisa de DOM, que a edge não tem).
//
// POST { email_id?: uuid, documento?: DocumentoEmail, contato?: {...}, formato?: "html"|"texto" }
//   - com `email_id`, lê o documento do banco;
//   - com `documento`, compila o que veio no corpo (preview de rascunho não salvo).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { compilarDocumento } from "../_shared/emailBuilder/compile.ts";
import type { DocumentoEmail } from "../_shared/emailBuilder/types.ts";
import { linkDescadastro } from "../_shared/resend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (c: unknown, s = 200) =>
  new Response(JSON.stringify(c), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** Contato fictício, usado quando o chamador não manda um real. */
const CONTATO_EXEMPLO = {
  contato: {
    nome: "Ana Paula Souza", primeiro_nome: "Ana", email: "ana@exemplo.com",
    telefone: "(42) 99999-0000", cidade: "Ponta Grossa",
  },
  empresa: { nome: "Clínica Vet Central" },
  responsavel: { nome: "Welinton", email: "welinton@ppgeducacao.com" },
  curso: { nome: "Pós em Clínica Médica de Pequenos Animais" },
  turma: { nome: "Turma 2026/1" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user } } = await supabase.auth.getUser(
      (req.headers.get("Authorization") ?? "").replace("Bearer ", ""),
    );
    if (!user) return json({ error: "não autenticado" }, 401);

    const body = await req.json().catch(() => ({}));
    const { email_id, documento, contato, formato } = body as {
      email_id?: string;
      documento?: DocumentoEmail;
      contato?: Record<string, unknown>;
      formato?: "html" | "texto";
    };

    let doc = documento;
    let utm: Record<string, string | null> = {};

    if (email_id) {
      // A RLS decide se este usuário enxerga o e-mail; o service_role a contorna, então
      // conferimos explicitamente com a mesma função que a policy usa.
      const { data: visivel } = await supabase.rpc("email_visivel", {
        _email_id: email_id, _user_id: user.id,
      });
      if (!visivel) return json({ error: "sem permissão sobre este e-mail" }, 403);

      const { data: reg, error } = await supabase
        .from("emails")
        .select("conteudo_json, utm_source, utm_campaign, utm_medium, utm_term, utm_content")
        .eq("id", email_id)
        .maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!reg) return json({ error: "e-mail não encontrado" }, 404);

      doc = reg.conteudo_json as DocumentoEmail | null ?? undefined;
      utm = {
        source: reg.utm_source, campaign: reg.utm_campaign, medium: reg.utm_medium,
        term: reg.utm_term, content: reg.utm_content,
      };
    }

    if (!doc?.linhas) {
      return json({ error: "sem documento para compilar (envie `documento` ou um email_id com conteudo_json)" }, 400);
    }

    const publica = Deno.env.get("SUPABASE_PUBLIC_URL") ||
      Deno.env.get("PUBLIC_SUPABASE_URL") ||
      Deno.env.get("SUPABASE_URL")!;

    const dados = { ...CONTATO_EXEMPLO, ...(contato ?? {}) };
    const destino = String((dados as { contato?: { email?: string } }).contato?.email ?? "exemplo@exemplo.com");

    const resultado = compilarDocumento(doc, {
      dados,
      utm,
      // Preview NÃO leva pixel: contaria abertura de quem só está conferindo o layout.
      pixelUrl: null,
      descadastroUrl: await linkDescadastro(publica, destino),
    });

    return json({
      ok: true,
      html: formato === "texto" ? undefined : resultado.html,
      texto: resultado.texto,
      avisos: resultado.avisos,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("email-preview", msg);
    return json({ error: msg }, 500);
  }
});
