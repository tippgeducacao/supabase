// ped-wa-migrar-numero — troca o número de WhatsApp do Pedagógico sem apagar o que existe.
//
// POR QUE existe: template do WhatsApp pertence a UMA WABA. O nome só resolve dentro dela
// (fora, a Meta devolve #132001). Trocar de número, portanto, não é trocar uma config: é
// RECRIAR os 41 templates ativos na WABA nova, esperar a aprovação de cada um, e só então
// virar a chave. Enquanto isso, o mesmo `ped_wa_templates` existe nas duas WABAs com ids
// diferentes — é o que `ped_wa_template_contas` guarda.
//
// Contexto de 10/09/2026: o número antigo (+55 46 9901-7195) foi BANIDO pela Meta por
// EXCESSO DE DISPAROS. (A Graph API mostra name_status DECLINED + quality GREEN, e isso foi
// lido errado como "ban por nome" — a causa real vem no aviso da Meta ao dono da conta.)
// O risco do número novo é repetir o padrão de envio: ver docs/Pedagógico.md.
//
// Ações (POST { acao, ... }):
//   estado      — o que existe de cada lado, template a template (nada muda)
//   submeter    — recria na WABA alvo os que ainda faltam, em lotes
//   sincronizar — lê a Graph API da WABA alvo e atualiza o status de cada um
//   teste       — envia um template real para um telefone, com valores de exemplo
//   ativar      — a virada: aponta a régua para o número novo (exige tudo aprovado)
import { createClient } from "npm:@supabase/supabase-js@2";
import { META_API, SAMPLES, SAMPLES_URL, buildComponents } from "../_shared/pedWaTemplateMeta.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Status da Meta → enum do banco. */
function statusDaMeta(s: string): string {
  switch (String(s || "").toUpperCase()) {
    case "APPROVED": return "aprovado";
    case "REJECTED": return "rejeitado";
    case "PAUSED":
    case "DISABLED": return "pausado";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION": return "pendente_meta";
    default: return "pendente_meta";
  }
}

interface Conta {
  id: string;
  waba_id: string;
  phone_number_id: string;
  phone_number: string | null;
  account_name: string | null;
  access_token: string;
  is_active: boolean;
}

/** Conta + token efetivo. O token de system user é rotacionado na tela do CRM: quando o
 *  mesmo `phone_number_id` existe lá, ele manda. Sem isso, migrar por uma linha recém-criada
 *  de `wa_accounts` usaria uma cópia que envelhece sozinha. */
async function carregarConta(admin: any, id: string): Promise<Conta | null> {
  const { data: w } = await admin
    .from("wa_accounts")
    .select("id, waba_id, phone_number_id, phone_number, account_name, access_token, is_active")
    .eq("id", id).maybeSingle();
  if (!w?.waba_id) return null;
  let token = w.access_token;
  const { data: crm } = await admin
    .from("crm_whatsapp_accounts").select("access_token")
    .eq("phone_number_id", w.phone_number_id).eq("ativo", true).maybeSingle();
  if (crm?.access_token) token = crm.access_token;
  if (!token) return null;
  return { ...w, access_token: token } as Conta;
}

/** Templates que a migração leva: os ATIVOS que já vivem na Meta hoje. Rascunho e
 *  `erro_meta` ficam de fora de propósito — nunca chegaram a existir em WABA nenhuma, e
 *  arrastá-los transformaria a migração numa fila de rejeições. */
async function templatesParaMigrar(admin: any) {
  const { data } = await admin
    .from("ped_wa_templates")
    .select("id, nome, categoria, idioma, corpo, rodape, botoes, header_tipo, header_exemplo_url, variaveis_mapping, uso_cadencia, is_manual, status, ativo, wa_account_id")
    .eq("ativo", true)
    .in("status", ["aprovado", "pendente_meta", "pausado"])
    .order("is_manual").order("uso_cadencia", { nullsFirst: false }).order("nome");
  return data ?? [];
}

