/**
 * AVALIAÇÃO ENTRE LÍDERES — a 3ª avaliação do ciclo trimestral de Cultura e Clima.
 *
 * Fonte: documento "Avaliação entre Líderes — Formulário Trimestral" (Carlos, 24/09/2026).
 * As outras duas medem o líder pela equipe e o colaborador pelo líder; esta devolve a cada
 * líder o que só outro líder enxerga — o ponto cego, a qualidade que virou excesso, o que
 * trava na fronteira entre os setores. Ver docs/Clima Organizacional.md.
 *
 * As perguntas moram AQUI, no código (como o DISC), e não no cadastro `fin_clima_perguntas`:
 * o cadastro só conhece escala, texto e nota, e o editor da aba Perguntas não sabe lidar com
 * opções, grupos e pergunta invertida — editar uma destas lá quebraria a pergunta.
 *
 * O modelo segue as "Notas para quem vai montar no sistema" do documento:
 * - dois formatos novos: escolha ÚNICA (pergunta 3) e MÚLTIPLA escolha (7, 8, 9, 11–16);
 * - o campo de texto é uma OPÇÃO de qualquer pergunta (`campoTexto`), não um formato próprio —
 *   a 10 é escala com texto e as outras nove são marcação com texto;
 * - o texto é OBRIGATÓRIO onde existe: a marcação é atalho, o texto é o conteúdo;
 * - a 9 tem DOIS grupos de marcação e um único campo de texto;
 * - a 2 é INVERTIDA no cálculo (de propósito, para acordar quem responde no automático);
 * - viram nota só as de escala (1, 2, 4, 5, 6 e 10); a 3 é distribuição, comparada com a
 *   autoavaliação; as de múltipla escolha viram contagem;
 * - o texto de apoio (as linhas em cinza) faz parte da pergunta e aparece na tela.
 *
 * ⚠️ As respostas gravam o TEXTO da opção (como os outros formulários). Mudar o texto de uma
 * opção aqui separa as respostas antigas das novas na contagem — não reescreva opção no meio
 * de um ciclo.
 */

export type TipoEscala = "freq" | "conc";

export const OPCOES_ESCALA: Record<TipoEscala, string[]> = {
  freq: ["Sempre", "Quase sempre", "Às vezes", "Raramente", "Nunca"],
  conc: ["Concordo totalmente", "Concordo", "Neutro", "Discordo", "Discordo totalmente"],
};

export interface GrupoOpcoes {
  id: string;
  /** Rótulo do grupo — só a pergunta 9 tem mais de um. */
  titulo?: string;
  opcoes: string[];
  /**
   * Opções que contradizem as outras ("Não, eu falo tudo…" × "Sim, sobre…"): marcar uma delas
   * desmarca o resto, e vice-versa (`alternarOpcao`). O PDF diz "marque quantas se aplicarem";
   * isto só evita resposta que se desmente (auditoria de 28/09/2026).
   */
  exclusivas?: string[];
}

/** Campo de texto que acompanha a pergunta. Onde existe, é obrigatório. */
export interface CampoTexto {
  rotulo: string;
}

interface PerguntaBase {
  id: string;
  numero: number;
  bloco: string;
  texto: string;
  /** Linha de apoio em cinza, embaixo da pergunta. */
  apoio?: string;
  campoTexto?: CampoTexto;
}

export interface PerguntaEscala extends PerguntaBase {
  tipo: "escala";
  escala: TipoEscala;
  /** A escala está "ao contrário": a 1ª opção é a PIOR. Só a pergunta 2. */
  invertida?: boolean;
}

export interface PerguntaUnica extends PerguntaBase {
  tipo: "unica";
  opcoes: string[];
}

export interface PerguntaMultipla extends PerguntaBase {
  tipo: "multipla";
  grupos: GrupoOpcoes[];
}

export type PerguntaEntreLideres = PerguntaEscala | PerguntaUnica | PerguntaMultipla;

