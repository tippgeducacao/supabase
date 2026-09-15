import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { docVazio, type DocumentoEmail } from "./types.ts";
import { aplicarAlteracaoEmailIA, orientacaoVisualEmailIA, revisarComercialEmailIA, validarAlteracaoEmailIA, validarDocumentoContextoEmailIA, validarRespostaEmailIA } from "./aiEdicao.ts";
import { schemaAjusteEmailIA } from "./aiSchema.ts";

const base = (): DocumentoEmail => ({
  ...docVazio("Mensagem existente"), assunto: "Assunto preservado", preheader: "Prévia preservada", cssCustomizado: ".legado{color:#333}",
  linhas: [
    { id: "abertura", nome: "Abertura", colunas: [{ id: "coluna-abertura", larguraPct: 100, blocos: [
      { id: "titulo", tipo: "texto", props: { texto: "Título anterior" }, estilo: { tamanhoFonte: 30 }, estiloMobile: { tamanhoFonte: 24 } },
      { id: "html-legado", tipo: "html", props: { html: "<p>Conteúdo que já existia</p>" } },
    ] }] },
    { id: "rodape", colunas: [{ id: "coluna-rodape", larguraPct: 100, blocos: [
      { id: "descadastro", tipo: "link", props: { texto: "Descadastrar", href: "{{descadastro_url}}" } },
    ] }] },
  ],
});
const bloco = { tipo: "texto", props: { texto: "Novo título" }, estilo: { tamanhoFonte: 32 }, estiloMobile: { tamanhoFonte: 26 } };
const linha = { nome: "Benefícios", empilharMobile: true, estilo: { padding: { topo: 0, direita: 0, baixo: 0, esquerda: 0 } }, colunas: [{ larguraPct: 100, estilo: { padding: { topo: 0, direita: 0, baixo: 0, esquerda: 0 } }, alinhamentoVertical: "top", blocos: [bloco] }] };
const cores = { corFundo: "#fff", corFundoPagina: "#eee", corTexto: "#111", corLink: "#70f" };

describe("ajustes localizados sem perda do documento existente", () => {
  it("troca um bloco preservando IDs, irmão legado, demais linhas e metadados", () => {
    const original = base(); const copia = structuredClone(original);
    const alteracao = validarAlteracaoEmailIA({ tipo: "bloco", alvo_id: "titulo", bloco }, original);
    const doc = aplicarAlteracaoEmailIA(original, alteracao);
    expect(doc.linhas[0].colunas[0].blocos[0]).toMatchObject({ id: "titulo", props: { texto: "Novo título" } });
    expect(doc.linhas[0].colunas[0].blocos[1]).toBe(original.linhas[0].colunas[0].blocos[1]);
    expect(doc.linhas[1]).toBe(original.linhas[1]);
    expect(doc.globais).toBe(original.globais);
    expect(doc.assunto).toBe(original.assunto);
    expect(doc.cssCustomizado).toBe(original.cssCustomizado);
    expect(original).toEqual(copia);
  });
  it("troca somente a linha escolhida e cria IDs sem colisão", () => {
    const original = base(); original.linhas[1].colunas[0].blocos[0].id = "ia-novo-1";
    const alteracao = validarAlteracaoEmailIA({ tipo: "linha", alvo_id: "abertura", linha }, original);
    const doc = aplicarAlteracaoEmailIA(original, alteracao);
    expect(doc.linhas[0].id).toBe("abertura");
    expect(doc.linhas[0].colunas[0].id).toBe("ia-novo-2");
    expect(doc.linhas[1]).toBe(original.linhas[1]);
    expect(doc.preheader).toBe(original.preheader);
  });
  it("muda apenas as quatro cores globais, inclusive com HTML legado", () => {
    const original = base();
    const doc = aplicarAlteracaoEmailIA(original, validarAlteracaoEmailIA({ tipo: "cores", cores }, original));
    expect(doc.linhas).toBe(original.linhas);
    expect(doc.globais).toEqual({ ...original.globais, ...cores });
    expect(doc.cssCustomizado).toBe(original.cssCustomizado);
  });
  it("o navegador recompõe do fragmento e ignora conteúdo fora do alvo enviado na resposta", () => {
    const original = base();
    const resposta = validarRespostaEmailIA({ resumo: "Ajustei o título", documento: { nome: "FORJADO" }, ajuste: { tipo: "bloco", alvo_id: "titulo" }, alteracao: { tipo: "bloco", alvo_id: "titulo", bloco } }, original);
    expect(resposta.documento.nome).toBe(original.nome);
    expect(resposta.documento.linhas[1]).toBe(original.linhas[1]);
    expect(resposta.documento.linhas[0].colunas[0].blocos[0].id).toBe("titulo");
  });
  it.each([
    { tipo: "bloco", alvo_id: "inexistente", bloco },
    { tipo: "bloco", alvo_id: "titulo", bloco: { tipo: "html", props: { html: "<script>alert(1)</script>" } } },
    { tipo: "bloco", alvo_id: "titulo", bloco: { tipo: "botao", props: { texto: "Abrir", href: "javascript:alert(1)" } } },
    { tipo: "bloco", alvo_id: "titulo", bloco, documento: {} },
    { tipo: "linha", alvo_id: "abertura", linha: { ...linha, cssCustomizado: "*{color:red}" } },
    { tipo: "cores", cores: { ...cores, corTexto: "red" } },
    { tipo: "cores", cores: { ...cores, fonte: "Arial" } },
  ])("recusa fragmento inseguro, alvo incorreto ou campos fora do escopo", alteracao => {
    expect(() => validarAlteracaoEmailIA(alteracao, base())).toThrow();
  });
  it("restaura contexto legado sem perder IDs e recusa IDs maliciosos ou duplicados", () => {
    const original = base();
    expect(validarDocumentoContextoEmailIA(original)).toBe(original);
    original.linhas[0].colunas[0].blocos[0].id = 'x"/><script>';
    expect(() => validarDocumentoContextoEmailIA(original)).toThrow();
    original.linhas[0].colunas[0].blocos[0].id = "rodape";
    expect(() => validarDocumentoContextoEmailIA(original)).toThrow();
  });
  it.each([
    { props: { texto: { valor: "objeto indevido" } } },
    { props: { itens: "lista indevida" } },
    { props: { html: 123 } },
    { estilo: { padding: "12px" } },
    { estiloMobile: { tamanhoFonte: {} } },
  ])("recusa conteúdo de versão que quebraria a prévia", invalido => {
    const doc = base();
    Object.assign(doc.linhas[0].colunas[0].blocos[0], invalido);
    expect(() => validarDocumentoContextoEmailIA(doc)).toThrow();
  });
  it("direção visual não autoriza reestruturar um ajuste localizado", () => {
    expect(orientacaoVisualEmailIA("evento", { tipo: "documento" })).toContain("data/horário/local somente quando fornecidos");
    expect(orientacaoVisualEmailIA("evento", { tipo: "bloco", alvo_id: "titulo" })).toContain("não autoriza reestruturar");
  });
});

