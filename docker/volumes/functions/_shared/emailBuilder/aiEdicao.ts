/** Edição localizada: a IA só fornece o fragmento que o usuário escolheu alterar. */
import { ErroDocumentoIA, validarDocumentoIA } from "./ai.ts";
import { docVazio, type Bloco, type DocumentoEmail, type GlobaisDoc, type Linha } from "./types.ts";
import { validarSnapshotFontesEmailIA, MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA } from "./aiFontes.ts";

// O limite original do conteúdo é independente dos metadados de conferência.
// A margem cobre a chave/fontesIA e a pontuação do JSON, sem ampliar o e-mail.
export const MAX_CARACTERES_REGISTRO_DOCUMENTO_EMAIL_IA = 160000 + MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA + 20;

export const DIRECOES_EMAIL_IA = [
  { id: "livre", nome: "Seguir meu pedido", descricao: "Composição orientada pelo conteúdo e pelas referências." },
  { id: "divulgacao", nome: "Divulgação de curso", descricao: "Título, apresentação, benefícios em colunas e inscrição." },
  { id: "evento", nome: "Convite para evento", descricao: "Convite, data e local informados, programação e confirmação." },
  { id: "ultima_chamada", nome: "Última chamada", descricao: "Mensagem curta, prazo confirmado e botão em destaque." },
  { id: "comunicado", nome: "Comunicado institucional", descricao: "Título sóbrio, informações organizadas e contato." },
] as const;
export type DirecaoVisualEmailIA = typeof DIRECOES_EMAIL_IA[number]["id"];
export type AjusteEmailIA = { tipo: "documento"; alvo_id?: never } | { tipo: "cores"; alvo_id?: never } | { tipo: "bloco"; alvo_id: string } | { tipo: "linha"; alvo_id: string };
export type CoresEmailIA = Pick<GlobaisDoc, "corFundo" | "corFundoPagina" | "corTexto" | "corLink">;
export type AlteracaoEmailIA =
  | { tipo: "documento"; documento: DocumentoEmail }
  | { tipo: "bloco"; alvo_id: string; bloco: Bloco }
  | { tipo: "linha"; alvo_id: string; linha: Linha }
  | { tipo: "cores"; cores: CoresEmailIA };
export interface AvisoComercialEmailIA { tipo: "preco" | "prazo" | "promessa" | "link"; trecho: string; motivo: string }
export type RevisaoComercialEmailIA = AvisoComercialEmailIA;
export interface RespostaEmailIA {
  documento: DocumentoEmail;
  resumo: string;
  ajuste: AjusteEmailIA;
  alteracao: AlteracaoEmailIA;
  revisao_comercial: AvisoComercialEmailIA[];
}

type Objeto = Record<string, unknown>;
const ID = /^[a-zA-Z0-9_-]{1,120}$/;
const falha = (caminho: string, motivo: string): never => { throw new ErroDocumentoIA(caminho, motivo); };
function objeto(v: unknown, caminho: string): Objeto {
  if (!v || typeof v !== "object" || Array.isArray(v)) return falha(caminho, "esperado objeto");
  return v as Objeto;
}
function campos(v: Objeto, permitidos: string[], caminho: string): void {
  if (Object.keys(v).some(k => !permitidos.includes(k))) falha(caminho, "campo não permitido");
}

/** Contexto já editado pode conter blocos legados e CSS. Conferimos o formato sem
 * reconstruí-lo como saída de IA nem mudar IDs ao guardar/restaurar um rascunho. */
