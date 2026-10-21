// Fila dos avisos do Gestor no WhatsApp da pessoa (`?cron=avisos_pessoais`). Chamado na hora pelos
// gatilhos gt_whatsapp_pessoal_* (a cutucada) e a cada 5 min pelo cron
// `assistente-avisos-pessoais-tick` (o que a cutucada perdeu). O texto mora em avisosPessoais.ts.
//
// Trava igual à dos avisos de tarefa: cada linha é REIVINDICADA antes do envio (UPDATE condicional
// em tentativas + reivindicado_em); falhou → solta com o erro; até 5 tentativas, só das últimas 24 h.
import { carregarLinhaDe, enviarTexto } from "./wa.ts";
import { linkCanal, textoAvisoPessoal, type AvisoPessoal } from "./avisosPessoais.ts";

const MAX_TENTATIVAS = 5;
const POR_RODADA = 20;
const JANELA_MS = 24 * 3600 * 1000;
const REIVINDICACAO_VENCE_MS = 2 * 60 * 1000;
const PAUSA_ENTRE_ENVIOS_MS = 800;

interface ItemFila {
  id: number;
  user_id: string;
  tipo: string;
  notificacao_id: string | null;
  mensagem_id: string | null;
  tentativas: number;
}

/** Erro que não se resolve tentando de novo (aviso desligado, mensagem apagada…). */
class Definitivo extends Error {}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reivindicar(admin: any, item: ItemFila): Promise<boolean> {
  const vence = new Date(Date.now() - REIVINDICACAO_VENCE_MS).toISOString();
  const { data, error } = await admin.from("gt_whatsapp_pessoal_fila")
    .update({ reivindicado_em: new Date().toISOString(), tentativas: item.tentativas + 1 })
    .eq("id", item.id)
    .eq("tentativas", item.tentativas)
    .is("enviado_em", null)
    .or(`reivindicado_em.is.null,reivindicado_em.lt.${vence}`)
    .select("id");
  if (error) throw new Error(`gt_whatsapp_pessoal_fila: ${error.message}`);
  return (data ?? []).length > 0;
}

async function nomeDe(admin: any, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const { data } = await admin.from("profiles").select("name").eq("id", userId).maybeSingle();
  return data?.name ?? null;
}

interface Mensagem {
  id: string;
  channel_id: string;
  user_id: string | null;
  content: string | null;
  message_type: string | null;
  attachments: unknown;
  parent_message_id: string | null;
  deleted_at: string | null;
}

const COLS_MSG = "id, channel_id, user_id, content, message_type, attachments, parent_message_id, deleted_at";

async function mensagemPorId(admin: any, id: string): Promise<Mensagem | null> {
  const { data, error } = await admin.from("gt_chat_messages").select(COLS_MSG).eq("id", id).maybeSingle();
  if (error) throw new Error(`gt_chat_messages: ${error.message}`);
  return data;
}

/**
 * A menção em tarefa aponta para a TAREFA, não para o comentário, e o sino guarda só 140 caracteres.
 * O comentário é a mensagem de quem marcou no chat da tarefa no mesmo instante (melhor esforço:
 * não achou, o aviso sai com o resumo do sino).
 */
