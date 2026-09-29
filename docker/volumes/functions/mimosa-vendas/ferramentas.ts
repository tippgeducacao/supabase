// Ferramentas da Mimosa de Vendas.
//
// Cada ferramenta é uma RPC `mimosa_*` do banco (migration 20260928160000), chamada
// com o JWT de QUEM PERGUNTA — é isso que faz `auth.uid()` existir lá dentro. A edge
// antiga (`sales-copilot-chat`) chamava as RPCs de curso com a service role e recebia
// tudo VAZIO (a service role não tem `sub`); não repita.
//
// Este arquivo não importa nada do runtime (nem supabase-js, nem o SDK): o cliente
// entra por parâmetro, para o vitest conseguir testar a validação e as fontes.
import { calcularOrcamento, ErroOrcamento } from "../_shared/mimosaOrcamento.ts";

export interface ClienteRpc {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type TipoFonte = "pedagogico" | "material" | "documento" | "busca" | "calculo";

export interface FonteMimosa {
  tipo: TipoFonte;
  rotulo: string;
  atualizado_em?: string | null;
  documento_id?: string | null;
  pagina?: number | null;
}

export interface ResultadoFerramenta {
  /** O que volta para o modelo (JSON em texto). */
  conteudo: string;
  erro: boolean;
  fontes: FonteMimosa[];
}

export const SECOES_PRODUTO = [
  "resumo",
  "grade",
  "grade_detalhada",
  "praticos",
  "professores",
  "turmas",
  "material",
  "links",
  "vocabulario",
  "aulas_extra",
] as const;

// Definições no formato da API (JSON Schema). A ordem é FIXA: o prompt caching
// casa por prefixo e as ferramentas vêm antes do system.
export const FERRAMENTAS = [
  {
    name: "detalhar_produto",
    description:
      "Abre UM produto no cadastro ao vivo. Aceita o nome (mesmo aproximado), o slug do material ou o id. " +
      "Seções: resumo (sempre vem: preço oficial, matrícula, formato, carga horária, coordenação, quem pode cursar, avisos), " +
      "grade (módulos e aulas com professor), grade_detalhada (grade + ementa de cada aula), praticos (módulos práticos com datas " +
      "de hoje em diante, cidade, horário e professores, por coorte), professores (lista com titulação e cargo), turmas " +
      "(em andamento e próxima, com dias e horário), material (playbook, ICP, dores, por que compra, SPIN, perguntas de conexão, " +
      "roteiro da reunião), links (links do material, conteúdo gratuito da área, links gerais como PIX e e-MEC), vocabulario, " +
      "aulas_extra. Sem `secoes`: resumo, grade, praticos, professores e turmas. Peça só o que a pergunta precisa.",
    input_schema: {
      type: "object",
      properties: {
        produto: { type: "string", description: "Nome do produto como o vendedor falou, slug ou id." },
        secoes: {
          type: "array",
          items: { type: "string", enum: [...SECOES_PRODUTO] },
          description: "Seções desejadas.",
        },
      },
      required: ["produto"],
    },
    eager_input_streaming: true,
  },
  {
    name: "buscar_na_base",
    description:
      "Busca geral por ASSUNTO em tudo que o comercial tem: grade e ementas de todas as pós, módulos práticos, aulas extras, " +
      "professores, apresentação de cada produto (ICP, dores, SPIN), roteiro de reunião, playbook, vocabulário, links do material, " +
      "conteúdo gratuito (aulas abertas, cursos gratuitos, webinars), links gerais, scripts do SDR (inclui o banco de objeções), " +
      "regras de quem pode cursar, avisos da gerência e os DOCUMENTOS enviados pela gestão. Use palavras-chave " +
      "(ex.: \"SISBI inspeção\", \"ultrassonografia\", \"objeção preço\"). Devolve trechos com a fonte e a data da última alteração.",
    input_schema: {
      type: "object",
      properties: {
        consulta: { type: "string", description: "Palavras-chave do assunto." },
      },
      required: ["consulta"],
    },
    eager_input_streaming: true,
  },
  {
    name: "modulos_praticos",
    description:
      "Módulos práticos presenciais de TODOS os cursos, só de hoje em diante, agrupados por encontro (cidade + dias seguidos), " +
      "com horário e professores. Filtre por produto, cidade e/ou período.",
    input_schema: {
      type: "object",
      properties: {
        produto: { type: "string", description: "Parte do nome do curso ou do módulo (opcional)." },
        cidade: { type: "string", description: "Cidade (opcional)." },
        de: { type: "string", description: "Data inicial AAAA-MM-DD (opcional; nunca antes de hoje)." },
        ate: { type: "string", description: "Data final AAAA-MM-DD (opcional)." },
      },
    },
    eager_input_streaming: true,
  },
  {
    name: "turmas",
    description:
      "Turmas de todos os cursos: as próximas a começar (e as em andamento, se pedir), com início, dias da semana e horário das aulas ao vivo.",
    input_schema: {
      type: "object",
      properties: {
        produto: { type: "string", description: "Parte do nome do curso (opcional)." },
        de: { type: "string", description: "Início a partir de AAAA-MM-DD (opcional)." },
        ate: { type: "string", description: "Início até AAAA-MM-DD (opcional)." },
        incluir_em_andamento: { type: "boolean", description: "Incluir turmas que já começaram e não terminaram." },
      },
    },
    eager_input_streaming: true,
  },
  {
    name: "buscar_professor",
    description:
      "Professores por nome ou por área/cargo/especialidade: titulação, cargo atual, bio, tópicos do currículo e em quais cursos ensina.",
    input_schema: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Nome (mesmo parcial) ou área, ex.: \"OPU aspiração folicular\"." },
      },
      required: ["termo"],
    },
    eager_input_streaming: true,
  },
  {
    name: "ler_documento",
    description:
      "Lê o texto de um documento enviado pela gestão (id vindo da lista de documentos ou de um resultado da busca). " +
      "Use pagina_inicial/pagina_final para ler só a parte relevante.",
    input_schema: {
      type: "object",
      properties: {
        documento_id: { type: "string", description: "Id do documento." },
        pagina_inicial: { type: "integer", description: "Primeira página (opcional)." },
        pagina_final: { type: "integer", description: "Última página (opcional)." },
      },
      required: ["documento_id"],
    },
    eager_input_streaming: true,
  },
  {
    name: "calcular_orcamento",
    description:
      "Calcula uma condição comercial EXATA (centavos certos, 2 casas): valor final com bolsa, parcela, entrada, matrícula com desconto, " +
      "total e vencimentos. Use SEMPRE que houver conta — nunca calcule de cabeça. Se as parcelas não fecharem no centavo, o resultado avisa.",
    input_schema: {
      type: "object",
      properties: {
        valor_integral: { type: "number", description: "Valor integral do curso em reais (ex.: 12730)." },
        desconto_percentual: { type: "number", description: "Bolsa/desconto em % sobre o integral (ex.: 20)." },
        valor_final: { type: "number", description: "Valor final já negociado, se houver (substitui a bolsa)." },
        parcelas: { type: "integer", description: "Número de parcelas (1 = à vista)." },
        entrada: { type: "number", description: "Entrada em reais (sai do valor antes de parcelar)." },
        matricula: { type: "number", description: "Valor cheio da matrícula em reais (ex.: 492.5)." },
        desconto_matricula_percentual: { type: "number", description: "Desconto da matrícula em %." },
        primeiro_vencimento: { type: "string", description: "Primeiro vencimento AAAA-MM-DD (opcional)." },
      },
      required: ["valor_integral"],
    },
    eager_input_streaming: true,
  },
];

