/** Partes aprovadas são reinseridas da base, nunca reescritas pelo provedor. */
import { ErroDocumentoIA, validarDocumentoIA } from "./ai.ts";
import { validarAjusteEmailIA, validarDocumentoContextoEmailIA, validarRespostaEmailIA, validarAvisosComerciaisEmailIA,
  type AjusteEmailIA, type RespostaEmailIA } from "./aiEdicao.ts";
import { SCHEMA_RESULTADO_EMAIL_IA, type Schema } from "./aiSchema.ts";
import type { Bloco, DocumentoEmail, Linha } from "./types.ts";

export interface ProtecaoEmailIA { blocos: string[]; linhas: string[]; cores: boolean }
export const protecaoEmailIAVazia = (): ProtecaoEmailIA => ({ blocos: [], linhas: [], cores: false });
export const temProtecaoEmailIA = (p: ProtecaoEmailIA): boolean => p.cores || p.blocos.length > 0 || p.linhas.length > 0;
const falha = (motivo: string): never => { throw new ErroDocumentoIA("protecao", motivo); };
const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const CORES = ["corFundo", "corFundoPagina", "corTexto", "corLink"] as const;

export function validarProtecaoEmailIA(valor: unknown, base?: DocumentoEmail): ProtecaoEmailIA {
  if (valor === undefined) return protecaoEmailIAVazia();
  if (!objeto(valor) || Object.keys(valor).some(k => !["blocos", "linhas", "cores"].includes(k)) || typeof valor.cores !== "boolean") return falha("proteção inválida");
  for (const campo of ["blocos", "linhas"] as const) {
    const ids = valor[campo];
    if (!Array.isArray(ids) || ids.length > (campo === "blocos" ? 500 : 200) || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) || new Set(ids).size !== ids.length) return falha("IDs inválidos ou repetidos");
  }
  const p = { blocos: [...valor.blocos as string[]], linhas: [...valor.linhas as string[]], cores: valor.cores };
  if (!temProtecaoEmailIA(p)) return p;
  if (!base) return falha("proteção exige um documento atual");
  validarDocumentoContextoEmailIA(base);
  const blocos = new Set(base.linhas.flatMap(l => l.colunas.flatMap(c => c.blocos.map(b => b.id))));
  if (p.linhas.some(id => !base.linhas.some(l => l.id === id)) || p.blocos.some(id => !blocos.has(id))) return falha("o trecho protegido não existe mais; reveja a seleção");
  // Uma linha protegida já contém seus blocos. Conservamos os IDs na preferência
  // para que desproteger a linha não desproteja um bloco aprovado separadamente.
  return p;
}

export function validarAjusteProtegidoEmailIA(base: DocumentoEmail | undefined, ajuste: AjusteEmailIA, p: ProtecaoEmailIA): void {
  validarAjusteEmailIA(ajuste, base);
  if (ajuste.tipo === "cores" && p.cores) return falha("as cores estão protegidas; desproteja antes de ajustar");
  if (!base || ajuste.tipo === "documento" || ajuste.tipo === "cores") return;
  const linha = base.linhas.find(l => ajuste.tipo === "linha" ? l.id === ajuste.alvo_id : l.colunas.some(c => c.blocos.some(b => b.id === ajuste.alvo_id)));
  if (linha && (p.linhas.includes(linha.id) || ajuste.tipo === "bloco" && p.blocos.includes(ajuste.alvo_id)
    || ajuste.tipo === "linha" && linha.colunas.some(c => c.blocos.some(b => p.blocos.includes(b.id))))) return falha("o alvo contém conteúdo protegido; desproteja antes de ajustar");
}

function alvos(base: DocumentoEmail, p: ProtecaoEmailIA) {
  const linhas = new Map(base.linhas.filter(l => p.linhas.includes(l.id)).map(l => [l.id, l]));
  const blocos = new Map(base.linhas.filter(l => !linhas.has(l.id)).flatMap(l => l.colunas.flatMap(c => c.blocos.filter(b => p.blocos.includes(b.id)).map(b => [b.id, b] as const))));
  return { linhas, blocos };
}

/** Defesa para alterações locais do editor: mover é permitido; trocar conteúdo,
 * estilos, IDs ou duplicar/apagar uma parte aprovada exige desprotegê-la. */
