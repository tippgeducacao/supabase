// Peças PURAS do ig-agente (testáveis sem banco nem rede): como a conversa do direct
// vira o histórico que o classificador lê, a janela de 24 h e o ritmo entre balões.

export type LinhaIg = {
  direcao: string | null;
  tipo: string | null;
  conteudo: string | null;
  created_at: string;
};
export type TurnoHistorico = { role: "user" | "assistant"; text: string };

/** A IA só lê a conversa da janela de 24h da Meta (ou desde o /reset, o que for mais novo). */
export const JANELA_HISTORICO_MS = 24 * 60 * 60 * 1000;
export const MAX_MENSAGENS_HISTORICO = 40;

export function inicioDaJanela(historicoDesde: string | null | undefined, agora: Date): string {
  const limite24h = agora.getTime() - JANELA_HISTORICO_MS;
  const reset = historicoDesde ? new Date(historicoDesde).getTime() : NaN;
  return new Date(Number.isFinite(reset) && reset > limite24h ? reset : limite24h).toISOString();
}

// Mídia sem texto também entra no histórico — senão o João responderia a uma mensagem
// que, para ele, não existe. A descrição é o que o sistema sabe: o tipo do anexo.
function descreverMidia(tipo: string): string {
  switch (tipo) {
    case "audio":
      return "[mandou um áudio, que não dá para ouvir por aqui]";
    case "image":
    case "animated_image":
      return "[mandou uma imagem]";
    case "video":
      return "[mandou um vídeo]";
    case "share":
    case "ig_post":
    case "ig_reel":
    case "reel":
      return "[compartilhou um post do Instagram]";
    case "story_mention":
      return "[marcou a PPGVET num story]";
    default:
      return "[mandou um anexo]";
  }
}

export function montarHistoricoIg(linhas: LinhaIg[]): TurnoHistorico[] {
  const turnos: TurnoHistorico[] = [];
  for (const l of linhas) {
    const tipo = String(l.tipo ?? "text");
    // Reação (❤️ numa mensagem) não é fala: nem conta como pergunta pendente.
    if (tipo === "reaction") continue;
    const texto = String(l.conteudo ?? "").trim();
    if (l.direcao === "inbound") {
      if (texto) {
        turnos.push({ role: "user", text: tipo === "story_reply" ? `[respondendo a um story] ${texto}` : texto });
      } else {
        turnos.push({ role: "user", text: descreverMidia(tipo) });
      }
    } else if (l.direcao === "outbound") {
      // Saída nossa: da IA, de um humano pelo app do Instagram (eco) ou do sistema.
      turnos.push({ role: "assistant", text: texto || "[mensagem com mídia]" });
    }
  }
  return turnos.slice(-MAX_MENSAGENS_HISTORICO);
}

/** Pausa antes de cada balão depois do primeiro: parece digitação, sem arrastar a conversa. */
export function atrasoEntreBaloesMs(texto: string): number {
  const porCaractere = String(texto ?? "").length * 35;
  return Math.min(4_000, Math.max(1_200, porCaractere));
}
