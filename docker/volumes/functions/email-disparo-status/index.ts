// Edge Function: email-disparo-status
// Responde "o disparo está realmente ligado?" — para o provedor que a operação usa.
//
// Substitui o `email-resend-status` como porta única da tela: aquele só sabia falar de
// Resend e, depois do SES entrar, dizia "RESEND_API_KEY ausente" mesmo quando o Resend
// não era mais o provedor escolhido — aviso verdadeiro sobre a coisa errada.
//
// A régua é o que está CADASTRADO em `email_remetentes`, não uma constante no código:
//   - sem remetente de disparo → não há provedor a checar, e é isso que a tela diz;
//   - remetente SES  → confere credencial AWS + identidades verificadas;
//   - remetente Resend → confere a API key + domínios verificados.
//
// Gate: admin/diretor (expõe estado de configuração da conta).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { listarIdentidadesSes, temCredenciaisSes } from "../_shared/emailProviders/ses.ts";
import { listarDominios, modoSeco, temResend } from "../_shared/resend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const json = (c: unknown, s = 200) =>
  new Response(JSON.stringify(c), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export interface StatusDisparo {
  /** Verde só quando dá para enviar de verdade. */
  ok: boolean;
  /** 'ses' | 'resend' | null (nenhum remetente de disparo cadastrado). */
  provider: string | null;
  credencialConfigurada: boolean;
  apiRespondeu: boolean;
  dominiosVerificados: number;
  dominiosPendentes: number;
  modoSeco: boolean;
  /** Frase pronta para a tela — evita cada front inventar a sua. */
  mensagem: string;
  detalhe?: string;
  comoResolver?: string;
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

    const base: StatusDisparo = {
      ok: false, provider: null, credencialConfigurada: false, apiRespondeu: false,
      dominiosVerificados: 0, dominiosPendentes: 0, modoSeco: modoSeco(), mensagem: "",
    };

    // Quem manda é o cadastro. Ativo primeiro: um remetente desativado não envia.
    const { data: remetentes } = await supabase
      .from("email_remetentes")
      .select("provider, ativo")
      .in("provider", ["ses", "resend"])
      .order("ativo", { ascending: false });

    const emUso = (remetentes ?? []).find((r) => r.ativo)?.provider
      ?? (remetentes ?? [])[0]?.provider
      ?? null;

    if (!emUso) {
      return json({
        ...base,
        mensagem: "Nenhum remetente de disparo cadastrado — nada é enviado por campanha ainda.",
        comoResolver: "Em Remetentes, crie um remetente e escolha Amazon SES (ou Resend).",
      });
    }

    base.provider = emUso;

    // ── Amazon SES ────────────────────────────────────────────────────────────
    if (emUso === "ses") {
      base.credencialConfigurada = temCredenciaisSes();
      if (!base.credencialConfigurada) {
        return json({
          ...base,
          mensagem: "Credenciais da AWS não estão configuradas no ambiente das edge functions.",
          comoResolver: "Adicione AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY e AWS_REGION ao serviço `functions` do compose e recrie só esse container — nunca clique em Deploy no Dokploy.",
        });
      }

      const r = await listarIdentidadesSes();
      if (!r.ok) {
        return json({
          ...base,
          mensagem: r.codigo === "UnrecognizedClientException" || r.codigo === "InvalidClientTokenId"
            ? "As credenciais da AWS existem, mas o SES as recusou. Chave inválida ou sem permissão de SES."
            : "As credenciais existem, mas a API do SES não respondeu.",
          detalhe: r.erro,
        });
      }

      base.apiRespondeu = true;
      base.dominiosVerificados = r.verificadas.length;
      base.dominiosPendentes = r.pendentes.length;
      const ok = r.verificadas.length > 0;
      return json({
        ...base,
        ok,
        mensagem: ok
          ? `Conectado ao Amazon SES. ${r.verificadas.length} identidade(s) verificada(s): ${r.verificadas.join(", ")}.`
          : r.pendentes.length === 0
          ? "Conectado ao SES, mas nenhuma identidade foi cadastrada ainda."
          : "Conectado ao SES, mas nenhuma identidade está verificada — o envio será recusado.",
        detalhe: r.pendentes.length ? `Pendentes: ${r.pendentes.join(", ")}` : undefined,
        comoResolver: ok
          ? undefined
          : "Verifique o domínio no console do SES (SPF/DKIM) e confirme que a conta saiu do sandbox.",
      });
    }

    // ── Resend ────────────────────────────────────────────────────────────────
    base.credencialConfigurada = temResend();
    if (!base.credencialConfigurada) {
      return json({
        ...base,
        mensagem: "RESEND_API_KEY não está configurada no ambiente das edge functions.",
        comoResolver: "Adicione a secret ao serviço `functions` do compose e recrie só esse container — nunca clique em Deploy no Dokploy.",
      });
    }

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
      detalhe: pendentes.length ? `Pendentes: ${pendentes.map((d) => `${d.name} (${d.status})`).join(", ")}` : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("email-disparo-status", msg);
    return json({ error: msg }, 500);
  }
});
