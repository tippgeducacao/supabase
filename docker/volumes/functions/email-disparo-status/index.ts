// Edge Function: email-disparo-status
// Responde "o disparo está realmente ligado?" — para o provedor que a operação usa.
//
// Porta única da tela para "o disparo está ligado?". O antecessor sabia falar só de um
// provedor e dizia "chave ausente" mesmo quando aquele provedor não era o escolhido —
// aviso verdadeiro sobre a coisa errada. A régua é o que está CADASTRADO.
//
// A régua é o que está CADASTRADO em `email_remetentes`, não uma constante no código:
//   - sem remetente de disparo → não há provedor a checar, e é isso que a tela diz;
//   - remetente SES  → confere credencial AWS + identidades verificadas;
//   - remetente Resend → domínios dos remetentes ativos + assinatura do webhook;
//
// Gate: admin/diretor (expõe estado de configuração da conta).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { listarIdentidadesSes, temCredenciaisSes } from "../_shared/emailProviders/ses.ts";
import { baseStatusDisparo, verificarStatusResend, type StatusDisparo } from "./statusResend.ts";

export type { StatusDisparo } from "./statusResend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const json = (c: unknown, s = 200) =>
  new Response(JSON.stringify(c), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

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

    const pedido = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const escolhido = pedido?.provider;
    if (escolhido != null && escolhido !== "ses" && escolhido !== "resend") {
      return json({ error: "Provedor de disparo inválido." }, 400);
    }
    const base: StatusDisparo = baseStatusDisparo(null);

    // Quem manda é o cadastro. Ativo primeiro: um remetente desativado não envia.
    const { data: remetentes, error: remetentesErro } = await supabase
      .from("email_remetentes")
      .select("provider, ativo, email_completo")
      .in("provider", ["ses", "resend"])
      .order("ativo", { ascending: false });
    if (remetentesErro) return json({ error: "Não foi possível consultar os remetentes de disparo." }, 500);

    const emUso = escolhido
      ?? (remetentes ?? []).find((r) => r.ativo && r.provider === "resend")?.provider
      ?? (remetentes ?? []).find((r) => r.ativo)?.provider
      ?? (remetentes ?? [])[0]?.provider
      ?? null;

    if (!emUso) {
      return json({
        ...base,
        mensagem: "Nenhum remetente de disparo cadastrado — nada é enviado por campanha ainda.",
        comoResolver: "Em Remetentes, crie um remetente e escolha Resend ou Amazon SES.",
      });
    }

    base.provider = emUso;

    if (emUso === "resend") {
      return json(await verificarStatusResend({
        remetentes: remetentes ?? [],
        apiKey: Deno.env.get("RESEND_API_KEY"),
        webhookSecret: Deno.env.get("RESEND_WEBHOOK_SECRET"),
        modoSeco: Deno.env.get("RESEND_DRY_RUN")?.toLowerCase() === "true",
      }));
    }

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

    return json({
      ...base,
      mensagem: "O provedor do remetente não está disponível para disparos.",
      comoResolver: "Em Remetentes, escolha Resend ou Amazon SES.",
    });
  } catch (e) {
    console.error("email-disparo-status: falha ao consultar configuração");
    return json({ error: "Não foi possível consultar a configuração de disparos." }, 500);
  }
});
