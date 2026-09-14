// Edge Function: email-campaign-dispatcher
// Roda a cada 1min via cron. Para cada campanha 'agendada' (com agendada_para <= now())
// ou 'enviando' (continuar), popula envios pendentes, envia em lote com throttle,
// atualiza contadores. Respeita 'pausada' / 'cancelada'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buscarSupressoes, normalizarEmail } from "../_shared/supressao.ts";
import { enfileirarContatosSegmentoEmail, resolverSegmentoEmail } from "../_shared/emailSegmentos.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function processarCampanha(supabase: any, campanha: any) {
  // Carrega segmento se ainda não populou envios
  const { count: jaTem, error: erroFila } = await supabase
    .from("email_campanhas_envios")
    .select("*", { count: "exact", head: true })
    .eq("campanha_id", campanha.id);

  if (erroFila) throw new Error("Não foi possível consultar a fila da campanha.");

  if (campanha.status === "agendada" || !campanha.iniciada_em || (jaTem ?? 0) === 0) {
    const { data: seg, error: erroSegmento } = await supabase.from("email_segmentos").select("*").eq("id", campanha.segmento_id).single();
    if (erroSegmento || !seg) throw new Error("Não foi possível carregar o segmento da campanha.");
    const contatos = await resolverSegmentoEmail(supabase, seg);
    // Só sai de agendada depois que TODOS os lotes existem. Uma falha intermediária
    // deixa a campanha agendada; o próximo ciclo completa a fila por upsert, sem
    // trocar os IDs e as chaves de idempotência dos destinatários já preparados.
    await enfileirarContatosSegmentoEmail(supabase, campanha.id, contatos);
    const { count: totalFila, error: erroTotal } = await supabase.from("email_campanhas_envios")
      .select("*", { count: "exact", head: true }).eq("campanha_id", campanha.id);
    if (erroTotal || totalFila == null) throw new Error("Não foi possível conferir a fila da campanha.");
    if (totalFila === 0) {
      const { error } = await supabase.from("email_campanhas").update({
        status: "enviada", concluida_em: new Date().toISOString(), total_destinatarios: 0,
      }).eq("id", campanha.id).eq("status", campanha.status);
      if (error) throw new Error("Não foi possível concluir a campanha sem destinatários.");
      return;
    }
    const { error } = await supabase.from("email_campanhas").update({
      total_destinatarios: totalFila,
      status: "enviando",
      iniciada_em: campanha.iniciada_em ?? new Date().toISOString(),
    }).eq("id", campanha.id).eq("status", campanha.status);
    if (error) throw new Error("Não foi possível iniciar a fila da campanha.");
    campanha.total_destinatarios = totalFila;
  }

  // Lote de até 50 envios pendentes
  const { data: loteBruto, error: erroLote } = await supabase
    .from("email_campanhas_envios")
    .select("*")
    .eq("campanha_id", campanha.id)
    .eq("status", "pendente")
    .limit(50);
  if (erroLote) throw new Error("Não foi possível consultar os envios pendentes da campanha.");

  // Supressão em LOTE: quem deu bounce duro, marcou spam ou se descadastrou sai do
  // lote antes de virar chamada de envio. O email-send confere de novo (defesa em
  // profundidade), mas filtrar aqui evita até 50 chamadas inúteis por rodada de cron.
  let pendentes = loteBruto ?? [];
  if (pendentes.length) {
    const normalizar = normalizarEmail;
    const bloqueados = await buscarSupressoes(
      supabase,
      pendentes.map((p: any) => p.contato_email),
    );

    if (bloqueados.size) {
      const pular = pendentes.filter((p: any) => bloqueados.has(normalizar(p.contato_email)));
      if (pular.length) {
        await supabase.from("email_campanhas_envios").update({
          status: "pulado",
          erro: "suprimido (bounce/spam/descadastro)",
        }).in("id", pular.map((p: any) => p.id));
        pendentes = pendentes.filter((p: any) => !bloqueados.has(normalizar(p.contato_email)));
      }
    }
  }

  if (pendentes.length === 0) {
    // Finaliza
    const { count: rest, error: erroPendentes } = await supabase
      .from("email_campanhas_envios")
      .select("*", { count: "exact", head: true })
      .eq("campanha_id", campanha.id)
      .eq("status", "pendente");
    if (erroPendentes || rest == null) throw new Error("Não foi possível conferir os envios pendentes da campanha.");
    if (rest === 0) {
      await supabase.from("email_campanhas").update({
        status: "enviada", concluida_em: new Date().toISOString(),
      }).eq("id", campanha.id);
    }
    return;
  }

  // Throttle por provedor. O limite documentado do Resend é 10 req/s POR TIME (soma de
  // todas as API keys), então o piso de 120 ms (~8,3/s) deixa folga para outra função
  // disparar em paralelo sem estourar a cota compartilhada. Na prática o gargalo é o
  // lote de 50 por rodada do cron, não a API.
  const { data: remetente } = await supabase
    .from("email_remetentes").select("provider").eq("id", campanha.remetente_id).maybeSingle();
  const viaResend = remetente?.provider === "resend";
  const throttleMs = viaResend
    ? Math.max(campanha.throttle_ms ?? 150, 120)
    : (campanha.throttle_ms ?? 150);

  let enviadosBatch = 0; let falhadosBatch = 0;
  for (const envio of pendentes) {
    // Re-check status (pode ter sido pausada/cancelada)
    const { data: cur } = await supabase.from("email_campanhas").select("status").eq("id", campanha.id).single();
    if (!cur || cur.status === "pausada" || cur.status === "cancelada") break;

    try {
      const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/email-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          template_id: campanha.template_id,
          remetente_id: campanha.remetente_id,
          destinatario_email: envio.contato_email,
          destinatario_nome: envio.contato_nome,
          variaveis: { nome: envio.contato_nome ?? "", email: envio.contato_email, ...(envio.contato_metadata ?? {}) },
          contexto_tipo: "campanha",
          contexto_id: campanha.id,
          // Chave ESTÁVEL por linha da fila: se o worker morrer depois de entregar mas
          // antes de marcar 'enviado', a linha volta como 'pendente' na próxima rodada
          // e esta chave impede a segunda entrega (no banco e no Resend).
          idempotencia_key: `campanha:${envio.id}`,
        }),
      });
      const j = await sendRes.json();
      // O email-send devolve 200 + suprimido:true quando o endereço entrou na lista de
      // supressão entre a montagem do lote e o envio. Não é entrega — não pode contar.
      if (sendRes.ok && j.suprimido) {
        await supabase.from("email_campanhas_envios").update({
          status: "pulado", erro: `suprimido (${j.motivo ?? "bounce/spam/descadastro"})`,
        }).eq("id", envio.id);
      } else if (sendRes.ok && j.ok !== false) {
        await supabase.from("email_campanhas_envios").update({
          // Na resposta de duplicado o email-send devolve `id` (e não `log_id`); sem o
          // fallback a linha ficaria sem vínculo e o webhook não acharia a campanha.
          status: "enviado", enviado_em: new Date().toISOString(), email_enviado_id: j.log_id ?? j.id ?? null,
        }).eq("id", envio.id);
        enviadosBatch++;
      } else {
        await supabase.from("email_campanhas_envios").update({
          status: "falhou", erro: JSON.stringify(j).slice(0, 500),
        }).eq("id", envio.id);
        falhadosBatch++;
        // Se 429, pausa
        if (sendRes.status === 429) {
          await supabase.from("email_campanhas").update({
            status: "pausada",
            ultimo_erro: `Rate limit ${viaResend ? "Resend" : "Gmail"} (429) — retome a campanha depois de alguns minutos`,
          }).eq("id", campanha.id);
          break;
        }
      }
    } catch (e) {
      await supabase.from("email_campanhas_envios").update({
        status: "falhou", erro: e instanceof Error ? e.message : String(e),
      }).eq("id", envio.id);
      falhadosBatch++;
    }
    await sleep(throttleMs);
  }

  // Update counters via RPC-like atomic increment
  if (enviadosBatch || falhadosBatch) {
    const { data: cAtual } = await supabase.from("email_campanhas").select("enviados, falhados").eq("id", campanha.id).single();
    await supabase.from("email_campanhas").update({
      enviados: (cAtual?.enviados ?? 0) + enviadosBatch,
      falhados: (cAtual?.falhados ?? 0) + falhadosBatch,
    }).eq("id", campanha.id);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const agora = new Date().toISOString();

    const { data: agendadas } = await supabase
      .from("email_campanhas")
      .select("*")
      .in("status", ["agendada", "enviando"])
      .or(`agendada_para.is.null,agendada_para.lte.${agora}`)
      .limit(5);

    const resultados: any[] = [];
    for (const c of agendadas ?? []) {
      try {
        await processarCampanha(supabase, c);
        resultados.push({ id: c.id, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase.from("email_campanhas").update({ ultimo_erro: msg }).eq("id", c.id);
        resultados.push({ id: c.id, ok: false, error: msg });
      }
    }

    return new Response(JSON.stringify({ ok: true, processadas: resultados.length, resultados }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