describe("schema parcial enviado aos dois provedores", () => {
  it.each([
    ["bloco", { resumo: "Ajustei o texto", bloco }],
    ["linha", { resumo: "Ajustei a seção", linha }],
    ["cores", { resumo: "Ajustei a paleta", cores }],
  ] as const)("permite somente a saída de %s", (tipo, resultado) => {
    const validar = new Ajv({ strict: true }).compile(schemaAjusteEmailIA(tipo));
    expect(validar(resultado), JSON.stringify(validar.errors)).toBe(true);
    expect(validar({ ...resultado, documento: {} })).toBe(false);
    expect(validar({ resumo: "Pronto", documento: base() })).toBe(false);
  });
});

describe("revisão comercial baseada nas referências", () => {
  const oferta = (texto: string, href = "#") => {
    const doc = base(); doc.linhas[0].colunas[0].blocos = [
      { id: "oferta", tipo: "texto", props: { texto } },
      { id: "cta", tipo: "botao", props: { texto: "Inscrever", href } },
    ]; return doc;
  };
  it("sinaliza preço, desconto, prazo e link ausentes da fonte", () => {
    const avisos = revisarComercialEmailIA(oferta("Invista R$ 1.200,00 com 20% até 30/09/2026."), "Curso de formação");
    expect(avisos.map(a => a.tipo)).toEqual(["preco", "preco", "prazo", "link"]);
    expect(avisos[0].trecho).toBe("R$ 1.200,00");
  });
  it("reconhece valores e destinos fornecidos sem tratá-los como certificação", () => {
    const fonte = "R$ 1.200,00, 20% até 30/09/2026 https://ppg.test/inscricao";
    expect(revisarComercialEmailIA(oferta("R$ 1.200,00 com 20% até 30/09/2026.", "https://ppg.test/inscricao"), fonte)).toEqual([]);
  });
  it("exige revisão de promessa mesmo que esteja escrita no briefing", () => {
    const avisos = revisarComercialEmailIA(oferta("Emprego garantido."), "Emprego garantido.");
    expect(avisos.some(a => a.tipo === "promessa")).toBe(true);
  });
});
