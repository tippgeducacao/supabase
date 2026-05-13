import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const META_API = "https://graph.facebook.com/v21.0";

interface ReqBody {
  ig_user_id?: string;
  // legado
  ig_account_id?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Auth
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ ok: false, error: "Não autenticado" });
    }
    const uid = userData.user.id;

    const adminClient = createClient(supabaseUrl, serviceKey);
    const [adminRes, diretorRes] = await Promise.all([
      adminClient.rpc("has_role", { _user_id: uid, _role: "admin" }),
      adminClient.rpc("has_role", { _user_id: uid, _role: "diretor" }),
    ]);
    const isAdmin = adminRes.data === true || diretorRes.data === true;
    if (!isAdmin) {
      return json({ ok: false, error: "Acesso restrito (admin/diretor)" });
    }

    const body = (await req.json().catch(() => ({}))) as ReqBody;
    const ig_user_id = (body.ig_user_id ?? body.ig_account_id ?? "").trim();
    if (!/^\d{5,25}$/.test(ig_user_id)) {
      return json({ ok: false, error: "ig_user_id inválido (esperado: numérico 5-25 dígitos)" });
    }

    // Token sempre vem de ig_accounts
    const { data: acct, error: acctErr } = await adminClient
      .from("ig_accounts")
      .select("id, access_token, username")
      .eq("ig_user_id", ig_user_id)
      .eq("is_active", true)
      .maybeSingle();

    if (acctErr) {
      return json({ ok: false, error: `Erro ao buscar token: ${acctErr.message}` });
    }
    if (!acct?.access_token) {
      return json({
        ok: false,
        error: "Conta não tem token configurado em ig_accounts. Reautenticar via OAuth.",
        code: "NO_TOKEN",
      });
    }

    // Graph API
    const url = new URL(`${META_API}/${ig_user_id}`);
    url.searchParams.set(
      "fields",
      "username,profile_picture_url,name,followers_count",
    );
    url.searchParams.set("access_token", acct.access_token);

    const res = await fetch(url.toString());
    const data = await res.json();

    if (!res.ok || data?.error) {
      const errCode = data?.error?.code;
      const errMsg = data?.error?.message || `Graph API: HTTP ${res.status}`;
      // Token expirado / inválido → marca is_active = false
      if (errCode === 190) {
        await adminClient
          .from("ig_accounts")
          .update({ is_active: false })
          .eq("ig_user_id", ig_user_id);
        return json({
          ok: false,
          error: "Token expirado ou inválido. Reautenticar via OAuth.",
          code: "TOKEN_INVALID",
        });
      }
      return json({ ok: false, error: errMsg });
    }

    // Atualiza cache de metadata
    await adminClient
      .from("ig_accounts")
      .update({
        username: data.username ?? null,
        profile_picture_url: data.profile_picture_url ?? null,
        followers_count: typeof data.followers_count === "number" ? data.followers_count : null,
        updated_at: new Date().toISOString(),
      })
      .eq("ig_user_id", ig_user_id);

    return json({
      ok: true,
      username: data.username,
      profile_picture_url: data.profile_picture_url,
      followers_count: data.followers_count ?? null,
      name: data.name ?? null,
    });
  } catch (err) {
    const e = err as Error;
    return json({ ok: false, error: e.message || "Erro inesperado" });
  }
});