export interface RespostaQuestao {
  /** Escala ou escolha única. */
  valor?: string;
  /** Múltipla escolha, por grupo (`opcoes` quando a pergunta tem um grupo só). */
  marcadas?: Record<string, string[]>;
  texto?: string;
}

export type RespostasEntreLideres = Record<string, RespostaQuestao>;

const MARQUE = "Marque quantas se aplicarem.";

export const ESTILOS_DE_LIDERAR = [
  "Define o caminho e cobra a execução",
  "Constrói a decisão junto com o time antes de fechar",
  "Dá a meta e deixa o time escolher o caminho",
  "Entra junto na operação e puxa pelo exemplo",
  "Cuida de desenvolver cada pessoa, mesmo quando isso custa prazo",
];

/** As 16 perguntas, na ordem e com o texto do documento. `[NOME]` = o líder avaliado. */
export const PERGUNTAS_ENTRE_LIDERES: PerguntaEntreLideres[] = [
  // Bloco 1 · Jeito de liderar
  {
    id: "q1", numero: 1, bloco: "Jeito de liderar", tipo: "escala", escala: "freq",
    texto: "Quando [NOME] assume um compromisso comigo, acontece no prazo combinado.",
  },
  {
    id: "q2", numero: 2, bloco: "Jeito de liderar", tipo: "escala", escala: "freq", invertida: true,
    texto: "[NOME] se mostra resistente quando a rota muda ou quando aparece uma ideia nova.",
  },
  {
    id: "q3", numero: 3, bloco: "Jeito de liderar", tipo: "unica",
    texto: "Qual frase descreve melhor o jeito de [NOME] liderar no dia a dia?",
    apoio: "Escolha uma. Não existe certa: é para comparar como cada líder é visto.",
    opcoes: ESTILOS_DE_LIDERAR,
  },
  // Bloco 2 · Interface entre os setores
  {
    id: "q4", numero: 4, bloco: "Interface entre os setores", tipo: "escala", escala: "conc",
    texto: "As decisões de [NOME] levam em conta o impacto que causam no meu setor.",
  },
  {
    id: "q5", numero: 5, bloco: "Interface entre os setores", tipo: "escala", escala: "freq",
    texto: "Quando meu setor depende de algo do setor de [NOME], a entrega vem no formato e no tempo que eu preciso.",
  },
  {
    id: "q6", numero: 6, bloco: "Interface entre os setores", tipo: "escala", escala: "conc",
    texto: "Quando saio de uma conversa com [NOME], sei exatamente o que ficou combinado e quem faz o quê.",
  },
  // Bloco 3 · Como [NOME] reage
  {
    id: "q7", numero: 7, bloco: "Como [NOME] reage", tipo: "multipla",
    texto:
      "Quando a pressão aperta (uma urgência, uma cobrança forte, algo dando errado), o que acontece com o emocional de [NOME]? E quanto disso chega em quem está por perto?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Fica mais calmo que o normal e organiza os outros",
        "Mantém a compostura, mas dá para sentir a tensão",
        "Fica mais ríspido ou curto nas respostas",
        "Acelera: fala muito, decide rápido demais",
        "Fecha, some e tenta resolver sozinho",
        "Transborda: o clima de quem está por perto pesa junto",
        "Não dá para saber, essa pessoa não transparece nada",
      ],
      exclusivas: ["Não dá para saber, essa pessoa não transparece nada"],
    }],
    campoTexto: {
      rotulo: "Conte a cena que te fez marcar isso. Se essa pessoa não deixa nada transparecer, diga se isso ajuda ou atrapalha.",
    },
  },
  {
    id: "q8", numero: 8, bloco: "Como [NOME] reage", tipo: "multipla",
    texto: "Quais são os sinais de que [NOME] está precisando replanejar as tarefas e recalcular a rota?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Começa a repetir que está sem tempo",
        "Demora mais para responder mensagem e e-mail",
        "Vai adiando decisão que já estava para ser tomada",
        "Assume tarefa que era do time para adiantar",
        "Entregas do setor começam a estourar prazo",
        "Cancela ou encurta reuniões e alinhamentos",
        "Fica mais curto no trato, muda o humor",
      ],
    }],
    campoTexto: { rotulo: "Qual desses sinais aparece primeiro, antes dos outros?" },
  },
  {
    id: "q9", numero: 9, bloco: "Como [NOME] reage", tipo: "multipla",
    texto: "Como [NOME] reage quando descobre que errou? E quando quem erra é alguém do time?",
    grupos: [
      {
        id: "proprio",
        titulo: "Quando o erro é de [NOME]:",
        opcoes: [
          "Assume rápido e já traz a correção",
          "Assume, mas demora a falar",
          "Explica o contexto antes de assumir",
          "Divide a responsabilidade com os outros",
          "Não costuma admitir",
        ],
      },
      {
        id: "time",
        titulo: "Quando o erro é de alguém do time:",
        opcoes: [
          "Protege o time por fora e trata por dentro",
          "Vai direto na pessoa, na hora",
          "Corrige na frente dos outros",
          "Absorve e refaz sozinho",
          "Cobra o time e expõe para fora",
        ],
      },
    ],
    campoTexto: { rotulo: "Se a reação for diferente nos dois casos, qual é a diferença?" },
  },
  {
    id: "q10", numero: 10, bloco: "Como [NOME] reage", tipo: "escala", escala: "freq",
    texto: "Quando [NOME] fica fora (viagem, férias, um dia inteiro tomado), o setor continua andando do mesmo jeito.",
    campoTexto: { rotulo: "O que você vê mudar quando essa pessoa não está?" },
  },
  // Bloco 4 · Ponto cego e possibilidade
  {
    id: "q11", numero: 11, bloco: "Ponto cego e possibilidade", tipo: "multipla",
    texto: "Qual é a coisa que quem convive com [NOME] percebe, e que você acha que essa pessoa não percebe sobre si mesma?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Não percebe o quanto o tom dela pesa nos outros",
        "Acha que delega, mas centraliza",
        "Acha que comunicou, e a mensagem não chegou",
        "Não percebe o quanto o time depende dela para decidir",
        "Se cobra demais e não vê isso",
        "Não percebe que o setor dela virou gargalo de outros",
        "Não enxerga o quanto já evoluiu",
      ],
    }],
    campoTexto: { rotulo: "Descreva com as suas palavras:" },
  },
  {
    id: "q12", numero: 12, bloco: "Ponto cego e possibilidade", tipo: "multipla",
    texto: "Qual qualidade de [NOME], em dose alta demais, começa a atrapalhar?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Exigência que vira cobrança sem folga",
        "Agilidade que atropela o combinado",
        "Cuidado com as pessoas que adia a conversa difícil",
        "Perfeccionismo que trava a entrega",
        "Autonomia que vira decisão isolada",
        "Foco no próprio setor que perde o resto da empresa",
        "Disponibilidade que faz assumir o que é dos outros",
      ],
    }],
    campoTexto: { rotulo: "Em que situação você viu isso acontecer?" },
  },
  {
    id: "q13", numero: 13, bloco: "Ponto cego e possibilidade", tipo: "multipla",
    texto: "Existe algo que você já pensou em falar para [NOME] e não falou?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Sim, sobre o jeito de tratar as pessoas",
        "Sim, sobre uma decisão que eu acho errada",
        "Sim, sobre algo que trava entre os nossos setores",
        "Sim, sobre algo pessoal que afeta o trabalho",
        "Não, eu falo tudo o que preciso falar",
      ],
      exclusivas: ["Não, eu falo tudo o que preciso falar"],
    }],
    campoTexto: { rotulo: "O que é, e o que te segurou?" },
  },
  {
    id: "q14", numero: 14, bloco: "Ponto cego e possibilidade", tipo: "multipla",
    texto: "Se um colaborador seu fosse trabalhar com [NOME] a partir de amanhã, o que você avisaria antes?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Traga o assunto com proposta pronta",
        "Fale direto, sem rodeio",
        "Avise antes, não gosta de ser pego de surpresa",
        "Mande por escrito, conversa de corredor some",
        "Evite pedir em cima da hora",
        "Procure na hora certa, tem hora ruim",
        "Não tenha medo de discordar, aceita bem",
      ],
    }],
    campoTexto: { rotulo: "O que mais você avisaria?" },
  },
  {
    id: "q15", numero: 15, bloco: "Ponto cego e possibilidade", tipo: "multipla",
    texto: "Se você assumisse o setor de [NOME] por uma semana, qual problema atacaria primeiro?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Redistribuir tarefas dentro do time",
        "Cortar ou simplificar um processo que trava",
        "Ajustar alguém específico do time",
        "Organizar prioridades, tem coisa demais ao mesmo tempo",
        "Documentar o que só está na cabeça dessa pessoa",
        "Melhorar a comunicação com os outros setores",
        "Pedir sistema para algo que hoje é feito na mão",
      ],
    }],
    campoTexto: {
      rotulo:
        "Qual problema exatamente, e o que você faria? Vale ideia que essa pessoa já tentou, desde que você diga por que vale tentar de novo.",
    },
  },
  // Bloco 5 · O conselho
  {
    id: "q16", numero: 16, bloco: "O conselho", tipo: "multipla",
    texto: "Que conselho você daria para [NOME] crescer como líder? E o que indicaria?",
    apoio: MARQUE,
    grupos: [{
      id: "opcoes",
      opcoes: [
        "Um livro",
        "Um curso ou formação",
        "Um podcast ou canal",
        "Uma conversa com alguém específico",
        "Um hábito para mudar na rotina",
        "Um conselho de vida, fora do trabalho",
      ],
    }],
    campoTexto: { rotulo: "Qual, e por que justamente essa indicação para essa pessoa? O que ela resolveria no caso dela." },
  },
];