export function validarDocumentoContextoEmailIA(valor: unknown): DocumentoEmail {
  const v = objeto(valor, "documento");
  const { fontesIA: _fontes, ...conteudoSemFontes } = v;
  if (JSON.stringify(conteudoSemFontes).length > 160000 || typeof v.nome !== "string" || v.nome.length > 120 || v.versao !== 1 || !Array.isArray(v.linhas) || v.linhas.length > 200) return falha("documento", "estrutura ou tamanho inválido");
  const g = objeto(v.globais, "globais");
  for (const chave of ["fonte", "corFundo", "corFundoPagina", "corTexto", "corLink"]) if (typeof g[chave] !== "string" || String(g[chave]).length > 200) falha(`globais.${chave}`, "texto inválido");
  for (const chave of ["larguraContainer", "tamanhoFonte", "breakpointMobile"]) if (typeof g[chave] !== "number" || !Number.isFinite(g[chave])) falha(`globais.${chave}`, "número inválido");
  const conferirPadding = (valorPadding: unknown) => {
    const p = objeto(valorPadding, "padding");
    for (const lado of ["topo", "direita", "baixo", "esquerda"]) if (p[lado] !== undefined && (typeof p[lado] !== "number" || !Number.isFinite(p[lado]))) falha(`padding.${lado}`, "número inválido");
  };
  const conferirEstilo = (valorEstilo: unknown) => {
    if (valorEstilo === undefined) return;
    const e = objeto(valorEstilo, "estilo");
    for (const chave of ["corTexto", "corFundo", "fonte", "alinhamento", "largura", "altura"]) if (e[chave] !== undefined && typeof e[chave] !== "string") falha(`estilo.${chave}`, "texto inválido");
    for (const chave of ["tamanhoFonte", "raio"]) if (e[chave] !== undefined && (typeof e[chave] !== "number" || !Number.isFinite(e[chave]))) falha(`estilo.${chave}`, "número inválido");
    for (const chave of ["pesoFonte", "alturaLinha"]) if (e[chave] !== undefined && !(typeof e[chave] === "string" || typeof e[chave] === "number" && Number.isFinite(e[chave]))) falha(`estilo.${chave}`, "valor inválido");
    if (e.padding !== undefined) conferirPadding(e.padding);
    if (e.borda !== undefined) {
      const b = objeto(e.borda, "estilo.borda");
      if (b.largura !== undefined && (typeof b.largura !== "number" || !Number.isFinite(b.largura))) falha("estilo.borda.largura", "número inválido");
      for (const chave of ["cor", "estilo"]) if (b[chave] !== undefined && typeof b[chave] !== "string") falha(`estilo.borda.${chave}`, "texto inválido");
    }
  };
  conferirPadding(g.paddingPadrao);
  if (!(typeof g.alturaLinha === "string" || typeof g.alturaLinha === "number" && Number.isFinite(g.alturaLinha))) falha("globais.alturaLinha", "valor inválido");
  const ids = new Set<string>();
  const id = (item: Objeto) => { if (typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id)) falha("documento.id", "ID inválido ou duplicado"); ids.add(item.id as string); };
  let blocos = 0;
  for (const valorLinha of v.linhas) {
    const l = objeto(valorLinha, "linha"); id(l); conferirEstilo(l.estilo);
    if (!Array.isArray(l.colunas) || !l.colunas.length || l.colunas.length > 12) return falha("linha.colunas", "lista inválida");
    for (const valorColuna of l.colunas) {
      const c = objeto(valorColuna, "coluna"); id(c); conferirEstilo(c.estilo);
      if (typeof c.larguraPct !== "number" || !Number.isFinite(c.larguraPct) || !Array.isArray(c.blocos)) return falha("coluna", "estrutura inválida");
      for (const valorBloco of c.blocos) {
        const b = objeto(valorBloco, "bloco"); id(b); const p = objeto(b.props, "bloco.props");
        conferirEstilo(b.estilo); conferirEstilo(b.estiloMobile);
        for (const chave of ["texto", "html", "href", "alvo", "src", "alt", "thumbnail", "variavel", "fallback"]) if (p[chave] !== undefined && typeof p[chave] !== "string") falha(`bloco.props.${chave}`, "texto inválido");
        if (p.itens !== undefined && (!Array.isArray(p.itens) || p.itens.some(item => typeof item !== "string"))) falha("bloco.props.itens", "lista de textos inválida");
        for (const chave of ["altura", "espessura"]) if (p[chave] !== undefined && (typeof p[chave] !== "number" || !Number.isFinite(p[chave]))) falha(`bloco.props.${chave}`, "número inválido");
        if (p.ordenada !== undefined && typeof p.ordenada !== "boolean") falha("bloco.props.ordenada", "booleano inválido");
        if (b.visivel !== undefined) { const visivel = objeto(b.visivel, "bloco.visivel"); for (const chave of ["desktop", "mobile"]) if (visivel[chave] !== undefined && typeof visivel[chave] !== "boolean") falha(`bloco.visivel.${chave}`, "booleano inválido"); }
        if (typeof b.tipo !== "string" || !["texto", "botao", "link", "lista", "imagem", "imagem-link", "video", "separador", "espacador", "texto-dinamico", "imagem-dinamica", "link-dinamico", "html", "html-dinamico", "texto-composto"].includes(b.tipo)) falha("bloco.tipo", "tipo inválido");
        if (++blocos > 500) falha("blocos", "documento muito extenso");
      }
    }
  }
  for (const chave of ["assunto", "preheader", "cssCustomizado"]) if (v[chave] !== undefined && typeof v[chave] !== "string") falha(`documento.${chave}`, "texto inválido");
  if (v.fontesIA !== undefined) {
    // Metadados antigos/corrompidos não podem certificar uma fonte nem apagar a
    // proposta. Preserva-se o conteúdo e a interface informa a falta de registro.
    const { fontesIA, ...conteudo } = v;
    try { return { ...conteudo, fontesIA: validarSnapshotFontesEmailIA(fontesIA) } as unknown as DocumentoEmail; }
    catch { return conteudo as unknown as DocumentoEmail; }
  }
  return v as unknown as DocumentoEmail;
}

