// Avisos do Gestor de Tarefas no WhatsApp da PESSOA (pedido do José, 19/10/2026): "com o nosso bot
// de relatório comercial, eu quero que ele traga avisos de menções e de canais — as notificações do
// gestor de tarefas devem vir no meu WhatsApp". Régua pura do texto, testada no vitest; fila e envio
// em avisosPessoaisTick.ts. Quem enfileira são os gatilhos gt_whatsapp_pessoal_* (banco).
import { URL_APP } from "./avisosTarefas.ts";

/** Teto do trecho da mensagem: o WhatsApp lê bem até aqui; o resto está a um toque no link. */
export const MAX_TRECHO = 700;

export interface AvisoPessoal {
  /** Tipo da notificação do sino (task_mention, chat_mention, chat_dm, reply…) ou 'canal'. */
  tipo: string;
  /** Título do sino ("Adriane mencionou você em …"); no 'canal' não existe. */
  titulo?: string | null;
  /** Quem escreveu (profiles.name); null = mensagem automática. */
  autor?: string | null;
  canal?: string | null;
  tipoCanal?: string | null; // channel | announcement | group
  /** Texto da mensagem (HTML do editor ou texto puro) — ou o resumo do sino quando não há mensagem. */
  conteudo?: string | null;
  messageType?: string | null; // text | image | file | audio | system
  anexos?: number;
  /** Caminho do app ("/gestor-tarefas?task=…"); vira link completo. */
  link?: string | null;
}

const ENTIDADES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

/** HTML do editor (ou texto puro) → texto do WhatsApp: parágrafo vira linha, item vira "• ". */
export function textoDaMensagem(conteudo: string | null | undefined): string {
  const s = String(conteudo ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTIDADES[m] ?? m)
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > MAX_TRECHO ? `${s.slice(0, MAX_TRECHO).trimEnd()}…` : s;
}

/** Mensagem só de anexo: diz o que chegou, para o aviso nunca sair vazio. */
function semTexto(messageType: string | null | undefined, anexos: number): string {
  if (messageType === "image") return "🖼️ imagem";
  if (messageType === "audio") return "🎙️ áudio";
  if (anexos > 1) return `📎 ${anexos} arquivos`;
  return anexos === 1 || messageType === "file" ? "📎 arquivo" : "";
}

/** Só o primeiro nome e o sobrenome, como nos avisos de tarefa. */
function nomeCurto(nome: string | null | undefined): string | null {
  const partes = String(nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return null;
  return partes.length > 2 ? `${partes[0]} ${partes[partes.length - 1]}` : partes.join(" ");
}

/** Primeira linha: quem, o quê e onde. */
function cabecalho(a: AvisoPessoal): string {
  const quem = nomeCurto(a.autor);
  const titulo = String(a.titulo ?? "").trim();
  if (a.tipo === "canal") {
    const onde = `${a.tipoCanal === "group" ? "no grupo" : "no canal"} *${String(a.canal ?? "").trim() || "sem nome"}*`;
    return quem ? `💬 *${quem}* ${onde}` : `📣 Aviso automático ${onde}`;
  }
  if (a.tipo === "chat_dm") return `✉️ Mensagem direta de *${quem ?? (titulo || "alguém")}*`;
  if (a.tipo === "task_mention" || a.tipo === "chat_mention") return `🔔 *${titulo || "Você foi mencionado"}*`;
  if (a.tipo === "reply") return `↩️ *${titulo || "Nova resposta"}*`;
  return `🔔 *${titulo || "Notificação do Gestor"}*`;
}

export function textoAvisoPessoal(a: AvisoPessoal): string {
  const anexos = Math.max(0, a.anexos ?? 0);
  const trecho = textoDaMensagem(a.conteudo);
  const corpo = trecho || semTexto(a.messageType, anexos);
  // Texto + anexo: a linha do anexo vai embaixo (o texto sozinho esconderia que veio um arquivo).
  const linhaAnexo = trecho && anexos > 0 ? (anexos > 1 ? `📎 ${anexos} anexos` : "📎 1 anexo") : null;
  const link = String(a.link ?? "").trim();
  return [
    cabecalho(a),
    ...(corpo ? ["", corpo] : []),
    ...(linhaAnexo ? [linhaAnexo] : []),
    ...(link ? ["", `🔗 ${link.startsWith("http") ? link : URL_APP + (link.startsWith("/") ? link : `/${link}`)}`] : []),
  ].join("\n");
}

/** Link do canal (o app redireciona o endereço antigo, ver destinoGestorLegado.ts). */
export function linkCanal(canalId: string): string {
  return `/gestor-tarefas?channel=${canalId}`;
}
