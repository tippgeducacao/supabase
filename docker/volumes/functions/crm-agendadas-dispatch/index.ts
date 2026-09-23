// crm-agendadas-dispatch
// Disparado pelo cron 'crm-mensagens-agendadas-dispatch' (a cada minuto): envia as
// mensagens agendadas do CRM Comercial (crm_mensagens_agendadas) cujo enviar_em venceu.
//
// REUSA a edge function crm-whatsapp-send para o envio de fato — assim herda toda a
// lógica já testada: resolução da conta WhatsApp, trava de frequência de template
// (1/24h por número), montagem do payload Meta, persistência em crm_whatsapp_messages
// e mirror para o thread do SAC. Aqui só fazemos o claim atômico e a atualização de
// status do agendamento.
//
// Janela de 24h (Meta): template é sempre permitido; texto livre fora da janela é
// recusado pela própria Meta (131047) e o erro é registrado no agendamento.
//
// tipo_mensagem = 'texto' | 'template' | 'midia'. A MÍDIA é enfileirada pela ação "Enviar
// texto livre" do FLUXO no modo "mensagens separadas" (o texto sai na hora por net.http_post
// e a mídia vem por aqui) — é o que garante que o vídeo chegue DEPOIS do texto, já que o
// pg_net dispara as requisições em paralelo, sem ordem.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { AUTOR_REENVIO_MATERIAL, LIMITE_REENVIO_MS, proximaTentativaMaterial } from '../_shared/reenvioMaterial.ts';
import { interpretarEnvioMaterial } from '../_shared/resultadoEnvioMaterial.ts';
import { phoneVariants } from '../crm-whatsapp-send/telefoneConversa.ts';
import {
  chaveDaConta, CODIGO_RATE_LIMIT, criarRitmo, intercalarPorConta,
  MAX_REAGENDAMENTOS_RATE_LIMIT, proximaTentativaRateLimit,
} from './ritmo.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Agendada = {
  id: string;
  wa_account_id: string | null;
  // Linha de WhatsApp Web (wa_conexoes). Quando presente, o envio sai pelo adapter do
  // provider (Uazapi) em vez da Meta — sem janela de 24h e sem template.
  wa_conexao_id: string | null;
  telefone: string;
  lead_id: string | null;
  oportunidade_id: string | null;
  tipo_mensagem: "texto" | "template" | "midia";
  conteudo: string | null;
  template_name: string | null;
  template_lang: string | null;
  template_components: unknown;
  automacao_id: string | null;
  anexo_url: string | null;
  filename: string | null;
  mime_type: string | null;
  criado_por_nome?: string | null;
  criado_em?: string;
  // origem='fluxo' (23/09/2026): template da ação "Enviar mensagem WhatsApp" do Fluxo, que
  // saiu do net.http_post direto para esta fila (ver ritmo.ts).
  contexto_campanha?: {
    persona?: string; aula_id?: string; origem?: string; fluxo_id?: string;
    header_media_url?: string; header_media_format?: string;
  } | null;
  // Reagendamentos já feitos por 130429. Ausente = migration 20260923200000 ainda não
  // aplicada ⇒ o dispatcher não adia (comportamento antigo: a falha é gravada).
  tentativas_rate_limit?: number | null;
};

