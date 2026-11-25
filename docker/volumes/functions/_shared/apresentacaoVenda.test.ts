import { describe, expect, it } from "vitest";
import {
  BLOCOS,
  MIN_FRASES,
  PERGUNTAS_POR_GRUPO,
  ehBloco,
  listaLimpa,
  montarMaterial,
  normalizarBloco,
  pedidoDoBloco,
  schemaDoBloco,
  textoLimpo,
} from "./apresentacaoVenda";

const pos = {
  nome: "Pós X interna",
  nome_comercial: "Gestão de Pessoas no Agro",
  marca: "PPGVET",
  instituicao: "Faculdade Y",
  formato: "online",
  carga_horaria: 420,
  periodo_total_meses: 14,
  tcc: null,
  produto_tipo: "pos",
};

describe("textoLimpo / listaLimpa", () => {
  it("troca travessão por vírgula e tira marcador de lista", () => {
    expect(textoLimpo("- Liderar equipes — no campo")).toBe("Liderar equipes, no campo");
    expect(textoLimpo("2) Negociar  prazos – com a chefia ")).toBe("Negociar prazos, com a chefia");
  });
  it("tira repetidas sem olhar acento nem pontuação, e vazias", () => {
    expect(listaLimpa(["Você lidera?", "voce lidera", "", "  ", "Outra"], 10)).toEqual(["Você lidera?", "Outra"]);
  });
  it("respeita o máximo", () => {
    expect(listaLimpa(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
});

describe("normalizarBloco", () => {
  it("SPIN: limita a 10 por grupo, tira grupo com menos de 2 e pergunta repetida entre grupos", () => {
    const muitas = Array.from({ length: 14 }, (_, i) => `Pergunta ${i}?`);
    const r = normalizarBloco("spin_situacao", {
      descricao: "Descobrir — onde atua",
      grupos: [
        { contexto: "Função", perguntas: muitas },
        { contexto: "Só uma", perguntas: ["Única?"] },
        { contexto: "Repetidas", perguntas: ["Pergunta 0?", "Pergunta 1?", "Nova A?", "Nova B?"] },
      ],
      lacunas: ["Falta — público"],
    });
    const grupos = r.dados.grupos as { contexto: string; perguntas: string[] }[];
    expect(grupos).toHaveLength(2);
    expect(grupos[0].perguntas).toHaveLength(PERGUNTAS_POR_GRUPO);
    expect(grupos[1]).toEqual({ contexto: "Repetidas", perguntas: ["Nova A?", "Nova B?"] });
    expect(r.dados.descricao).toBe("Descobrir, onde atua");
    expect(r.lacunas).toEqual(["Falta, público"]);
  });

  it("SPIN sem pergunta utilizável é erro (não grava etapa vazia)", () => {
    expect(() => normalizarBloco("spin_problema", { descricao: "x", grupos: [], lacunas: [] })).toThrow(/perguntas/);
  });

  it("habilidades: exige 5 e corta o excesso", () => {
    expect(() => normalizarBloco("habilidades", { itens: ["a", "b", "c"], lacunas: [] })).toThrow(/5/);
    const r = normalizarBloco("habilidades", { itens: ["a", "b", "c", "d", "e", "f"], lacunas: [] });
    expect(r.dados.itens).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("técnicas: tira área sem nome ou sem itens e põe rótulos padrão", () => {
    const r = normalizarBloco("tecnicas", {
      eyebrow: "",
      titulo: "",
      nota: "",
      categorias: [{ nome: "Liderança", itens: ["Feedback", "Feedback"] }, { nome: "", itens: ["x"] }, { nome: "Vazia", itens: [] }],
      lacunas: [],
    });
    expect(r.dados).toEqual({
      eyebrow: "Conteúdo da pós",
      titulo: "temas abordados",
      nota: "",
      categorias: [{ nome: "Liderança", itens: ["Feedback"] }],
    });
  });

  it(`frases: menos de ${MIN_FRASES} é erro`, () => {
    expect(() => normalizarBloco("frases", { itens: ["uma"], lacunas: [] })).toThrow(/frases/);
    const itens = Array.from({ length: 20 }, (_, i) => `Frase número ${i}.`);
    expect(normalizarBloco("frases", { itens, lacunas: [] }).dados.itens).toHaveLength(20);
  });

  it("resposta torta (null, string) vira erro claro, não exceção de tipo", () => {
    expect(() => normalizarBloco("frases", null)).toThrow(/frases/);
    expect(() => normalizarBloco("tecnicas", "texto")).toThrow(/áreas/);
  });
});

describe("schema e pedido", () => {
  it("todo bloco tem schema fechado (additionalProperties false) e lacunas obrigatórias", () => {
    for (const b of BLOCOS) {
      const s = schemaDoBloco(b) as { additionalProperties: boolean; required: string[] };
      expect(s.additionalProperties).toBe(false);
      expect(s.required).toContain("lacunas");
    }
  });
  it("o pedido leva o material e o nome da pós", () => {
    const p = pedidoDoBloco("spin_implicacao", "## Grade\n- Aula A", "Pós Z");
    expect(p).toContain('MATERIAL da pós "Pós Z"');
    expect(p).toContain("- Aula A");
    expect(p).toContain("Implicação");
  });
  it("ehBloco aceita só os 7 nomes", () => {
    expect(ehBloco("frases")).toBe(true);
    expect(ehBloco("preco")).toBe(false);
    expect(ehBloco(undefined)).toBe(false);
  });
});

describe("montarMaterial", () => {
  it("junta cadastro, grade por módulo (sem pré-abertura), extras, professores e ficha", () => {
    const txt = montarMaterial(
      pos,
      [
        { modulo_numero: 1, modulo_nome: "Liderança", tipo_modulo: "ao_vivo", aula_titulo: "Aula de pré-abertura", titulo: null, ementa: null },
        { modulo_numero: 1, modulo_nome: "Liderança", tipo_modulo: "ao_vivo", aula_titulo: "Feedback", titulo: "Parte 1", ementa: "Como dar feedback" },
        { modulo_numero: 1, modulo_nome: "Liderança", tipo_modulo: "ao_vivo", aula_titulo: "Feedback", titulo: "Parte 2", ementa: "Como dar feedback" },
        { modulo_numero: 2, modulo_nome: "Negociação", tipo_modulo: "gravado", aula_titulo: null, titulo: "Negociar com o produtor", ementa: null },
      ],
      [{ titulo: "Live extra", ementa: "Bate-papo" }],
      [{ nome: "Ana", titulacao: "Dra.", area_expertise: "Gestão", especialidades: ["RH"], mini_bio: "Bio da Ana", coordenador: true }],
      { pains: [{ title: "Dor" }] },
    );
    expect(txt).toContain("# Pós-graduação: Gestão de Pessoas no Agro");
    expect(txt).toContain("Carga horária: 420 h");
    expect(txt).toContain("### Módulo 1: Liderança (ao_vivo)");
    expect(txt).toContain("- Feedback: Parte 1 | Como dar feedback | Parte 2");
    expect(txt).not.toMatch(/pré-abertura/i);
    expect(txt).toContain("- Negociar com o produtor");
    expect(txt).toContain("- Live extra: Bate-papo");
    expect(txt).toContain("- Ana (coordenador(a); Dra.; Gestão; RH): Bio da Ana");
    expect(txt).toContain("Ficha de venda já cadastrada");
  });

  it("leva público-alvo e lead qualificado do Pedagógico, com as quebras de linha", () => {
    const txt = montarMaterial(
      { ...pos, publico_alvo: "  Veterinários   de granja\n\n  Zootecnistas ", lead_qualificado: "Formado na área" },
      [], [], [], null,
    );
    expect(txt).toContain("## Público-alvo (escrito pelo Pedagógico)\nVeterinários de granja\nZootecnistas");
    expect(txt).toContain("## Lead qualificado (escrito pelo Pedagógico)\nFormado na área");
    expect(montarMaterial({ ...pos, publico_alvo: "   ", lead_qualificado: null }, [], [], [], null)).not.toMatch(/Público-alvo|Lead qualificado/);
  });

  it("tira o rótulo interno «PÓS |» do nome (a IA copiava para as frases)", () => {
    const txt = montarMaterial({ ...pos, nome_comercial: "PÓS | PISCICULTURA E PRODUÇÃO DE TILÁPIA" }, [], [], [], null);
    expect(txt.split("\n")[0]).toBe("# Pós-graduação: PISCICULTURA E PRODUÇÃO DE TILÁPIA");
  });
});
