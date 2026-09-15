import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { SCHEMA_ASSUNTOS_EMAIL_IA, validarSugestoesAssuntoEmailIA } from "./aiAssuntos.ts";

const opcoes = () => ({ sugestoes: [
  { estilo: "direto", assunto: "Conheça nossa formação", preheader: "Veja os detalhes do curso e os próximos passos." },
  { estilo: "informativo", assunto: "Informações sobre a formação", preheader: "Conteúdo, público e formato para planejar seus estudos." },
  { estilo: "persuasivo", assunto: "Seu próximo passo na veterinária", preheader: "Explore uma formação que combina com seus objetivos." },
] });

describe("três opções de assunto e preheader sem documento", () => {
  it("schema dos provedores só aceita opções de cabeçalho, nunca documento ou layout", () => {
    const validar = new Ajv({ strict: true }).compile(SCHEMA_ASSUNTOS_EMAIL_IA);
    expect(validar(opcoes())).toBe(true);
    expect(validar({ ...opcoes(), documento: {} })).toBe(false);
    expect(validar({ documento: {} })).toBe(false);
    const extras = opcoes(); Object.assign(extras.sugestoes[0], { blocos: [] });
    expect(validar(extras)).toBe(false);
  });
  it("normaliza a ordem e aceita avisos comerciais calculados pela edge", () => {
    const valor = opcoes(); valor.sugestoes.reverse();
    Object.assign(valor.sugestoes[0], { revisao_comercial: [{ tipo: "promessa", trecho: "Emprego garantido", motivo: "Confira a comprovação." }] });
    const resultado = validarSugestoesAssuntoEmailIA(valor);
    expect(resultado.sugestoes.map(s => s.estilo)).toEqual(["direto", "informativo", "persuasivo"]);
    expect(resultado.sugestoes[0].revisao_comercial).toEqual([]);
    expect(resultado.sugestoes[2].revisao_comercial).toHaveLength(1);
  });
  it.each([0, 1, 2, 4])("exige três opções e recusa %s", quantidade => {
    const valor = opcoes(); valor.sugestoes = Array.from({ length: quantidade }, (_, i) => valor.sugestoes[i % 3]);
    expect(() => validarSugestoesAssuntoEmailIA(valor)).toThrow();
  });
  it.each([
    { assunto: "" }, { assunto: "a".repeat(201) }, { preheader: "a".repeat(251) },
    { assunto: "Oferta\r\nBcc: outro@exemplo.test" }, { preheader: "<script>alert(1)</script>" },
    { estilo: "agressivo" }, { documento: {} },
    { revisao_comercial: [{ tipo: "privado", trecho: "x", motivo: "x" }] },
  ])("recusa texto inseguro ou opção fora do contrato", invalida => {
    const valor = opcoes(); Object.assign(valor.sugestoes[0], invalida);
    expect(() => validarSugestoesAssuntoEmailIA(valor)).toThrow();
  });
  it("recusa estilos ou assuntos repetidos", () => {
    const estilos = opcoes(); estilos.sugestoes[1].estilo = estilos.sugestoes[0].estilo;
    expect(() => validarSugestoesAssuntoEmailIA(estilos)).toThrow();
    const assuntos = opcoes(); assuntos.sugestoes[1].assunto = assuntos.sugestoes[0].assunto.toUpperCase();
    expect(() => validarSugestoesAssuntoEmailIA(assuntos)).toThrow();
  });
});
