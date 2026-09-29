import { describe, expect, it } from "vitest";
import { dadosParaIA, validarAnalise } from "./analiseLider.ts";
import { OPCOES_ESCALA, PERGUNTAS_ENTRE_LIDERES, resumoDoAvaliado, type RespostasEntreLideres } from "./avaliacaoEntreLideres.ts";
import { resumoDaEquipe } from "./resumoEquipeDoLider.ts";

function completa(texto: string): RespostasEntreLideres {
  const r: RespostasEntreLideres = {};
  for (const p of PERGUNTAS_ENTRE_LIDERES) {
    if (p.tipo === "escala") r[p.id] = { valor: OPCOES_ESCALA[p.escala][1] };
    if (p.tipo === "unica") r[p.id] = { valor: p.opcoes[0] };
    if (p.tipo === "multipla") r[p.id] = { marcadas: Object.fromEntries(p.grupos.map((g) => [g.id, [g.opcoes[0]]])) };
    if (p.campoTexto) r[p.id] = { ...r[p.id], texto };
  }
  return r;
}

describe("dados que vão para a IA", () => {
  const linhas = [
    { avaliador_id: "jose-uuid", avaliado_id: "m", respostas: completa("Segura decisões demais.") },
    { avaliador_id: "rafael-uuid", avaliado_id: "m", respostas: completa("Entrega no prazo.") },
    { avaliador_id: "m", avaliado_id: "m", respostas: { q3: { valor: "Dá a meta e deixa o time escolher o caminho" } } },
  ];
  const equipe = resumoDaEquipe(
    [
      { chave: "l1", bloco: "Clareza", texto: "Meu líder comunica com clareza.", tipo: "scale-freq" },
      { chave: "l13", bloco: "Abertas", texto: "Principal ponto forte?", tipo: "text" },
    ],
    [{ l1: "Sempre", l13: "Paciência" }],
  );
  const texto = dadosParaIA({
    nome: "Marisa",
    trimestre: "2026-Q3",
    equipe,
    entreLideres: resumoDoAvaliado(linhas, "m"),
    papelDoAvaliador: { "jose-uuid": "lider", "rafael-uuid": "diretor" },
  });

  it("não leva o nome nem o id de quem escreveu — só o papel", () => {
    expect(texto).not.toContain("jose-uuid");
    expect(texto).not.toContain("rafael-uuid");
    expect(texto).toContain('(líder) "Segura decisões demais."');
    expect(texto).toContain('(diretoria) "Entrega no prazo."');
    expect(texto).toContain("2 (1 de líderes, 1 da diretoria)");
  });

  it("traz a equipe, a autoavaliação e o nome no lugar de [NOME]", () => {
    expect(texto).toContain("Respostas: 1. Média geral: 5,00.");
    expect(texto).toContain('"Paciência"');
    expect(texto).toContain('"Dá a meta e deixa o time escolher o caminho"');
    expect(texto).toContain("Quando Marisa assume um compromisso comigo");
    expect(texto).not.toContain("[NOME]");
  });

  it("avisa quando uma das fontes está vazia", () => {
    const vazio = dadosParaIA({
      nome: "Laura",
      trimestre: "2026-Q3",
      equipe: null,
      entreLideres: resumoDoAvaliado([], "l"),
      papelDoAvaliador: {},
    });
    expect(vazio).toContain("Nenhuma resposta da equipe neste trimestre.");
    expect(vazio).toContain("Nenhuma avaliação de pares ou da diretoria neste trimestre.");
    expect(vazio).toContain("Não respondeu a autoavaliação");
  });
});

describe("validação do que a IA devolve", () => {
  const ok = {
    resumo: "Retrato.",
    pontos_fortes: [" Prazo "],
    pontos_de_atencao: ["Centraliza"],
    como_se_ve_x_como_e_visto: "Se vê delegando.",
    recomendacoes: ["Delegar uma decisão por semana"],
  };

  it("aceita o formato e apara os textos", () => {
    expect(validarAnalise(ok)?.pontos_fortes).toEqual(["Prazo"]);
  });

  it("recusa o que veio fora do formato", () => {
    expect(validarAnalise(null)).toBeNull();
    expect(validarAnalise({ ...ok, resumo: "" })).toBeNull();
    expect(validarAnalise({ ...ok, recomendacoes: "fazer x" })).toBeNull();
  });
});


describe('validarAnalise — análise incompleta (28/09/2026)', () => {
  const base = { resumo: 'Resumo.', pontos_fortes: ['A'], pontos_de_atencao: ['B'], como_se_ve_x_como_e_visto: 'C', recomendacoes: ['D'] };
  it('lista vazia é recusada (a edge pede de novo em vez de salvar)', () => {
    expect(validarAnalise({ ...base, recomendacoes: [] })).toBeNull();
    expect(validarAnalise({ ...base, pontos_fortes: ['  '] })).toBeNull();
    expect(validarAnalise({ ...base, pontos_de_atencao: [] })).toBeNull();
  });
  it('tira o resto de JSON grudado no fim de um texto', () => {
    const r = validarAnalise({ ...base, como_se_ve_x_como_e_visto: 'Trate como hipótese, não como fato fechado.]}' });
    expect(r?.como_se_ve_x_como_e_visto).toBe('Trate como hipótese, não como fato fechado.');
  });
});