/**
 * A pergunta 3 respondida pelo próprio líder, sobre si mesmo. É o outro lado da comparação
 * mais forte do formulário: como ele se vê × como os pares o veem. Grava com a MESMA chave
 * (`q3`), numa linha em que avaliador = avaliado.
 */
export const PERGUNTA_AUTOAVALIACAO: PerguntaUnica = {
  id: "q3",
  numero: 3,
  bloco: "Autoavaliação",
  tipo: "unica",
  texto: "Qual frase descreve melhor o seu jeito de liderar no dia a dia?",
  apoio: "Escolha uma. Não existe certa: é para comparar como você se vê com como os colegas te veem.",
  opcoes: ESTILOS_DE_LIDERAR,
};

/** Quantas pessoas cada um avalia, no mínimo — só quem tem trabalho em comum com ele. */
export const MINIMO_DE_AVALIACOES = 3;

/**
 * Decisão do Carlos (28/09/2026): o LÍDER avalia os diretores OBRIGATORIAMENTE, além do mínimo
 * de 3 líderes. A diretoria segue com o mínimo de 3 pessoas. A mesma régua está no banco
 * (`avaliacao_pendencias_de`), que é quem decide o aviso.
 */
export const DIRETORIA_OBRIGATORIA_PARA_LIDERES = true;