/** Novos envios só começam até aqui; o resto volta para 'agendado' (nunca saiu). */
const PRAZO_INICIO_MS = 45_000;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Tipo Meta da mídia: do mime_type e, na falta dele, da extensão do arquivo.
function tipoDaMidia(mime: string | null, url: string, filename: string | null): string {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  const ext = (filename || url).toLowerCase().split("?")[0].split(".").pop() ?? "";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "3gp", "mov"].includes(ext)) return "video";
  if (["ogg", "opus", "mp3", "m4a"].includes(ext)) return "audio";
  return "document";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
    return jsonResp({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  try {
    // Higiene de órfãos: linha presa em 'enviando' há >5min = execução anterior morreu
    // no meio (não chegou a enviar). Auto-cura:
    //  • TEMPLATE → volta pra 'agendado' (re-enfileira). É seguro porque a crm-whatsapp-send
    //    tem trava de 1 template/24h por número: se a Meta JÁ recebeu, o reenvio é PULADO
    //    (não duplica). Sem isso, um disparo em massa perdia milhares de órfãos como erro.
    //  • TEXTO LIVRE → 'erro' (sem trava 24h, reenviar duplicaria a mensagem).
    //  ⚠️ 23/09/2026: "preso há >5min" é medido pelo CLAIM (processando_desde), não pelo
    //  enviar_em. Com fila acumulada (Fluxo grande), uma linha agendada há 6 min e agarrada
    //  agora ainda está EM VOO — resetá-la pelo enviar_em fazia a próxima execução enviá-la
    //  de novo. A trava 1 template/24h citada acima foi REMOVIDA da crm-whatsapp-send, então
    //  nada mais protegia contra essa duplicata. Coluna ausente (migration não aplicada) ⇒
    //  cai na régua antiga.
    const presoDesde = new Date(Date.now() - 5 * 60_000).toISOString();
    const limparOrfaos = async (coluna: "processando_desde" | "enviar_em") => {
      const r1 = await admin
        .from("crm_mensagens_agendadas")
        .update({ status: "agendado", enviar_em: new Date().toISOString(), erro_detalhe: null })
        .eq("status", "enviando").eq("tipo_mensagem", "template")
        .lt(coluna, presoDesde);
      if (r1?.error) return r1.error;
      await admin
        .from("crm_mensagens_agendadas")
        .update({ status: "erro", erro_detalhe: "Envio interrompido (timeout). Reagende se necessário." })
        .eq("status", "enviando").neq("tipo_mensagem", "template")
        .lt(coluna, presoDesde);
      return null;
    };
    if (await limparOrfaos("processando_desde")) await limparOrfaos("enviar_em");

    // Claim atômico via RPC: marca 'enviando' e devolve as linhas, num único UPDATE
    // server-side (FOR UPDATE SKIP LOCKED). Evita o `.in([ids])` na URL — que com
    // lote grande (800) estoura o limite de tamanho da request e derruba o dispatcher.
    // ⚠️ LOTE precisa caber no TEMPO DE VIDA de UMA execução da edge. LOTE=8000 quebrou:
    // a edge agarra 8000 (marca 'enviando') mas morre antes de enviar tudo, deixando
    // milhares órfãos em 'enviando'. Com CONC=40 (~20 envios/s), ~1000 saem em ~50s —
    // dentro de um ciclo de cron (60s), então cada execução TERMINA o que agarrou (zero
    // órfão). Vazão ~1000/min. Não aumentar sem medir o tempo real de envio da edge.
    const LOTE = 1000;
    const { data: claimed, error: claimErr } = await admin.rpc("crm_agendadas_claim", { p_limit: LOTE });
    if (claimErr) throw claimErr;
    if (!claimed?.length) return jsonResp({ processed: 0 });

    // CONC trabalhadores em paralelo, mas cada CONTA no seu ritmo (ritmo.ts): antes eram
    // blocos de 40 simultâneos sem olhar o número, e o Fluxo nem passava por aqui.
    const inicio = Date.now();
    const rows = intercalarPorConta((claimed ?? []) as Agendada[]);
    const results: Record<string, string> = {};
    const naoIniciadas: string[] = [];
    const ritmo = criarRitmo();
    const CONC = 40;
    let cursor = 0;
    const trabalhador = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        const conta = chaveDaConta(row);
        const espera = ritmo.reservar(conta);
        if (Date.now() + espera - inicio > PRAZO_INICIO_MS) { naoIniciadas.push(row.id); continue; }
        if (espera > 0) await dormir(espera);
        const res = await processarUma(admin, row);
        if (res === "reagendado_rate_limit") ritmo.penalizar(conta);
        results[row.id] = res;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, trabalhador));
    // Não iniciadas nunca chegaram à crm-whatsapp-send: devolver à fila é seguro.
    for (let i = 0; i < naoIniciadas.length; i += 100) {
      await admin.from("crm_mensagens_agendadas").update({ status: "agendado" })
        .in("id", naoIniciadas.slice(i, i + 100)).eq("status", "enviando");
    }
    return jsonResp({ processed: Object.keys(results).length, devolvidas: naoIniciadas.length, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[crm-agendadas-dispatch] fatal:", msg);
    return jsonResp({ error: msg }, 500);
  }
});