export function validarPreservacaoManualEmailIA(base: DocumentoEmail, novo: DocumentoEmail, protecao: ProtecaoEmailIA): void {
  const p = validarProtecaoEmailIA(protecao, base);
  validarDocumentoContextoEmailIA(novo);
  const ordenar = (valor: unknown): unknown => Array.isArray(valor) ? valor.map(ordenar)
    : objeto(valor) ? Object.fromEntries(Object.keys(valor).sort().map(chave => [chave, ordenar(valor[chave])])) : valor;
  const iguais = (a: unknown, b: unknown) => JSON.stringify(ordenar(a)) === JSON.stringify(ordenar(b));
  for (const id of p.linhas) {
    const original = base.linhas.find(l => l.id === id)!;
    const encontrados = novo.linhas.filter(l => l.id === id);
    if (encontrados.length !== 1 || !iguais(original, encontrados[0])) return falha("uma linha aprovada foi modificada, removida ou duplicada");
  }
  const antes = base.linhas.flatMap(l => l.colunas.flatMap(c => c.blocos));
  const depois = novo.linhas.flatMap(l => l.colunas.flatMap(c => c.blocos));
  for (const id of p.blocos) {
    const original = antes.find(b => b.id === id)!;
    const encontrados = depois.filter(b => b.id === id);
    if (encontrados.length !== 1 || !iguais(original, encontrados[0])) return falha("um bloco aprovado foi modificado, removido ou duplicado");
  }
  if (p.cores && CORES.some(chave => novo.globais[chave] !== base.globais[chave])) return falha("as cores globais aprovadas foram modificadas");
  if ((p.linhas.length || p.blocos.length) && novo.cssCustomizado !== base.cssCustomizado) return falha("o CSS que afeta os trechos aprovados foi modificado");
}

export function schemaProtegidoEmailIA(base: DocumentoEmail, p: ProtecaoEmailIA): Schema {
  // anyOf confirmado nos contratos oficiais Claude/Gemini em 14/09/2026.
  // São só duas uniões, sem repetir o catálogo de estilos nem recursão:
  // platform.claude.com/docs/en/build-with-claude/structured-outputs
  // ai.google.dev/api/generate-content#GenerationConfig
  const schema = structuredClone(SCHEMA_RESULTADO_EMAIL_IA);
  const { linhas, blocos } = alvos(base, p);
  const marcador = (ids: string[]): Schema => ({ type: "object", properties: { preservar_id: { type: "string", enum: ids } }, required: ["preservar_id"], additionalProperties: false });
  if (linhas.size) schema.$defs!.linha = { anyOf: [schema.$defs!.linha, marcador([...linhas.keys()])] };
  if (blocos.size) schema.$defs!.bloco = { anyOf: [schema.$defs!.bloco, marcador([...blocos.keys()])] };
  return schema;
}

export function orientacaoProtecaoEmailIA(base: DocumentoEmail | undefined, p: ProtecaoEmailIA): string {
  if (!base || !temProtecaoEmailIA(p)) return "";
  const { linhas, blocos } = alvos(base, p);
  return `\nPROTEÇÕES APROVADAS têm precedência sobre qualquer pedido de alteração. Em documento completo, represente cada linha protegida exclusivamente por {"preservar_id":"ID"} em documento.linhas; cada bloco protegido fora dessas linhas exclusivamente por esse marcador em coluna.blocos. Use cada ID autorizado exatamente uma vez. Não copie, reescreva nem duplique o conteúdo desses trechos em outras seções: o servidor restaura os originais. Não coloque IDs em itens novos. Linhas protegidas: ${JSON.stringify([...linhas.keys()])}. Blocos protegidos fora delas: ${JSON.stringify([...blocos.keys()])}. ${p.cores ? "As quatro cores globais originais serão preservadas pelo servidor." : ""} Em ajuste localizado, mantenha o schema do alvo e não retorne marcadores.`;
}

/** Troca marcadores por espaços temporários para validar apenas os itens novos.
 * O merge ocorre depois da validação nativa e nunca confia em IDs do provedor. */