export interface ParticipanteDaMeta {
  id: string;
  papel: "lider" | "diretor";
}

export interface MetaEntreLideres {
  papel: "lider" | "diretor";
  /** Líder: outros LÍDERES avaliados. Diretoria: pessoas avaliadas (qualquer papel). */
  avaliados: number;
  minimo: number;
  /** Diretores avaliados e quantos são obrigatórios (0 para a diretoria). */
  diretoriaAvaliada: number;
  diretoriaTotal: number;
  autoavaliacao: boolean;
  cumprida: boolean;
}

/** Quanto da meta do trimestre a pessoa já cumpriu, a partir de quem ela já avaliou. */
export function metaEntreLideres(
  eu: ParticipanteDaMeta,
  participantes: ParticipanteDaMeta[],
  enviados: Iterable<string>,
): MetaEntreLideres {
  const feitos = new Set(enviados);
  const outros = participantes.filter((p) => p.id !== eu.id);
  const autoavaliacao = feitos.has(eu.id);
  if (eu.papel === "lider" && DIRETORIA_OBRIGATORIA_PARA_LIDERES) {
    const diretores = outros.filter((p) => p.papel === "diretor");
    const avaliados = outros.filter((p) => p.papel === "lider" && feitos.has(p.id)).length;
    const diretoriaAvaliada = diretores.filter((p) => feitos.has(p.id)).length;
    return {
      papel: "lider",
      avaliados,
      minimo: MINIMO_DE_AVALIACOES,
      diretoriaAvaliada,
      diretoriaTotal: diretores.length,
      autoavaliacao,
      cumprida: avaliados >= MINIMO_DE_AVALIACOES && diretoriaAvaliada >= diretores.length && autoavaliacao,
    };
  }
  const avaliados = outros.filter((p) => feitos.has(p.id)).length;
  return {
    papel: eu.papel,
    avaliados,
    minimo: MINIMO_DE_AVALIACOES,
    diretoriaAvaliada: 0,
    diretoriaTotal: 0,
    autoavaliacao,
    cumprida: avaliados >= MINIMO_DE_AVALIACOES && autoavaliacao,
  };
}