async function comentarioDaMencao(admin: any, n: any): Promise<Mensagem | null> {
  if (!n.actor_id || !n.reference_id) return null;
  const { data: canal } = await admin.from("gt_chat_channels")
    .select("id").eq("slug", `task-${n.reference_id}`).limit(1).maybeSingle();
  if (!canal?.id) return null;
  const t = new Date(n.created_at).getTime();
  const { data } = await admin.from("gt_chat_messages").select(COLS_MSG)
    .eq("channel_id", canal.id)
    .eq("user_id", n.actor_id)
    .gte("created_at", new Date(t - 60_000).toISOString())
    .lte("created_at", new Date(t + 5_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

const contarAnexos = (a: unknown) => (Array.isArray(a) ? a.length : 0);

/** Monta o aviso a partir da fila (sem enviar). Lança Definitivo quando não há o que avisar. */
export async function montarAviso(admin: any, item: ItemFila): Promise<string> {
  let aviso: AvisoPessoal;
  if (item.notificacao_id) {
    const { data: n, error } = await admin.from("gt_notifications")
      .select("type, title, body, link, actor_id, reference_type, reference_id, created_at")
      .eq("id", item.notificacao_id).maybeSingle();
    if (error) throw new Error(`gt_notifications: ${error.message}`);
    if (!n) throw new Definitivo("notificação apagada");
    const msg = n.reference_type === "chat_message" && n.reference_id
      ? await mensagemPorId(admin, n.reference_id)
      // Menção e resposta em thread de TAREFA apontam para a tarefa: o texto é achado no chat dela.
      : n.type === "task_mention" || (n.type === "reply" && n.reference_type === "task")
        ? await comentarioDaMencao(admin, n)
        : null;
    if (msg?.deleted_at) throw new Definitivo("mensagem apagada");
    aviso = {
      tipo: n.type,
      titulo: n.title,
      autor: await nomeDe(admin, n.actor_id),
      conteudo: msg ? msg.content : n.body,
      messageType: msg?.message_type ?? null,
      anexos: msg ? contarAnexos(msg.attachments) : 0,
      link: n.link,
    };
  } else if (item.mensagem_id) {
    const msg = await mensagemPorId(admin, item.mensagem_id);
    if (!msg || msg.deleted_at) throw new Definitivo("mensagem apagada");
    const { data: canal } = await admin.from("gt_chat_channels")
      .select("name, type").eq("id", msg.channel_id).maybeSingle();
    aviso = {
      tipo: "canal",
      autor: await nomeDe(admin, msg.user_id),
      canal: canal?.name ?? null,
      tipoCanal: canal?.type ?? null,
      conteudo: msg.content,
      messageType: msg.message_type,
      anexos: contarAnexos(msg.attachments),
      link: linkCanal(msg.channel_id),
    };
  } else {
    throw new Definitivo("linha sem notificação nem mensagem");
  }
  return textoAvisoPessoal(aviso);
}

async function enviarItem(admin: any, item: ItemFila): Promise<void> {
  const { data: cfg, error } = await admin.from("gt_whatsapp_pessoal")
    .select("telefone, wa_conexao_id, ativo").eq("user_id", item.user_id).maybeSingle();
  if (error) throw new Error(`gt_whatsapp_pessoal: ${error.message}`);
  if (!cfg?.ativo) throw new Definitivo("aviso desligado");
  const texto = await montarAviso(admin, item);
  const linha = await carregarLinhaDe(admin, cfg.wa_conexao_id);
  const r = await enviarTexto(linha, cfg.telefone, texto);
  // A Uazapi devolve { ok:false } SEM lançar em não-2xx.
  if (r && (r as any).ok === false) throw new Error("envio recusado pelo provider (ok:false)");
}

export async function processarAvisosPessoais(admin: any): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from("gt_whatsapp_pessoal_fila")
    .select("id, user_id, tipo, notificacao_id, mensagem_id, tentativas")
    .is("enviado_em", null)
    .lt("tentativas", MAX_TENTATIVAS)
    .gte("criado_em", new Date(Date.now() - JANELA_MS).toISOString())
    .order("id")
    .limit(POR_RODADA);
  if (error) throw new Error(`gt_whatsapp_pessoal_fila: ${error.message}`);

  let enviados = 0;
  const erros: string[] = [];
  for (const item of (data ?? []) as ItemFila[]) {
    if (!(await reivindicar(admin, item))) continue; // outro edge pegou
    if (enviados > 0) await dormir(PAUSA_ENTRE_ENVIOS_MS);
    try {
      await enviarItem(admin, item);
      await admin.from("gt_whatsapp_pessoal_fila")
        .update({ enviado_em: new Date().toISOString(), erro: null }).eq("id", item.id);
      enviados++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await admin.from("gt_whatsapp_pessoal_fila")
        .update({ erro: msg, reivindicado_em: null, ...(e instanceof Definitivo ? { tentativas: MAX_TENTATIVAS } : {}) })
        .eq("id", item.id);
      erros.push(`${item.id}: ${msg}`);
    }
  }
  return { enviados, ...(erros.length ? { erros } : {}) };
}

/**
 * Conferência (`?cron=avisos_pessoais&previa=N`): o texto dos últimos N itens da fila (enviados ou
 * não), sem enviar e sem mexer na fila — é como se confere a mensagem contra avisos reais.
 */
export async function previaAvisosPessoais(admin: any, n: number): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from("gt_whatsapp_pessoal_fila")
    .select("id, user_id, tipo, notificacao_id, mensagem_id, tentativas, enviado_em, erro")
    .order("id", { ascending: false })
    .limit(Math.min(Math.max(n, 1), 20));
  if (error) return { erro: `gt_whatsapp_pessoal_fila: ${error.message}` };
  const itens = [];
  for (const item of data ?? []) {
    let texto: string;
    try { texto = await montarAviso(admin, item); } catch (e) { texto = `(não monta: ${(e as Error).message})`; }
    itens.push({ id: item.id, tipo: item.tipo, enviado_em: item.enviado_em, erro: item.erro, texto });
  }
  return { itens };
}
