import { describe, expect, it } from "vitest";
import { pontosClima, resumoDaEquipe, type PerguntaDaEquipe } from "./resumoEquipeDoLider.ts";

const perguntas: PerguntaDaEquipe[] = [
  { chave: "l1", bloco: "Clareza e Simplicidade", texto: "Meu líder comunica com clareza…", tipo: "scale-freq" },
  { chave: "l2", bloco: "Clareza e Simplicidade", texto: "As tarefas são simples…", tipo: "scale-conc" },
  { chave: "l5", bloco: "Feedback e Desenvolvimento", texto: "Meu líder me dá feedbacks…", tipo: "scale-freq" },
  { chave: "l13", bloco: "Perguntas Abertas", texto: "Qual é o principal ponto forte do seu líder?", tipo: "text" },
];

describe("pontos da escala do clima", () => {
  it("1ª opção vale 5, última vale 1, fora da escala não conta", () => {
    expect(pontosClima("Sempre", "scale-freq")).toBe(5);
    expect(pontosClima("Nunca", "scale-freq")).toBe(1);
    expect(pontosClima("Neutro", "scale-conc")).toBe(3);
    expect(pontosClima("Neutro", "scale-freq")).toBeNull();
    expect(pontosClima(7, "numeric")).toBeNull();
  });
});

describe("resumo do que a equipe disse", () => {
  const r = resumoDaEquipe(perguntas, [
    { l1: "Sempre", l2: "Concordo", l5: "Às vezes", l13: "  Escuta o time.  " },
    { l1: "Raramente", l2: "Discordo totalmente", l5: "Nunca", l13: "" },
  ]);

  it("conta as respostas e faz a média geral só com a escala", () => {
    expect(r.respostas).toBe(2);
    // l1: 5, 2 · l2: 4, 1 · l5: 3, 1 → 16/6
    expect(r.mediaGeral).toBeCloseTo(16 / 6, 10);
  });

  it("média por bloco e por pergunta, com a distribuição na ordem da escala", () => {
    expect(r.blocos).toEqual([
      { bloco: "Clareza e Simplicidade", media: (5 + 2 + 4 + 1) / 4, respostas: 4 },
      { bloco: "Feedback e Desenvolvimento", media: 2, respostas: 2 },
    ]);
    const l1 = r.perguntas.find((p) => p.pergunta.chave === "l1");
    expect(l1?.media).toBe(3.5);
    expect(l1?.distribuicao.map((d) => d.vezes)).toEqual([1, 0, 0, 1, 0]);
  });

  it("textos abertos sem autor, aparados, sem os vazios", () => {
    expect(r.textos).toEqual([{ pergunta: perguntas[3], textos: ["Escuta o time."] }]);
  });

  it("sem resposta: médias vazias, não zero", () => {
    const vazio = resumoDaEquipe(perguntas, []);
    expect(vazio.mediaGeral).toBeNull();
    expect(vazio.blocos.every((b) => b.media === null)).toBe(true);
  });
});


describe('anonimato: textos fora da ordem de chegada (28/09/2026)', () => {
  const qs: PerguntaDaEquipe[] = [
    { chave: 'l13', bloco: 'Abertas', texto: 'Ponto forte?', tipo: 'text' },
    { chave: 'l14', bloco: 'Abertas', texto: 'A desenvolver?', tipo: 'text' },
  ];
  // Quem respondeu PRIMEIRO escreveu 'Zeta' e 'Alfa'; o segundo, 'Beta' e 'Ômega'.
  const r = resumoDaEquipe(qs, [{ l13: 'Zeta', l14: 'Alfa' }, { l13: 'Beta', l14: 'Ômega' }]);
  it('cada pergunta em ordem alfabética, independente das outras', () => {
    expect(r.textos[0].textos).toEqual(['Beta', 'Zeta']);
    expect(r.textos[1].textos).toEqual(['Alfa', 'Ômega']);
  });
  it('a 1ª posição já não junta as falas da mesma pessoa', () => {
    expect([r.textos[0].textos[0], r.textos[1].textos[0]]).not.toEqual(['Zeta', 'Alfa']);
  });
});