/** O que ainda falta, numa frase ("Falta: 1 líder, 1 diretor e a autoavaliação."). "" = cumprida. */
export function oQueFalta(m: MetaEntreLideres): string {
  const partes: string[] = [];
  const faltamAvaliados = Math.max(0, m.minimo - m.avaliados);
  if (faltamAvaliados > 0) {
    const quem = m.papel === "lider"
      ? (faltamAvaliados === 1 ? "líder" : "líderes")
      : (faltamAvaliados === 1 ? "pessoa" : "pessoas");
    partes.push(`${faltamAvaliados} ${quem}`);
  }
  const faltamDiretores = Math.max(0, m.diretoriaTotal - m.diretoriaAvaliada);
  if (faltamDiretores > 0) partes.push(`${faltamDiretores} ${faltamDiretores === 1 ? "diretor" : "diretores"}`);
  if (!m.autoavaliacao) partes.push("a autoavaliação");
  if (partes.length === 0) return "";
  const lista = partes.length === 1 ? partes[0] : `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`;
  return `Falta: ${lista}.`;
}

/** Marca/desmarca uma opção de um grupo respeitando as `exclusivas`. */
export function alternarOpcao(grupo: GrupoOpcoes, marcadas: string[], opcao: string): string[] {
  if (marcadas.includes(opcao)) return marcadas.filter((o) => o !== opcao);
  const exclusivas = grupo.exclusivas ?? [];
  if (exclusivas.includes(opcao)) return [opcao];
  return [...marcadas.filter((o) => !exclusivas.includes(o)), opcao];
}

/** Troca `[NOME]` pelo nome do avaliado. */
export function comNome(texto: string, nome: string): string {
  return texto.split("[NOME]").join(nome);
}

/**
 * Nome curto para o texto das perguntas ("Quando Marisa assume…"): o primeiro nome, ou os
 * dois primeiros quando outro participante tem o mesmo primeiro nome.
 */
export function nomeNaPergunta(nome: string, todosOsNomes: string[]): string {
  const partes = nome.trim().split(/\s+/);
  const primeiro = partes[0] ?? "";
  const repetido = todosOsNomes.filter((n) => n.trim().split(/\s+/)[0] === primeiro).length > 1;
  return repetido && partes.length > 1 ? `${primeiro} ${partes[1]}` : primeiro;
}

