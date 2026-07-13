// Web Push do WEBCHAT (VAPID) — compartilhado por crm-webchat (push imediato de "nova
// mensagem" quando a aba do lead está oculta) e webchat-reengajar (cutucão de abandono).
// web-push carregado LAZY e DEFENSIVO: se a lib não carregar no runtime, quem chama decide
// o fallback (reengajar → WhatsApp; nova mensagem → simplesmente não notifica).
// deno-lint-ignore-file no-explicit-any

const VAPID_PUBLIC = Deno.env.get("WEBCHAT_VAPID_PUBLIC") ?? "";
const VAPID_PRIVATE = Deno.env.get("WEBCHAT_VAPID_PRIVATE") ?? "";
const VAPID_SUBJECT = Deno.env.get("WEBCHAT_VAPID_SUBJECT") ?? "mailto:contato@ppgeducacao.com.br";

let webpush: any = null;
let tentado = false;
let ultimoErro: string | null = null;

export function webpushErro(): string | null { return ultimoErro; }

export async function getWebpush(): Promise<any> {
  if (tentado) return webpush;
  tentado = true;
  if (!(VAPID_PUBLIC && VAPID_PRIVATE)) { ultimoErro = "vapid_env_ausente"; return null; }
  try {
    const mod: any = await import("npm:web-push@3.6.7");
    webpush = mod.default ?? mod;
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (e) {
    ultimoErro = (e as Error).message?.slice(0, 300) ?? "erro desconhecido";
    console.error(`[webchatPush] web-push indisponível: ${ultimoErro}`);
    webpush = null;
  }
  return webpush;
}

export type PushResultado = "ok" | "gone" | "erro";

export async function enviarPush(
  wp: any,
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: unknown,
): Promise<{ r: PushResultado; detalhe: string }> {
  const alvo = `…${sub.endpoint.slice(-12)}`;
  try {
    await wp.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { r: "ok", detalhe: `${alvo}: ok` };
  } catch (e: any) {
    const code = e?.statusCode ?? 0;
    const detalhe = `${alvo}: ${code || (e?.message ?? "erro").slice(0, 80)}`;
    if (code === 404 || code === 410) return { r: "gone", detalhe }; // subscription morta → apagar
    console.error(`[webchatPush] push ${code}: ${e?.message ?? e}`);
    return { r: "erro", detalhe };
  }
}

// Manda o push pra TODAS as subscriptions da sessão; apaga as mortas (410/404).
// Retorna quantas entregas OK.
export async function pushParaSessao(
  supabase: any,
  sessaoId: string,
  payload: { title: string; body: string; url?: string; icon?: string; tag?: string },
): Promise<number> {
  const wp = await getWebpush();
  if (!wp) return 0;
  const { data: subs } = await supabase
    .from("webchat_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("sessao_id", sessaoId);
  let ok = 0;
  for (const sub of (subs ?? []) as any[]) {
    const { r } = await enviarPush(wp, sub, payload);
    if (r === "ok") ok++;
    else if (r === "gone") {
      await supabase.from("webchat_push_subscriptions").delete().eq("endpoint", sub.endpoint);
    }
  }
  return ok;
}
