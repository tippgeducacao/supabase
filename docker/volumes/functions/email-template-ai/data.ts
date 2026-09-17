import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { dadosDoCurso } from "../crm-agente-sdr/catalogoCursos.ts";
import { resolverOfertaEmailIA } from "./ofertas.ts";
import { compararFontesEmailIA, criarSnapshotFontesEmailIA, MAX_CARACTERES_FONTES_EMAIL_IA, validarSnapshotFontesEmailIA, type FonteContextoEmailIA, type SnapshotFontesEmailIA, type TipoFonteEmailIA } from "../_shared/emailBuilder/aiFontes.ts";

type Objeto = Record<string, unknown>;
export interface SelecaoContextoEmailIA { curso_id?: string; campanha_id?: string; marca_id?: string; oferta_id?: string; usar_resultados?: boolean }
export interface ImagemBibliotecaEmailIA { id: string; nome: string; url: string; origem: string; curso_id?: string; marca_id?: string }
export interface ContextoEmailIA {
  texto: string;
  fontes: string[];
  imagens: ImagemBibliotecaEmailIA[];
  imagensPermitidas: string[];
  snapshot_fontes: SnapshotFontesEmailIA;
}
export class ErroDadosEmailIA extends Error {
  constructor(public status: number, public code: string, mensagem: string) { super(mensagem); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const objeto = (v: unknown): v is Objeto => !!v && typeof v === "object" && !Array.isArray(v);
const invalido = (mensagem: string) => new ErroDadosEmailIA(400, "BAD_REQUEST", mensagem);
const indisponivel = () => new ErroDadosEmailIA(503, "CONTEXT_UNAVAILABLE", "Não foi possível consultar os materiais cadastrados. Tente novamente.");
const texto = (v: unknown, limite = 3000) => typeof v === "string" ? v.trim().slice(0, limite) : "";

export function validarSelecaoContextoEmailIA(valor: unknown): SelecaoContextoEmailIA {
  if (valor == null) return {};
  if (!objeto(valor) || Object.keys(valor).some(k => !["curso_id", "campanha_id", "marca_id", "oferta_id", "usar_resultados"].includes(k))) throw invalido("Selecione um contexto válido para criar o e-mail.");
  const selecao: SelecaoContextoEmailIA = {};
  for (const chave of ["curso_id", "campanha_id", "marca_id", "oferta_id"] as const) {
    const id = valor[chave];
    if (id == null || id === "") continue;
    if (typeof id !== "string" || !UUID.test(id)) throw invalido("A seleção de contexto é inválida.");
    selecao[chave] = id;
  }
  if (selecao.oferta_id && !selecao.curso_id) throw invalido("Selecione o curso da oferta comercial.");
  if (valor.usar_resultados !== undefined) {
    if (typeof valor.usar_resultados !== "boolean" || valor.usar_resultados && !selecao.campanha_id) throw invalido("Selecione uma campanha para usar os resultados.");
    if (valor.usar_resultados) selecao.usar_resultados = true;
  }
  return selecao;
}

/** URLs são lidas do cadastro, nunca baixadas pelo worker. Recusa arquivos
 * executáveis/vetoriais e URLs temporárias que deixariam o e-mail sem imagem. */
export function urlImagemBiblioteca(valor: unknown): string | null {
  if (typeof valor !== "string" || valor.length > 2048) return null;
  try {
    const url = new URL(valor);
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || /\.(svg|html?|js|pdf)(?:$|\/)/i.test(url.pathname)
      || /\/object\/sign\//.test(url.pathname)
      || [...url.searchParams.keys()].some(k => /^(token|signature|expires|x-amz-.+)$/i.test(k))) return null;
    return url.href;
  } catch { return null; }
}
function urlLink(valor: unknown): string | null {
  if (typeof valor !== "string" || valor.length > 2048) return null;
  try { const u = new URL(valor); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}

type Consulta = PromiseLike<{ data: unknown; error: unknown }>;
async function consultarLista(consulta: Consulta): Promise<Objeto[]> {
  const { data, error } = await consulta;
  if (error || !Array.isArray(data)) throw indisponivel();
  return data as Objeto[];
}
async function consultarUm(consulta: Consulta): Promise<Objeto | null> {
  const { data, error } = await consulta;
  if (error) throw indisponivel();
  return objeto(data) ? data : null;
}
async function listarPaginado(criar: (inicio: number, fim: number) => Consulta): Promise<Objeto[]> {
  const itens: Objeto[] = [];
  for (let inicio = 0; ; inicio += 500) {
    const pagina = await consultarLista(criar(inicio, inicio + 499));
    itens.push(...pagina);
    if (pagina.length < 500) return itens;
    if (itens.length >= 10000) throw new ErroDadosEmailIA(413, "CATALOG_TOO_LARGE", "O catálogo ultrapassa o limite de consulta. Refine os materiais ativos antes de carregar.");
  }
}
function imagensCurso(curso: Objeto): ImagemBibliotecaEmailIA[] {
  return (["banner", "thumbnail"] as const).flatMap(tipo => {
    const url = urlImagemBiblioteca(curso[`${tipo}_url`]);
    return url ? [{ id: `curso:${curso.id}:${tipo}`, nome: `${curso.nome} — ${tipo === "banner" ? "Banner" : "Capa"}`, url, origem: "Catálogo de cursos", curso_id: String(curso.id) }] : [];
  });
}
function imagemMarketing(item: Objeto): ImagemBibliotecaEmailIA[] {
  const url = urlImagemBiblioteca(item.generated_image_url);
  return url ? [{ id: `marketing:${item.id}`, nome: texto(item.title, 180) || "Imagem aprovada", url, origem: "Marketing · aprovado", ...(typeof item.brand_profile_id === "string" ? { marca_id: item.brand_profile_id } : {}) }] : [];
}
function linha(rotulo: string, valor: unknown, limite = 3000): string {
  const conteudo = Array.isArray(valor) ? valor.filter(v => typeof v === "string").join(", ").slice(0, limite) : texto(valor, limite);
  return conteudo ? `${rotulo}: ${conteudo}` : "";
}

export async function resolverContextoEmailIA(cliente: SupabaseClient, valor: unknown, _urlPublica: string, opcoes: { conferencia?: boolean } = {}): Promise<ContextoEmailIA> {
  const selecao = validarSelecaoContextoEmailIA(valor);
  const oferta = await resolverOfertaEmailIA(cliente, selecao, opcoes);
  const partes: string[] = []; const fontes: string[] = []; const imagens: ImagemBibliotecaEmailIA[] = [];
  const registros: FonteContextoEmailIA[] = []; let caracteres = 0;
  const indisponivelSelecionada = (tipo: TipoFonteEmailIA, id: string, rotulo: string, mensagem: string) => {
    if (!opcoes.conferencia) throw invalido(mensagem);
    registros.push({ tipo, id, rotulo, estado: "indisponivel", campos: {} });
  };
  const adicionar = (tipo: TipoFonteEmailIA, id: string, rotulo: string, valores: Array<[string, unknown, number?]>) => {
    const campos: Record<string, string> = {}; const linhas: string[] = [];
    for (const [campo, valorCampo, limite = 3000] of valores) {
      const completa = linha(campo, valorCampo, limite); if (!completa) continue;
      const inicio = campo.length + 2;
      const disponivel = MAX_CARACTERES_FONTES_EMAIL_IA - caracteres - inicio - 2;
      if (disponivel <= 0) break;
      const conteudo = completa.slice(inicio, inicio + disponivel);
      if (!conteudo) break;
      campos[campo] = conteudo; linhas.push(`${campo}: ${conteudo}`); caracteres += campo.length + 2 + conteudo.length + 2;
    }
    // O snapshot só registra valores que entraram no texto efetivamente enviado.
    // O limite global preexistente não pode fazer parecer que o modelo leu uma
    // marca/playbook que ficou inteiramente fora do seu contexto.
    if (!linhas.length) return;
    partes.push(linhas.join("\n")); fontes.push(rotulo.slice(0, 240));
    registros.push({ tipo, id, rotulo: rotulo.slice(0, 240), estado: "disponivel", campos });
  };
  // Condições aprovadas entram primeiro: o limite global não pode cortar preço,
  // validade ou ressalvas para acomodar um playbook longo.
  if (oferta) {
    if (oferta.fonte.estado === "indisponivel") registros.push(oferta.fonte);
    else adicionar("oferta", oferta.fonte.id, oferta.fonte.rotulo, Object.entries(oferta.fonte.campos));
  }
  if (selecao.curso_id) {
    const curso = await consultarUm(cliente.from("comercial_cursos").select("id,nome,curso_id,resumo_curto,cor_destaque,banner_url,thumbnail_url").eq("id", selecao.curso_id).eq("ativo", true).maybeSingle());
    if (!curso) indisponivelSelecionada("curso", selecao.curso_id, "Curso selecionado", "O curso selecionado não está mais disponível no catálogo ativo.");
    else {
      const [playbooks, links, cadastro] = await Promise.all([
        consultarLista(cliente.from("comercial_curso_playbook").select("definicao,descricao_detalhada,publico_alvo,habilidades,objetivos_profissionais,professores_destaques,modulos_duracao,formato_aulas,dores_limitacoes").eq("curso_id", curso.id).eq("ativo", true).order("versao", { ascending: false }).limit(1)),
        listarPaginado((inicio, fim) => cliente.from("comercial_curso_links").select("titulo,url,tipo,descricao").eq("curso_id", curso.id).eq("ativo", true).order("ordem").order("id").range(inicio, fim)),
        curso.curso_id ? consultarUm(cliente.from("cursos").select("id,nome").eq("id", curso.curso_id).eq("ativo", true).maybeSingle()) : Promise.resolve(null),
      ]);
      const modalidade = cadastro ? dadosDoCurso({ id: String(cadastro.id), nome: String(cadastro.nome) }) : null;
      adicionar("curso", selecao.curso_id, `Catálogo de cursos: ${curso.nome}`, [
        ["CURSO CADASTRADO", curso.nome], ["Resumo", curso.resumo_curto], ["Cor de destaque", curso.cor_destaque, 20],
        ["Modalidade de entrega", `${modalidade?.modalidade_confirmada ? modalidade.modalidades.join(" / ") : "não confirmada; não inferir a modalidade pelo nome do curso ou pelo material"}.`],
        ["Conferência comercial", oferta?.oferta ? "As condições confirmadas estão na oferta aprovada selecionada. O catálogo do curso não confirma outras condições ou prazo geral de matrícula." : "Preço, vagas, desconto e prazo de matrícula não foram confirmados por esta consulta."],
      ]);
      const playbook = playbooks[0];
      if (playbook) adicionar("playbook", selecao.curso_id, `Playbook: ${curso.nome}`, [
        ["Definição", playbook.definicao], ["Conteúdo", playbook.descricao_detalhada, 5000], ["Público", playbook.publico_alvo],
        ["Habilidades", playbook.habilidades], ["Objetivos profissionais", playbook.objetivos_profissionais], ["Professores", playbook.professores_destaques],
        // Carga horária e formato das aulas são o que todo e-mail de curso precisa dizer
        // e ficavam de fora: sem eles a IA não tinha como responder "quanto dura" e
        // "como assisto" a não ser inventando. Preenchidos em 10 de 10 playbooks ativos.
        ["Carga horária e módulos", playbook.modulos_duracao], ["Formato das aulas", playbook.formato_aulas],
        ["Dores do público", playbook.dores_limitacoes],
      ]);
      const linksUsados = links.filter(link => urlLink(link.url)).slice(0, 50).map(link => `${texto(link.titulo, 160)} (${link.tipo}): ${urlLink(link.url)}`).join("\n");
      if (linksUsados) adicionar("links", selecao.curso_id, `Links cadastrados: ${curso.nome}`, [["Links cadastrados", linksUsados, MAX_CARACTERES_FONTES_EMAIL_IA]]);
      imagens.push(...imagensCurso(curso));
    }
  }
  if (selecao.campanha_id) {
    const campanha = await consultarUm(cliente.from("email_campanhas").select("id,nome,status,template_id,segmento_id").eq("id", selecao.campanha_id).maybeSingle());
    if (!campanha) indisponivelSelecionada("campanha", selecao.campanha_id, "Campanha selecionada", "A campanha selecionada não está mais disponível.");
    else {
      // Somente a descrição do público. Não consultamos contatos, filtros,
      // remetentes ou métricas. Conteúdo anterior não é oferta comercial atual.
      const [template, segmento] = await Promise.all([
        consultarUm(cliente.from("email_templates").select("nome,assunto,descricao,corpo_texto,conteudo_json").eq("id", campanha.template_id).maybeSingle()),
        consultarUm(cliente.from("email_segmentos").select("nome,descricao").eq("id", campanha.segmento_id).maybeSingle()),
      ]);
      const links: string[] = [];
      if (objeto(template?.conteudo_json) && Array.isArray(template.conteudo_json.linhas)) {
        for (const l of template.conteudo_json.linhas) if (objeto(l) && Array.isArray(l.colunas)) for (const c of l.colunas) if (objeto(c) && Array.isArray(c.blocos)) for (const b of c.blocos) {
          if (objeto(b) && objeto(b.props)) { const url = urlLink(b.props.href); if (url && links.length < 30 && !links.includes(url)) links.push(url); }
        }
      }
      adicionar("campanha", selecao.campanha_id, `Campanha de e-mail: ${campanha.nome}`, [
        ["CAMPANHA CADASTRADA", campanha.nome], ["Público", segmento?.nome], ["Descrição do público", segmento?.descricao],
        ["Assunto anterior", template?.assunto], ["Descrição", template?.descricao],
        ["Texto anterior (referência histórica; condições e prazos exigem conferência)", template?.corpo_texto, 5000],
        ["Links da campanha", links.join("\n"), MAX_CARACTERES_FONTES_EMAIL_IA],
      ]);
    }
  }
  if (selecao.marca_id) {
    const marca = await consultarUm(cliente.from("brand_profiles").select("id,account_name,brand_name,publico_alvo,tom_de_voz,tom_descricao,estrutura_visual,regras_estilo,termos_obrigatorios,termos_proibidos,alertas_nao_usar").eq("id", selecao.marca_id).eq("is_active", true).maybeSingle());
    if (!marca) indisponivelSelecionada("marca", selecao.marca_id, "Perfil de marca selecionado", "O perfil de marca selecionado não está mais ativo.");
    else adicionar("marca", selecao.marca_id, `Perfil de marca: ${marca.brand_name || marca.account_name}`, [
      ["PERFIL DE MARCA", marca.brand_name || marca.account_name], ["Público", marca.publico_alvo], ["Tom de voz", marca.tom_de_voz],
      ["Descrição do tom", marca.tom_descricao], ["Direção visual", marca.estrutura_visual], ["Regras de estilo", marca.regras_estilo],
      ["Termos obrigatórios", marca.termos_obrigatorios], ["Termos proibidos", marca.termos_proibidos], ["Evitar", marca.alertas_nao_usar],
    ]);
  }
  let snapshot_fontes: SnapshotFontesEmailIA;
  try { snapshot_fontes = await criarSnapshotFontesEmailIA(selecao, registros, new Date(), oferta?.naoVerificaveis); }
  catch { throw new ErroDadosEmailIA(413, "SOURCES_TOO_LARGE", "Não foi possível registrar as fontes dentro do limite de 24 KB. Reduza os materiais selecionados e tente novamente."); }
  return { texto: partes.join("\n\n"), fontes, imagens, imagensPermitidas: imagens.map(i => i.url), snapshot_fontes };
}

export async function listarImagensBibliotecaEmailIA(cliente: SupabaseClient, valor: unknown, usuarioId: string): Promise<ImagemBibliotecaEmailIA[]> {
  if (!UUID.test(usuarioId)) throw invalido("Não foi possível identificar o dono da biblioteca.");
  const selecao = validarSelecaoContextoEmailIA(valor);
  const [cursos, marketing] = await Promise.all([
    listarPaginado((inicio, fim) => {
      let consulta = cliente.from("comercial_cursos").select("id,nome,banner_url,thumbnail_url").eq("ativo", true).order("nome").order("id");
      if (selecao.curso_id) consulta = consulta.eq("id", selecao.curso_id);
      return consulta.range(inicio, fim);
    }),
    listarPaginado((inicio, fim) => {
      // A RLS do pipeline só libera o próprio autor; service_role não deve
      // transformar a biblioteca de e-mails em acesso às artes privadas alheias.
      let consulta = cliente.from("ai_content_pipeline").select("id,title,generated_image_url,brand_profile_id").eq("user_id", usuarioId).eq("status", "approved").order("updated_at", { ascending: false }).order("id");
      if (selecao.marca_id) consulta = consulta.eq("brand_profile_id", selecao.marca_id);
      return consulta.range(inicio, fim);
    }),
  ]);
  return [...cursos.flatMap(imagensCurso), ...marketing.flatMap(imagemMarketing)];
}

export async function resolverImagensBibliotecaEmailIA(cliente: SupabaseClient, ids: unknown, valor: unknown, _urlPublica: string, usuarioId: string): Promise<ImagemBibliotecaEmailIA[]> {
  if (ids == null) return [];
  if (!Array.isArray(ids) || ids.length > 4 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw invalido("Selecione até quatro imagens da biblioteca.");
  const selecao = validarSelecaoContextoEmailIA(valor);
  return Promise.all(ids.map(async (id): Promise<ImagemBibliotecaEmailIA> => {
    const [origem, registroId, tipo, extra] = id.split(":");
    if (!UUID.test(registroId ?? "") || extra) throw invalido("A imagem selecionada não pertence à biblioteca.");
    let imagens: ImagemBibliotecaEmailIA[] = [];
    if (origem === "curso" && ["banner", "thumbnail"].includes(tipo)) {
      if (selecao.curso_id && selecao.curso_id !== registroId) throw invalido("A imagem pertence a outro curso. Atualize a seleção da biblioteca.");
      const curso = await consultarUm(cliente.from("comercial_cursos").select("id,nome,banner_url,thumbnail_url").eq("id", registroId).eq("ativo", true).maybeSingle());
      if (curso) imagens = imagensCurso(curso);
    } else if (origem === "marketing" && !tipo) {
      if (!UUID.test(usuarioId)) throw invalido("Não foi possível identificar o dono da biblioteca.");
      let consulta = cliente.from("ai_content_pipeline").select("id,title,generated_image_url,brand_profile_id").eq("id", registroId).eq("user_id", usuarioId).eq("status", "approved");
      if (selecao.marca_id) consulta = consulta.eq("brand_profile_id", selecao.marca_id);
      const item = await consultarUm(consulta.maybeSingle());
      if (item) imagens = imagemMarketing(item);
    }
    const imagem = imagens.find(i => i.id === id);
    if (!imagem) throw invalido("Uma imagem deixou de estar disponível ou aprovada. Atualize a biblioteca.");
    return imagem;
  }));
}

/** Chamado somente DEPOIS da autorização admin/diretor feita pelo handler. */
export async function tratarAcaoDadosEmailIA(corpo: Objeto, deps: { cliente: SupabaseClient; usuarioId: string; urlPublica: string }): Promise<Objeto | null> {
  if (corpo.acao === "listar_contextos") {
    const [cursos, campanhas, marcas] = await Promise.all([
      listarPaginado((inicio, fim) => deps.cliente.from("comercial_cursos").select("id,nome").eq("ativo", true).order("nome").order("id").range(inicio, fim)),
      listarPaginado((inicio, fim) => deps.cliente.from("email_campanhas").select("id,nome").order("criada_em", { ascending: false }).order("id").range(inicio, fim)),
      listarPaginado((inicio, fim) => deps.cliente.from("brand_profiles").select("id,brand_name,account_name").eq("is_active", true).order("account_name").order("id").range(inicio, fim)),
    ]);
    return { cursos, campanhas, marcas: marcas.map(m => ({ id: m.id, nome: m.brand_name || m.account_name })) };
  }
  if (corpo.acao === "carregar_contexto") return { contexto: await resolverContextoEmailIA(deps.cliente, corpo.contexto, deps.urlPublica) };
  if (corpo.acao === "conferir_fontes") {
    let anterior: SnapshotFontesEmailIA;
    try { anterior = validarSnapshotFontesEmailIA(corpo.snapshot_fontes); }
    catch { throw invalido("O registro das fontes está inválido. Gere uma nova proposta para registrar o contexto atual."); }
    const atual = await resolverContextoEmailIA(deps.cliente, anterior.selecao, deps.urlPublica, { conferencia: true });
    return { snapshot_fontes: atual.snapshot_fontes, comparacao: compararFontesEmailIA(anterior, atual.snapshot_fontes) };
  }
  if (corpo.acao === "listar_imagens") return { imagens: await listarImagensBibliotecaEmailIA(deps.cliente, corpo.contexto, deps.usuarioId) };
  return null;
}
