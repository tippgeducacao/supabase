// Edge Function: email-dominios-verificar
// Cria/relê o domínio de um remetente Resend e guarda os DNS records REAIS em
// email_remetentes.dns_records — a tela de Domínios mostrava exemplos fixos antes disso.
//
// POST { remetente_id?: uuid, forcar_verificacao?: boolean }
//   sem remetente_id → processa todos os remetentes com provider='resend'.
//
// Gate: admin/diretor (a chamada expõe estado de configuração do domínio).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  criarDominio,
  dnsRecordsParaTela,
  listarDominios,
  obterDominio,
  temResend,
  verificarDominio,
  type ResendDominio,
} from "../_shared/resend.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function dominioDoEmail(email: string): string | null {
  const parte = email.split("@")[1]?.trim().toLowerCase();
  return parte || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!temResend()) {
      return json({
        error: "RESEND_API_KEY não configurada no ambiente das edge functions.",
        como_resolver: "Adicione a secret ao serviço functions do compose e recrie só esse container.",
      }, 412);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Gate: admin/diretor -----------------------------------------------------
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "não autenticado" }, 401);

    // has_role tem DUAS sobrecargas (_user_id/_role app_role e user_id/role_name text).
    // Os nomes abaixo escolhem a de texto — trocar para _user_id/_role deixa a chamada
    // ambígua e o PostgREST devolve "function is not unique".
    const [{ data: ehAdmin }, { data: ehDiretor }] = await Promise.all([
      supabase.rpc("has_role", { user_id: user.id, role_name: "admin" }),
      supabase.rpc("has_role", { user_id: user.id, role_name: "diretor" }),
    ]);
    if (!ehAdmin && !ehDiretor) return json({ error: "sem permissão" }, 403);

    const { remetente_id, forcar_verificacao } = await req.json().catch(() => ({}));

    let q = supabase
      .from("email_remetentes")
      .select("id, email_completo, provider, resend_domain_id, dominio_verificado")
      .eq("provider", "resend");
    if (remetente_id) q = q.eq("id", remetente_id);
    const { data: remetentes, error } = await q;
    if (error) return json({ error: error.message }, 500);
    if (!remetentes?.length) {
      return json({ ok: true, processados: 0, aviso: "nenhum remetente com provider Resend" });
    }

    // Um GET só, reaproveitado: evita bater na API por remetente quando vários
    // compartilham o mesmo domínio (tcc@, secretaria@, cancelamento@...).
    const listados = await listarDominios();
    const porNome = new Map<string, ResendDominio>();
    for (const d of listados.data?.data ?? []) porNome.set(d.name.toLowerCase(), d);

    const resultados: unknown[] = [];

    for (const rem of remetentes) {
      const nomeDominio = dominioDoEmail(rem.email_completo);
      if (!nomeDominio) {
        resultados.push({ remetente: rem.email_completo, ok: false, erro: "e-mail sem domínio" });
        continue;
      }

      let dominio: ResendDominio | undefined;

      if (rem.resend_domain_id) {
        const r = await obterDominio(rem.resend_domain_id);
        if (r.ok) dominio = r.data;
      }
      // Já existe no painel (cadastrado à mão ou por outro remetente do mesmo domínio).
      if (!dominio) dominio = porNome.get(nomeDominio);

      if (!dominio) {
        const criado = await criarDominio(nomeDominio);
        if (!criado.ok) {
          resultados.push({ remetente: rem.email_completo, ok: false, erro: criado.erro });
          continue;
        }
        dominio = criado.data;
        if (dominio) porNome.set(nomeDominio, dominio);
      }

      if (!dominio) {
        resultados.push({ remetente: rem.email_completo, ok: false, erro: "domínio não resolvido" });
        continue;
      }

      // Pede a reconferência do DNS e relê — o Resend atualiza de forma assíncrona,
      // então o status pode continuar 'pending' nesta rodada.
      if (forcar_verificacao && dominio.status !== "verified") {
        await verificarDominio(dominio.id);
        const relido = await obterDominio(dominio.id);
        if (relido.ok && relido.data) dominio = relido.data;
      }

      const verificado = dominio.status === "verified";
      await supabase.from("email_remetentes").update({
        resend_domain_id: dominio.id,
        dns_records: dnsRecordsParaTela(dominio),
        dominio_status: dominio.status,
        dominio_verificado: verificado,
        dominio_verificado_em: verificado ? new Date().toISOString() : null,
      }).eq("id", rem.id);

      resultados.push({
        remetente: rem.email_completo,
        dominio: dominio.name,
        status: dominio.status,
        verificado,
        registros: dnsRecordsParaTela(dominio).length,
        ok: true,
      });
    }

    return json({ ok: true, processados: resultados.length, resultados });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("email-dominios-verificar", msg);
    return json({ error: msg }, 500);
  }
});
