// ped-wa-migrar-numero — troca o número de WhatsApp do Pedagógico sem apagar o que existe.
//
// POR QUE existe: template do WhatsApp pertence a UMA WABA. O nome só resolve dentro dela
// (fora, a Meta devolve #132001). Trocar de número, portanto, não é trocar uma config: é
// RECRIAR os 41 templates ativos na WABA nova, esperar a aprovação de cada um, e só então
// virar a chave. Enquanto isso, o mesmo `ped_wa_templates` existe nas duas WABAs com ids
// diferentes — é o que `ped_wa_template_contas` guarda.
//
// Contexto de 10/09/2026: o número antigo (+55 46 9901-7195) foi BANIDO pela Meta por
// revisão de NOME DE EXIBIÇÃO (account_review_status REJECTED, name_status DECLINED) com
// quality_rating GREEN — ou seja, o conteúdo dos templates não é o culpado e migra 1:1.
//
// Ações (POST { acao, ... }):
//   estado      — o que existe de cada lado, template a template (nada muda)
//   submeter    — recria na WABA alvo os que ainda faltam, em lotes
//   sincronizar — lê a Graph API da WABA alvo e atualiza o status de cada um
//   teste       — envia um template real para um telefone, com valores de exemplo
//   ativar      — a virada: aponta a régua para o número novo (exige tudo aprovado)
import { createClient } from "npm:@supabase/supabase-js@2";
import { META_API, SAMPLES, buildComponents } from "../_shared/pedWaTemplateMeta.ts";

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
    .select("id, nome, categoria, idioma, corpo, rodape, botoes, header_tipo, header_exemplo_url, variaveis_mapping, uso_cadencia, is_manual, status, ativo")
    .eq("ativo", true)
    .in("status", ["aprovado", "pendente_meta", "pausado"])
    .order("is_manual").order("uso_cadencia", { nullsFirst: false }).order("nome");
  return data ?? [];
}

/** Parâmetros de corpo com os MESMOS samples da submissão — é o que faz o teste chegar
 *  legível no celular em vez de "{{1}}". */
function parametrosDeTeste(variaveis_mapping: any): { type: string; parameters: unknown[] }[] {
  if (!variaveis_mapping || typeof variaveis_mapping !== "object" || Array.isArray(variaveis_mapping)) return [];
  const chaves = Object.keys(variaveis_mapping).filter((k) => /^\d+$/.test(k))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (!chaves.length) return [];
  return [{
    type: "body",
    parameters: chaves.map((k) => {
      const nome = String(variaveis_mapping[k] ?? "");
      // \n em parâmetro a Meta recusa (#132000) — ver docs/Pedagógico.md, convite ao professor.
      const valor = (SAMPLES[nome] ?? nome ?? `valor ${k}`).replace(/\n+/g, " · ");
      return { type: "text", text: valor };
    }),
  }];
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
      const { data: contas } = await admin
        .from("wa_accounts")
        .select("id, account_name, phone_number, phone_number_id, waba_id, is_active")
        .eq("is_active", true).order("account_name");
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
        if (!r.ok || resp?.error) return json({ erro: resp?.error ?? `Meta ${r.status}` }, 422);
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
        .select("id, nome, idioma, corpo, variaveis_mapping")
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
            components: parametrosDeTeste(t.variaveis_mapping),
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
      const templates = await templatesParaMigrar(admin);
      const cadencia = templates.filter((t: any) => !t.is_manual);
      const { data: rastro } = await admin
        .from("ped_wa_template_contas")
        .select("template_id, status, meta_template_id")
        .eq("wa_account_id", alvo.id);
      const porId = new Map((rastro ?? []).map((r: any) => [r.template_id, r]));

      const faltando = cadencia
        .filter((t: any) => porId.get(t.id)?.status !== "aprovado")
        .map((t: any) => ({ nome: t.nome, status: porId.get(t.id)?.status ?? "não existe" }));

      if (faltando.length && body?.forcar !== true) {
        return json({
          ok: false,
          erro: `${faltando.length} template(s) da cadência ainda não estão aprovados no número novo`,
          faltando,
        }, 409);
      }

      // A linha principal passa a refletir a conta nova: é dela que o dispatcher lê
      // (`status='aprovado'` + `nome`) e as telas de edição.
      let migrados = 0;
      for (const t of templates) {
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

      const anterior = prod?.id ?? null;
      await admin.from("ped_configuracoes").upsert({
        chave: "wa_account_id_pedagogico",
        valor: alvo.id,
        descricao: "UUID da wa_account a ser usada no Pedagógico v2",
      }, { onConflict: "chave" });

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

      await admin.from("ped_configuracoes").upsert({
        chave: "wa_migracao_historico",
        valor: JSON.stringify({ em: new Date().toISOString(), de: anterior, para: alvo.id, por: user.id, templates: migrados, anterior_desativado: anteriorDesativado }),
        descricao: "Ultima troca do numero do Pedagogico (tela Migracao de numero).",
      }, { onConflict: "chave" });

      return json({ ok: true, numero_ativo: alvo.phone_number, templates_migrados: migrados, anterior_desativado: anteriorDesativado, faltando });
    }

    // ── ativar_podcast ────────────────────────────────────────────────────────
    // Fase 2: o convite de podcast passa a sair pelo mesmo número. Separado do `ativar` de
    // propósito — o podcast é MARKETING, e jogar esse volume num número recém-nascido em
    // TIER_250 na primeira semana é o caminho curto para o próximo ban. A partir daqui o
    // `whatsapp-webhook` decide podcast × professor por candidato, não por número.
    if (acao === "ativar_podcast") {
      const { data: tplsPodcast } = await admin
        .from("ped_wa_templates").select("id, nome").eq("ativo", true).like("nome", "podcast%");
      const ids = (tplsPodcast ?? []).map((t: any) => t.id);

      const { data: rastro } = await admin
        .from("ped_wa_template_contas")
        .select("template_id, status, meta_template_id")
        .eq("wa_account_id", alvo.id).in("template_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const porId = new Map((rastro ?? []).map((r: any) => [r.template_id, r]));

      const faltando = (tplsPodcast ?? [])
        .filter((t: any) => porId.get(t.id)?.status !== "aprovado")
        .map((t: any) => ({ nome: t.nome, status: porId.get(t.id)?.status ?? "não existe" }));
      if (faltando.length && body?.forcar !== true) {
        return json({ ok: false, erro: `${faltando.length} template(s) de podcast ainda não aprovados no número novo`, faltando }, 409);
      }

      // Os 6 modelos declaram a conta DONA (é o que evita o 132001). Reapontar aqui é o que
      // faz o SAC do podcast voltar a enviar: as ~64 conversas carimbadas com o número velho
      // caem no padrão sozinhas assim que aquela conta deixa de estar ativa.
      let repontados = 0;
      for (const t of (tplsPodcast ?? [])) {
        const r: any = porId.get(t.id);
        if (!r?.meta_template_id) continue;
        await admin.from("ped_wa_templates").update({
          wa_account_id: alvo.id, meta_template_id: r.meta_template_id, status: r.status, erro_meta: null,
        }).eq("id", t.id);
        repontados++;
      }

      const { data: podRow } = await admin.rpc("get_wa_account_podcast");
      const podAnterior = (Array.isArray(podRow) ? podRow[0] : podRow)?.id ?? null;

      await admin.from("ped_configuracoes").upsert({
        chave: "wa_account_id_podcast",
        valor: alvo.id,
        descricao: "Convite de podcast: id da conta em wa_accounts (número Podcast PPGVET). Vazio até cadastrar o token.",
      }, { onConflict: "chave" });

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
