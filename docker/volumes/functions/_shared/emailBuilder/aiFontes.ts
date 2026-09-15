export type TipoFonteEmailIA = "curso" | "playbook" | "links" | "campanha" | "marca" | "oferta";
export interface SelecaoFontesEmailIA { curso_id?: string; campanha_id?: string; marca_id?: string; oferta_id?: string; usar_resultados?: boolean }
export interface FonteEmailIA {
  chave: string; tipo: TipoFonteEmailIA; id: string; rotulo: string;
  estado: "disponivel" | "indisponivel"; campos: Record<string, string>; hash: string;
  hashes_campos: Record<string, string>; campos_resumidos: string[];
}
export interface ItemNaoVerificavelEmailIA { tipo: "preco" | "prazo" | "vagas" | "desconto"; motivo: string }
export interface SnapshotFontesEmailIA {
  versao: 1; capturado_em: string; selecao: SelecaoFontesEmailIA;
  fontes: FonteEmailIA[]; nao_verificaveis: ItemNaoVerificavelEmailIA[];
  cobertura_parcial?: true;
}
export interface AlteracaoFonteEmailIA {
  chave: string; tipo: TipoFonteEmailIA; rotulo: string;
  situacao: "alterada" | "indisponivel" | "adicionada" | "removida";
  campos: Array<{ campo: string; anterior: string | null; atual: string | null; anterior_resumido?: boolean; atual_resumido?: boolean }>;
}
export interface ComparacaoFontesEmailIA {
  estado: "sem_alteracoes" | "alterado" | "indisponivel" | "sem_fontes";
  alteracoes: AlteracaoFonteEmailIA[];
}
export const MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA = 24 * 1024;
export const MAX_CARACTERES_FONTES_EMAIL_IA = 28000;
const TIPOS: TipoFonteEmailIA[] = ["curso", "playbook", "links", "campanha", "marca", "oferta"];
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const falha = () => new Error("O registro das fontes deste e-mail está inválido. Gere uma nova proposta para registrar as fontes atuais.");
function chaves(v: Record<string, unknown>, permitidas: string[]) { if (Object.keys(v).some(k => !permitidas.includes(k))) throw falha(); }
function texto(v: unknown, max: number, vazio = false): string { if (typeof v !== "string" || v.length > max || !vazio && !v.trim()) throw falha(); return v; }
function identidade(tipo: TipoFonteEmailIA, selecao: SelecaoFontesEmailIA): string | undefined {
  return selecao[tipo === "oferta" ? "oferta_id" : tipo === "campanha" ? "campanha_id" : tipo === "marca" ? "marca_id" : "curso_id"];
}
function canonico(campos: Record<string, string>): string { return JSON.stringify(Object.keys(campos).sort().map(campo => [campo, campos[campo]])); }
export const NAO_VERIFICAVEIS_FONTES_EMAIL_IA: readonly ItemNaoVerificavelEmailIA[] = [
  { tipo: "preco", motivo: "Esta consulta não confirma o preço vigente da oferta. Valores em referências, PDFs ou campanhas anteriores exigem confirmação comercial." },
  { tipo: "prazo", motivo: "Não há prazo de matrícula confirmado nesta consulta. Vigência do cadastro, datas do curso e textos de materiais não comprovam o encerramento das inscrições." },
  { tipo: "vagas", motivo: "A quantidade de vagas disponíveis não é verificada. Informações de PDFs, referências e versões anteriores precisam de confirmação." },
  { tipo: "desconto", motivo: "Descontos e condições promocionais não são confirmados automaticamente pelo catálogo, playbook, links ou histórico de campanha." },
];

/** Identidades vinculadas à seleção. Os hashes são registros de proveniência,
 * não provas assinadas nem confirmação comercial. Campos longos guardam prévia
 * declarada e hash do valor completo enviado ao modelo. */