/** Opções de uma pergunta de escala ou de escolha única, na ordem da tela. */
export function opcoesDaPergunta(p: PerguntaEscala | PerguntaUnica): string[] {
  return p.tipo === "escala" ? OPCOES_ESCALA[p.escala] : p.opcoes;
}

/**
 * Pontos de 1 a 5 de uma resposta de escala: a 1ª opção vale 5 e a última vale 1 — menos
 * na pergunta INVERTIDA, em que "Sempre resistente" vale 1. Sem isso ela inflaria a média.
 * `null` = resposta que não é da escala (não entra na conta).
 */
export function pontosDaEscala(p: PerguntaEscala, valor: string | undefined | null): number | null {
  if (!valor) return null;
  const i = OPCOES_ESCALA[p.escala].indexOf(valor);
  if (i < 0) return null;
  const pontos = 5 - i;
  return p.invertida ? 6 - pontos : pontos;
}

/** A pergunta está respondida o bastante para seguir? */
export function respostaCompleta(p: PerguntaEntreLideres, r: RespostaQuestao | undefined): boolean {
  if (!r) return false;
  if (p.campoTexto && !(r.texto ?? "").trim()) return false;
  if (p.tipo === "escala" || p.tipo === "unica") {
    return !!r.valor && opcoesDaPergunta(p).includes(r.valor);
  }
  // Múltipla: pelo menos uma marcação válida em CADA grupo (a 9 tem dois).
  return p.grupos.every((g) => (r.marcadas?.[g.id] ?? []).some((o) => g.opcoes.includes(o)));
}

/** As 16 respondidas? É o que a tela exige antes de enviar (e o banco confere as chaves). */
export function avaliacaoCompleta(respostas: RespostasEntreLideres): boolean {
  return PERGUNTAS_ENTRE_LIDERES.every((p) => respostaCompleta(p, respostas[p.id]));
}

/**
 * Deixa na resposta só o que a pergunta conhece: o texto sem espaço sobrando nas pontas,
 * marcações que existem, nada de chave de outro formato. É isso que vai para o banco.
 */
