import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { docVazio, type DocumentoEmail } from "./types.ts";
import { validarAlteracaoEmailIA, type AjusteEmailIA } from "./aiEdicao.ts";
import { EXEMPLO_RESULTADO_EMAIL_IA } from "./aiSchema.ts";
import { schemaProtegidoEmailIA, validarProtecaoEmailIA, validarAjusteProtegidoEmailIA, validarDocumentoProtegidoEmailIA, validarRespostaProtegidaEmailIA, validarPreservacaoManualEmailIA, type ProtecaoEmailIA } from "./aiProtecoes.ts";

const base = (): DocumentoEmail => ({ ...docVazio("E-mail aprovado"), cssCustomizado: ".aprovado{color:#123456}", linhas: [
  { id: "abertura", colunas: [{ id: "col-abertura", larguraPct: 100, blocos: [
    { id: "titulo", tipo: "texto", props: { texto: "Título aprovado" }, estilo: { tamanhoFonte: 31 }, estiloMobile: { tamanhoFonte: 24 }, visivel: { desktop: true } },
    { id: "html-legado", tipo: "html", props: { html: '<p class="aprovado">Trecho original</p>' } },
  ] }] },
  { id: "rodape", nome: "Rodapé aprovado", oculto: false, colunas: [{ id: "col-rodape", larguraPct: 100, blocos: [{ id: "descadastro", tipo: "link", props: { texto: "Descadastrar", href: "{{descadastro_url}}" } }] }] },
] });
const p = (): ProtecaoEmailIA => ({ linhas: ["rodape"], blocos: ["html-legado"], cores: true });
const estrutura = (): Record<string, unknown> & { linhas: Array<Record<string, unknown>> } => {
  const doc = structuredClone(EXEMPLO_RESULTADO_EMAIL_IA.documento) as unknown as Record<string, unknown> & { linhas: Array<Record<string, unknown>> };
  const linha = structuredClone(EXEMPLO_RESULTADO_EMAIL_IA.documento.linhas[0]);
  return { ...doc, globais: { ...doc.globais as object, corTexto: "#ff0000" }, linhas: [{ preservar_id: "rodape" }, { ...linha, colunas: [{ ...linha.colunas[0], blocos: [{ preservar_id: "html-legado" }, ...linha.colunas[0].blocos] }] }] };
};

describe("proteções persistentes independentes das instruções do modelo", () => {
  it("conserva linha, bloco legado, cores, CSS e IDs integralmente sem mutar base", () => {
    const original = base(); const antes = structuredClone(original);
    const doc = validarDocumentoProtegidoEmailIA(estrutura(), original, p());
    expect(doc.linhas[0]).toBe(original.linhas[1]);
    expect(doc.linhas[1].colunas[0].blocos[0]).toBe(original.linhas[0].colunas[0].blocos[1]);
    expect(doc.globais.corTexto).toBe(original.globais.corTexto);
    expect(doc.cssCustomizado).toBe(original.cssCustomizado);
    expect(original).toEqual(antes);
    const ids = doc.linhas.flatMap(l => [l.id, ...l.colunas.flatMap(c => [c.id, ...c.blocos.map(b => b.id)])]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id === "rodape")).toHaveLength(1);
    expect(ids.filter(id => id === "html-legado")).toHaveLength(1);
  });
  it("mantém estilo desktop/mobile e visibilidade do bloco aprovado", () => {
    const original = base(); const protecao = { blocos: ["titulo"], linhas: [], cores: false };
    const doc = validarDocumentoProtegidoEmailIA({ ...docVazio("Novo"), linhas: [{ colunas: [{ larguraPct: 100, blocos: [{ preservar_id: "titulo" }] }] }] }, original, protecao);
    expect(doc.linhas[0].colunas[0].blocos[0]).toBe(original.linhas[0].colunas[0].blocos[0]);
  });
  it("schema admite somente marcador autorizado no nível correto", () => {
    const validar = new Ajv({ strict: true }).compile(schemaProtegidoEmailIA(base(), p()));
    expect(validar({ resumo: "Ajustei", documento: estrutura() })).toBe(true);
    const errado = estrutura(); errado.linhas[0] = { preservar_id: "html-legado" };
    expect(validar({ resumo: "Ajustei", documento: errado })).toBe(false);
  });
  it.each(["ausente", "duplicado", "desconhecido", "campos extras", "id injetado", "html novo"])("recusa marcador/saída %s", tipo => {
    const valor = estrutura();
    if (tipo === "ausente") valor.linhas.shift();
    if (tipo === "duplicado") valor.linhas.push({ preservar_id: "rodape" });
    if (tipo === "desconhecido") valor.linhas[0] = { preservar_id: "abertura" };
    if (tipo === "campos extras") valor.linhas[0] = { preservar_id: "rodape", nome: "Alterado" };
    if (tipo === "id injetado") Object.assign(valor.linhas[1], { id: "rodape" });
    if (tipo === "html novo") valor.linhas.push({ colunas: [{ larguraPct: 100, blocos: [{ tipo: "html", props: { html: "<script>executar()</script>" } }] }] });
    expect(() => validarDocumentoProtegidoEmailIA(valor, base(), p())).toThrow();
  });
  it("proteção redundante de filho não exige duplicá-lo fora da linha", () => {
    const protecao = { ...p(), blocos: ["html-legado", "descadastro"] };
    expect(validarDocumentoProtegidoEmailIA(estrutura(), base(), protecao).linhas[0].id).toBe("rodape");
  });
  it("IDs nativos novos não colidem nem na segunda geração", () => {
    const primeiro = validarDocumentoProtegidoEmailIA(estrutura(), base(), p());
    const segundo = validarDocumentoProtegidoEmailIA(estrutura(), primeiro, p());
    expect(segundo.linhas[0]).toBe(primeiro.linhas[0]);
    expect(segundo.linhas[1].id).not.toBe(primeiro.linhas[1].id);
  });
  it.each([
    { tipo: "bloco", alvo_id: "html-legado" }, { tipo: "linha", alvo_id: "abertura" },
    { tipo: "linha", alvo_id: "rodape" }, { tipo: "bloco", alvo_id: "descadastro" }, { tipo: "cores" },
  ] as const)("recusa escopo que toca uma proteção", ajuste => {
    expect(() => validarAjusteProtegidoEmailIA(base(), ajuste as AjusteEmailIA, p())).toThrow();
  });
  it("ajuste em irmão livre mantém todo o conteúdo protegido", () => {
    const original = base(); const ajuste = { tipo: "bloco", alvo_id: "titulo" } as const;
    const alteracao = validarAlteracaoEmailIA({ ...ajuste, bloco: { tipo: "texto", props: { texto: "Novo título" } } }, original);
    const doc = validarRespostaProtegidaEmailIA({ resumo: "Ajustei", ajuste, alteracao }, original, p()).documento;
    expect(doc.linhas[1]).toBe(original.linhas[1]);
    expect(doc.linhas[0].colunas[0].blocos[1]).toBe(original.linhas[0].colunas[0].blocos[1]);
    expect(doc.globais).toBe(original.globais);
  });
  it("navegador reconstrói proteção a partir da base e não de objeto final adulterado", () => {
    const original = base();
    const resposta = validarRespostaProtegidaEmailIA({ resumo: "Ajustei", ajuste: { tipo: "documento" }, documento: { nome: "Injetado" }, estrutura_protegida: estrutura() }, original, p());
    expect(resposta.documento.linhas[0]).toBe(original.linhas[1]);
    expect(resposta.documento.linhas[1].colunas[0].blocos[0]).toBe(original.linhas[0].colunas[0].blocos[1]);
    expect(() => validarRespostaProtegidaEmailIA({ resumo: "Ajustei", documento: resposta.documento }, original, p())).toThrow();
  });
  it.each([{ ...p(), blocos: ["nao-existe"] }, { ...p(), linhas: ["rodape", "rodape"] }, { ...p(), blocos: ["x\" onclick=\"1"] }, { ...p(), extra: "injetado" }])("recusa preferência obsoleta/injetada", valor => {
    expect(() => validarProtecaoEmailIA(valor, base())).toThrow();
  });
});