export type NomeFerramenta = (typeof FERRAMENTAS)[number]["name"];

class EntradaInvalida extends Error {}

function texto(v: unknown, campo: string, { obrigatorio = false, max = 300 } = {}): string | null {
  if (v == null || v === "") {
    if (obrigatorio) throw new EntradaInvalida(`${campo} é obrigatório.`);
    return null;
  }
  if (typeof v !== "string") throw new EntradaInvalida(`${campo} precisa ser texto.`);
  const t = v.trim();
  if (!t && obrigatorio) throw new EntradaInvalida(`${campo} é obrigatório.`);
  return t ? t.slice(0, max) : null;
}

function data(v: unknown, campo: string): string | null {
  const t = texto(v, campo, { max: 10 });
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new EntradaInvalida(`${campo}: use AAAA-MM-DD.`);
  return t;
}

function inteiro(v: unknown, campo: string): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new EntradaInvalida(`${campo}: use um número inteiro.`);
  return n;
}

/** Status que o front mostra enquanto a ferramenta roda ("Consultando…"). */
export function statusDaFerramenta(nome: string, entrada: Record<string, unknown>): string {
  const aspas = (v: unknown) => (typeof v === "string" && v.trim() ? `“${v.trim().slice(0, 60)}”` : "");
  // Em primeira pessoa e com cara de gente (29/09/2026): "Consultando X no cadastro" e
  // "Buscando X em toda a base" soavam como log de sistema na tela do vendedor.
  switch (nome) {
    case "detalhar_produto":
      return `Abrindo a ficha de ${aspas(entrada.produto) || "produto"}`;
    case "buscar_na_base":
      return `Procurando ${aspas(entrada.consulta) || "isso"} nos materiais`;
    case "modulos_praticos":
      return `Olhando os módulos práticos${entrada.produto ? ` de ${aspas(entrada.produto)}` : ""}${entrada.cidade ? ` em ${aspas(entrada.cidade)}` : ""}`;
    case "turmas":
      return `Olhando as turmas${entrada.produto ? ` de ${aspas(entrada.produto)}` : ""}`;
    case "buscar_professor":
      return `Procurando ${aspas(entrada.termo) || "o professor"} entre os professores`;
    case "ler_documento":
      return "Lendo o documento";
    case "calcular_orcamento":
      return "Fazendo as contas do orçamento";
    default:
      return "Dando uma olhada no sistema";
  }
}