/** As cadências que a régua de AULAS e de GRAVAÇÃO realmente consomem — copiadas de
 *  `dispatch-professor-invite` (FOLLOWUP_CADENCIAS + STATUS_TO_CADENCIA + o lote) e de
 *  `dispatch-gravacao-convite`. É esta lista, e não `!is_manual`, que define o gate da
 *  virada.
 *
 *  Por que não `!is_manual`: os 6 modelos `podcast_*` também são `is_manual = false`, e
 *  cobrá-los na fase 1 prende a régua de AULAS atrás da aprovação de modelos MARKETING —
 *  que a Meta analisa mais devagar numa WABA nova, e que o próprio projeto decidiu adiar
 *  para a fase 2. `enviar_carta_convite` (uso_cadencia ".") e `comprovante_pagamento`
 *  também caem fora: nenhum dispatcher os lê (grep em supabase/functions), então um
 *  "pendente" neles não pode travar a volta da régua ao ar. */
const CADENCIA_QUE_BLOQUEIA = [
  // dispatch-professor-invite → FOLLOWUP_CADENCIAS
  "convite_inicial", "followup_dia_2", "followup_dia_4", "followup_dia_6", "followup_dia_8",
  "followup_dia_10", "followup_dia_12", "followup_dia_14", "agradecemos_negativa",
  // dispatch-professor-invite → STATUS_TO_CADENCIA + convite em lote
  "lembrete_30d", "lembrete_7d", "lembrete_1d", "dia_aula_manha", "dia_aula_link",
  "pos_aula_status", "convite_semestre_lote",
  // dispatch-gravacao-convite
  "gravacao_convite_proposta", "gravacao_contrato", "gravacao_lembrete_gravacao", "gravacao_pagamento",
];

/** Os modelos da fase 2. Pelo PAPEL (uso_cadencia), nunca pelo nome: `nome like 'podcast%'`
 *  também casa `podcast_recebi_o_agendamento`, que está em `erro_meta`, nunca existiu em
 *  WABA nenhuma e que a migração — por desenho — não submete. Cobrá-lo tornaria o gate da
 *  fase 2 impossível de satisfazer. Mesma lista que o `pod-convite-dispatch` usa. */
const CADENCIA_PODCAST = [
  "podcast_convite", "podcast_followup_1", "podcast_followup_2",
  "podcast_agenda_1", "podcast_agenda_2", "podcast_agenda_3",
];

/** Parâmetros de corpo com os MESMOS samples da submissão — é o que faz o teste chegar
 *  legível no celular em vez de "{{1}}". */
