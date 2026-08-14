// Edge Function: email-resend-status
// Responde "o Resend está realmente ligado?" — a pergunta que a tela de Marketing não
// sabia responder: ela só checava se EXISTE remetente Resend, o que não diz nada sobre
// a chave estar configurada nem sobre a API responder.
//
// Confere três camadas, da mais básica para a mais específica:
//   1. a secret RESEND_API_KEY existe no ambiente das edge functions?
//   2. a chave é aceita pela API do Resend (bate no endpoint de domínios)?
//   3. algum domínio está verificado — sem isso o envio é recusado.
//
// GET/POST, gate admin/diretor (expõe estado de configuração da conta).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { listarDominios, modoSeco, temResend } from "../_shared/resend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export interface StatusResend {
  /** Verde só quando dá para enviar de verdade. */
  ok: boolean;
  chaveConfigurada: boolean;
  apiRespondeu: boolean;
  dominiosVerificados: number;
  dominiosPendentes: number;
  modoSeco: boolean;
  /** Frase pronta para a tela mostrar — evita cada front inventar a sua. */
  mensagem: string;
  detalhe?: string;
}

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

    const [{ data: ehAdmin }, { data: ehDiretor }] = await Promise.all([
      supabase.rpc("has_role", { user_id: user.id, role_name: "admin" }),
      supabase.rpc("has_role", { user_id: user.id, role_name: "diretor" }),
    ]);
    if (!ehAdmin && !ehDiretor) return json({ error: "sem permissão" }, 403);

    const base: StatusResend = {
      ok: false,
      chaveConfigurada: temResend(),
      apiRespondeu: false,
      dominiosVerificados: 0,
      dominiosPendentes: 0,
      modoSeco: modoSeco(),
      mensagem: "",
    };

    if (!base.chaveConfigurada) {
      return json({
        ...base,
        mensagem: "RESEND_API_KEY não está configurada no ambiente das edge functions.",
        detalhe: "Adicione a secret ao serviço `functions` do compose e recrie só esse container — nunca clique em Deploy no Dokploy.",
      });
    }

    // A chamada de domínios é a mais barata que exige autenticação válida.
    const res = await listarDominios();
    if (!res.ok) {
      return json({
        ...base,
        mensagem: res.status === 401
          ? "A RESEND_API_KEY existe, mas o Resend recusou (401). A chave está inválida ou foi revogada."
          : "A chave existe, mas a API do Resend não respondeu.",
        detalhe: res.erro,
      });
    }

    const dominios = res.data?.data ?? [];
    const verificados = dominios.filter((d) => d.status === "verified");
    const pendentes = dominios.filter((d) => d.status !== "verified");

    const ok = verificados.length > 0;
    return json({
      ...base,
      ok,
      apiRespondeu: true,
      dominiosVerificados: verificados.length,
      dominiosPendentes: pendentes.length,
      mensagem: ok
        ? `Conectado ao Resend. ${verificados.length} domínio(s) verificado(s): ${verificados.map((d) => d.name).join(", ")}.`
        : dominios.length === 0
        ? "Conectado ao Resend, mas nenhum domínio foi cadastrado ainda."
        : "Conectado ao Resend, mas nenhum domínio está verificado — o envio será recusado.",
      detalhe: pendentes.length
        ? `Pendentes: ${pendentes.map((d) => `${d.name} (${d.status})`).join(", ")}`
        : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("email-resend-status", msg);
    return json({ error: msg }, 500);
  }
});
