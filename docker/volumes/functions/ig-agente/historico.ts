// Peças PURAS do ig-agente (testáveis sem banco nem rede): como a conversa do direct
// vira o histórico que o João lê, qual elegibilidade simulada vale na rodada, o
// telefone sintético do teste e o ritmo entre balões.
import { type EstadoElegibilidade, VERSAO_REGRA_ELEGIBILIDADE } from "../crm-agente-sdr/elegibilidadeAgendamento.ts";

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

/**
 * Última decisão de elegibilidade SIMULADA registrada nesta conversa. No modo teste o
 * agendamento só "confirma" depois de uma análise aprovada do mesmo curso — e a análise
 * pode acontecer numa mensagem e a confirmação em outra. Mesma leitura que o webchat faz
 * de `webchat_sessoes.teste_tool_chamadas`.
 */
export function ultimaElegibilidadeTeste(chamadas: unknown): EstadoElegibilidade | null {
  if (!Array.isArray(chamadas)) return null;
  let ultima: EstadoElegibilidade | null = null;
  for (const chamada of chamadas) {
    // deno-lint-ignore no-explicit-any
    const estado = (chamada as any)?.elegibilidade_teste;
    if (estado?.regra_versao === VERSAO_REGRA_ELEGIBILIDADE
      && typeof estado.curso === "string"
      && ["aprovado", "reprovado", "pendente"].includes(estado.decisao)) {
      ultima = { ...estado };
    }
  }
  return ultima;
}

/**
 * Telefone SINTÉTICO do teste: começa com 000, então nunca é o número de ninguém. As
 * tools que consultam de verdade no teste (horários, cursos, objeções) recebem este; as
 * que teriam efeito são simuladas (crm-webchat/modoTeste.ts).
 */
export function telefoneTesteIg(igsid: string): string {
  const digitos = String(igsid ?? "").replace(/\D/g, "");
  return `000${digitos.slice(-8).padStart(8, "0")}`;
}

/** Pausa antes de cada balão depois do primeiro: parece digitação, sem arrastar a conversa. */
export function atrasoEntreBaloesMs(texto: string): number {
  const porCaractere = String(texto ?? "").length * 35;
  return Math.min(4_000, Math.max(1_200, porCaractere));
}