export function validarAjusteEmailIA(valor: unknown, documento?: DocumentoEmail): AjusteEmailIA {
  if (valor === undefined) return { tipo: "documento" };
  const v = objeto(valor, "ajuste");
  campos(v, ["tipo", "alvo_id"], "ajuste");
  if (!["documento", "bloco", "linha", "cores"].includes(String(v.tipo))) return falha("ajuste.tipo", "tipo inválido");
  if (v.tipo === "documento" || v.tipo === "cores") {
    if (v.alvo_id !== undefined) falha("ajuste.alvo_id", "este ajuste não recebe alvo");
    if (v.tipo === "cores" && !documento) falha("ajuste", "documento atual obrigatório");
    return { tipo: v.tipo };
  }
  if (typeof v.alvo_id !== "string" || !ID.test(v.alvo_id)) return falha("ajuste.alvo_id", "ID inválido");
  if (!documento) return falha("ajuste", "documento atual obrigatório");
  const alvos = v.tipo === "linha" ? documento.linhas : documento.linhas.flatMap(l => l.colunas.flatMap(c => c.blocos));
  if (alvos.filter(a => a.id === v.alvo_id).length !== 1) return falha("ajuste.alvo_id", "alvo não encontrado ou ambíguo");
  return { tipo: v.tipo as "bloco" | "linha", alvo_id: v.alvo_id };
}

/** Valida o conteúdo NOVO com o mesmo contrato do documento completo. O contexto
 * pode conter HTML legado; passá-lo novamente pelo contrato perderia esse conteúdo. */
