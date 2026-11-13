// ajustar-mensagens-disparo — chat "Ajustar com IA" da Central de Disparos (13/11/2026).
//
// Pedido da Kelrin (Marketing): um chat tipo o do Claude no disparo aberto, OPCIONAL, para pedir
// ajustes no texto das mensagens já geradas ("troque o horário para 20h", "só no e-mail:
// assunto mais curto"). Sem dizer onde, o ajuste vale para TODAS as mensagens em que faz
// sentido; quando o pedido diz onde, só lá.
//
// Dois passos, para caber no teto de ~100 s do Cloudflare mesmo com 17 mensagens:
//   1. ROTEAMENTO (1 chamada, saída estruturada): lê todas as mensagens numeradas + a conversa
//      e devolve a resposta do chat e a lista de alvos { numero, o_que_mudar }. Pergunta sem
//      pedido de mudança = lista vazia, só resposta.
//   2. REESCRITA (1 chamada por alvo, em paralelo): reescreve UMA mensagem aplicando só o ajuste.
//
// A edge NÃO grava: devolve { resposta, alteracoes: [{ id, texto }] } e quem grava é a tela,
// pelo mesmo UPDATE de sempre (a RLS de dispatch_messages vale como hoje) — e guarda o "antes"
// para o Desfazer. Os textos vêm da TELA (`textos`), para a IA ver o que a pessoa digitou e
// ainda não saiu do campo; mensagem sem texto da tela usa o do banco.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import {
  LIMITE_INSTRUCAO, contextoDaMarca, custoUsd, executarAjuste, historicoLimpo, ordenar,
  type MensagemDoDisparo,
} from "./regras.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELO = Deno.env.get("AJUSTE_DISPARO_MODEL") ?? "claude-opus-5-5";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let chamador;
  try {
    chamador = await exigirAcesso(req, { usuario: true });
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const dispatchId = typeof body?.dispatch_id === "string" ? body.dispatch_id : "";
    const instrucao = String(body?.instrucao ?? "").trim().slice(0, LIMITE_INSTRUCAO);
    const historico = historicoLimpo(body?.historico);
    const textosDaTela: Record<string, unknown> =
      body?.textos && typeof body.textos === "object" ? body.textos : {};
    if (!dispatchId) return json({ error: "Abra um disparo antes de usar o chat." }, 400);
    if (!instrucao) return json({ error: "Escreva o que quer ajustar." }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: disparo, error: errD } = await db
      .from("dispatches").select("id, brand_profile_id").eq("id", dispatchId).maybeSingle();
    if (errD) throw errD;
    if (!disparo) return json({ error: "Disparo não encontrado." }, 404);

    const [{ data: linhas, error: errM }, { data: bp }, { data: chave }] = await Promise.all([
      db.from("dispatch_messages")
        .select("id, canal, conteudo_gerado, status, dispatch_type_message:dispatch_type_messages(ordem, timing_label, timing_offset, intencao)")
        .eq("dispatch_id", dispatchId),
      db.from("brand_profiles").select("*").eq("id", disparo.brand_profile_id).maybeSingle(),
      db.from("ai_api_keys").select("api_key").eq("provider", "anthropic").eq("is_active", true)
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (errM) throw errM;
    if (!chave?.api_key) {
      return json({ error: "Chave da Anthropic não configurada. Cadastre nas Configurações do Marketing." }, 400);
    }

    // deno-lint-ignore no-explicit-any
    const msgs: MensagemDoDisparo[] = ordenar((linhas ?? []).map((l: any) => {
      const daTela = textosDaTela[l.id];
      return {
        id: l.id,
        canal: l.canal,
        texto: typeof daTela === "string" ? daTela : (l.conteudo_gerado ?? ""),
        ordem: l.dispatch_type_message?.ordem ?? null,
        momento: l.dispatch_type_message?.timing_label ?? null,
        deslocamento: l.dispatch_type_message?.timing_offset ?? null,
        intencao: l.dispatch_type_message?.intencao ?? null,
        status: l.status ?? null,
      };
    }));
    if (!msgs.length) return json({ error: "Este disparo ainda não tem mensagens. Gere as mensagens primeiro." }, 400);

    const { resposta, alteracoes, falhas, uso } = await executarAjuste({
      apiKey: chave.api_key,
      modelo: MODELO,
      msgs,
      instrucao,
      historico,
      marca: contextoDaMarca(bp),
    });

    // 3. Custo no mesmo painel da geração (ai_cost_tracking, por pessoa e mês).
    const custo = custoUsd(uso.entrada, uso.saida);
    const userId = chamador.tipo === "usuario" ? chamador.usuarioId : null;
    if (userId) {
      const mes = new Date().toISOString().slice(0, 7) + "-01";
      const { data: linha } = await db.from("ai_cost_tracking").select("*")
        .eq("user_id", userId).eq("month", mes).eq("provider", "anthropic").maybeSingle();
      if (linha) {
        await db.from("ai_cost_tracking").update({
          total_generations: (linha.total_generations || 0) + alteracoes.length,
          total_cost_usd: (linha.total_cost_usd || 0) + custo,
          total_cost_brl: (linha.total_cost_brl || 0) + custo * 5.5,
        }).eq("id", linha.id);
      } else {
        await db.from("ai_cost_tracking").insert({
          user_id: userId, month: mes, provider: "anthropic", model: MODELO,
          total_generations: alteracoes.length, total_cost_usd: custo, total_cost_brl: custo * 5.5,
        });
      }
    }

    return json({
      resposta,
      alteracoes,
      falhas,
      custo_usd: custo,
    });
  } catch (e) {
    console.error("ajustar-mensagens-disparo error:", e);
    return json({ error: e instanceof Error ? e.message : "Erro ao ajustar as mensagens" }, 500);
  }
});