function parametrosDeTeste(variaveis_mapping: any, botoes: any): { type: string; [k: string]: unknown }[] {
  const componentes: { type: string; [k: string]: unknown }[] = [];

  if (variaveis_mapping && typeof variaveis_mapping === "object" && !Array.isArray(variaveis_mapping)) {
    const chaves = Object.keys(variaveis_mapping).filter((k) => /^\d+$/.test(k))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (chaves.length) {
      componentes.push({
        type: "body",
        parameters: chaves.map((k) => {
          const nome = String(variaveis_mapping[k] ?? "");
          // \n em parâmetro a Meta recusa (#132000) — ver docs/Pedagógico.md, convite ao professor.
          const valor = (SAMPLES[nome] ?? nome ?? `valor ${k}`).replace(/\n+/g, " · ");
          return { type: "text", text: valor };
        }),
      });
    }
  }

  // Botão de URL com {{1}}: a Meta EXIGE o parâmetro dele no envio. Sem isto o teste de
  // `dia_aula_link_v2` (o link da sala, único modelo com URL dinâmica) falha sempre — e o
  // passo 3 acusaria de defeito um número que está bom.
  if (Array.isArray(botoes)) {
    botoes.forEach((b: any, i: number) => {
      const url = b?.url ?? b?.link;
      const tipo = String(b?.type ?? b?.tipo ?? (url ? "URL" : "")).toUpperCase();
      if (tipo !== "URL" || !url || !/\{\{\d+\}\}/.test(String(url))) return;
      // No banco o botão guarda a variável da URL em `url_var` (string solta) — censo das
      // chaves de todos os botões: nenhum usa `url_vars_mapping`/`variaveis_mapping`.
      const varNome = String(b?.url_var ?? (b?.url_vars_mapping ?? b?.variaveis_mapping ?? {})?.["1"] ?? "");
      componentes.push({
        // `index` numérico, igual ao `dispatch-professor-invite` — o caminho que já entrega em produção.
        type: "button", sub_type: "url", index: i,
        parameters: [{ type: "text", text: SAMPLES_URL[varNome] ?? SAMPLES[varNome] ?? "abc-defg-hij" }],
      });
    });
  }

  return componentes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  try {
    // Quem chama. Toda ação aqui mexe em número de produção ou manda mensagem real —
    // o gate é o mesmo do resto do pedagógico.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ erro: "Não autenticado" }, 401);
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ erro: "Não autenticado" }, 401);
    const { data: podeAcessar } = await admin.rpc("user_can_access_pedagogico", { _user_id: user.id });
    if (podeAcessar !== true) return json({ erro: "Sem permissão (pedagógico)" }, 403);

    const body = await req.json().catch(() => ({}));
    const acao = String(body?.acao ?? "estado");
    const alvoId = String(body?.wa_account_id ?? "");

    // Conta EM PRODUÇÃO (a que a régua usa agora).
    const { data: prodRow } = await admin.rpc("get_wa_account_pedagogico");
    const prod = (Array.isArray(prodRow) ? prodRow[0] : prodRow) ?? null;

    // ── estado ────────────────────────────────────────────────────────────────
    if (acao === "estado") {
      const templates = await templatesParaMigrar(admin);
      // Inclui as INATIVAS de propósito: a conta que sai da produção é desativada pelo
      // `ativar`, e sem ela na lista não existe caminho de volta pela tela — só SQL.
      const { data: contas } = await admin
        .from("wa_accounts")
        .select("id, account_name, phone_number, phone_number_id, waba_id, is_active")
        .order("is_active", { ascending: false }).order("account_name");
      const { data: rastro } = await admin
        .from("ped_wa_template_contas")
        .select("template_id, wa_account_id, status, meta_template_id, meta_rejection_reason, meta_submitted_at");

      const porTemplate: Record<string, Record<string, unknown>> = {};
      for (const r of rastro ?? []) {
        porTemplate[r.template_id] ??= {};
        (porTemplate[r.template_id] as Record<string, unknown>)[r.wa_account_id] = r;
      }

      return json({
        ok: true,
        producao: prod ? { id: prod.id, nome: prod.account_name, numero: prod.phone_number, waba_id: prod.waba_id } : null,
        // A tela NÃO redefine o que é cadência: ela recebe a régua daqui. Enquanto os dois
        // lados calculavam por conta própria, o botão habilitava com 6 e o servidor exigia
        // 7 — clique que só devolvia 409.
        cadencia_bloqueante: CADENCIA_QUE_BLOQUEIA,
        cadencia_podcast: CADENCIA_PODCAST,
        contas: contas ?? [],
        templates: templates.map((t: any) => ({
          id: t.id, nome: t.nome, categoria: t.categoria, uso_cadencia: t.uso_cadencia,
          is_manual: t.is_manual, status_producao: t.status,
          por_conta: porTemplate[t.id] ?? {},
        })),
      });
    }

    if (!alvoId) return json({ erro: "wa_account_id é obrigatório" }, 422);
    const alvo = await carregarConta(admin, alvoId);
    if (!alvo) return json({ erro: "Conta alvo não encontrada, inativa ou sem token" }, 422);

    // ── submeter ──────────────────────────────────────────────────────────────
    // Em LOTES (default 8). A edge morre por wall-clock antes de 41 chamadas à Meta —
    // e uma submissão perdida no meio é um template que a régua não acha depois.
    if (acao === "submeter") {
      const limite = Math.max(1, Math.min(20, Number(body?.limite ?? 8)));
      const refazer = body?.refazer === true;
      const templates = await templatesParaMigrar(admin);

      const { data: jaTem } = await admin
        .from("ped_wa_template_contas")
        .select("template_id, status")
        .eq("wa_account_id", alvo.id);
      const status = new Map((jaTem ?? []).map((r: any) => [r.template_id, r.status]));

      const pendentes = templates.filter((t: any) => {
        const s = status.get(t.id);
        if (!s) return true;
        if (refazer && (s === "erro_meta" || s === "rejeitado")) return true;
        return false;
      });

      const resultados: unknown[] = [];
      for (const t of pendentes.slice(0, limite)) {
        const payload = {
          name: t.nome,
          language: t.idioma || "pt_BR",
          category: String(t.categoria || "utility").toUpperCase(),
          components: buildComponents(t),
        };
        const r = await fetch(`${META_API}/${alvo.waba_id}/message_templates`, {
          method: "POST",
          headers: { Authorization: `Bearer ${alvo.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const resp = await r.json().catch(() => ({}));
        const agora = new Date().toISOString();

        if (!r.ok || resp?.error) {
          // Já existe na WABA alvo (#100 / duplicado): não é falha — é o retry de um lote
          // que passou. Sincronizar depois traz o id e o status reais.
          const msg = String(resp?.error?.message ?? "");
          const duplicado = /already exists|duplicate/i.test(msg);
          await admin.from("ped_wa_template_contas").upsert({
            template_id: t.id, wa_account_id: alvo.id,
            status: duplicado ? "pendente_meta" : "erro_meta",
            erro_meta: duplicado ? null : resp, meta_submitted_at: agora,
          }, { onConflict: "template_id,wa_account_id" });
          resultados.push({ nome: t.nome, ok: duplicado, duplicado, erro: duplicado ? null : (resp?.error ?? resp) });
          continue;
        }

        await admin.from("ped_wa_template_contas").upsert({
          template_id: t.id, wa_account_id: alvo.id,
          meta_template_id: resp?.id ? String(resp.id) : null,
          status: statusDaMeta(resp?.status ?? "PENDING"),
          meta_submitted_at: agora, meta_rejected_at: null, meta_rejection_reason: null, erro_meta: null,
        }, { onConflict: "template_id,wa_account_id" });
        resultados.push({ nome: t.nome, ok: true, meta_template_id: resp?.id ?? null });
      }

      return json({
        ok: true, enviados: resultados.length,
        restantes: Math.max(0, pendentes.length - resultados.length),
        total: templates.length, resultados,
      });
    }

    // ── sincronizar ───────────────────────────────────────────────────────────
    // A Meta não avisa este sistema quando aprova (o webhook de status de template cai no
    // app do CRM). Lemos a WABA e casamos por NOME — que é a chave real de um template.
    if (acao === "sincronizar") {
      const templates = await templatesParaMigrar(admin);
      const porNome = new Map(templates.map((t: any) => [t.nome, t]));

      const naMeta: any[] = [];
      let url: string | null =
        `${META_API}/${alvo.waba_id}/message_templates?limit=200&fields=name,status,category,language,id,rejected_reason&access_token=${alvo.access_token}`;
      for (let pagina = 0; url && pagina < 10; pagina++) {
        const r = await fetch(url);
        const resp = await r.json().catch(() => ({}));
        if (!r.ok || resp?.error) {
          // `resp.error` da Graph é um OBJETO {message, code, ...}: devolvido cru, a tela
          // mostrava "[object Object]".
          const e = resp?.error;
          return json({ erro: e ? `Meta ${e.code ?? r.status}: ${e.message ?? "erro"}` : `Meta ${r.status}` }, 422);
        }
        naMeta.push(...(resp?.data ?? []));
        url = resp?.paging?.next ?? null;
      }

      let atualizados = 0;
      const linhas: unknown[] = [];
      for (const m of naMeta) {
        const t: any = porNome.get(m.name);
        if (!t) continue;
        const st = statusDaMeta(m.status);
        await admin.from("ped_wa_template_contas").upsert({
          template_id: t.id, wa_account_id: alvo.id,
          meta_template_id: m.id ? String(m.id) : null,
          status: st,
          meta_approved_at: st === "aprovado" ? new Date().toISOString() : null,
          meta_rejected_at: st === "rejeitado" ? new Date().toISOString() : null,
          meta_rejection_reason: m.rejected_reason && m.rejected_reason !== "NONE" ? String(m.rejected_reason) : null,
        }, { onConflict: "template_id,wa_account_id" });
        atualizados++;
        linhas.push({ nome: m.name, status: st, categoria_meta: m.category });
      }

      const faltando = templates.filter((t: any) => !naMeta.some((m) => m.name === t.nome)).map((t: any) => t.nome);
      return json({ ok: true, na_meta: naMeta.length, atualizados, faltando, linhas });
    }

    // ── teste ─────────────────────────────────────────────────────────────────
    // Envio REAL, com valores de exemplo, para um telefone escolhido. É o único jeito de
    // saber que o número novo entrega antes de virar a chave — a aprovação da Meta diz que
    // o texto passou, não que a mensagem chega.
    if (acao === "teste") {
      const telefone = String(body?.telefone ?? "").replace(/\D/g, "");
      if (telefone.length < 12) return json({ erro: "telefone inválido (use 55DDD9XXXXXXXX)" }, 422);

      const ids: string[] = Array.isArray(body?.template_ids) ? body.template_ids.map(String) : [];
      if (!ids.length) return json({ erro: "template_ids é obrigatório" }, 422);

      const { data: tpls } = await admin
        .from("ped_wa_templates")
        .select("id, nome, idioma, corpo, variaveis_mapping, botoes")
        .in("id", ids);

      const enviados: unknown[] = [];
      for (const t of (tpls ?? []).slice(0, 10)) {
        const waPayload = {
          messaging_product: "whatsapp",
          to: telefone,
          type: "template",
          template: {
            name: t.nome,
            language: { code: t.idioma || "pt_BR" },
            components: parametrosDeTeste(t.variaveis_mapping, t.botoes),
          },
        };
        const r = await fetch(`${META_API}/${alvo.phone_number_id}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${alvo.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify(waPayload),
        });
        const resp = await r.json().catch(() => ({}));
        enviados.push({
          nome: t.nome, ok: r.ok && !resp?.error,
          wa_message_id: resp?.messages?.[0]?.id ?? null,
          erro: r.ok ? null : (resp?.error?.message ?? `Meta ${r.status}`),
          codigo: resp?.error?.code ?? null,
        });
      }

      await admin.from("ped_configuracoes").upsert({
        chave: "wa_migracao_ultimo_teste",
        valor: JSON.stringify({ em: new Date().toISOString(), telefone, conta: alvo.id, enviados }),
        descricao: "Ultimo teste de envio pelo numero novo (tela Migracao de numero).",
      }, { onConflict: "chave" });

      return json({ ok: true, numero_usado: alvo.phone_number, enviados });
    }

    // ── ativar ────────────────────────────────────────────────────────────────
    // A virada. Um UPDATE em `ped_configuracoes` muda a conta de TODOS os disparos de uma
    // vez (todos passam por get_wa_account_pedagogico) — e por isso ele só acontece com a
    // cadência 100% aprovada do outro lado: template faltando = régua que dispara no vazio.
    if (acao === "ativar") {
      // Voltar para uma conta DESATIVADA exige pedir. Sem esta guarda, a tela (que lista as
      // desativadas para permitir o caminho de volta) ficava a UM clique de devolver a
      // régua ao número banido e desligar o bom — o rastro da conta banida ainda tem os 20
      // da cadência 'aprovado', então o gate passava.
      if (!alvo.is_active && body?.reverter !== true) {
        return json({
          ok: false,
          erro: "esta conta está DESATIVADA. Voltar para ela só com confirmação explícita de reversão.",
        }, 409);
      }

      const templates = await templatesParaMigrar(admin);
      const { data: rastro } = await admin
        .from("ped_wa_template_contas")
        .select("template_id, status, meta_template_id")
        .eq("wa_account_id", alvo.id);
      const porId = new Map((rastro ?? []).map((r: any) => [r.template_id, r]));

      // O gate percorre a LISTA DE CADÊNCIAS, não os templates que existem. Percorrendo os
      // templates, uma cadência sem template no conjunto (editado e virado `rascunho`,
      // desativado, rejeitado) simplesmente sumia do gate — que passava com 19, ou no limite
      // com zero. Cada cadência precisa de UM template aprovado do outro lado.
      const faltando = CADENCIA_QUE_BLOQUEIA.flatMap((uso) => {
        const doUso = templates.filter((t: any) => t.uso_cadencia === uso);
        if (!doUso.length) return [{ nome: `(nenhum modelo para "${uso}")`, status: "não existe" }];
        const aprovado = doUso.some((t: any) => porId.get(t.id)?.status === "aprovado");
        return aprovado ? [] : doUso.map((t: any) => ({ nome: t.nome, status: porId.get(t.id)?.status ?? "não existe" }));
      });

      if (faltando.length && body?.forcar !== true) {
        return json({
          ok: false,
          erro: `${faltando.length} template(s) da cadência ainda não estão aprovados no número novo`,
          faltando,
        }, 409);
      }

      const anterior = prod?.id ?? null;

      // Voltar atrás significa ativar uma conta que o `ativar` anterior desativou — e
      // `get_wa_account_pedagogico()` exige `is_active`. Sem reativar aqui, a config
      // apontaria para uma conta que a RPC não devolve: a régua ficaria SEM conta nenhuma.
      if (!alvo.is_active) {
        const { error: reErr } = await admin
          .from("wa_accounts").update({ is_active: true }).eq("id", alvo.id);
        if (reErr) return json({ ok: false, erro: `não consegui reativar a conta alvo: ${reErr.message}` }, 500);
      }

      // ESTE upsert É a virada — e vem ANTES de qualquer outra escrita, de propósito. Com a
      // cópia de status antes dele, uma falha aqui deixava a linha principal já reescrita
      // com a WABA nova e a régua ainda no número velho, e a mensagem "nada mudou" mentia.
      // Na ordem atual, falhou aqui = nada foi trocado de fato.
      const { error: viradaErr } = await admin.from("ped_configuracoes").upsert({
        chave: "wa_account_id_pedagogico",
        valor: alvo.id,
        descricao: "UUID da wa_account a ser usada no Pedagógico v2",
      }, { onConflict: "chave" });
      if (viradaErr) {
        return json({
          ok: false,
          erro: `a régua NÃO foi trocada (a gravação da configuração falhou: ${viradaErr.message}). ` +
            `Nada mudou de número — clique de novo.`,
        }, 500);
      }

      // A linha principal passa a refletir a conta nova: é dela que o dispatcher lê
      // (`status='aprovado'` + `nome`) e as telas de edição. Só os modelos SEM conta dona —
      // os que seguem o número do pedagógico. Quem tem `wa_account_id` (os `podcast_*`)
      // pertence a OUTRO número e é assunto do `ativar_podcast`: reescrevê-los aqui
      // rebaixava os 6 para `pendente_meta` na produção, e o `pod-convite-dispatch` (que
      // exige 'aprovado') pulava todo candidato — sem WhatsApp E sem e-mail.
      // Idempotente: repetir o clique reescreve os mesmos valores.
      let migrados = 0;
      for (const t of templates) {
        if (t.wa_account_id) continue;
        const r: any = porId.get(t.id);
        if (!r?.meta_template_id) continue;
        await admin.from("ped_wa_templates").update({
          meta_template_id: r.meta_template_id,
          status: r.status,
          meta_approved_at: r.status === "aprovado" ? new Date().toISOString() : null,
          erro_meta: null,
        }).eq("id", t.id);
        migrados++;
      }

      // Aposenta o número que sai. Não é higiene: enquanto a conta antiga fica `is_active`,
      // toda conversa que carimbou `metadata.wa_account_id` com ela continua tentando enviar
      // por lá — e o `carregarConta` do `whatsapp-send-message` só cai no número padrão
      // quando a conta NÃO está ativa. Quem troca de número troca porque o anterior não
      // serve mais; `desativar_anterior: false` é a exceção, não a regra.
      let anteriorDesativado = false;
      if (anterior && anterior !== alvo.id && body?.desativar_anterior !== false) {
        const { error: descErr } = await admin
          .from("wa_accounts").update({ is_active: false }).eq("id", anterior);
        anteriorDesativado = !descErr;
      }

      // Unificação (decisão de 11/09: o podcast vai para ESTE número). Sem isto, entre este
      // clique e o `ativar_podcast` o podcast seguia no número antigo — banido, mas ATIVO. A
      // Meta devolve 200 num número banido: o motor contava o toque como entregue e, no 3º,
      // marcava o convidado 'silenciou' + 'convidar em 6 meses'. Em 04/09 isso silenciou 15
      // convidados cujos toques de WhatsApp não chegaram (14 tinham recebido o e-mail).
      // Desativado, o `pod-convite-dispatch` para em "sem conta" ANTES de tocar em qualquer
      // candidato, e o `ativar_podcast` depois grava a conta nova.
      let podcastAntigoDesativado = false;
      if (body?.unificar_podcast === true) {
        const { data: cfgPod } = await admin
          .from("ped_configuracoes").select("valor").eq("chave", "wa_account_id_podcast").maybeSingle();
        const podAtual = (cfgPod?.valor as string | null) || null;
        if (podAtual && podAtual !== alvo.id) {
          const { error: pErr } = await admin.from("wa_accounts").update({ is_active: false }).eq("id", podAtual);
          podcastAntigoDesativado = !pErr;
        }
      }

      await admin.from("ped_configuracoes").upsert({
        chave: "wa_migracao_historico",
        valor: JSON.stringify({ em: new Date().toISOString(), de: anterior, para: alvo.id, por: user.id, templates: migrados, anterior_desativado: anteriorDesativado, reverter: body?.reverter === true }),
        descricao: "Ultima troca do numero do Pedagogico (tela Migracao de numero).",
      }, { onConflict: "chave" });

      return json({ ok: true, numero_ativo: alvo.phone_number, templates_migrados: migrados, anterior_desativado: anteriorDesativado, podcast_antigo_desativado: podcastAntigoDesativado, faltando });
    }

    // ── ativar_podcast ────────────────────────────────────────────────────────
    // Fase 2: o convite de podcast passa a sair pelo mesmo número. Separado do `ativar` de
    // propósito — o podcast é MARKETING, e jogar esse volume num número recém-nascido em
    // TIER_250 na primeira semana é o caminho curto para o próximo ban. A partir daqui o
    // `whatsapp-webhook` decide podcast × professor por candidato, não por número.
    if (acao === "ativar_podcast") {
      // Da MESMA fonte que o `submeter` usa: cobrar aprovação de um template que a própria
      // migração se recusa a submeter é um 409 que nunca sai.
      const tplsPodcast = (await templatesParaMigrar(admin))
        .filter((t: any) => CADENCIA_PODCAST.includes(String(t.uso_cadencia ?? "")));
      const ids = tplsPodcast.map((t: any) => t.id);

      const { data: rastro } = await admin
        .from("ped_wa_template_contas")
        .select("template_id, status, meta_template_id")
        .eq("wa_account_id", alvo.id).in("template_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const porId = new Map((rastro ?? []).map((r: any) => [r.template_id, r]));

      // Pela LISTA de cadências, não pelos templates presentes — um podcast que caísse para
      // rejeitado/rascunho sumia do conjunto e o gate passava (no limite, vazio).
      const faltando = CADENCIA_PODCAST.flatMap((uso) => {
        const doUso = tplsPodcast.filter((t: any) => t.uso_cadencia === uso);
        if (!doUso.length) return [{ nome: `(nenhum modelo para "${uso}")`, status: "não existe" }];
        return doUso.some((t: any) => porId.get(t.id)?.status === "aprovado")
          ? []
          : doUso.map((t: any) => ({ nome: t.nome, status: porId.get(t.id)?.status ?? "não existe" }));
      });
      if (faltando.length && body?.forcar !== true) {
        return json({ ok: false, erro: `${faltando.length} template(s) de podcast ainda não aprovados no número novo`, faltando }, 409);
      }

      // Conta do podcast ANTES da troca — lida da config, não da RPC: se o `ativar` já
      // desativou o número velho (unificar_podcast), a RPC (que exige is_active) volta vazia.
      const { data: cfgPod } = await admin
        .from("ped_configuracoes").select("valor").eq("chave", "wa_account_id_podcast").maybeSingle();
      const podAnterior = (cfgPod?.valor as string | null) || null;

      // ESTE upsert É a virada do podcast, e vem PRIMEIRO — igual ao `ativar`. Antes ele vinha
      // por último e sem conferir erro: se falhasse, os modelos já estavam repontados, a conta
      // velha já desativada, a config apontando para uma conta inativa e a tela dizendo "Podcast
      // agora sai por ...". Resultado: pod-convite-dispatch sem conta (nem WhatsApp nem e-mail)
      // e o webhook sem saber qual é o número do podcast.
      const { error: viradaErr } = await admin.from("ped_configuracoes").upsert({
        chave: "wa_account_id_podcast",
        valor: alvo.id,
        descricao: "Convite de podcast: id da conta em wa_accounts (número Podcast PPGVET). Vazio até cadastrar o token.",
      }, { onConflict: "chave" });
      if (viradaErr) {
        return json({
          ok: false,
          erro: `o podcast NÃO foi trocado (a gravação da configuração falhou: ${viradaErr.message}). Nada mudou — clique de novo.`,
        }, 500);
      }

      // Os 6 modelos declaram a conta DONA (é o que evita o 132001). Reapontar aqui é o que
      // faz o SAC do podcast voltar a enviar: as ~64 conversas carimbadas com o número velho
      // caem no padrão sozinhas assim que aquela conta deixa de estar ativa.
      let repontados = 0;
      for (const t of tplsPodcast) {
        const r: any = porId.get(t.id);
        if (!r?.meta_template_id) continue;
        await admin.from("ped_wa_templates").update({
          wa_account_id: alvo.id, meta_template_id: r.meta_template_id, status: r.status, erro_meta: null,
        }).eq("id", t.id);
        repontados++;
      }

      let anteriorDesativado = false;
      if (podAnterior && podAnterior !== alvo.id && body?.desativar_anterior !== false) {
        const { error: descErr } = await admin
          .from("wa_accounts").update({ is_active: false }).eq("id", podAnterior);
        anteriorDesativado = !descErr;
      }

      return json({ ok: true, numero_ativo: alvo.phone_number, templates_repontados: repontados, anterior_desativado: anteriorDesativado, faltando });
    }

    return json({ erro: `ação desconhecida: ${acao}` }, 422);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ped-wa-migrar-numero]", msg);
    return json({ erro: msg }, 500);
  }
});