export function limparRespostas(respostas: RespostasEntreLideres): RespostasEntreLideres {
  const limpas: RespostasEntreLideres = {};
  for (const p of PERGUNTAS_ENTRE_LIDERES) {
    const r = respostas[p.id];
    if (!r) continue;
    const limpa: RespostaQuestao = {};
    if (p.tipo === "multipla") {
      limpa.marcadas = {};
      for (const g of p.grupos) {
        limpa.marcadas[g.id] = g.opcoes.filter((o) => (r.marcadas?.[g.id] ?? []).includes(o));
      }
    } else if (r.valor) {
      limpa.valor = r.valor;
    }
    if (p.campoTexto) limpa.texto = (r.texto ?? "").trim();
    limpas[p.id] = limpa;
  }
  return limpas;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Leitura dos resultados (painel da diretoria)
// ─────────────────────────────────────────────────────────────────────────────────────

export interface LinhaResposta {
  avaliador_id: string;
  avaliado_id: string;
  respostas: RespostasEntreLideres;
}

export interface NotaDaPergunta {
  pergunta: PerguntaEscala;
  media: number | null;
  respostas: number;
}

export interface ContagemDeOpcao {
  opcao: string;
  vezes: number;
}

export interface ResumoDoAvaliado {
  /** Quantos colegas avaliaram (sem contar a autoavaliação). */
  avaliacoes: number;
  avaliadores: string[];
  notas: NotaDaPergunta[];
  /** Média de todas as respostas de escala juntas (1 a 5). */
  mediaGeral: number | null;
  /** Pergunta 3: como os colegas veem × como a pessoa se vê. */
  estilo: { contagem: ContagemDeOpcao[]; autoavaliacao: string | null };
  /** Múltipla escolha: quantos marcaram cada opção, por grupo — só as marcadas, da mais para a menos. */
  marcacoes: Record<string, Record<string, ContagemDeOpcao[]>>;
  /** Os textos de cada pergunta, com quem escreveu (a avaliação é identificada). */
  textos: Record<string, { avaliador_id: string; texto: string }[]>;
}

function media(valores: number[]): number | null {
  if (valores.length === 0) return null;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

/** Tudo o que o painel mostra de UMA pessoa avaliada, a partir das linhas do trimestre. */
export function resumoDoAvaliado(linhas: LinhaResposta[], avaliadoId: string): ResumoDoAvaliado {
  const dosColegas = linhas.filter((l) => l.avaliado_id === avaliadoId && l.avaliador_id !== avaliadoId);
  const auto = linhas.find((l) => l.avaliado_id === avaliadoId && l.avaliador_id === avaliadoId);

  const escalas = PERGUNTAS_ENTRE_LIDERES.filter((p): p is PerguntaEscala => p.tipo === "escala");
  const todasAsNotas: number[] = [];
  const notas = escalas.map((p) => {
    const pontos = dosColegas
      .map((l) => pontosDaEscala(p, l.respostas?.[p.id]?.valor))
      .filter((n): n is number => n !== null);
    todasAsNotas.push(...pontos);
    return { pergunta: p, media: media(pontos), respostas: pontos.length };
  });

  const q3 = PERGUNTAS_ENTRE_LIDERES.find((p) => p.id === "q3") as PerguntaUnica;
  const contagemEstilo = q3.opcoes
    .map((opcao) => ({ opcao, vezes: dosColegas.filter((l) => l.respostas?.q3?.valor === opcao).length }))
    .filter((c) => c.vezes > 0)
    .sort((a, b) => b.vezes - a.vezes);
  const autoValor = auto?.respostas?.q3?.valor;

  const marcacoes: ResumoDoAvaliado["marcacoes"] = {};
  for (const p of PERGUNTAS_ENTRE_LIDERES) {
    if (p.tipo !== "multipla") continue;
    marcacoes[p.id] = {};
    for (const g of p.grupos) {
      marcacoes[p.id][g.id] = g.opcoes
        .map((opcao) => ({
          opcao,
          vezes: dosColegas.filter((l) => (l.respostas?.[p.id]?.marcadas?.[g.id] ?? []).includes(opcao)).length,
        }))
        .filter((c) => c.vezes > 0)
        .sort((a, b) => b.vezes - a.vezes);
    }
  }

  const textos: ResumoDoAvaliado["textos"] = {};
  for (const p of PERGUNTAS_ENTRE_LIDERES) {
    if (!p.campoTexto) continue;
    textos[p.id] = dosColegas
      .map((l) => ({ avaliador_id: l.avaliador_id, texto: (l.respostas?.[p.id]?.texto ?? "").trim() }))
      .filter((t) => t.texto);
  }

  return {
    avaliacoes: dosColegas.length,
    avaliadores: dosColegas.map((l) => l.avaliador_id),
    notas,
    mediaGeral: media(todasAsNotas),
    estilo: { contagem: contagemEstilo, autoavaliacao: autoValor && q3.opcoes.includes(autoValor) ? autoValor : null },
    marcacoes,
    textos,
  };
}

export interface ParticipacaoDaPessoa {
  /** Quantos colegas a pessoa avaliou no trimestre (sem a autoavaliação). */
  avaliou: number;
  fezAutoavaliacao: boolean;
  /** Por quantos colegas foi avaliada. */
  recebeu: number;
}

export function participacao(linhas: LinhaResposta[], pessoaId: string): ParticipacaoDaPessoa {
  return {
    avaliou: linhas.filter((l) => l.avaliador_id === pessoaId && l.avaliado_id !== pessoaId).length,
    fezAutoavaliacao: linhas.some((l) => l.avaliador_id === pessoaId && l.avaliado_id === pessoaId),
    recebeu: linhas.filter((l) => l.avaliado_id === pessoaId && l.avaliador_id !== pessoaId).length,
  };
}
