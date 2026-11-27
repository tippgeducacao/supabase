// Edge Function: emb-avisos — Programa de Embaixadores (26/11/2026).
// O cron (a cada 5 min, só quando há pendência) chama esta edge; ela manda o e-mail de reunião marcada,
// remarcada ou cancelada ao embaixador dono do indicado e marca o que saiu em emb_avisos_reuniao.
// Porta: segredo próprio no cabeçalho (app_secrets EMB_AVISOS_SECRET) ou a chave de serviço.
// Ver docs/Embaixadores.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { remetenteDoPrograma } from "../_shared/embaixadores.ts";
import { emailDeReuniao, type AvisoPendente } from "./aviso.ts";

const APP = (Deno.env.get("APP_URL") || "https://sistemappgvet.ppgeducacao.site").replace(/\/$/, "");
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: segredo } = await admin.from("app_secrets").select("valor").eq("chave", "EMB_AVISOS_SECRET").maybeSingle();
  try {
    await exigirAcesso(req, { servico: true, segredo: { cabecalho: "x-emb-avisos-secret", valor: (segredo as { valor?: string } | null)?.valor } });
  } catch (e) {
    return respostaAcessoNegado(e);
  }

  const { data, error } = await admin.rpc("emb_avisos_pendentes");
  if (error) {
    console.error("[emb-avisos] pendentes", error);
    return json({ error: "Não foi possível ler os avisos." }, 500);
  }
  const pendentes = (data ?? []) as AvisoPendente[];
  if (!pendentes.length) return json({ ok: true, enviados: 0 });
  const remetente = await remetenteDoPrograma(admin);
  if (!remetente) return json({ error: "Nenhum remetente de e-mail ativo." }, 503);

  let enviados = 0;
  for (const a of pendentes) {
    const chave = { agendamento_id: a.agendamento_id, data_agendamento: a.data_agendamento, tipo: a.tipo };
    const { data: ja } = await admin.from("emb_avisos_reuniao").select("tentativas").match(chave).maybeSingle();
    const tentativas = ((ja as { tentativas?: number } | null)?.tentativas ?? 0) + 1;
    // Conta a tentativa ANTES de enviar: se a função morrer no meio, não repete para sempre.
    const { error: erroMarca } = await admin.from("emb_avisos_reuniao")
      .upsert({ ...chave, embaixador_id: a.embaixador_id, tentativas }, { onConflict: "agendamento_id,data_agendamento,tipo" });
    if (erroMarca) { console.error("[emb-avisos] marcar", erroMarca); continue; }
    const { assunto, html, texto } = emailDeReuniao(a, `${APP}/embaixador/painel/agenda`);
    const resposta = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/email-send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remetente_id: remetente,
        destinatario_email: a.email,
        destinatario_nome: a.embaixador,
        assunto,
        corpo_html: html,
        corpo_texto: texto,
        contexto_tipo: "emb_reuniao",
        idempotencia_key: `emb_reuniao:${a.agendamento_id}:${a.data_agendamento}:${a.tipo}`,
      }),
      signal: AbortSignal.timeout(30000),
    }).catch((e) => { console.error("[emb-avisos] email-send falhou", e); return null; });
    if (!resposta?.ok) {
      if (resposta) console.error("[emb-avisos] email-send", resposta.status, await resposta.text());
      continue;
    }
    await admin.from("emb_avisos_reuniao").update({ enviado_em: new Date().toISOString() }).match(chave);
    enviados += 1;
  }
  return json({ ok: true, pendentes: pendentes.length, enviados });
});