export function validarAlteracaoEmailIA(valor: unknown, base?: DocumentoEmail): AlteracaoEmailIA {
  const v = objeto(valor, "alteracao");
  if (v.tipo === "documento") {
    campos(v, ["tipo", "documento"], "alteracao");
    return { tipo: "documento", documento: validarDocumentoIA(v.documento) };
  }
  const ajuste = validarAjusteEmailIA({ tipo: v.tipo, ...(v.alvo_id !== undefined ? { alvo_id: v.alvo_id } : {}) }, base);
  if (!base || ajuste.tipo === "documento") return falha("alteracao", "documento atual obrigatório");
  if (ajuste.tipo === "cores") {
    campos(v, ["tipo", "cores"], "alteracao");
    const cores = objeto(v.cores, "alteracao.cores");
    const nomes = ["corFundo", "corFundoPagina", "corTexto", "corLink"] as const;
    campos(cores, [...nomes], "alteracao.cores");
    for (const nome of nomes) if (typeof cores[nome] !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(cores[nome])) falha(`alteracao.cores.${nome}`, "cor hexadecimal obrigatória");
    return { tipo: "cores", cores: Object.fromEntries(nomes.map(nome => [nome, String(cores[nome]).toLowerCase()])) as CoresEmailIA };
  }
  campos(v, ["tipo", "alvo_id", ajuste.tipo], "alteracao");
  const linhas = ajuste.tipo === "linha" ? [v.linha] : [{ colunas: [{ larguraPct: 100, blocos: [v.bloco] }] }];
  const validado = validarDocumentoIA({ ...docVazio("Fragmento"), linhas });
  return ajuste.tipo === "linha"
    ? { ...ajuste, tipo: "linha", linha: validado.linhas[0] }
    : { ...ajuste, tipo: "bloco", bloco: validado.linhas[0].colunas[0].blocos[0] };
}

export function aplicarAlteracaoEmailIA(base: DocumentoEmail | undefined, alteracao: AlteracaoEmailIA): DocumentoEmail {
  if (alteracao.tipo === "documento") return alteracao.documento;
  if (!base) return falha("alteracao", "documento atual obrigatório");
  validarAjusteEmailIA({ tipo: alteracao.tipo, ...("alvo_id" in alteracao ? { alvo_id: alteracao.alvo_id } : {}) }, base);
  if (alteracao.tipo === "cores") return { ...base, globais: { ...base.globais, ...alteracao.cores } };
  // IDs de partes preservadas continuam idênticos; IDs de elementos novos nunca
  // colidem com o documento, inclusive após várias rodadas de ajuste.
  const ids = new Set<string>();
  for (const l of base.linhas) for (const item of [l, ...l.colunas, ...l.colunas.flatMap(c => c.blocos)]) {
    if (!ID.test(item.id) || ids.has(item.id)) falha("documento.id", "IDs inválidos ou duplicados; regularize o documento antes do ajuste");
    ids.add(item.id);
  }
  let sequencia = 0;
  const novoId = () => { let id: string; do { id = `ia-novo-${++sequencia}`; } while (ids.has(id)); ids.add(id); return id; };
  const linhas = base.linhas.map(l => {
    if (alteracao.tipo === "linha") {
      if (l.id !== alteracao.alvo_id) return l;
      return { ...alteracao.linha, id: l.id, ...(l.oculto !== undefined ? { oculto: l.oculto } : {}), colunas: alteracao.linha.colunas.map(c => ({ ...c, id: novoId(), blocos: c.blocos.map(b => ({ ...b, id: novoId() })) })) };
    }
    if (!l.colunas.some(c => c.blocos.some(b => b.id === alteracao.alvo_id))) return l;
    return { ...l, colunas: l.colunas.map(c => c.blocos.some(b => b.id === alteracao.alvo_id) ? { ...c, blocos: c.blocos.map(b => b.id === alteracao.alvo_id ? { ...b, ...alteracao.bloco, id: b.id } : b) } : c) };
  });
  const contar = (itens: Linha[]) => itens.reduce((soma, l) => soma + l.colunas.reduce((total, c) => total + c.blocos.length, 0), 0);
  if (contar(linhas) > Math.max(120, contar(base.linhas))) falha("blocos", "ajuste excede o limite de blocos do documento");
  return { ...base, linhas };
}

