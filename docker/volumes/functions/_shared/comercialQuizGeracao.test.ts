import { describe, expect, it } from "vitest";
import {
  MAX_LOTES,
  aprovadasNaCega,
  escolherPrograma,
  estadoDepoisDoLote,
  fichaSemVisual,
  motivoParaPular,
  normalizarQuestoes,
  tamanhoDoLote,
  type Candidato,
  type ConfigQuiz,
} from "./comercialQuizGeracao.ts";

const agora = new Date("2026-11-10T12:00:00Z");
const minAtras = (m: number) => new Date(agora.getTime() - m * 60_000).toISOString();

function cfg(p: Partial<ConfigQuiz>): ConfigQuiz {
  return {
    origem: "automatico",
    ativo: false,
    geracao_status: "parcial",
    geracao_tentada_em: minAtras(30),
    geracao_lotes: 1,
    ativado_auto_em: null,
    ...p,
  };
}
function cand(programId: string, config: ConfigQuiz | null, fichaAtualizadaEm: string | null = minAtras(60 * 24 * 30)): Candidato {
  return { programId, slug: programId, nome: programId, fichaAtualizadaEm, config };
}

describe("motivoParaPular", () => {
  it("pós sem config entra na fila", () => {
    expect(motivoParaPular(cand("x", null), agora)).toBeNull();
  });
  it("NUNCA mexe em quiz feito à mão, nem forçado", () => {
    expect(motivoParaPular(cand("x", cfg({ origem: "manual", geracao_status: null })), agora, true)).toMatch(/à mão/);
  });
  it("rodada em curso trava; morta há mais de 15 min é retomada", () => {
    expect(motivoParaPular(cand("x", cfg({ geracao_status: "gerando", geracao_tentada_em: minAtras(5) })), agora)).not.toBeNull();
    expect(motivoParaPular(cand("x", cfg({ geracao_status: "gerando", geracao_tentada_em: minAtras(20) })), agora)).toBeNull();
  });
  it("sem_conteudo espera a ficha mudar (ou 1 dia)", () => {
    const c = cfg({ geracao_status: "sem_conteudo", geracao_tentada_em: minAtras(60) });
    expect(motivoParaPular(cand("x", c, minAtras(120)), agora)).not.toBeNull();
    expect(motivoParaPular(cand("x", c, minAtras(10)), agora)).toBeNull();
    expect(motivoParaPular(cand("x", cfg({ geracao_status: "sem_conteudo", geracao_tentada_em: minAtras(60 * 25) }), minAtras(60 * 48)), agora)).toBeNull();
  });
  it("erro tenta de novo depois de 1 h; esgotou lotes só com ficha nova", () => {
    expect(motivoParaPular(cand("x", cfg({ geracao_status: "erro", geracao_tentada_em: minAtras(30) })), agora)).not.toBeNull();
    expect(motivoParaPular(cand("x", cfg({ geracao_status: "erro", geracao_tentada_em: minAtras(61) })), agora)).toBeNull();
    const esgotou = cfg({ geracao_status: "erro", geracao_tentada_em: minAtras(600), geracao_lotes: MAX_LOTES });
    expect(motivoParaPular(cand("x", esgotou, minAtras(700)), agora)).not.toBeNull();
    expect(motivoParaPular(cand("x", esgotou, minAtras(5)), agora)).toBeNull();
  });
  it("pronto sai da fila", () => {
    expect(motivoParaPular(cand("x", cfg({ geracao_status: "pronto" })), agora)).not.toBeNull();
  });
});

describe("escolherPrograma", () => {
  it("nova primeiro, depois a tentada há mais tempo; ignora manual", () => {
    const lista = [
      cand("manual", cfg({ origem: "manual", geracao_status: null })),
      cand("velha", cfg({ geracao_tentada_em: minAtras(90) })),
      cand("recente", cfg({ geracao_tentada_em: minAtras(20) })),
      cand("nova", null),
    ];
    expect(escolherPrograma(lista, agora)?.programId).toBe("nova");
    expect(escolherPrograma(lista.slice(0, 3), agora)?.programId).toBe("velha");
    expect(escolherPrograma(lista.slice(0, 1), agora)).toBeNull();
  });
});

describe("normalizarQuestoes", () => {
  const semMistura = <T,>(xs: T[]) => [...xs].reverse();
  const boa = { pergunta: "Qual é o público da pós em X?", opcoes: ["A1", "B1", "C1", "D1"], correta: 0, explicacao: "Porque sim.", categoria: "Produto" };
  it("embaralha e acompanha o gabarito", () => {
    const [q] = normalizarQuestoes([boa], [], semMistura);
    expect(q.options.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
    expect(q.options.find((o) => o.id === q.correct_option_id)?.text).toBe("A1");
    expect(q.correct_option_id).toBe("d");
  });
  it("descarta forma ruim, repetida e já existente; categoria estranha vira Produto", () => {
    const r = normalizarQuestoes(
      [
        { ...boa, opcoes: ["a", "b", "c"] },
        { ...boa, opcoes: ["a", "a", "c", "d"] },
        { ...boa, correta: 4 },
        { ...boa, pergunta: "curta" },
        { ...boa, pergunta: "Já existe esta pergunta, né?" },
        { ...boa, categoria: "Outra" },
        { ...boa },
      ],
      ["JÁ existe esta pergunta né"],
      semMistura,
    );
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe("Produto");
  });
});

describe("aprovadasNaCega", () => {
  it("fica só a que a resposta cega acertou", () => {
    const q = (id: string) => ({ question: "pergunta " + id, category: "Produto" as const, options: [], correct_option_id: id, explanation: "" });
    const { aprovadas, reprovadas } = aprovadasNaCega([q("a"), q("b"), q("c")], [
      { n: 1, alternativa: "a" },
      { n: 2, alternativa: "nenhuma" },
      { n: 3, alternativa: "d" },
    ]);
    expect(aprovadas.map((x) => x.correct_option_id)).toEqual(["a"]);
    expect(reprovadas).toBe(2);
  });
});

describe("estadoDepoisDoLote", () => {
  it("liga a aba com 40, uma vez só; pronto com 100", () => {
    expect(estadoDepoisDoLote(39, 2, null)).toMatchObject({ status: "parcial", ligar: false });
    expect(estadoDepoisDoLote(40, 3, null)).toMatchObject({ status: "parcial", ligar: true });
    expect(estadoDepoisDoLote(60, 4, "2026-11-10T00:00:00Z")).toMatchObject({ ligar: false });
    expect(estadoDepoisDoLote(100, 6, "x")).toMatchObject({ status: "pronto" });
  });
  it("teto de lotes: pronto se passou de 40, erro se não", () => {
    expect(estadoDepoisDoLote(70, MAX_LOTES, "x").status).toBe("pronto");
    expect(estadoDepoisDoLote(20, MAX_LOTES, null)).toMatchObject({ status: "erro", ligar: false });
  });
});

describe("auxiliares", () => {
  it("ficha sem campos visuais nem vazios", () => {
    expect(fichaSemVisual({ id: "x", accentBg: "#fff", areaIcon: "🐄", pains: [], title: "T", tagline: "" })).toEqual({ title: "T" });
  });
  it("lote entre 5 e 20", () => {
    expect(tamanhoDoLote(0)).toBe(20);
    expect(tamanhoDoLote(90)).toBe(15);
    expect(tamanhoDoLote(99)).toBe(6);
    expect(tamanhoDoLote(100)).toBe(5);
  });
});