export function validarSnapshotFontesEmailIA(valor: unknown): SnapshotFontesEmailIA {
  if (!objeto(valor)) throw falha();
  chaves(valor, ["versao", "capturado_em", "selecao", "fontes", "nao_verificaveis", "cobertura_parcial"]);
  if (valor.cobertura_parcial !== undefined && valor.cobertura_parcial !== true) throw falha();
  if (valor.versao !== 1 || typeof valor.capturado_em !== "string" || valor.capturado_em.length > 40 || !Number.isFinite(Date.parse(valor.capturado_em)) || !objeto(valor.selecao)) throw falha();
  chaves(valor.selecao, ["curso_id", "campanha_id", "marca_id", "oferta_id", "usar_resultados"]);
  const selecao: SelecaoFontesEmailIA = {};
  for (const campo of ["curso_id", "campanha_id", "marca_id", "oferta_id"] as const) if (valor.selecao[campo] !== undefined) {
    const id = texto(valor.selecao[campo], 36); if (!UUID.test(id)) throw falha(); selecao[campo] = id;
  }
  if (selecao.oferta_id && !selecao.curso_id) throw falha();
  if (valor.selecao.usar_resultados !== undefined) {
    if (typeof valor.selecao.usar_resultados !== "boolean" || valor.selecao.usar_resultados && !selecao.campanha_id) throw falha();
    if (valor.selecao.usar_resultados) selecao.usar_resultados = true;
  }
  if (!Array.isArray(valor.fontes) || valor.fontes.length > 6 || !Array.isArray(valor.nao_verificaveis) || valor.nao_verificaveis.length > 4) throw falha();
  let caracteres = 0; const vistas = new Set<string>();
  const fontes = valor.fontes.map((v): FonteEmailIA => {
    if (!objeto(v)) throw falha(); chaves(v, ["chave", "tipo", "id", "rotulo", "estado", "campos", "hash", "hashes_campos", "campos_resumidos"]);
    if (!TIPOS.includes(v.tipo as TipoFonteEmailIA) || typeof v.id !== "string" || !UUID.test(v.id) || identidade(v.tipo as TipoFonteEmailIA, selecao) !== v.id
      || v.chave !== `${v.tipo}:${v.id}` || vistas.has(v.chave) || !["disponivel", "indisponivel"].includes(String(v.estado)) || !objeto(v.campos)
      || typeof v.hash !== "string" || !/^[\da-f]{64}$/.test(v.hash) || !objeto(v.hashes_campos) || !Array.isArray(v.campos_resumidos)
      || v.campos_resumidos.some(c => typeof c !== "string" || !Object.prototype.hasOwnProperty.call(v.campos, c)) || new Set(v.campos_resumidos).size !== v.campos_resumidos.length) throw falha();
    vistas.add(v.chave); const campos: Record<string, string> = {};
    if (Object.keys(v.campos).length > 20) throw falha();
    for (const [campo, conteudo] of Object.entries(v.campos)) {
      if (!campo.trim() || campo.length > 160 || ["__proto__", "constructor", "prototype"].includes(campo)) throw falha();
      campos[campo] = texto(conteudo, MAX_CARACTERES_FONTES_EMAIL_IA, true); caracteres += campos[campo].length + campo.length;
    }
    const hashes_campos: Record<string, string> = {};
    if (Object.keys(v.hashes_campos).length !== Object.keys(campos).length) throw falha();
    for (const campo of Object.keys(campos)) {
      const hash = v.hashes_campos[campo]; if (typeof hash !== "string" || !/^[\da-f]{64}$/.test(hash)) throw falha(); hashes_campos[campo] = hash;
    }
    if (v.estado === "indisponivel" && Object.keys(campos).length) throw falha();
    return { chave: v.chave, tipo: v.tipo as TipoFonteEmailIA, id: v.id, rotulo: texto(v.rotulo, 240), estado: v.estado as FonteEmailIA["estado"], campos, hash: v.hash, hashes_campos, campos_resumidos: v.campos_resumidos as string[] };
  });
  if (caracteres > MAX_CARACTERES_FONTES_EMAIL_IA + 5000) throw falha();
  const tiposAviso = new Set<string>();
  const nao_verificaveis = valor.nao_verificaveis.map((v): ItemNaoVerificavelEmailIA => {
    if (!objeto(v)) throw falha(); chaves(v, ["tipo", "motivo"]);
    if (!["preco", "prazo", "vagas", "desconto"].includes(String(v.tipo)) || tiposAviso.has(String(v.tipo))) throw falha();
    tiposAviso.add(String(v.tipo)); return { tipo: v.tipo as ItemNaoVerificavelEmailIA["tipo"], motivo: texto(v.motivo, 500) };
  });
  const snapshot: SnapshotFontesEmailIA = { versao: 1, capturado_em: new Date(valor.capturado_em).toISOString(), selecao, fontes, nao_verificaveis,
    ...(valor.cobertura_parcial === true ? { cobertura_parcial: true } : {}) };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA) throw falha();
  return snapshot;
}

