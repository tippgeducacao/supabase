// pod-gravacao-lembretes: mensagens da GRAVAÇÃO de podcast já marcada (14/10/2026; régua do guia
// da equipe desde 22/10/2026).
//
// O agendamento chega pelo aviso do Calendly (aguardando a validação da equipe) ou é registrado à
// mão em Convites de Podcast. Daqui saem, pelo WhatsApp do Pedagógico: as confirmações ao convidado
// e ao host depois de VALIDADO, os lembretes depois dos DADOS CONFIRMADOS (convidado 7d/3d/véspera/
// dia; host 15d/7d/3d/véspera/dia) e os agradecimentos ao marcar "Gravado". QUANDO cada um sai:
// planoDeLembretes (_shared/podcastLembretes.ts, com teste). O lembrete de 3 dias do host que não
// sai vira o aviso "briefing manual" para a equipe (pod_avisos) — na tela, sem telefone.
//
// Duas portas:
//  · cron de 15 em 15 min (pg_cron, segredo do Vault no cabeçalho x-pod-gravacao-cron-secret)
//    — varre tudo que está em aberto;
//  · a tela, logo depois de salvar/marcar Gravado (usuário do Pedagógico) — só aquele
//    agendamento, para a confirmação e o agradecimento saírem na hora.
// Cada envio é RESERVADO antes (pod_gravacao_lembrete_reservar): as duas portas podem
// rodar juntas e nenhuma mensagem sai duas vezes.
// Sem modelo aprovado na Meta, ou faltando um dado (ex.: briefing do host), nada é gravado:
// a próxima rodada tenta de novo, até a janela do lembrete passar.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  enviarModeloPodcast, formatPhone, modeloAprovadoPorUso, parametrosDoModelo, primeiroNomePodcast, telefoneLegivel,
  type CtxPodcast,
} from "../_shared/podcastEnvio.ts";
import { agradHostPula, dataBR, horaBR, LEMBRETES, planoDeLembretes } from "../_shared/podcastLembretes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SEL =
  "id, status, inicio, agendado_em, validado_em, dados_confirmados_em, gravado_em, lembretes, link_acesso, link_briefing, usuario_acesso, podcast_id, " +
  "podcast:ped_podcasts(nome), " +
  "convidado:ped_professores!pod_gravacao_agendamentos_convidado_id_fkey(id, nome, contato_whatsapp), " +
  "host:ped_professores!pod_gravacao_agendamentos_host_id_fkey(id, nome, contato_whatsapp)";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(url, service);
    const body = await req.json().catch(() => ({} as any));
    const auth = req.headers.get("Authorization") ?? "";

    // Porta do cron ou da tela (usuário do pedagógico, um agendamento só). O cron se prova
    // pelo segredo do Vault no cabeçalho: comparar o Bearer com a service role do runtime
    // NÃO serve — a chave que o banco manda é outra string, e a edge devolvia 401 a todo
    // cron (pego em 14/10/2026, migration 20261014130612).
    let ehCron = auth === `Bearer ${service}`;
    const segredo = req.headers.get("x-pod-gravacao-cron-secret");
    if (!ehCron && segredo) {
      const { data: ok } = await admin.rpc("pod_gravacao_validar_cron", { p_segredo: segredo });
      ehCron = ok === true;
    }
    let soId: string | null = null;
    if (!ehCron) {
      const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ ok: false, error: "não autenticado" }, 401);
      const { data: pode } = await admin.rpc("user_can_access_pedagogico", { _user_id: user.id });
      if (!pode) return json({ ok: false, error: "sem permissão (pedagógico)" }, 403);
      if (!body?.agendamento_id) return json({ ok: false, error: "agendamento_id obrigatório" }, 400);
      soId = String(body.agendamento_id);
    } else if (body?.agendamento_id) {
      soId = String(body.agendamento_id);
    }

    const { data: waRow } = await admin.rpc("get_wa_account_podcast");
    const wa = Array.isArray(waRow) ? waRow[0] : waRow;
    if (!wa?.phone_number_id || !wa?.access_token) return json({ ok: true, skipped: "sem conta de WhatsApp do pedagógico" });

    const agora = new Date();
    let lista: any[] = [];
    if (soId) {
      const { data } = await admin.from("pod_gravacao_agendamentos").select(SEL).eq("id", soId);
      lista = data ?? [];
    } else {
      const ontem = new Date(agora.getTime() - 86400_000).toISOString();
      const doisDias = new Date(agora.getTime() - 2 * 86400_000).toISOString();
      const [{ data: ag }, { data: gr }] = await Promise.all([
        admin.from("pod_gravacao_agendamentos").select(SEL).eq("status", "agendado").gte("inicio", ontem).limit(500),
        admin.from("pod_gravacao_agendamentos").select(SEL).eq("status", "gravado").gte("gravado_em", doisDias).limit(200),
      ]);
      lista = [...(ag ?? []), ...(gr ?? [])];
    }

    const modelos = new Map<string, any>();
    const modelo = async (uso: string) => {
      if (!modelos.has(uso)) modelos.set(uso, await modeloAprovadoPorUso(admin, [uso]));
      return modelos.get(uso);
    };

    const r = { enviados: 0, pulados: 0, aguardando: 0, falhas: 0, agendamentos: lista.length };
    for (const a of lista) {
      const inicio = new Date(a.inicio);
      const ctx: CtxPodcast = {
        nome: primeiroNomePodcast(a.convidado?.nome),
        podcast: a.podcast?.nome ?? "podcast",
        youtube: "",
        dataGravacao: dataBR(inicio),
        horarioGravacao: horaBR(inicio),
        host: a.host?.nome ?? null,
        nomeHost: a.host?.nome ? primeiroNomePodcast(a.host.nome) : null,
        convidado: a.convidado?.nome ?? null,
        telefoneConvidado: telefoneLegivel(a.convidado?.contato_whatsapp) || null,
        linkAcesso: a.link_acesso ?? null,
        linkBriefing: a.link_briefing ?? null,
        usuarioAcesso: a.usuario_acesso ?? null,
      };

      for (const passo of planoDeLembretes(a, agora)) {
        const def = LEMBRETES[passo.chave];
        if (passo.acao === "pular") {
          await admin.rpc("pod_gravacao_lembrete_registrar", { p_id: a.id, p_chave: passo.chave, p_status: "pulado", p_detalhe: passo.motivo ?? null });
          r.pulados++;
          if (passo.chave === "host_3d") await avisarBriefingManual(admin, a, passo.motivo ?? null);
          continue;
        }
        const tpl = await modelo(def.uso);
        if (!tpl) { r.aguardando++; continue; } // modelo ainda não aprovado na Meta
        if (passo.chave === "agrad_host" && agradHostPula(tpl.nome, a.inicio, a.gravado_em)) {
          await admin.rpc("pod_gravacao_lembrete_registrar", {
            p_id: a.id, p_chave: passo.chave, p_status: "pulado", p_detalhe: "marcado como gravado em outro dia (o texto antigo diz \"hoje\")",
          });
          r.pulados++;
          continue;
        }
        const { params, vazios } = parametrosDoModelo(tpl.variaveis_mapping, ctx);
        if (vazios.length) { r.aguardando++; continue; } // falta dado (ex.: briefing); a tela mostra
        const pessoa = def.destino === "host" ? a.host : a.convidado;
        const to = formatPhone(pessoa?.contato_whatsapp);
        const { data: reservou } = await admin.rpc("pod_gravacao_lembrete_reservar", { p_id: a.id, p_chave: passo.chave });
        if (!reservou) continue; // outra rodada pegou
        if (!to) {
          await admin.rpc("pod_gravacao_lembrete_registrar", { p_id: a.id, p_chave: passo.chave, p_status: "pulado", p_detalhe: "sem WhatsApp no cadastro" });
          r.pulados++;
          continue;
        }
        const env = await enviarModeloPodcast(admin, {
          wa, to, tpl, params,
          sac: { professorId: pessoa.id, telefone: pessoa.contato_whatsapp ?? null, nome: pessoa.nome ?? null, podcastId: a.podcast_id },
        });
        await admin.rpc("pod_gravacao_lembrete_registrar", {
          p_id: a.id, p_chave: passo.chave, p_status: env.ok ? "enviado" : "falhou",
          p_detalhe: env.ok ? null : JSON.stringify(env.erro ?? "").slice(0, 300),
        });
        if (env.ok) r.enviados++; else { r.falhas++; console.error("[pod-gravacao-lembretes] falha", a.id, passo.chave, JSON.stringify(env.erro)); }
      }
    }
    return json({ ok: true, ...r });
  } catch (e) {
    console.error("[pod-gravacao-lembretes] fatal", String(e));
    return json({ ok: false, error: String(e) }, 500);
  }
});

// "Se o de 3 dias do host for pulado, o sistema sinaliza para a equipe enviar o briefing
// manualmente" (guia). Um aviso por gravação (índice único); falha aqui não segura os lembretes.
async function avisarBriefingManual(admin: any, a: any, motivo: string | null) {
  // insert puro: o índice único é parcial (tipo = briefing_manual) e o PostgREST não faz upsert nele;
  // a 2ª tentativa só bate no índice e é ignorada
  const { error } = await admin.from("pod_avisos").insert({
    tipo: "briefing_manual", professor_id: a.host?.id ?? null, papel: "host", gravacao_id: a.id,
    podcast_id: a.podcast_id, texto: motivo ? `O lembrete de 3 dias do host não saiu: ${motivo}` : "O lembrete de 3 dias do host não saiu",
  });
  if (error && !/duplicate|unique/i.test(error.message)) console.error("[pod-gravacao-lembretes] aviso briefing", a.id, error.message);
}
