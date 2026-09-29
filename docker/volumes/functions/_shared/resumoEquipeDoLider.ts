/**
 * O que a EQUIPE disse sobre o líder (Avaliação de Liderança — anônima), resumido.
 *
 * Usado pelo card "📊 Minhas avaliações" de cada líder no Gestor de Tarefas e pela edge
 * `avaliacao-lider-analise` (a IA recebe estes números, não as respostas cruas). Mora em
 * `_shared` para a tela e a IA contarem igual.
 *
 * ⚠️ As respostas precisam chegar com as chaves já no formato FIXO (`l1`…`l15`): as gravadas
 * pelo id da pergunta do banco são traduzidas antes (`src/lib/clima-respostas.ts` na tela; a
 * edge traduz pela ordem, igual).
 * ⚠️ Anônima: aqui não entra data, setor nem nada que ligue uma resposta a uma pessoa — só
 * contagens, médias e os textos soltos.
 */

export const ESCALAS_CLIMA: Record<string, string[]> = {
  "scale-freq": ["Sempre", "Quase sempre", "Às vezes", "Raramente", "Nunca"],
  "scale-conc": ["Concordo totalmente", "Concordo", "Neutro", "Discordo", "Discordo totalmente"],
};

export interface PerguntaDaEquipe {
  chave: string;
  bloco: string;
  texto: string;
  /** scale-freq | scale-conc | text | numeric */
  tipo: string;
}

export interface ResumoDaEquipe {
  respostas: number;
  /** Média de todas as respostas de escala juntas (1 a 5). */
  mediaGeral: number | null;
  blocos: { bloco: string; media: number | null; respostas: number }[];
  perguntas: {
    pergunta: PerguntaDaEquipe;
    media: number | null;
    respostas: number;
    /** Quantas vezes cada opção foi escolhida, na ordem da escala. */
    distribuicao: { opcao: string; vezes: number }[];
  }[];
  /** Respostas abertas, sem autor (a avaliação é anônima). */
  textos: { pergunta: PerguntaDaEquipe; textos: string[] }[];
}

/** 1ª opção da escala = 5, última = 1. `null` = fora da escala (não entra na conta). */
export function pontosClima(valor: unknown, tipo: string): number | null {
  const opcoes = ESCALAS_CLIMA[tipo];
  if (!opcoes || typeof valor !== "string") return null;
  const i = opcoes.indexOf(valor);
  return i < 0 ? null : 5 - i;
}

function media(valores: number[]): number | null {
  return valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
}

export function resumoDaEquipe(
  perguntas: PerguntaDaEquipe[],
  respostas: Record<string, unknown>[],
): ResumoDaEquipe {
  const escalas = perguntas.filter((p) => ESCALAS_CLIMA[p.tipo]);
  const todas: number[] = [];

  const porPergunta = escalas.map((p) => {
    const pontos = respostas.map((r) => pontosClima(r?.[p.chave], p.tipo)).filter((n): n is number => n !== null);
    todas.push(...pontos);
    return {
      pergunta: p,
      media: media(pontos),
      respostas: pontos.length,
      distribuicao: ESCALAS_CLIMA[p.tipo].map((opcao) => ({
        opcao,
        vezes: respostas.filter((r) => r?.[p.chave] === opcao).length,
      })),
    };
  });

  const nomesDosBlocos = [...new Set(escalas.map((p) => p.bloco))];
  const blocos = nomesDosBlocos.map((bloco) => {
    const pontos = porPergunta
      .filter((x) => x.pergunta.bloco === bloco)
      .flatMap((x) => respostas.map((r) => pontosClima(r?.[x.pergunta.chave], x.pergunta.tipo)))
      .filter((n): n is number => n !== null);
    return { bloco, media: media(pontos), respostas: pontos.length };
  });

  const textos = perguntas
    .filter((p) => p.tipo === "text")
    .map((p) => ({
      pergunta: p,
      textos: respostas
        .map((r) => r?.[p.chave])
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim())
        // ⚠️ Anonimato: cada lista em ordem ALFABÉTICA, independente das outras. Na ordem de
        // chegada, o 1º texto de cada pergunta era sempre da mesma pessoa (a primeira a
        // responder): dava para juntar as falas de alguém e, sabendo quem respondeu primeiro,
        // saber quem escreveu (auditoria de 28/09/2026).
        .sort((a, b) => a.localeCompare(b, "pt-BR")),
    }));

  return { respostas: respostas.length, mediaGeral: media(todas), blocos, perguntas: porPergunta, textos };
}
