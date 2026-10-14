// Envio de modelo de WhatsApp de PODCAST — o que o motor (pod-convite-dispatch) e as
// respostas automáticas do whatsapp-webhook têm em comum: resolver cada {{n}} pelo nome da
// variável, montar os parâmetros, enviar pela Graph API e espelhar no SAC.
//
// Uma cópia só por um motivo concreto: a variável nova `link_agenda` (14/10/2026) tinha de
// valer nos dois caminhos. Com duas cópias do resolvedor, o link sairia VAZIO num deles — e
// a Meta recusa parâmetro vazio (131008) sem que ninguém veja.
import { logPodcastConversaSac } from "./podcastSac.ts";

export const META_GRAPH = "https://graph.facebook.com/v21.0";

export interface CtxPodcast {
  nome: string;
  podcast: string;
  youtube: string;
  /** ped_podcasts.link_agenda (Calendly). */
  linkAgenda?: string | null;
  /** ped_configuracoes.podcast_plataforma_gravacao (ex.: Zencastr). */
  plataforma?: string | null;
}

export function primeiroNomePodcast(nome?: string | null): string {
  return String(nome ?? "").trim().split(/\s+/)[0] || "Professor(a)";
}

// Meta rejeita \n/tab/4+ espaços em PARÂMETRO de template
export function sanitizeWaParam(s: string): string {
  return String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{4,}/g, "   ").trim();
}

/**
 * Valor de uma variável do modelo pelo NOME semântico (variaveis_mapping). Decide por
 * pedaço do nome, e a ORDEM importa: `nome_podcast` tem "nome" e "podcast" — tem de cair
 * em podcast. Nome desconhecido devolve "" (o chamador recusa o envio).
 */
export function resolverVarPodcast(nomeVar: string, ctx: CtxPodcast): string {
  const v = String(nomeVar ?? "").toLowerCase();
  if (v.includes("youtube")) return ctx.youtube ?? "";
  if (v.includes("agenda")) return ctx.linkAgenda ?? "";
  if (v.includes("plataforma")) return ctx.plataforma ?? "";
  if (v.includes("podcast")) return ctx.podcast ?? "";
  if (v.includes("nome") || v.includes("convidado")) return ctx.nome ?? "";
  return "";
}

export interface ParametroWa { type: "text"; text: string }

/**
 * Parâmetros do BODY na ordem {{1}}, {{2}}… a partir do variaveis_mapping. `vazios` lista
 * as variáveis que ficaram sem valor: com qualquer uma vazia a Meta recusa o modelo inteiro.
 */
export function parametrosDoModelo(mapping: unknown, ctx: CtxPodcast): { params: ParametroWa[]; vazios: string[] } {
  const vm = (mapping && typeof mapping === "object" && !Array.isArray(mapping))
    ? mapping as Record<string, unknown>
    : { "1": "nome_convidado", "2": "nome_podcast" };
  const chaves = Object.keys(vm).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  const params: ParametroWa[] = [];
  const vazios: string[] = [];
  for (const k of chaves) {
    const texto = sanitizeWaParam(resolverVarPodcast(String(vm[k] ?? ""), ctx));
    if (!texto) vazios.push(String(vm[k] ?? `{{${k}}}`));
    params.push({ type: "text", text: texto });
  }
  return { params, vazios };
}

/** Corpo do modelo com os parâmetros — o texto legível que vai para o SAC. */
export function renderModelo(corpo: string | null | undefined, params: ParametroWa[]): string {
  let t = String(corpo ?? "");
  params.forEach((p, i) => { t = t.split(`{{${i + 1}}}`).join(p.text ?? ""); });
  return t.trim();
}

export interface ContaWa { id?: string | null; phone_number_id: string; access_token: string }
export interface ModeloWa { nome: string; idioma?: string | null; corpo?: string | null; variaveis_mapping?: unknown; uso_cadencia?: string | null }

/**
 * O primeiro modelo aprovado e ativo da lista de usos, NA ORDEM da lista (prioridade). Com
 * um só uso, é a busca de sempre do motor.
 */
export async function modeloAprovadoPorUso(admin: any, usos: string[]): Promise<ModeloWa | null> {
  if (!usos.length) return null;
  const { data } = await admin
    .from("ped_wa_templates")
    .select("nome, idioma, corpo, variaveis_mapping, uso_cadencia")
    .in("uso_cadencia", usos).eq("status", "aprovado").eq("ativo", true);
  for (const u of usos) {
    const t = (data ?? []).find((x: any) => x.uso_cadencia === u);
    if (t) return t as ModeloWa;
  }
  return null;
}

/**
 * Modelo do follow-up de agendamento N. Podcast COM link da agenda usa o texto novo
 * (`podcast_agenda_N_link`, com o link no {{3}}) e, enquanto ele não estiver aprovado, o
 * antigo; podcast sem link usa só o antigo, que pede dia e horário por mensagem.
 */
export function usosDoAgendamento(toque: number, linkAgenda?: string | null): string[] {
  const base = `podcast_agenda_${toque}`;
  return linkAgenda ? [`${base}_link`, base] : [base];
}

/** Envia o modelo e espelha no SAC. Nunca lança: devolve ok/erro. */
export async function enviarModeloPodcast(admin: any, a: {
  wa: ContaWa;
  to: string;
  tpl: ModeloWa;
  params: ParametroWa[];
  sac: { professorId: string; telefone?: string | null; nome?: string | null; podcastId?: string | null };
  enviadaEm?: string;
}): Promise<{ ok: boolean; wamid: string | null; erro?: unknown }> {
  try {
    const r = await fetch(`${META_GRAPH}/${a.wa.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${a.wa.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: a.to, type: "template",
        template: { name: a.tpl.nome, language: { code: a.tpl.idioma || "pt_BR" }, components: [{ type: "body", parameters: a.params }] },
      }),
    });
    const resp = await r.json().catch(() => ({} as any));
    if (!r.ok) return { ok: false, wamid: null, erro: resp };
    const wamid = resp?.messages?.[0]?.id ?? null;
    await logPodcastConversaSac(admin, {
      professorId: a.sac.professorId,
      telefone: a.sac.telefone ?? null,
      nome: a.sac.nome ?? null,
      podcastId: a.sac.podcastId ?? null,
      waAccountId: a.wa.id ?? null,
      direcao: "outbound",
      conteudo: renderModelo(a.tpl.corpo, a.params) || a.tpl.nome,
      waMessageId: wamid,
      templateName: a.tpl.nome,
      enviadaEm: a.enviadaEm ?? new Date().toISOString(),
    });
    return { ok: true, wamid };
  } catch (e) {
    return { ok: false, wamid: null, erro: String(e) };
  }
}