export async function processarUma(
  admin: ReturnType<typeof createClient>,
  row: Agendada,
): Promise<string> {
  const falhar = async (detalhe: string) => {
    await admin.from("crm_mensagens_agendadas")
      .update({ status: "erro", erro_detalhe: detalhe })
      .eq("id", row.id);
    return `erro: ${detalhe}`;
  };

  try {
    const reenvioSdr = row.criado_por_nome === AUTOR_REENVIO_MATERIAL && row.tipo_mensagem === 'midia';
    if (reenvioSdr) {
      // Fila de material não é follow-up comercial: continua após um agendamento,
      // mas nunca após pausa, opt-out, arquivamento ou temporizador do contato.
      if (!row.wa_account_id || row.wa_conexao_id) return await falhar('Conta do reenvio indisponível.');
      const idadeFila = Date.now() - Date.parse(row.criado_em ?? '');
      if (!Number.isFinite(idadeFila) || idadeFila >= LIMITE_REENVIO_MS) return await falhar('Prazo das tentativas de reenvio encerrado.');
      const cancelar = async (motivo: string) => {
        await admin.from('crm_mensagens_agendadas').update({ status: 'cancelado', erro_detalhe: motivo }).eq('id', row.id);
        return 'cancelado';
      };
      const { data: leads, error: erroLead } = await admin.from('cliente_ppg_leads_sdr')
        .select('pausa_ia,nao_perturbe').in('remotejid', phoneVariants(row.telefone).map((t) => `${t}@s.whatsapp.net`));
      if (erroLead || !leads?.length) return await falhar('Não foi possível validar o contato para o reenvio.');
      if (leads.some((l: { pausa_ia: boolean; nao_perturbe: boolean }) => l.pausa_ia || l.nao_perturbe)) return await cancelar('Contato pausado ou opt-out.');
      const { data: flags, error: erroFlags } = await admin.rpc('crm_lead_flags_por_telefone', { p_telefone: row.telefone });
      if (erroFlags) return await falhar('Não foi possível validar bloqueios do contato.');
      const estado = Array.isArray(flags) ? flags[0] : flags;
      if (estado?.arquivado || estado?.timer_ativo) return await cancelar('Contato arquivado ou com temporizador.');
      // Janela da CONTA que vai enviar, não de outra linha que recebeu o lead.
      const { data: ultima, error: erroJanela } = await admin.from('crm_whatsapp_messages')
        .select('created_at').eq('wa_account_id', row.wa_account_id).in('telefone', phoneVariants(row.telefone))
        .eq('direcao', 'inbound').order('created_at', { ascending: false }).limit(1).maybeSingle();
      const idade = Date.now() - Date.parse(ultima?.created_at ?? '');
      if (erroJanela || !Number.isFinite(idade) || idade >= 24 * 3600_000) return await falhar('Janela de WhatsApp fechada ou sem confirmação.');
      const { data: outroEnvio, error: erroOutro } = await admin.from('crm_whatsapp_messages')
        .select('id').eq('wa_account_id', row.wa_account_id).in('telefone', phoneVariants(row.telefone))
        .eq('direcao', 'outbound').eq('tipo', 'document').contains('anexos', [{ url: row.anexo_url }])
        .gte('created_at', row.criado_em).in('status_entrega', ['sent', 'delivered', 'read']).limit(1).maybeSingle();
      if (erroOutro) return await falhar('Não foi possível conferir outro envio do material.');
      if (outroEnvio) return await cancelar('O material já teve outro envio aceito após entrar na fila.');
    }
    // Monta o corpo para a crm-whatsapp-send conforme o tipo
    const sendBody: Record<string, unknown> = {
      mensagem_agendada_id: row.id,
      wa_account_id: row.wa_account_id ?? undefined,
      // Linha web manda no roteamento: a crm-whatsapp-send, ao ver wa_conexao_id, envia
      // pelo provider da linha (Uazapi) e ignora conta Meta/janela/template.
      wa_conexao_id: row.wa_conexao_id ?? undefined,
      telefone: row.telefone,
      tipo: row.tipo_mensagem === "template" ? "template" : "text",
      lead_id: row.lead_id ?? undefined,
      oportunidade_id: row.oportunidade_id ?? undefined,
      // Disparo de automação → carimba origem 'automacao' (balão roxo no chat). Template
      // segue como 'template' no espelho (o mirror checa template antes da origem).
      ...(row.automacao_id ? { origem: "automacao" } : {}),
    };
    if (row.tipo_mensagem === "template") {
      if (!row.template_name) return await falhar("Template não informado");
      sendBody.template_name = row.template_name;
      sendBody.template_lang = row.template_lang || "pt_BR";
      sendBody.template_components = Array.isArray(row.template_components) ? row.template_components : [];
      if (row.contexto_campanha?.persona === 'aula') {
        // Revalidar o cadastro no momento do envio, além da validação do Fluxo.
        const { error } = await admin.rpc('crm_aula_contexto_disparo', { p_aula_id: row.contexto_campanha.aula_id });
        if (error) return await falhar('Cadastro da aula incompleto ou indisponível. Revise a aula antes de reenviar.');
        sendBody.fluxo_id = row.automacao_id;
        sendBody.header_media_url = row.contexto_campanha.header_media_url || undefined;
        sendBody.header_media_format = row.contexto_campanha.header_media_format || undefined;
      } else if (row.contexto_campanha?.origem === 'fluxo') {
        // Template do Fluxo: mesmo corpo que o net.http_post direto mandava. fluxo_id é o que
        // a aba Entregas e o "liberar falhas" usam para casar a mensagem com o fluxo. Sem
        // `origem` de propósito: o envio direto não carimbava, e os painéis contam assim.
        delete sendBody.origem;
        sendBody.fluxo_id = row.contexto_campanha.fluxo_id || row.automacao_id || undefined;
        sendBody.header_media_url = row.contexto_campanha.header_media_url || undefined;
        sendBody.header_media_format = row.contexto_campanha.header_media_format || undefined;
      }
    } else if (row.tipo_mensagem === "midia") {
      // MÍDIA (imagem/vídeo/documento). Quem enfileira hoje é a ação "Enviar texto livre" do
      // FLUXO no modo "mensagens separadas": o texto já saiu por net.http_post e a mídia vem
      // pela fila — é o que garante a ORDEM (o pg_net envia em paralelo, sem ordem).
      const url = String(row.anexo_url ?? "").trim();
      if (!url) return await falhar("Mídia sem URL");
      sendBody.tipo = tipoDaMidia(row.mime_type, url, row.filename);
      sendBody.anexo_url = url;
      if (row.filename) sendBody.filename = row.filename;
      if (row.mime_type) sendBody.mime_type = row.mime_type;
      const legenda = String(row.conteudo ?? "").trim();
      if (legenda) sendBody.conteudo = legenda;
    } else {
      const texto = String(row.conteudo ?? "").trim();
      if (!texto) return await falhar("Conteúdo vazio");
      sendBody.conteudo = texto;
    }

    // O contato pode ter sido arquivado/temporizado depois do claim do lote.
    // Revalida cada automação imediatamente antes do envio; erro na consulta
    // interrompe o disparo. Agendamentos humanos e respostas transacionais
    // preservam a política própria, sem ganhar uma restrição de prospecção.
    if (row.automacao_id) {
      const { data: protecao, error: erroProtecao } = await admin.rpc("crm_agendada_validar_envio", {
        p_mensagem_id: row.id,
      });
      if (erroProtecao || typeof protecao?.permitido !== "boolean") {
        return await falhar("Não foi possível validar as proteções do contato antes do envio.");
      }
      if (!protecao.permitido) return "cancelado";
    }

    // 130429: a crm-whatsapp-send devolve sem gravar e esta fila reagenda. Só com a coluna
    // de contagem presente (migration aplicada) e nunca na última tentativa, que grava a falha.
    const feitasRateLimit = typeof row.tentativas_rate_limit === 'number' ? row.tentativas_rate_limit : null;
    const adiarRateLimit = !reenvioSdr && !row.wa_conexao_id && feitasRateLimit !== null
      && feitasRateLimit < MAX_REAGENDAMENTOS_RATE_LIMIT;
    if (adiarRateLimit) sendBody.adiar_rate_limit = true;

    console.log("[crm-agendadas-dispatch] ->", row.id, JSON.stringify(sendBody));
    const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
      body: JSON.stringify(sendBody),
    });
    const resp = await r.json().catch(() => ({} as Record<string, unknown>));
    console.log("[crm-agendadas-dispatch] <-", row.id, r.status, JSON.stringify(resp));

    if (reenvioSdr) {
      const resultado = interpretarEnvioMaterial(r.ok, resp, r.status);
      if (!resultado.cronograma_enviado) {
        const proxima = proximaTentativaMaterial(resultado, row.criado_em ?? '');
        if (!proxima) return await falhar(resultado.cronograma_erro ?? 'Envio sem confirmação.');
        await admin.from('crm_mensagens_agendadas').update({ status: 'agendado', enviar_em: proxima,
          erro_detalhe: 'Envio recusado; nova tentativa registrada.' }).eq('id', row.id);
        return 'reagendado';
      }
    }

    if (adiarRateLimit && (resp as any)?.reagendavel === true
        && Number((resp as any)?.meta_code) === CODIGO_RATE_LIMIT) {
      const feitas = feitasRateLimit ?? 0;
      const proxima = proximaTentativaRateLimit(feitas);
      if (proxima) {
        await admin.from('crm_mensagens_agendadas').update({
          status: 'agendado', enviar_em: proxima, tentativas_rate_limit: feitas + 1,
          erro_detalhe: `Limite de envio por segundo da Meta (130429). Nova tentativa ${feitas + 2} de ${MAX_REAGENDAMENTOS_RATE_LIMIT + 1}.`,
        }).eq('id', row.id);
        return 'reagendado_rate_limit';
      }
    }

    // crm-whatsapp-send pode pular o envio (trava de frequência de template 1/24h)
    if ((resp as any)?.skipped) {
      return await falhar(
        String((resp as any)?.motivo ?? "Envio pulado pela trava de frequência de template (Meta)."),
      );
    }
    if (!r.ok || (resp as any)?.error || !(resp as any)?.success) {
      return await falhar(String((resp as any)?.error ?? `Falha no envio (status ${r.status})`));
    }
    if (row.contexto_campanha?.persona === 'aula' && !String((resp as any)?.wa_message_id ?? '').trim()) {
      return await falhar('Envio da aula sem identificador de aceite do WhatsApp.');
    }

    await admin.from("crm_mensagens_agendadas")
      .update({
        status: "enviado",
        enviado_em: (resp as any)?.sent_at ?? new Date().toISOString(),
        wa_message_id: (resp as any)?.wa_message_id ?? null,
        erro_detalhe: null,
      })
      .eq("id", row.id);
    return "enviado";
  } catch (e) {
    return await falhar(e instanceof Error ? e.message : String(e));
  }
}
