import { normalizarEmail } from "./supressao.ts";

export interface FiltroSegmentoEmail { campo: string; operador: string; valor: unknown }
export interface QuerySegmentoEmail { tabela: string; filtros: FiltroSegmentoEmail[] }
export interface ContatoSegmentoEmail { email: string; nome: string | null; metadata: unknown }
export interface SegmentoEmail {
  tipo: "dinamico" | "estatico";
  query_dinamica?: QuerySegmentoEmail | null;
  contatos_estaticos?: unknown[] | null;
}

// A prévia e o disparo precisam resolver o MESMO público. Em 14/09/2026 o
// assistente oferecia colunas que não existem e a fila tratava a falha como zero.
export const FONTES_SEGMENTO_EMAIL: Record<string, { emailCol: string; nomeCol: string; campos: readonly string[] }> = {
  profiles: { emailCol: "email", nomeCol: "name", campos: ["ativo", "departamento_id", "user_type", "nivel"] },
  ped_professores: { emailCol: "email", nomeCol: "nome", campos: ["ativo", "status"] },
  alunos: { emailCol: "email", nomeCol: "nome", campos: [] },
  leads: { emailCol: "email", nomeCol: "nome", campos: ["status", "curso_interesse", "origem_criacao"] },
};
const OPERADORES = new Set(["eq", "neq", "in", "contains", "gt", "lt", "is_null", "is_not_null"]);

export function validarQuerySegmentoEmail(valor: unknown): QuerySegmentoEmail {
  if (!valor || typeof valor !== "object") throw new Error("Configure a origem do segmento.");
  const query = valor as QuerySegmentoEmail;
  if (typeof query.tabela !== "string" || !Object.prototype.hasOwnProperty.call(FONTES_SEGMENTO_EMAIL, query.tabela)) {
    throw new Error("Origem de contatos não permitida.");
  }
  if (!Array.isArray(query.filtros)) throw new Error("Os filtros do segmento são inválidos.");
  const cfg = FONTES_SEGMENTO_EMAIL[query.tabela];
  for (const filtro of query.filtros) {
    if (!filtro || !cfg.campos.includes(filtro.campo)) throw new Error("O segmento contém um campo de filtro indisponível. Revise os critérios.");
    if (!OPERADORES.has(filtro.operador)) throw new Error("O segmento contém um operador de filtro inválido.");
    if (["is_null", "is_not_null"].includes(filtro.operador)) continue;
    if (filtro.operador === "in") {
      if (!Array.isArray(filtro.valor) || filtro.valor.length === 0 || filtro.valor.some(v => v == null || String(v).trim() === "")) {
        throw new Error("Informe pelo menos um valor para o filtro em lista.");
      }
    } else if (filtro.valor == null || typeof filtro.valor === "object" || String(filtro.valor).trim() === "") {
      throw new Error("Preencha o valor de todos os filtros.");
    }
  }
  return query;
}

// O cliente PostgREST compartilha os mesmos operadores para tabelas diferentes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aplicarFiltrosSegmento(consulta: any, filtros: FiltroSegmentoEmail[]) {
  for (const filtro of filtros) {
    switch (filtro.operador) {
      case "eq": consulta = consulta.eq(filtro.campo, filtro.valor); break;
      case "neq": consulta = consulta.neq(filtro.campo, filtro.valor); break;
      case "in": consulta = consulta.in(filtro.campo, filtro.valor); break;
      case "contains": consulta = consulta.ilike(filtro.campo, `%${filtro.valor}%`); break;
      case "gt": consulta = consulta.gt(filtro.campo, filtro.valor); break;
      case "lt": consulta = consulta.lt(filtro.campo, filtro.valor); break;
      case "is_null": consulta = consulta.is(filtro.campo, null); break;
      case "is_not_null": consulta = consulta.not(filtro.campo, "is", null); break;
    }
  }
  return consulta;
}

export function normalizarContatosSegmentoEmail(contatos: unknown[]): ContatoSegmentoEmail[] {
  const unicos = new Map<string, ContatoSegmentoEmail>();
  for (const contato of contatos) {
    if (!contato || typeof contato !== "object") continue;
    const registro = contato as Record<string, unknown>;
    if (typeof registro.email !== "string") continue;
    const email = normalizarEmail(registro.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || unicos.has(email)) continue;
    unicos.set(email, {
      email,
      nome: typeof registro.nome === "string" ? registro.nome : null,
      metadata: registro.metadata ?? null,
    });
  }
  return [...unicos.values()];
}

// Cada tentativa completa os lotes que faltaram sem recriar IDs já enfileirados.
// O ID da fila também compõe a chave de idempotência do envio no provedor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function enfileirarContatosSegmentoEmail(cliente: any, campanhaId: string, contatos: ContatoSegmentoEmail[]): Promise<void> {
  for (let inicio = 0; inicio < contatos.length; inicio += 500) {
    const linhas = contatos.slice(inicio, inicio + 500).map(contato => ({
      campanha_id: campanhaId,
      contato_email: contato.email,
      contato_nome: contato.nome,
      contato_metadata: contato.metadata,
      status: "pendente",
    }));
    const { error } = await cliente.from("email_campanhas_envios").upsert(linhas, {
      onConflict: "campanha_id,contato_email", ignoreDuplicates: true,
    });
    if (error) throw new Error("Não foi possível concluir a fila da campanha. A preparação será retomada sem duplicar contatos.");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolverSegmentoEmail(cliente: any, segmento: SegmentoEmail): Promise<ContatoSegmentoEmail[]> {
  if (!segmento || !["estatico", "dinamico"].includes(segmento.tipo)) throw new Error("Segmento inválido ou indisponível.");
  if (segmento.tipo === "estatico") {
    if (!Array.isArray(segmento.contatos_estaticos)) throw new Error("A lista de contatos do segmento é inválida.");
    return normalizarContatosSegmentoEmail(segmento.contatos_estaticos);
  }
  const query = validarQuerySegmentoEmail(segmento.query_dinamica);
  const cfg = FONTES_SEGMENTO_EMAIL[query.tabela];
  const contatos: unknown[] = [];
  // PostgREST limita cada resposta a 1.000 linhas mesmo com limit(10000).
  // A ordem por chave primária evita que páginas adjacentes troquem de posição.
  const tamanhoPagina = 1000;
  for (let inicio = 0; ; inicio += tamanhoPagina) {
    let consulta = cliente.from(query.tabela)
      .select(`${cfg.emailCol},${cfg.nomeCol}`)
      .not(cfg.emailCol, "is", null)
      .order("id", { ascending: true })
      .range(inicio, inicio + tamanhoPagina - 1);
    consulta = aplicarFiltrosSegmento(consulta, query.filtros);
    const { data, error } = await consulta;
    if (error) throw new Error("Não foi possível consultar os contatos do segmento. Revise os filtros e tente novamente.");
    if (!Array.isArray(data)) throw new Error("A consulta do segmento não retornou uma lista válida.");
    contatos.push(...data.map((registro: Record<string, unknown>) => ({ email: registro[cfg.emailCol], nome: registro[cfg.nomeCol] })));
    if (data.length < tamanhoPagina) break;
  }
  return normalizarContatosSegmentoEmail(contatos);
}
