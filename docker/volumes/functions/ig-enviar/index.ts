// ig-enviar — o atendente responde o DIRECT DO INSTAGRAM pelo SAC v2 (25/09/2026).
// ----------------------------------------------------------------------------
// Quem chama: o composer do Instagram no SAC (supabase.functions.invoke, JWT do usuário).
//   POST { conversa_id, texto } → 200 { ok: true, enviadas } | { ok: false, codigo, erro }
//
// Acesso: a conversa é lida com o JWT DA PESSOA (RLS do SAC) — quem não enxerga a
// conversa no SAC não manda por ela. O resto (token da conta, gravação) é service_role.
//
// Caminho de volta: o balão entra em ig_mensagens (origem 'humano' + autor) e o gatilho
// trg_ig_mensagens_espelhar_sac o põe na thread do SAC. O eco do webhook depois não
// duplica (mesmo mid) e faz o ig-agente pausar a IA nessa conversa.
// Regras de janela/texto: envio.ts. Mapa: docs/Instagram (IA + Chat).md
// ----------------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { enviarTextoIg } from "../_shared/igMensageria.ts";
import { type DepsEnvioIg, enviarDoSac, type RespostaEnvioIg } from "./envio.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// Erro de regra volta 200 com `ok:false` — o front lê o `codigo` (o invoke do supabase-js
// esconde o corpo de respostas 4xx/5xx).
const json = (data: RespostaEnvioIg | Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function depsReais(authorization: string): DepsEnvioIg {
  const comoUsuario = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async destino(conversaId) {
      const { data: conv } = await comoUsuario.from("sac_conversas")
        .select("id, canal, contato_id, ig_conta_id").eq("id", conversaId).maybeSingle();
      if (!conv || conv.canal !== "instagram" || !conv.ig_conta_id) return null;
      const { data: ct } = await admin.from("sac_contatos")
        .select("ig_igsid, ig_conta_id").eq("id", conv.contato_id).maybeSingle();
      if (!ct?.ig_igsid) return null;
      const { data: conta } = await admin.from("ig_contas")
        .select("ig_user_id").eq("id", conv.ig_conta_id).maybeSingle();
      if (!conta) return null;
      return { contaId: conv.ig_conta_id, igUserId: conta.ig_user_id ?? null, igsid: ct.ig_igsid };
    },
    async ultimoInbound(d) {
      const { data } = await admin.from("ig_mensagens").select("created_at")
        .eq("conta_id", d.contaId).eq("contato_igsid", d.igsid)
        .eq("direcao", "inbound").neq("tipo", "reaction")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data?.created_at ?? null;
    },
    async token(contaId) {
      const { data } = await admin.from("ig_contas_secrets").select("access_token").eq("conta_id", contaId).maybeSingle();
      return data?.access_token ? String(data.access_token) : null;
    },
    enviar: (token, igsid, texto) => enviarTextoIg(token, igsid, texto),
    async gravar(linha, enviou) {
      // upsert SEM ignoreDuplicates: se o eco chegou antes (gravado como humano sem autor),
      // esta escrita põe o autor — o espelho do SAC atualiza o balão.
      const { error } = enviou
        ? await admin.from("ig_mensagens").upsert(linha, { onConflict: "mid" })
        : await admin.from("ig_mensagens").insert(linha);
      if (error) console.error("[ig-enviar] não gravou o balão:", error.message);
    },
    agora: () => Date.now(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, codigo: "nao_autorizado", erro: "método não suportado" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const jwt = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!jwt || jwt === SERVICE_ROLE || jwt === ANON_KEY) {
    return json({ ok: false, codigo: "nao_autorizado", erro: "Entre no sistema de novo." });
  }
  const { data: u } = await admin.auth.getUser(jwt);
  const userId = u?.user?.id;
  if (!userId) return json({ ok: false, codigo: "nao_autorizado", erro: "Sessão expirada — entre de novo." });

  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const conversaId = String(body?.conversa_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(conversaId)) {
    return json({ ok: false, codigo: "conversa_invalida", erro: "Conversa inválida." });
  }

  const { data: perfil } = await admin.from("profiles").select("name").eq("id", userId).maybeSingle();
  const resposta = await enviarDoSac(depsReais(authorization), {
    conversaId,
    texto: String(body?.texto ?? ""),
    autor: { id: userId, nome: (perfil?.name ?? "").trim() || null },
  });
  if (!resposta.ok) console.warn("[ig-enviar]", resposta.codigo, resposta.erro);
  return json(resposta);
});