async function hashTexto(texto: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
}
export type FonteContextoEmailIA = Omit<FonteEmailIA, "chave" | "hash" | "hashes_campos" | "campos_resumidos">;
export async function criarSnapshotFontesEmailIA(selecao: SelecaoFontesEmailIA, fontes: FonteContextoEmailIA[], agora = new Date(), naoVerificaveis: readonly ItemNaoVerificavelEmailIA[] = NAO_VERIFICAVEIS_FONTES_EMAIL_IA): Promise<SnapshotFontesEmailIA> {
  const resolvidas = await Promise.all(fontes.map(async f => {
    const assinatura = JSON.stringify([f.tipo, f.id, f.estado, canonico(f.campos)]);
    const hash = await hashTexto(assinatura);
    const hashes_campos = Object.fromEntries(await Promise.all(Object.entries(f.campos).map(async ([campo, conteudo]) => [campo, await hashTexto(conteudo)])));
    return { ...f, campos: { ...f.campos }, chave: `${f.tipo}:${f.id}`, hash, hashes_campos, campos_resumidos: [] as string[] };
  }));
  const snapshot = { versao: 1, capturado_em: agora.toISOString(), selecao, fontes: resolvidas, nao_verificaveis: naoVerificaveis };
  // Não cortamos fatos enviados ao modelo. Só a cópia exibida na comparação é
  // abreviada explicitamente; hashes completos continuam detectando mudanças.
  // A margem comporta a marca posterior de cobertura parcial sem invalidar um
  // snapshot que antes cabia exatamente no limite de persistência.
  for (let i = 0; new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA - 64; i++) {
    const maior = resolvidas.flatMap(fonte => Object.entries(fonte.campos).map(([campo, conteudo]) => ({ fonte, campo, conteudo }))).sort((a, b) => b.conteudo.length - a.conteudo.length)[0];
    if (!maior || maior.conteudo.length <= 120 || i >= 200) throw new Error("As fontes excedem o limite de 24 KB do registro de conferência. Reduza os materiais selecionados e tente novamente.");
    maior.fonte.campos[maior.campo] = maior.conteudo.slice(0, Math.max(120, Math.floor(maior.conteudo.length * 0.7))) + "…";
    if (!maior.fonte.campos_resumidos.includes(maior.campo)) maior.fonte.campos_resumidos.push(maior.campo);
  }
  return validarSnapshotFontesEmailIA(snapshot);
}

export function compararFontesEmailIA(anterior: unknown, atual: unknown): ComparacaoFontesEmailIA {
  const antes = validarSnapshotFontesEmailIA(anterior); const depois = validarSnapshotFontesEmailIA(atual);
  if (JSON.stringify(Object.entries(antes.selecao).sort()) !== JSON.stringify(Object.entries(depois.selecao).sort())) throw new Error("As fontes pertencem a seleções diferentes. Confira o contexto escolhido antes de comparar.");
  const antigas = new Map(antes.fontes.map(f => [f.chave, f])); const novas = new Map(depois.fontes.map(f => [f.chave, f]));
  const alteracoes: AlteracaoFonteEmailIA[] = [];
  for (const chave of new Set([...antigas.keys(), ...novas.keys()])) {
    const a = antigas.get(chave); const b = novas.get(chave); const fonte = b ?? a!;
    const indisponivel = b?.estado === "indisponivel";
    const mudouCampo = (campo: string) => a?.campos_resumidos.includes(campo) || b?.campos_resumidos.includes(campo)
      ? (a?.hashes_campos[campo] ?? null) !== (b?.hashes_campos[campo] ?? null) : (a?.campos[campo] ?? null) !== (b?.campos[campo] ?? null);
    if (a && b && a.estado === b.estado && [...new Set([...Object.keys(a.campos), ...Object.keys(b.campos)])].every(c => !mudouCampo(c))) continue;
    const campos = [...new Set([...Object.keys(a?.campos ?? {}), ...Object.keys(b?.campos ?? {})])].sort()
      .filter(mudouCampo)
      .map(campo => ({ campo, anterior: a?.campos[campo] ?? null, atual: b?.campos[campo] ?? null,
        ...(a?.campos_resumidos.includes(campo) ? { anterior_resumido: true } : {}), ...(b?.campos_resumidos.includes(campo) ? { atual_resumido: true } : {}) }));
    alteracoes.push({ chave, tipo: fonte.tipo, rotulo: fonte.rotulo, situacao: indisponivel ? "indisponivel" : !b ? "removida" : !a ? "adicionada" : "alterada", campos });
  }
  return { estado: depois.fontes.some(f => f.estado === "indisponivel") ? "indisponivel" : alteracoes.length ? "alterado" : depois.fontes.length ? "sem_alteracoes" : "sem_fontes", alteracoes };
}
