// crm-fluxo-email: despachante da fila de e-mails dos Fluxos de Automação (28/09/2026).
// Desde 02/10/2026 a mesma fila leva os e-mails das automações de funil (CRM V2) e do
// SAC 2.0 — um despachante só, para os três motores não somarem rajadas no provedor.
//
// Pedido do usuário: "porque não tem enviar template de e-mail aqui?" — a ação existia só
// nos Webhooks (11/09/2026) porque o motor dos fluxos (SQL) não sabia enviar e-mail.
//
// Por que FILA e não uma chamada por lead: iniciar um fluxo para um segmento põe milhares
// de execuções no mesmo instante. Uma chamada HTTP por lead soltaria o lote inteiro em
// paralelo — foi exatamente o que a Meta puniu com 130429 no WhatsApp em 23/09/2026. Aqui o
// motor só grava a linha (`crm_fluxo_email_envios`) e o cron `crm-fluxo-email-dispatch`
// chama esta função a cada 20 s, que envia em ritmo controlado (~6 por segundo desde 06/11/2026;
// antes era em série, ~1–2 por segundo).
//
// Só o banco chama: exige a chave de serviço EXATA (o runtime self-hosted não lê
// verify_jwt por função). Qualquer outra credencial recebe 401 antes de ler a fila.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ehLimitePorSegundoDoProvedor, processarEmParalelo, processarItemFila, statusDoLog, type ItemFilaEmail } from "./despacho.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// O worker self-hosted morre por volta de 60 s (mesmo teto do imap-sync-inbox). Mas o orçamento que
// manda é o de SOBREPOSIÇÃO: o cron dispara a cada 20 s e, com rodadas de ~20 s, duas rodadas liam
// os MESMOS itens (`duplicado: 58` e `62` de 120 no log de 06/11 18:06 UTC) — a reserva atômica
// evitava o envio em dobro, mas metade do trabalho ia fora. Por isso nenhum item NOVO começa depois
// de 16 s: a rodada termina antes do próximo disparo, e o item que já está em voo leva 1–2 s.
const ORCAMENTO_MS = 16_000;
// 06/11/2026: eram 40 itens em série por rodada de 20 s (~2 e-mails/s) e a fila de 27 mil itens
// só esvaziava à noite. Agora 4 envios ao mesmo tempo; o lote (160) é só o teto — quem manda é o
// orçamento de tempo (~4 × 16 s / 0,95 s ≈ 67 itens por rodada ≈ 3,5 e-mails/s).
// ⚠️ NÃO suba a concorrência sem olhar a SOBREPOSIÇÃO: nos minutos múltiplos de 5 outras rotinas
// disparam o despachante junto com o cron e 2–3 rodadas rodam ao mesmo tempo (log de 06/11 19:00:59
// UTC: três rodadas com `freio_limite_por_segundo`). Com 6 em voo (18 com 3 rodadas) o Resend, que
// aceita 10 req/s nesta conta (confirmado no painel), recusou 57 envios em 1 h, 7 por rajada. Com 4,
// até 2 rodadas sobrepostas (≈ 8/s) cabem no limite. O limite por segundo, se vier, é repetido pelo
// provedor e, persistindo, freia a rodada.
const LOTE = 160;
const CONCORRENCIA = 4;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token || !SERVICE_ROLE || token !== SERVICE_ROLE) return json({ error: "unauthorized" }, 401);

  const inicio = Date.now();
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: fila, error } = await admin
    .from("crm_fluxo_email_envios")
    .select("id, origem, fluxo_id, execucao_id, passagem, no_id, automacao_id, chave, acao_ref, lead_id, params")
    .eq("status", "pendente")
    .order("criado_em", { ascending: true })
    .limit(LOTE);
  if (error) return json({ ok: false, error: error.message }, 500);

  const agora = () => new Date().toISOString();
  const contagem: Record<string, number> = {};
  let freio = false; // limite por segundo do Resend persistente: para a rodada (ver despacho.ts)

  const processar = async (item: ItemFilaEmail) => {
    const resultado = await processarItemFila(item, {
      nucleo: {
        carregarLead: async (id) => {
          const { data, error } = await admin.from("leads")
            .select("id, nome, email, whatsapp, curso_interesse").eq("id", id).maybeSingle();
          if (error) throw error;
          return data;
        },
        carregarTemplate: async (id) => {
          const { data, error } = await admin.from("email_templates")
            .select("id, ativo, assunto, corpo_html, corpo_texto, uso").eq("id", id).maybeSingle();
          if (error) throw error;
          return data;
        },
        carregarRemetente: async (id) => {
          const { data, error } = await admin.from("email_remetentes")
            .select("id, ativo, provider, dominio_verificado").eq("id", id).maybeSingle();
          if (error) throw error;
          return data;
        },
        enviar: async (body) => {
          const resposta = await fetch(`${SUPABASE_URL}/functions/v1/email-send`, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` },
            body: JSON.stringify(body),
          });
          const corpo = await resposta.json().catch(() => null);
          if (ehLimitePorSegundoDoProvedor({ status: resposta.status, corpo })) freio = true;
          return { ok: resposta.ok, status: resposta.status, corpo };
        },
        // As variáveis já chegam resolvidas pelo motor do fluxo.
        resolverVariavel: (modelo) => modelo,
      },
      assumir: async (id) => {
        const { data, error } = await admin.from("crm_fluxo_email_envios")
          .update({ status: "processando", processado_em: agora() })
          .eq("id", id).eq("status", "pendente").select("id");
        if (error) throw error;
        return (data ?? []).length === 1;
      },
      concluir: async (id, r) => {
        const { error } = await admin.from("crm_fluxo_email_envios")
          .update({ status: r.status, motivo: r.motivo ?? null, log_id: r.log_id ?? null, finalizado_em: agora() })
          .eq("id", id).eq("status", "processando");
        if (error) throw error;
      },
      descartar: async (id, r) => {
        await admin.from("crm_fluxo_email_envios")
          .update({ status: r.status, motivo: r.motivo ?? null, finalizado_em: agora() })
          .eq("id", id).eq("status", "pendente");
      },
      registrarNoFluxo: async (it, r) => {
        await admin.from("crm_fluxo_logs").insert({
          execucao_id: it.execucao_id, fluxo_id: it.fluxo_id, no_id: it.no_id,
          acao: "enviar_email", status: statusDoLog(r),
          detalhe: { motivo: r.motivo ?? null, log_id: r.log_id ?? null, fila_id: it.id },
        });
      },
    });
    contagem[resultado.status] = (contagem[resultado.status] ?? 0) + 1;
  };

  // CONCORRENCIA envios ao mesmo tempo (era 1). O erro de UM item não derruba os que estão em voo:
  // ele é contado e o item fica como estava (a linha `processando` não se repete, como sempre).
  await processarEmParalelo((fila ?? []) as ItemFilaEmail[], CONCORRENCIA, async (item) => {
    try {
      await processar(item);
    } catch (e) {
      contagem.excecao = (contagem.excecao ?? 0) + 1;
      console.error("crm-fluxo-email: item falhou", item.id, e instanceof Error ? e.message : String(e));
    }
  }, () => freio /* o resto continua `pendente` */ || Date.now() - inicio > ORCAMENTO_MS /* e o resto fica para a próxima rodada */);

  // O cron descarta o retorno; sem log não há como saber o efeito de uma rodada.
  console.log("crm-fluxo-email", JSON.stringify({ lidos: fila?.length ?? 0, ...contagem, ...(freio ? { freio_limite_por_segundo: true } : {}), ms: Date.now() - inicio }));
  return json({ ok: true, lidos: fila?.length ?? 0, resultados: contagem });
});