describe("defesa das proteções na edição manual e inserção de seções", () => {
  it("permite assunto/preheader, texto livre, mudança de posição e nova seção sem normalizar IDs", () => {
    const original = base(); const novo = structuredClone(original);
    novo.assunto = "Novo assunto manual"; novo.preheader = "Nova prévia";
    novo.linhas[0].colunas[0].blocos[0].props.texto = "Título livre editado";
    novo.linhas.reverse();
    novo.linhas.push({ id: "linha-manual", colunas: [{ id: "col-manual", larguraPct: 100, blocos: [{ id: "bloco-manual", tipo: "texto", props: { texto: "Conteúdo complementar" } }] }] });
    const copia = structuredClone(novo);
    expect(() => validarPreservacaoManualEmailIA(original, novo, p())).not.toThrow();
    expect(novo).toEqual(copia);
    expect(novo.linhas[2].id).toBe("linha-manual");
  });
  it("permite mover o bloco protegido entre colunas sem alterar seu conteúdo", () => {
    const original = base(); const novo = structuredClone(original);
    const protegido = novo.linhas[0].colunas[0].blocos.splice(1, 1)[0];
    novo.linhas[0].colunas[0].larguraPct = 50;
    novo.linhas[0].colunas.push({ id: "nova-coluna", larguraPct: 50, blocos: [protegido] });
    expect(() => validarPreservacaoManualEmailIA(original, novo, p())).not.toThrow();
  });
  it.each(["texto protegido", "estilo da linha", "filho da linha", "excluir", "duplicar", "trocar ID", "cor global", "CSS"])("bloqueia %s", tipo => {
    const original = base(); const novo = structuredClone(original);
    if (tipo === "texto protegido") novo.linhas[0].colunas[0].blocos[1].props.html = "<p>Alterado</p>";
    if (tipo === "estilo da linha") novo.linhas[1].estilo = { corFundo: "#ff0000" };
    if (tipo === "filho da linha") novo.linhas[1].colunas[0].blocos[0].props.texto = "Sair";
    if (tipo === "excluir") novo.linhas[0].colunas[0].blocos.pop();
    if (tipo === "duplicar") novo.linhas[0].colunas[0].blocos.push(structuredClone(novo.linhas[0].colunas[0].blocos[1]));
    if (tipo === "trocar ID") novo.linhas[1].id = "novo-id";
    if (tipo === "cor global") novo.globais.corLink = "#ff0000";
    if (tipo === "CSS") novo.cssCustomizado = ".aprovado{display:none}";
    expect(() => validarPreservacaoManualEmailIA(original, novo, p())).toThrow();
  });
  it("ordem das chaves JSON não representa uma alteração do bloco", () => {
    const original = base(); const novo = structuredClone(original);
    const anterior = novo.linhas[0].colunas[0].blocos[1];
    novo.linhas[0].colunas[0].blocos[1] = { props: anterior.props, tipo: anterior.tipo, id: anterior.id };
    expect(() => validarPreservacaoManualEmailIA(original, novo, p())).not.toThrow();
  });
});