export function validarDocumentoProtegidoEmailIA(valor: unknown, base: DocumentoEmail, protecao: ProtecaoEmailIA): DocumentoEmail {
  const p = validarProtecaoEmailIA(protecao, base);
  const { linhas: protegidas, blocos: protegidos } = alvos(base, p);
  if (!objeto(valor) || !Array.isArray(valor.linhas) || JSON.stringify(valor).length > 160000) return falha("estrutura de proteção inválida");
  const vistos = new Set<string>();
  const linhasRestaurar = new Map<number, Linha>();
  const blocosRestaurar = new Map<string, Bloco>();
  const espaco = () => ({ tipo: "espacador", props: { altura: 0 }, estilo: {}, estiloMobile: {} });
  const marcador = (v: Record<string, unknown>, permitidos: Map<string, Linha> | Map<string, Bloco>): string | undefined => {
    if (!("preservar_id" in v)) return;
    if (Object.keys(v).length !== 1 || typeof v.preservar_id !== "string" || !permitidos.has(v.preservar_id) || vistos.has(v.preservar_id)) return falha("marcador protegido desconhecido, repetido ou adulterado");
    vistos.add(v.preservar_id); return v.preservar_id;
  };
  const linhas = valor.linhas.map((v, li) => {
    if (!objeto(v)) return falha("linha inválida");
    const id = marcador(v, protegidas);
    if (id) { linhasRestaurar.set(li, protegidas.get(id)!); return { colunas: [{ larguraPct: 100, blocos: [espaco()] }] }; }
    if ("id" in v || !Array.isArray(v.colunas)) return falha("linha nova deve usar somente o contrato nativo, sem IDs");
    return { ...v, colunas: v.colunas.map((c, ci) => {
      if (!objeto(c) || "id" in c || !Array.isArray(c.blocos)) return falha("coluna nova inválida ou com ID");
      return { ...c, blocos: c.blocos.map((b, bi) => {
        if (!objeto(b)) return falha("bloco inválido");
        const blocoId = marcador(b, protegidos);
        if (blocoId) { blocosRestaurar.set(`${li}:${ci}:${bi}`, protegidos.get(blocoId)!); return espaco(); }
        if ("id" in b) return falha("bloco novo não pode injetar um ID");
        return b;
      }) };
    }) };
  });
  if (vistos.size !== protegidas.size + protegidos.size) return falha("a proposta omitiu um trecho protegido");
  const novo = validarDocumentoIA({ ...valor, linhas });
  const ids = new Set(base.linhas.flatMap(l => [l.id, ...l.colunas.flatMap(c => [c.id, ...c.blocos.map(b => b.id)])]));
  let sequencia = 0;
  const novoId = () => { let id: string; do { id = `ia-livre-${++sequencia}`; } while (ids.has(id)); ids.add(id); return id; };
  novo.linhas = novo.linhas.map((l, li) => linhasRestaurar.get(li) ?? { ...l, id: novoId(), colunas: l.colunas.map((c, ci) => ({ ...c, id: novoId(), blocos: c.blocos.map((b, bi) => blocosRestaurar.get(`${li}:${ci}:${bi}`) ?? { ...b, id: novoId() }) })) });
  if (p.cores) for (const chave of CORES) novo.globais[chave] = base.globais[chave];
  // CSS legado influencia os trechos aprovados. Só o CSS da base pode continuar;
  // o modelo não ganha permissão para produzir CSS por existir uma proteção.
  if ((protegidas.size || protegidos.size) && base.cssCustomizado !== undefined) novo.cssCustomizado = base.cssCustomizado;
  validarPreservacaoManualEmailIA(base, novo, p);
  return novo;
}

/** A prévia recompõe a mesma base e marcadores da edge, preservando IDs/legado. */
export function validarRespostaProtegidaEmailIA(valor: unknown, base?: DocumentoEmail, protecao?: ProtecaoEmailIA): RespostaEmailIA {
  const p = validarProtecaoEmailIA(protecao, base);
  if (!temProtecaoEmailIA(p)) return validarRespostaEmailIA(valor, base);
  if (!objeto(valor)) return falha("resposta inválida");
  const ajuste = validarAjusteEmailIA(valor.ajuste, base);
  validarAjusteProtegidoEmailIA(base, ajuste, p);
  if (ajuste.tipo !== "documento") return validarRespostaEmailIA(valor, base);
  if (!base || typeof valor.resumo !== "string" || !valor.resumo.trim() || valor.resumo.length > 2000) return falha("resumo ou documento base inválido");
  const documento = validarDocumentoProtegidoEmailIA(valor.estrutura_protegida, base, p);
  return { documento, resumo: valor.resumo.trim(), ajuste, alteracao: { tipo: "documento", documento }, revisao_comercial: validarAvisosComerciaisEmailIA(valor.revisao_comercial) };
}
