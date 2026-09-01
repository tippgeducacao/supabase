// Edge Function: crm-mencao-email
//
// Avisa POR E-MAIL o colega que foi marcado com @ numa atividade do CRM (observação da
// empresa, do negócio ou do contato). O aviso no SINO continua sendo gravado pelo
// próprio front (`crm_notificacoes`); esta função é só o segundo canal — pedido do
// usuário 2026-09-01: "e se for por e-mail?", porque nem todo mundo fica olhando o sino.
//
// ⚠️ SÓ COLEGA. Contato de empresa (o cliente) nunca entra aqui: a observação é uma nota
// INTERNA e mandá-la para fora seria vazamento. Quem chama já separa as duas espécies
// (ver `useCrmMencoes.ts`), e aqui os ids são resolvidos contra `profiles` — um id de
// lead simplesmente não acha e-mail nenhum e cai fora.
//
// Por que uma função e não o front chamando `email-send` direto:
//   1. o e-mail do destinatário é resolvido no SERVIDOR (service_role), então o cliente
//      não precisa carregar/enviar e-mail de ninguém;
//   2. a escolha do REMETENTE mora num lugar só;
//   3. a idempotência (não mandar o mesmo aviso duas vezes) fica centralizada.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Payload {
  /** `profiles.id` de quem foi mencionado. */
  destinatarios: string[];
  /** Quem escreveu (para o "Fulano mencionou você"). */
  autor_nome?: string;
  /** Nome do registro (empresa, negócio ou contato). */
  onde?: string;
  /** Trecho em TEXTO PURO da observação. */
  trecho?: string;
  /** URL ABSOLUTA do registro — quem chama sabe a origem do app; a função não. */
  link?: string;
  /** Id da atividade — entra na chave de idempotência. */
  atividade_id?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function corpoHtml({ autor, onde, trecho, link }: { autor: string; onde: string | null; trecho: string; link: string | null }) {
  const titulo = `${esc(autor)} mencionou você${onde ? ` em ${esc(onde)}` : ""}`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">
  <p style="margin:0 0 12px"><strong>${titulo}</strong></p>
  ${trecho ? `<blockquote style="margin:0 0 16px;padding:10px 14px;border-left:3px solid #7c3aed;background:#f5f3ff;color:#374151">${esc(trecho)}</blockquote>` : ""}
  ${link ? `<p style="margin:0 0 16px"><a href="${esc(link)}" style="display:inline-block;padding:9px 16px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Abrir no CRM</a></p>` : ""}
  <p style="margin:0;font-size:12px;color:#6b7280">Você recebeu este aviso porque foi marcado com @ numa observação do CRM.</p>
</div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "não autenticado" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Só usuário logado dispara e-mail — senão a função vira um relay aberto.
    const { data: userData } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    ).auth.getUser();
    if (!userData?.user) return json({ error: "não autenticado" }, 401);

    const p = (await req.json()) as Payload;
    const ids = Array.from(new Set((p.destinatarios ?? []).filter(Boolean)));
    if (ids.length === 0) return json({ enviados: 0, motivo: "sem destinatários" });

    // E-mail resolvido no servidor. Só perfis ATIVOS e com e-mail: mandar aviso para
    // quem saiu da empresa é ruído, e sem e-mail não há o que fazer.
    const { data: perfis, error: errPerfis } = await admin
      .from("profiles")
      .select("id, name, email")
      .in("id", ids)
      .eq("ativo", true);
    if (errPerfis) throw errPerfis;
    const alvos = (perfis ?? []).filter((x: { email?: string | null }) => !!x.email);
    if (alvos.length === 0) return json({ enviados: 0, motivo: "nenhum destinatário com e-mail" });

    /**
     * REMETENTE do aviso, em ordem de preferência:
     *   1. `CRM_MENCAO_REMETENTE_ID` (secret) — a palavra final de quem administra;
     *   2. um remetente de setor COMERCIAL, se existir;
     *   3. a caixa institucional (`secretaria@`);
     *   4. o primeiro ativo, como último recurso.
     *
     * ⚠️ O "primeiro ativo" NÃO pode ser a régua principal: hoje o mais antigo é o
     * `tcc@ppgeducacao.com`, e aviso interno saindo da caixa que fala com aluno é
     * confuso e mistura reputação de domínio — exatamente o que `docs/E-mail e Caixas.md`
     * manda evitar. Ele fica só como rede de segurança para não silenciar o aviso.
     */
    let remetenteId = Deno.env.get("CRM_MENCAO_REMETENTE_ID") ?? null;
    if (!remetenteId) {
      const { data: rems } = await admin
        .from("email_remetentes")
        .select("id, setor, email_completo, criado_em")
        .eq("ativo", true)
        .order("criado_em", { ascending: true });
      const lista = (rems ?? []) as Array<{ id: string; setor: string | null; email_completo: string | null }>;
      const comercial = lista.find((r) => (r.setor ?? "").toLowerCase().includes("comercial"));
      const institucional = lista.find((r) => (r.email_completo ?? "").toLowerCase().startsWith("secretaria@"));
      remetenteId = (comercial ?? institucional ?? lista[0])?.id ?? null;
    }
    if (!remetenteId) return json({ error: "Nenhum remetente ativo para enviar o aviso." }, 400);

    const autor = (p.autor_nome ?? "").trim() || "Alguém";
    const onde = (p.onde ?? "").trim() || null;
    const trecho = (p.trecho ?? "").trim();
    const link = (p.link ?? "").trim() || null;
    const assunto = `${autor} mencionou você${onde ? ` — ${onde}` : ""}`;
    const html = corpoHtml({ autor, onde, trecho, link });

    let enviados = 0;
    const falhas: string[] = [];
    for (const alvo of alvos as Array<{ id: string; name: string | null; email: string }>) {
      try {
        const resp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/email-send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            remetente_id: remetenteId,
            destinatario_email: alvo.email,
            destinatario_nome: alvo.name ?? undefined,
            assunto,
            corpo_html: html,
            corpo_texto: `${assunto}\n\n${trecho}${link ? `\n\n${link}` : ""}`,
            contexto_tipo: "crm_mencao",
            contexto_id: p.atividade_id ?? undefined,
            // Uma atividade avisa cada pessoa UMA vez, mesmo se o front repetir a chamada.
            ...(p.atividade_id ? { idempotencia_key: `crm_mencao:${p.atividade_id}:${alvo.id}` } : {}),
          }),
        });
        if (resp.ok) enviados++;
        else falhas.push(`${alvo.email}: ${resp.status}`);
      } catch (e) {
        falhas.push(`${alvo.email}: ${e instanceof Error ? e.message : "erro"}`);
      }
    }
    return json({ enviados, falhas });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "erro" }, 500);
  }
});