/** Usado na edge e no navegador. Em ajustes, ignora o documento recebido e
 * recompõe a proposta a partir da base usada na geração e do fragmento validado. */
export function validarAvisosComerciaisEmailIA(valor: unknown): AvisoComercialEmailIA[] {
  const avisos = valor ?? [];
  if (!Array.isArray(avisos) || avisos.length > 60) return falha("revisao_comercial", "lista inválida");
  return avisos.map((aviso, i): AvisoComercialEmailIA => {
    const a = objeto(aviso, `revisao_comercial[${i}]`);
    campos(a, ["tipo", "trecho", "motivo"], "revisao_comercial");
    if (!["preco", "prazo", "promessa", "link"].includes(String(a.tipo)) || typeof a.trecho !== "string" || !a.trecho.trim() || a.trecho.length > 500 || typeof a.motivo !== "string" || !a.motivo.trim() || a.motivo.length > 500) return falha("revisao_comercial", "aviso inválido");
    return { tipo: a.tipo as AvisoComercialEmailIA["tipo"], trecho: a.trecho, motivo: a.motivo };
  });
}

export function validarRespostaEmailIA(valor: unknown, documentoBase?: DocumentoEmail): RespostaEmailIA {
  const v = objeto(valor, "resposta");
  if (typeof v.resumo !== "string" || !v.resumo.trim() || v.resumo.length > 2000) return falha("resumo", "resumo inválido");
  const alteracao = validarAlteracaoEmailIA(v.alteracao ?? { tipo: "documento", documento: v.documento }, documentoBase);
  const ajuste: AjusteEmailIA = alteracao.tipo === "bloco" || alteracao.tipo === "linha" ? { tipo: alteracao.tipo, alvo_id: alteracao.alvo_id } : { tipo: alteracao.tipo };
  if (v.ajuste !== undefined && JSON.stringify(validarAjusteEmailIA(v.ajuste, documentoBase)) !== JSON.stringify(ajuste)) falha("ajuste", "ajuste divergente da alteração");
  const revisao_comercial = validarAvisosComerciaisEmailIA(v.revisao_comercial);
  const documento = aplicarAlteracaoEmailIA(documentoBase, alteracao);
  const { fontesIA: _fontes, ...conteudo } = documento;
  if (JSON.stringify(conteudo).length > 160000) falha("documento", "conteúdo excede o tamanho permitido");
  return { documento, resumo: v.resumo.trim(), ajuste, alteracao, revisao_comercial };
}

const COMPOSICOES: Record<DirecaoVisualEmailIA, string> = {
  livre: "Siga a composição solicitada e use as referências visuais como inspiração.",
  divulgacao: "Base de divulgação: abertura com título e fundo de destaque (1 coluna), apresentação curta (1 coluna), benefícios concretos (2 colunas empilhadas no celular), CTA de inscrição (1 coluna) e rodapé. Destaque a formação selecionada, sem inventar modalidade, carga horária ou valores.",
  evento: "Base de convite: título do evento (1 coluna), apresentação (1 coluna), serviço com data/horário/local somente quando fornecidos (2 colunas), programação informada (1 coluna), botão para confirmar presença e rodapé. Se não há data, peça conferência no resumo, sem criar uma.",
  ultima_chamada: "Base de última chamada: título direto (1 coluna), lembrete breve, prazo SOMENTE se constar nas referências, botão forte e rodapé. Use contraste e espaços generosos; não invente urgência, escassez, quantidade de vagas ou desconto.",
  comunicado: "Base institucional: cabeçalho sóbrio, título objetivo, informação principal, detalhes em lista, contato ou ação quando necessário e rodapé; todas as seções em uma coluna e sem pressão comercial.",
};
export function orientacaoVisualEmailIA(direcao: DirecaoVisualEmailIA, ajuste: AjusteEmailIA): string {
  return ajuste.tipo === "documento" ? COMPOSICOES[direcao] : "Ajuste localizado: preserve o tema, a estrutura e todas as partes fora do alvo. A direção visual não autoriza reestruturar o documento.";
}