const MAX_CONTEUDO = 60_000;

function empacotar(dados: unknown): string {
  const json = JSON.stringify(dados ?? null);
  if (json.length <= MAX_CONTEUDO) return json;
  return `${json.slice(0, MAX_CONTEUDO)}… [cortado: resultado grande demais — peça menos seções ou filtre]`;
}

function maisRecente(...datas: unknown[]): string | null {
  let melhor: string | null = null;
  for (const d of datas) {
    if (typeof d === "string" && d && (!melhor || d > melhor)) melhor = d;
  }
  return melhor;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** As fontes que aparecem como etiquetas embaixo da resposta, com a data da última alteração. */
export function fontesDoResultado(nome: string, dados: Json, entrada: Record<string, unknown>): FonteMimosa[] {
  if (!dados || typeof dados !== "object" || dados.erro) return [];
  switch (nome) {
    case "detalhar_produto": {
      const produto = dados.resumo?.produto ?? String(entrada.produto ?? "produto");
      const fontes: FonteMimosa[] = [];
      const ped = maisRecente(
        dados.grade?.atualizado_em,
        dados.professores?.atualizado_em,
        ...(Array.isArray(dados.praticos?.modulos) ? dados.praticos.modulos.map((m: Json) => m?.atualizado_em) : []),
      );
      if (dados.resumo?.pos || dados.grade || dados.praticos || dados.turmas) {
        fontes.push({ tipo: "pedagogico", rotulo: `${produto} — cadastro do Pedagógico`, atualizado_em: ped });
      }
      if (dados.material) {
        fontes.push({
          tipo: "material",
          rotulo: `${produto} — material de venda`,
          atualizado_em: maisRecente(dados.material.playbook?.atualizado_em, dados.material.apresentacao?.atualizado_em),
        });
      } else if (dados.resumo?.material_de_venda) {
        fontes.push({ tipo: "material", rotulo: `${produto} — material de venda`, atualizado_em: dados.resumo.material_de_venda.atualizado_em ?? null });
      }
      return fontes;
    }
    case "buscar_na_base": {
      const vistos = new Set<string>();
      const fontes: FonteMimosa[] = [];
      for (const r of Array.isArray(dados.resultados) ? dados.resultados : []) {
        const doc = r?.fonte === "documento";
        const rotulo = doc
          ? String(r.titulo ?? "Documento").replace(/ — p\. \d+.*$/, "")
          : `${ROTULO_FONTE[r?.fonte as string] ?? "Base"}${r?.curso ? ` · ${r.curso}` : ""}`;
        if (vistos.has(rotulo)) continue;
        vistos.add(rotulo);
        fontes.push({
          tipo: doc ? "documento" : "busca",
          rotulo,
          atualizado_em: r?.atualizado_em ?? null,
          documento_id: doc ? (r?.ref?.documento_id ?? null) : null,
          pagina: doc ? (r?.ref?.pagina ?? null) : null,
        });
        if (fontes.length >= 6) break;
      }
      return fontes;
    }
    case "modulos_praticos":
      return [{ tipo: "pedagogico", rotulo: "Módulos práticos — Pedagógico", atualizado_em: dados.atualizado_em ?? null }];
    case "turmas":
      return [{ tipo: "pedagogico", rotulo: "Turmas — Pedagógico", atualizado_em: dados.atualizado_em ?? null }];
    case "buscar_professor":
      return [{
        tipo: "pedagogico",
        rotulo: "Professores — Pedagógico",
        atualizado_em: maisRecente(...(Array.isArray(dados.professores) ? dados.professores.map((p: Json) => p?.atualizado_em) : [])),
      }];
    case "ler_documento":
      return dados.documento
        ? [{ tipo: "documento", rotulo: String(dados.documento.titulo ?? "Documento"), atualizado_em: dados.documento.atualizado_em ?? null, documento_id: dados.documento.id ?? null }]
        : [];
    case "calcular_orcamento":
      return [{ tipo: "calculo", rotulo: "Cálculo exato (régua da Proposta Formalizada)" }];
    default:
      return [];
  }
}

const ROTULO_FONTE: Record<string, string> = {
  grade: "Grade",
  modulo_pratico: "Módulo prático",
  aula_ao_vivo_extra: "Aula ao vivo extra",
  professor: "Professor",
  apresentacao_do_produto: "Apresentação",
  roteiro_de_reuniao: "Roteiro de reunião",
  playbook: "Playbook",
  vocabulario: "Vocabulário",
  link_do_material: "Link do material",
  conteudo_gratuito: "Conteúdo gratuito",
  link_geral: "Links gerais",
  script_sdr: "Script do SDR",
  quem_pode_cursar: "Quem pode cursar",
  aviso_da_gerencia: "Aviso da gerência",
};

/** Executa uma ferramenta. Nunca lança: erro vira `tool_result` com `is_error`. */
export async function executarFerramenta(
  cliente: ClienteRpc,
  nome: string,
  entradaBruta: unknown,
): Promise<ResultadoFerramenta> {
  const entrada = (entradaBruta && typeof entradaBruta === "object" ? entradaBruta : {}) as Record<string, unknown>;
  try {
    let fn: string;
    let args: Record<string, unknown>;
    switch (nome) {
      case "detalhar_produto": {
        const secoes = Array.isArray(entrada.secoes)
          ? entrada.secoes.filter((s): s is string => typeof s === "string" && (SECOES_PRODUTO as readonly string[]).includes(s))
          : null;
        fn = "mimosa_produto";
        args = { p_ref: texto(entrada.produto, "produto", { obrigatorio: true, max: 200 }), p_secoes: secoes && secoes.length ? secoes : null };
        break;
      }
      case "buscar_na_base":
        fn = "mimosa_buscar";
        args = { p_consulta: texto(entrada.consulta, "consulta", { obrigatorio: true, max: 300 }), p_limite: 20 };
        break;
      case "modulos_praticos":
        fn = "mimosa_praticos";
        args = {
          p_produto: texto(entrada.produto, "produto", { max: 200 }),
          p_cidade: texto(entrada.cidade, "cidade", { max: 100 }),
          p_de: data(entrada.de, "de"),
          p_ate: data(entrada.ate, "ate"),
        };
        break;
      case "turmas":
        fn = "mimosa_turmas";
        args = {
          p_produto: texto(entrada.produto, "produto", { max: 200 }),
          p_de: data(entrada.de, "de"),
          p_ate: data(entrada.ate, "ate"),
          p_incluir_em_andamento: entrada.incluir_em_andamento === true,
        };
        break;
      case "buscar_professor":
        fn = "mimosa_professores";
        args = { p_termo: texto(entrada.termo, "termo", { obrigatorio: true, max: 200 }), p_limite: 8 };
        break;
      case "ler_documento": {
        const id = texto(entrada.documento_id, "documento_id", { obrigatorio: true, max: 40 })!;
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new EntradaInvalida("documento_id inválido.");
        fn = "mimosa_documento_ler";
        args = {
          p_documento_id: id,
          p_pagina_inicial: inteiro(entrada.pagina_inicial, "pagina_inicial"),
          p_pagina_final: inteiro(entrada.pagina_final, "pagina_final"),
          p_limite_caracteres: 24000,
        };
        break;
      }
      case "calcular_orcamento": {
        const r = calcularOrcamento(entrada as never);
        return { conteudo: empacotar(r), erro: false, fontes: fontesDoResultado(nome, r, entrada) };
      }
      default:
        return { conteudo: JSON.stringify({ erro: `Ferramenta desconhecida: ${nome}` }), erro: true, fontes: [] };
    }

    const { data: dados, error } = await cliente.rpc(fn, args);
    if (error) {
      return { conteudo: JSON.stringify({ erro: `Falha ao consultar o sistema: ${error.message}` }), erro: true, fontes: [] };
    }
    return { conteudo: empacotar(dados), erro: false, fontes: fontesDoResultado(nome, dados, entrada) };
  } catch (e) {
    const msg = e instanceof EntradaInvalida || e instanceof ErroOrcamento
      ? e.message
      : `Erro inesperado: ${(e as Error)?.message ?? String(e)}`;
    return { conteudo: JSON.stringify({ erro: msg }), erro: true, fontes: [] };
  }
}
