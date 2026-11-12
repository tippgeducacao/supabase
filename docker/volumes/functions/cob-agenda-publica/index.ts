// acesso: publico — página /renegociar/<token> do aluno, sem login; o token de 128 bits do convite é a credencial e toda regra mora no banco (RPCs só de service_role)
//
// cob-agenda-publica — a ponte entre a página da AGENDA DE RENEGOCIAÇÃO (`/renegociar/<token>`)
// e o banco. O aluno da 9.9 COBRANÇA - FASE 03 recebe o modelo `cob_reuniao_convite` pelo
// número 7693 (o do Rafael); o botão abre a página com o token dele. Ele não digita nada:
// escolhe o horário e pronto.
//
//   POST { acao: "carregar", token }               → { ok, primeiro_nome, reuniao, horarios }
//   POST { acao: "marcar", token, horario_id }     → { ok, reuniao }
//   erro: { ok:false, motivo: link_invalido | horario_indisponivel | muitas_tentativas | pedido_invalido | falhou }
//
// Por que uma edge e não RPC do navegador: `anon` não tem NADA nas tabelas `cob_reuniao*`.
// As RPCs `cob_reuniao_publico_*` só executam como service_role, e a service_role nunca sai
// daqui. Trava do horário, uma reunião por pessoa e os lembretes (confirmação agora, 1 h antes
// e no horário, todos modelos do 7693 com o botão do token) estão no banco
// (migration 20261112120000_cob_agenda_renegociacao). Aqui só se valida o formato
// (`_shared/cobAgendaPublica.ts`, testado) e se cria o evento no Google.
//
// O Google é SECUNDÁRIO (mesmo princípio do professor-agenda-publica e do RH): a reunião já
// está gravada quando ele é chamado. Falhou ⇒ o aluno vê a confirmação sem a sala e a
// cobrança cola o link pelo painel do SAC (`cob_reuniao_atualizar`).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";
import {
  MAX_BYTES_DO_PEDIDO,
  criarFreio,
  interpretarPedido,
  linkDeSala,
  montarEvento,
  motivoConhecido,
  respostaCarregar,
  reuniaoPublica,
  type EventoDoBanco,
} from "../_shared/cobAgendaPublica.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// 8 marcações por IP a cada 10 min (o link vai por WhatsApp; ninguém marca 8 vezes).
const podeMarcar = criarFreio(8, 10 * 60_000);

// IP do cliente sem confiar no que ele manda (mesma régua do professor-agenda-publica): o
// PRIMEIRO valor do x-forwarded-for é forjável; varre da direita e pega o primeiro público.
const IP_PRIVADO_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;
function ipDe(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const partes = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = partes.length - 1; i >= 0; i--) {
    if (!IP_PRIVADO_RE.test(partes[i])) return partes[i];
  }
  return partes[partes.length - 1] || "desconhecido";
}

/** Evento com Meet na agenda "Cobrança - Renegociação" e o link anotado na reunião. */
async function criarEvento(
  // deno-lint-ignore no-explicit-any
  admin: any,
  evento: EventoDoBanco & { reuniao_id?: unknown },
  reuniao: { inicio: string; fim: string },
): Promise<string | null> {
  const corpo = montarEvento(evento, reuniao);
  if (!corpo || typeof evento.reuniao_id !== "string") return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/google-calendar-create-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify(corpo),
    });
    const j = await res.json().catch(() => null);
    if (!j?.success) {
      console.error("[cob-agenda-publica] Google recusou o evento:", j?.error);
      return null;
    }
    const link = linkDeSala(j?.event?.meetLink);
    const { error } = await admin.rpc("cob_reuniao_publico_anotar_evento", {
      p_reuniao_id: evento.reuniao_id,
      p_meet_link: link,
      p_google_event_id: typeof j?.event?.id === "string" ? j.event.id : null,
      p_cache_id: typeof j?.event?.cache_id === "string" ? j.event.cache_id : null,
    });
    if (error) console.error("[cob-agenda-publica] sala não anotada na reunião:", error.message);
    return link;
  } catch (e) {
    console.error("[cob-agenda-publica] evento no Google falhou:", e instanceof Error ? e.message : e);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, motivo: "pedido_invalido" }, 405);

  let corpo: unknown;
  try {
    const texto = await req.text();
    if (texto.length > MAX_BYTES_DO_PEDIDO) return json({ ok: false, motivo: "pedido_invalido" }, 413);
    corpo = JSON.parse(texto);
  } catch {
    return json({ ok: false, motivo: "pedido_invalido" }, 400);
  }

  const pedido = interpretarPedido(corpo);
  if ("erro" in pedido) return json({ ok: false, motivo: pedido.erro });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (pedido.acao === "carregar") {
      const { data, error } = await admin.rpc("cob_reuniao_publico_carregar", { p_token: pedido.token });
      if (error) throw error;
      return json(respostaCarregar(data));
    }

    if (!podeMarcar(ipDe(req))) return json({ ok: false, motivo: "muitas_tentativas" });

    const { data: r, error } = await admin.rpc("cob_reuniao_publico_marcar", {
      p_token: pedido.token,
      p_horario_id: pedido.horarioId,
    });
    if (error) throw error;
    if (!r?.ok) return json({ ok: false, motivo: motivoConhecido(r?.motivo) });

    let reuniao = reuniaoPublica(r.reuniao);
    if (!r.ja_marcada && r.evento && reuniao) {
      const link = await criarEvento(admin, r.evento, reuniao);
      if (link) reuniao = { ...reuniao, link };
    }
    console.log(`[cob-agenda-publica] reunião ${r.ja_marcada ? "já marcada" : "marcada"} para ${reuniao?.inicio ?? "?"}`);
    return json({ ok: true, reuniao });
  } catch (e) {
    console.error("[cob-agenda-publica]", e instanceof Error ? e.message : e);
    // Sem detalhe para quem está de fora; o motivo fica no log da edge.
    return json({ ok: false, motivo: "falhou" }, 503);
  }
});
