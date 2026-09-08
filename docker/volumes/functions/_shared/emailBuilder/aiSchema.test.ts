import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { EXEMPLO_RESULTADO_EMAIL_IA, SCHEMA_RESULTADO_EMAIL_IA } from "./aiSchema.ts";
import { validarDocumentoIA } from "./ai.ts";
import { compilarDocumento } from "./compile.ts";

const validarSchema = new Ajv({ allErrors: true, strict: true }).compile(SCHEMA_RESULTADO_EMAIL_IA);

function proposta(blocos: unknown[]) {
  const exemplo = structuredClone(EXEMPLO_RESULTADO_EMAIL_IA);
  const linha = exemplo.documento.linhas[0];
  return {
    ...exemplo,
    documento: { ...exemplo.documento, linhas: [{ ...linha, colunas: [{ ...linha.colunas[0], blocos }] }] },
  };
}

const bloco = (tipo: string, props: unknown, estilo = {}, estiloMobile = {}) => ({ tipo, props, estilo, estiloMobile });

describe("schema de saída estruturada do editor de e-mails", () => {
  it("valida o exemplo completo no AJV, no contrato de segurança e no compilador", () => {
    expect(validarSchema(EXEMPLO_RESULTADO_EMAIL_IA), JSON.stringify(validarSchema.errors)).toBe(true);
    const documento = validarDocumentoIA(EXEMPLO_RESULTADO_EMAIL_IA.documento);
    const { html } = compilarDocumento(documento);
    expect(html).toContain("Conhecimento para o seu próximo passo");
    expect(html).toContain("font-size:26px!important");
    expect(html).toContain("{{descadastro_url}}");
    expect(documento.linhas[0].colunas[0].blocos).toHaveLength(3);
  });

  it.each([
    bloco("texto", { texto: "Conheça nossas formações" }),
    bloco("botao", { texto: "Conhecer", href: "https://example.com/curso", alvo: "_blank" }),
    bloco("link", { texto: "Descadastrar", href: "{{descadastro_url}}", alvo: "_blank" }),
    bloco("lista", { itens: ["Conhecimento aplicado", "Novas perspectivas"], ordenada: false }),
    bloco("imagem", { src: "https://example.com/hero.webp", alt: "Formação" }),
    bloco("imagem-link", { src: "https://example.com/hero.jpg", alt: "Formação", href: "https://example.com/curso", alvo: "_self" }),
    bloco("video", { thumbnail: "https://example.com/video.png", alt: "Apresentação", texto: "Assistir", href: "https://example.com/video", alvo: "_blank" }),
    bloco("separador", { espessura: 1 }),
    bloco("espacador", { altura: 24 }),
  ])("aceita variante $tipo com props próprias e estilos vazios", item => {
    const resultado = proposta([item]);
    expect(validarSchema(resultado), JSON.stringify(validarSchema.errors)).toBe(true);
    expect(() => validarDocumentoIA(resultado.documento)).not.toThrow();
  });

  it.each([
    { resumo: "Pronto", documento: {} },
    { resumo: "Pronto", documento: JSON.stringify(EXEMPLO_RESULTADO_EMAIL_IA.documento) },
    { resumo: "Pronto", documento: null },
    { resumo: "Pronto", documento: [] },
    { ...EXEMPLO_RESULTADO_EMAIL_IA, documento: { ...EXEMPLO_RESULTADO_EMAIL_IA.documento, linhas: [] } },
  ])("não aceita documento vazio, serializado ou sem linhas", resultado => {
    expect(validarSchema(resultado)).toBe(false);
  });

  it.each([
    bloco("texto", { texto: "Texto", html: "<script>alert(1)</script>" }),
    bloco("html", { html: "<strong>Mensagem</strong>" }),
    bloco("texto-composto", { html: "<b>Mensagem</b>" }),
    bloco("texto-dinamico", { variavel: "contato.nome" }),
    bloco("texto", { texto: "Texto" }, { padding: 24 }),
    bloco("texto", { texto: "Texto" }, { fontSize: "24px" }),
    bloco("texto", { texto: "Texto" }, { tamanhoFonte: "24" }),
    bloco("texto", { texto: "Texto" }, { largura: "expression(alert(1))" }),
    bloco("texto", { texto: "Texto" }, {}, { fonte: "Arial; color:red" }),
  ])("rejeita tipo, campo ou estilo fora da allowlist", item => {
    expect(validarSchema(proposta([item]))).toBe(false);
  });

  it("exige objetos de estilo explícitos, sem forçar overrides", () => {
    const permitido = proposta([bloco("texto", { texto: "Texto" })]);
    expect(validarSchema(permitido)).toBe(true);
    const incompleto = proposta([{ tipo: "texto", props: { texto: "Texto" } }]);
    expect(validarSchema(incompleto)).toBe(false);
    const nulo = proposta([{ tipo: "texto", props: { texto: "Texto" }, estilo: null, estiloMobile: {} }]);
    expect(validarSchema(nulo)).toBe(false);
  });

  it("mantém a segunda validação obrigatória para URL, CSS e limites semânticos", () => {
    const casos = [
      proposta([bloco("botao", { texto: "Abrir", href: "javascript:alert(1)", alvo: "_blank" })]),
      proposta([bloco("texto", { texto: "Texto" }, { corTexto: '#fff;"><script>alert(1)</script>' })]),
      proposta([bloco("imagem", { src: "data:image/svg+xml,<svg onload=alert(1)>", alt: "Imagem" })]),
      proposta([bloco("texto", { texto: "a".repeat(4001) })]),
    ];
    for (const resultado of casos) {
      // Restrições semânticas não suportadas nos dois provedores ficam no código,
      // nunca confiamos em um JSON apenas por ele obedecer ao schema da geração.
      expect(validarSchema(resultado)).toBe(true);
      expect(() => validarDocumentoIA(resultado.documento)).toThrow();
    }
  });

  it.each([
    bloco("botao", { texto: "Falar com a equipe" }),
    bloco("separador", { texto: "Outro texto" }),
    bloco("texto", { href: "https://example.com", texto: "Conhecer" }),
    bloco("imagem", { thumbnail: "https://example.com/video.jpg", alt: "Imagem" }),
  ])("correlaciona tipo e props no validador final, sem expandir a gramática", item => {
    const resultado = proposta([item]);
    expect(validarSchema(resultado)).toBe(true);
    expect(() => validarDocumentoIA(resultado.documento)).toThrow();
  });

  it("documenta placeholder # do CTA e exige fontes somente nos globais", () => {
    const resultado = proposta([bloco("botao", { texto: "Conhecer", href: "#" })]);
    expect(validarSchema(resultado)).toBe(true);
    expect(JSON.stringify(SCHEMA_RESULTADO_EMAIL_IA)).toContain("use exatamente #");
    expect(validarSchema(proposta([bloco("texto", { texto: "Texto" }, { fonte: "Arial" })]))).toBe(false);
  });

  it("fecha todos os objetos e usa apenas o subconjunto comum sem recursão", () => {
    let opcionais = 0;
    let unioes = 0;
    const permitidas = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "minItems", "enum", "$ref", "$defs"]);
    function visitar(schema: Record<string, unknown>) {
      for (const chave of Object.keys(schema)) expect(permitidas.has(chave), chave).toBe(true);
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        const propriedades = schema.properties as Record<string, Record<string, unknown>>;
        const obrigatorias = schema.required as string[];
        opcionais += Object.keys(propriedades).filter(c => !obrigatorias.includes(c)).length;
        Object.values(propriedades).forEach(visitar);
      }
      if (schema.anyOf) { unioes++; (schema.anyOf as Record<string, unknown>[]).forEach(visitar); }
      if (schema.items) visitar(schema.items as Record<string, unknown>);
      if (schema.$ref) {
        expect(Object.keys(schema)).toEqual(["$ref"]);
        expect(String(schema.$ref)).toMatch(/^#\/\$defs\/[a-z_]+$/);
      }
      if (schema.$defs) Object.values(schema.$defs as Record<string, Record<string, unknown>>).forEach(visitar);
    }
    visitar(SCHEMA_RESULTADO_EMAIL_IA as Record<string, unknown>);
    expect(opcionais).toBe(19);
    expect(opcionais).toBeLessThanOrEqual(24);
    expect(unioes).toBe(0);
    expect(JSON.stringify(SCHEMA_RESULTADO_EMAIL_IA).length).toBeLessThan(16000);

    function semCiclo(schema: Record<string, unknown>, caminho: string[] = []) {
      if (schema.$ref) {
        const nome = String(schema.$ref).split("/").at(-1)!;
        expect(caminho).not.toContain(nome);
        const alvo = SCHEMA_RESULTADO_EMAIL_IA.$defs?.[nome];
        expect(alvo).toBeTruthy();
        semCiclo(alvo as Record<string, unknown>, [...caminho, nome]);
      }
      if (schema.properties) Object.values(schema.properties as Record<string, Record<string, unknown>>).forEach(s => semCiclo(s, caminho));
      if (schema.items) semCiclo(schema.items as Record<string, unknown>, caminho);
      if (schema.anyOf) (schema.anyOf as Record<string, unknown>[]).forEach(s => semCiclo(s, caminho));
    }
    semCiclo(SCHEMA_RESULTADO_EMAIL_IA as Record<string, unknown>);
  });
});