/** Revisão verificável por regras, sem uma segunda chamada paga. É uma triagem:
 * avisos não certificam fatos e não substituem conferência humana da oferta. */
export function revisarComercialEmailIA(documento: DocumentoEmail, referencias = "", destinosExistentes: string[] = []): AvisoComercialEmailIA[] {
  const normalizar = (texto: string) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const fonte = normalizar(referencias);
  const textos = [documento.assunto ?? "", documento.preheader ?? ""];
  const links: string[] = [];
  for (const l of documento.linhas) for (const c of l.colunas) for (const b of c.blocos) {
    if (b.props.texto) textos.push(b.props.texto);
    if (b.props.html) textos.push(b.props.html.replace(/<[^>]*>/g, " "));
    if (b.props.itens) textos.push(...b.props.itens);
    if (b.props.href) links.push(b.props.href);
  }
  const resultado: AvisoComercialEmailIA[] = [];
  const vistos = new Set<string>();
  const adicionar = (tipo: AvisoComercialEmailIA["tipo"], trecho: string, motivo: string) => {
    const chave = `${tipo}:${normalizar(trecho)}`;
    if (vistos.has(chave) || resultado.length >= 60) return;
    vistos.add(chave); resultado.push({ tipo, trecho: trecho.slice(0, 500), motivo });
  };
  for (const texto of textos) {
    for (const m of texto.matchAll(/R\$\s*\d(?:[\d.,]*\d)?|\b\d+(?:[.,]\d+)?\s*%|\b\d{1,2}\s*(?:x\b|parcelas?\b)/gi)) {
      if (!fonte.includes(normalizar(m[0]))) adicionar("preco", m[0], "Valor, desconto ou parcelamento sem correspondência nas referências fornecidas. Confirme a condição comercial.");
    }
    for (const m of texto.matchAll(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+\d{4})?\b|\b(?:s[oó] hoje|[uú]ltim[oa]s? (?:vagas|dias|horas)|por tempo limitado|at[eé] amanh[ãa])\b/gi)) {
      if (!fonte.includes(normalizar(m[0]))) adicionar("prazo", m[0], "Data, prazo ou urgência sem correspondência nas referências fornecidas. Confirme antes de enviar.");
    }
    for (const frase of texto.split(/(?<=[.!?])\s+|\n/)) {
      if (/garanti[dr]|resultado[s]? (?:cert[oa]s?|comprovad[oa]s?)|melhor do (?:brasil|mercado)|reconhecid[oa].{0,20}\bMEC\b|sem risco|emprego garantido/i.test(frase)) adicionar("promessa", frase, "Promessa ou afirmação comercial exige comprovação e revisão humana, mesmo quando aparece no material de referência.");
      // "100%" ganha a MESMA excecao por referencia que preco e prazo ja tinham: era a
      // unica promessa sem saida, e "100% online" e fato de catalogo, nao superlativo.
      // Garantia, MEC e resultado comprovado seguem sem excecao, de proposito.
      for (const m of frase.matchAll(/\b100\s*%/g)) {
        if (!fonte.includes(normalizar(m[0]))) adicionar("promessa", m[0], "Afirmacao de totalidade sem correspondencia nas referencias fornecidas. Confirme antes de enviar.");
      }
    }
  }
  for (const href of links) {
    if (/^\{\{\s*descadastro_url\s*\}\}$/.test(href)) continue;
    if (href === "#") adicionar("link", href, "Botão ou link ainda sem destino. Complete o endereço antes de enviar.");
    else if (!fonte.includes(normalizar(href)) && !destinosExistentes.some(destino => normalizar(destino) === normalizar(href))) adicionar("link", href, "Destino não encontrado nas referências fornecidas. Confira se é o link oficial desta comunicação.");
  }
  return resultado;
}
