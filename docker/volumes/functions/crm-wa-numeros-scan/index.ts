// crm-wa-numeros-scan
// Varredura das BMs para a "Planilha de Números" — a trilha API OFICIAL.
//
// A tela precisa responder duas coisas que hoje ninguém sabe: quais números existem em
// cada Business Manager (inclusive os que NUNCA foram cadastrados no CRM) e como está a
// qualidade de cada um. Isso vira snapshot em crm_wa_bm_numeros em vez de consulta ao
// vivo por causa de `qualidade_anterior`: o aviso que serve não é "está YELLOW", é "CAIU
// de GREEN para YELLOW anteontem", e sem memória não existe queda.
//
// ⚠️ ALCANCE POR BM: varrer a BM inteira (`/{bm}/owned_whatsapp_business_accounts`) exige
// o escopo `business_management` no token. Em 01/09/2026 as BMs "Ppgagro - Educação" e
// "BM 02 - ppgvet" têm; "BM 01" e "BM 03" não. Sem o escopo NÃO falhamos: caímos para as
// WABAs já cadastradas e gravamos escopo_completo=false, para a tela dizer que a BM pode
// ter mais números do que está mostrando. Ganhar o escopo liga a varredura sem tocar aqui.
//
// Falha de uma BM não derruba as outras (mesmo contrato da crm-whatsapp-saude).
//
// ⚠️ Também é chamada pelo NAVEGADOR (botão "Atualizar agora") → nunca devolver 502/504:
// o Cloudflare troca por página sem CORS e o front só vê "Failed to send a request".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const META_GRAPH = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 12_000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Só os dígitos — a Meta devolve "+55 46 9988-3017" e o CRM guarda "46 9 9988-3017". */
function digitos(s: string | null | undefined): string {
  return String(s ?? "").replace(/\D/g, "");
}

async function graph(url: string, token: string): Promise<any> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(body?.error?.message || `Meta API ${r.status}`);
      (err as any).code = body?.error?.code;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

interface Conta {
  id: string;
  nome: string;
  waba_id: string | null;
  phone_number_id: string | null;
  access_token: string;
}

