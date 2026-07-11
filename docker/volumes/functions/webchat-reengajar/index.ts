// webchat-reengajar — cutuca o lead que abandonou o chat da LP no meio (fechou o navegador
// e não deu sequência). Fonte = RPC webchat_sessoes_abandonadas (o lead conversou, o João
// falou por último, ocioso, SEM agendamento, ainda não cutucado). Manda:
//   1) Web Push (VAPID) p/ quem optou por avisos no navegador (desktop/Android);
//   2) FALLBACK WhatsApp (linha Web Uazapi, sem janela 24h) p/ iPhone / quem não optou.
// Marca webchat_sessoes.reengajado_em → só cutuca UMA vez.
//
// Chamado pelo cron `webchat-reengajar` (Authorization: Bearer <service_role>). Deploy por
// git push (deploy-edges.yml), NUNCA pelo Deploy do Dokploy.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const VAPID_PUBLIC = Deno.env.get("WEBCHAT_VAPID_PUBLIC") ?? "";
const VAPID_PRIVATE = Deno.env.get("WEBCHAT_VAPID_PRIVATE") ?? "";
const VAPID_SUBJECT = Deno.env.get("WEBCHAT_VAPID_SUBJECT") ?? "mailto:contato@ppgeducacao.com.br";
const WA_CONEXAO = Deno.env.get("WEBCHAT_WA_CONEXAO_ID") ?? "";
const SEND_URL = (Deno.env.get("AGENTE_SDR_SEND_URL") ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, "");

const OCIOSO_MIN = Number(Deno.env.get("WEBCHAT_REENGAJAR_OCIOSO_MIN") ?? 20);
const JANELA_HORAS = Number(Deno.env.get("WEBCHAT_REENGAJAR_JANELA_HORAS") ?? 24);
const MAX = Number(Deno.env.get("WEBCHAT_REENGAJAR_MAX") ?? 100);

// web-push é carregado SOB DEMANDA (lazy) e de forma DEFENSIVA: se a lib não carregar no
// runtime, o reengajamento degrada pro fallback WhatsApp em vez de derrubar a função.
let webpush: any = null;
let webpushTentado = false;
async function getWebpush(): Promise<any> {
  if (webpushTentado) return webpush;
  webpushTentado = true;
  if (!(VAPID_PUBLIC && VAPID_PRIVATE)) return null;
  try {
    const mod: any = await import("npm:web-push@3.6.7");
    webpush = mod.default ?? mod;
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (e) {
    console.error(`[webchat-reengajar] web-push indisponível (usando fallback WhatsApp): ${(e as Error).message}`);
    webpush = null;
  }
  return webpush;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function primeiroNome(n: string | null): string { return (n ?? "").trim().split(/\s+/)[0] || ""; }
function limparCurso(c: string | null): string {
  if (!c) return "";
  return c.replace(/^p[oó]s\s*\|\s*/i, "").replace(/^mba\s*\|\s*/i, "MBA ").replace(/^curso\s*\|\s*/i, "").trim();
}

async function enviarPush(wp: any, sub: { endpoint: string; p256dh: string; auth: string }, payload: unknown): Promise<"ok" | "gone" | "erro"> {
  try {
    await wp.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return "ok";
  } catch (e: any) {
    const code = e?.statusCode ?? 0;
    if (code === 404 || code === 410) return "gone"; // subscription morta → apaga
    console.error(`[webchat-reengajar] push ${code}: ${e?.message ?? e}`);
    return "erro";
  }
}

async function enviarWhatsapp(telefone: string, texto: string): Promise<boolean> {
  if (!WA_CONEXAO) return false;
  try {
    const res = await fetch(SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wa_conexao_id: WA_CONEXAO, telefone, tipo: "text", conteudo: texto }),
    });
    if (!res.ok) { console.error(`[webchat-reengajar] whatsapp HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); return false; }
    return true;
  } catch (e) {
    console.error(`[webchat-reengajar] whatsapp: ${(e as Error).message}`);
    return false;
  }
}

Deno.serve(async (req) => {
  // gate: só o cron (Bearer service role)
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${SERVICE_ROLE}`) {
    return json({ ok: false, erro: "nao_autorizado" }, 401);
  }

  const { data: sessoes, error } = await supabase.rpc("webchat_sessoes_abandonadas", {
    p_ocioso_min: OCIOSO_MIN, p_janela_horas: JANELA_HORAS, p_max: MAX,
  });
  if (error) {
    console.error(`[webchat-reengajar] rpc: ${error.message}`);
    return json({ ok: false, erro: error.message }, 500);
  }

  let porPush = 0, porWhatsapp = 0, semSucesso = 0;
  for (const s of (sessoes ?? []) as any[]) {
    const primeiro = primeiroNome(s.nome);
    const saud = primeiro ? `, ${primeiro}` : "";
    let sucesso = false;

    // 1) Web Push (se o lead optou e o VAPID/lib estão OK)
    const wp = s.tem_push ? await getWebpush() : null;
    if (wp) {
      const { data: subs } = await supabase
        .from("webchat_push_subscriptions")
        .select("endpoint, p256dh, auth")
        .eq("sessao_id", s.sessao_id);
      const payload = {
        title: "PPG Educação",
        body: `Oi${saud}! Vamos continuar? Ainda dá tempo de garantir seu horário. 👨‍🏫`,
        url: s.origem_url || "/",
        icon: "/favicon.ico",
      };
      for (const sub of (subs ?? []) as any[]) {
        const r = await enviarPush(wp, sub, payload);
        if (r === "ok") sucesso = true;
        else if (r === "gone") await supabase.from("webchat_push_subscriptions").delete().eq("endpoint", sub.endpoint);
      }
      if (sucesso) porPush++;
    }

    // 2) fallback WhatsApp (iPhone / quem não optou / push falhou)
    if (!sucesso) {
      const curso = limparCurso(s.curso) || "nossa pós";
      const texto = `Oi${saud}! 👋 A gente começou a conversar sobre a ${curso} e você precisou sair. Quando puder, é só me responder por aqui que a gente continua. 🙂`;
      if (await enviarWhatsapp(s.telefone, texto)) { porWhatsapp++; sucesso = true; }
    }

    if (sucesso) {
      await supabase.from("webchat_sessoes").update({ reengajado_em: new Date().toISOString() }).eq("id", s.sessao_id);
    } else {
      semSucesso++;
    }
  }

  return json({ ok: true, total: (sessoes ?? []).length, push: porPush, whatsapp: porWhatsapp, sem_sucesso: semSucesso });
});
