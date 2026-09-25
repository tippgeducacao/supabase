// ig-agente-simular — HARNESS DE TESTE da IA do direct do Instagram (25/09/2026).
// ----------------------------------------------------------------------------
// Roda um roteiro de conversa pelo classificador REAL (Luna 5.6, Claude de reserva — as
// mesmas chaves e o mesmo modelo da produção, porque roda no mesmo edge-runtime) e pelo
// roteiro REAL (fluxo.ts), com o MESMO "pensar" da produção (ig-agente/rodada.ts).
//
// ⚠️ NADA vai para o Instagram e NADA é gravado: sem ig_mensagens, sem ig_conversa_ia,
// sem trava. O histórico da conversa vive em memória, montado como a produção monta.
// O que ele NÃO prova: envio, debounce, trava, pausa por humano e /reset — isso é o
// index.test.ts (com banco simulado) e o teste ao vivo no @sutil_gu.
//
// Uso (POST, header x-followup-key = crm_agente_sdr_config.followup_secret, a mesma chave
// do harness do João):
//   { "id": "formado-feliz", "nome_perfil": "Carla Souza",
//     "turnos": ["tudo sim, e vc?", "sou vet", "quero", "46 99988-1234"],
//     "esperado": { "etapa_final": "whatsapp_enviado", "etapa_crm": "Formados" } }
// Um turno pode ser uma lista: ["oi", "sou vet"] = duas DMs seguidas, UMA resposta.
// Runner: scripts/teste-agente/simular-instagram.mjs · Mapa: docs/Instagram (IA + Chat).md
// ----------------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { executarCenario, validarCenario } from "./simulacao.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });

async function autorizado(req: Request): Promise<boolean> {
  const chave = req.headers.get("x-followup-key") ?? "";
  if (!chave) return false;
  const { data } = await supabase.from("crm_agente_sdr_config").select("followup_secret").eq("id", 1).maybeSingle();
  const segredo = String(data?.followup_secret ?? "");
  return Boolean(segredo) && chave === segredo;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "método não suportado" }, 405);
  if (!(await autorizado(req))) return json({ error: "não autorizado" }, 401);

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const v = validarCenario(body);
  if ("erro" in v) return json({ error: v.erro }, 400);

  try {
    return json(await executarCenario(v.cenario));
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.error("[ig-agente-simular] falhou:", msg);
    return json({ error: msg }, 500);
  }
});