/** Uma BM e o token que consegue lê-la, com as WABAs que já conhecemos por cadastro. */
interface Alvo {
  bm_id: string;
  bm_nome: string | null;
  token: string;
  wabasConhecidas: Set<string>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Cron chama com a service_role; a tela chama com o usuário logado. Os dois valem,
    // qualquer outro não — a varredura gasta cota da Graph API.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "não autorizado" }, 401);
    const ehServico = authHeader.includes(SERVICE_ROLE);
    if (!ehServico) {
      const asUser = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const { data: userData } = await asUser.auth.getUser();
      if (!userData?.user) return json({ error: "não autorizado" }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    const { data: contas, error: contasErr } = await admin
      .from("crm_whatsapp_accounts")
      .select("id, nome, waba_id, phone_number_id, access_token")
      .eq("ativo", true);
    if (contasErr) return json({ error: `Falha ao ler contas: ${contasErr.message}` }, 422);

    const comWaba = ((contas ?? []) as Conta[]).filter((c) => c.waba_id && c.access_token);
    if (comWaba.length === 0) return json({ bms: [], numeros: 0, aviso: "nenhuma conta com waba_id" });

    // ── 1) Descobrir a BM de cada conta ────────────────────────────────────────
    // Uma chamada por conta; contas da mesma BM colapsam num alvo só. O token guardado é
    // o primeiro que respondeu — se ele não tiver `business_management`, um token irmão
    // da mesma BM pode ter, então guardamos os candidatos e testamos na ordem.
    const alvos = new Map<string, Alvo & { candidatos: string[] }>();
    const semBm: { conta: string; erro: string }[] = [];

    await Promise.all(
      comWaba.map(async (c) => {
        try {
          const info = await graph(`${META_GRAPH}/${c.waba_id}?fields=owner_business_info`, c.access_token);
          const bm = info?.owner_business_info ?? null;
          if (!bm?.id) {
            semBm.push({ conta: c.nome, erro: "WABA sem owner_business_info" });
            return;
          }
          const atual = alvos.get(bm.id);
          if (atual) {
            atual.wabasConhecidas.add(c.waba_id!);
            if (!atual.candidatos.includes(c.access_token)) atual.candidatos.push(c.access_token);
          } else {
            alvos.set(bm.id, {
              bm_id: bm.id,
              bm_nome: bm.name ?? null,
              token: c.access_token,
              candidatos: [c.access_token],
              wabasConhecidas: new Set([c.waba_id!]),
            });
          }
        } catch (e) {
          semBm.push({ conta: c.nome, erro: e instanceof Error ? e.message : String(e) });
        }
      }),
    );

    // Índice de cadastro: phone_number_id é a chave exata (o telefone tem o problema do
    // nono dígito, e o mesmo número pode aparecer escrito de três jeitos).
    const contaPorPhoneId = new Map<string, string>();
    for (const c of comWaba) if (c.phone_number_id) contaPorPhoneId.set(String(c.phone_number_id), c.id);

    // O snapshot anterior inteiro, de uma vez. Era um select por número — com ~50 números
    // em 4 BMs isso eram 50 idas ao banco por varredura, de hora em hora, para ler uma
    // tabela que cabe folgada na memória.
    const { data: anteriores } = await admin
      .from("crm_wa_bm_numeros")
      .select("id, waba_id, phone_number_id, qualidade, qualidade_anterior, qualidade_mudou_em, sumiu_em");
    const antes = new Map<string, any>();
    for (const r of anteriores ?? []) antes.set(`${r.waba_id}|${r.phone_number_id}`, r);

    const vistos = new Set<string>(); // `${waba_id}|${phone_number_id}`
    const resumo: any[] = [];
    let totalNumeros = 0;

    // ── 2) Varrer cada BM ──────────────────────────────────────────────────────
    for (const alvo of alvos.values()) {
      let wabas: { id: string; name?: string }[] = [];
      let escopoCompleto = false;
      let erroBm: string | null = null;

      for (const token of alvo.candidatos) {
        try {
          const j = await graph(
            `${META_GRAPH}/${alvo.bm_id}/owned_whatsapp_business_accounts?fields=id,name&limit=200`,
            token,
          );
          wabas = Array.isArray(j?.data) ? j.data : [];
          escopoCompleto = true;
          alvo.token = token;
          break;
        } catch (e) {
          erroBm = e instanceof Error ? e.message : String(e);
        }
      }

      // Sem `business_management`: cai para o que já conhecemos por cadastro.
      if (!escopoCompleto) {
        wabas = [...alvo.wabasConhecidas].map((id) => ({ id }));
      }

      let numerosDaBm = 0;
      for (const w of wabas) {
        try {
          const [fones, waba] = await Promise.all([
            graph(
              `${META_GRAPH}/${w.id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status&limit=100`,
              alvo.token,
            ),
            graph(`${META_GRAPH}/${w.id}?fields=name,account_review_status,business_verification_status`, alvo.token)
              .catch(() => null),
          ]);

          for (const p of (Array.isArray(fones?.data) ? fones.data : [])) {
            const chave = `${w.id}|${p.id}`;
            vistos.add(chave);

            const qualidade = p.quality_rating ?? null;
            const anterior = antes.get(chave) ?? null;

            // Só registra o degrau quando a qualidade REALMENTE muda — senão toda passada
            // de hora em hora reescreveria "mudou agora" e a queda ficaria invisível.
            const mudou = anterior && anterior.qualidade !== qualidade;
            const linha = {
              bm_id: alvo.bm_id,
              bm_nome: alvo.bm_nome,
              waba_id: String(w.id),
              waba_nome: waba?.name ?? w.name ?? null,
              phone_number_id: String(p.id),
              numero: digitos(p.display_phone_number),
              numero_display: p.display_phone_number ?? null,
              verified_name: p.verified_name ?? null,
              qualidade,
              qualidade_anterior: mudou ? anterior.qualidade : (anterior?.qualidade_anterior ?? null),
              qualidade_mudou_em: mudou ? new Date().toISOString() : (anterior?.qualidade_mudou_em ?? null),
              tier: p.messaging_limit_tier ?? null,
              status_numero: p.status ?? null,
              name_status: p.name_status ?? null,
              waba_revisao: waba?.account_review_status ?? null,
              waba_verificacao: waba?.business_verification_status ?? null,
              wa_account_id: contaPorPhoneId.get(String(p.id)) ?? null,
              visto_em: new Date().toISOString(),
              sumiu_em: null,
            };

            const { error: upErr } = await admin
              .from("crm_wa_bm_numeros")
              .upsert(linha, { onConflict: "waba_id,phone_number_id" });
            if (upErr) console.error("[crm-wa-numeros-scan] upsert:", upErr.message);
            numerosDaBm++;
            totalNumeros++;
          }
        } catch (e) {
          console.error(`[crm-wa-numeros-scan] WABA ${w.id}:`, e instanceof Error ? e.message : e);
        }
      }

      await admin.from("crm_wa_bm_varreduras").upsert({
        bm_id: alvo.bm_id,
        bm_nome: alvo.bm_nome,
        escopo_completo: escopoCompleto,
        wabas_vistas: wabas.length,
        numeros_vistos: numerosDaBm,
        // Sem escopo não é erro, é alcance — o erro da Graph vira explicação, não alarme.
        erro: escopoCompleto ? null : erroBm,
        executada_em: new Date().toISOString(),
      });

      resumo.push({
        bm_id: alvo.bm_id,
        bm_nome: alvo.bm_nome,
        escopo_completo: escopoCompleto,
        wabas: wabas.length,
        numeros: numerosDaBm,
      });
    }

    // ── 3) Quem a varredura não viu mais ───────────────────────────────────────
    // Marcado, nunca apagado: a Meta some com número desativado sem avisar, e o histórico
    // de que ele existiu é o que explica um buraco no funil três meses depois.
    const sumidos = [...antes.entries()]
      .filter(([chave, r]) => !r.sumiu_em && !vistos.has(chave))
      .map(([, r]) => r.id);
    if (sumidos.length > 0) {
      await admin.from("crm_wa_bm_numeros").update({ sumiu_em: new Date().toISOString() }).in("id", sumidos);
    }

    return json({
      bms: resumo,
      numeros: totalNumeros,
      sumiram: sumidos.length,
      contas_sem_bm: semBm,
      executada_em: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[crm-wa-numeros-scan] fatal:", e instanceof Error ? e.message : e);
    return json({ error: "erro interno na varredura das BMs" }, 500);
  }
});
