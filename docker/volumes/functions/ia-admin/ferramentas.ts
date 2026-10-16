// Ferramentas da IA Administrativa.
//
// Tudo é leitura, menos `registrar_achado` (que só grava na fila de achados). As consultas ao
// banco passam por `ia_admin_sql` (migration 20261016180000): transação SÓ-LEITURA, como o
// papel `ia_admin_leitor`, sem coluna sensível e com lista de bloqueio. No chat a RPC é chamada
// com o JWT de quem pergunta (diretor/admin); na varredura, com a service role.
//
// Sem import de runtime: o cliente entra por parâmetro, para o vitest testar a validação.

export interface ClienteRpc {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** O que a tela mostra de cada passo (e o que fica salvo na mensagem). */
export interface EtapaIa {
  ferramenta: string;
  rotulo: string;
  /** SQL executado, termo buscado, tabela… */
  detalhe?: string;
  linhas?: number;
  ms?: number;
  erro?: string;
  achado_id?: string;
}

export interface ResultadoFerramenta {
  /** O que volta para o modelo (texto/JSON). */
  conteudo: string;
  erro: boolean;
  etapa: EtapaIa;
  /** Resumo compacto para o histórico do modelo nas próximas perguntas do chat. */
  memoria?: string;
  /** A ferramenta fecha o trabalho (entregar_prompt): o laço para sem mais uma rodada. */
  encerra?: boolean;
}

/** O que a IA entrega no modo "prompt" (demanda nova do TI → gt_tarefa_prompts). */
export interface EntregaPrompt {
  tipo: "codigo" | "operacao" | "fora_do_sistema" | "informacao_insuficiente";
  entendimento: string;
  motivo: string | null;
  prompt: string | null;
  perguntas: string | null;
}

export const TIPOS_ENTREGA = ["codigo", "operacao", "fora_do_sistema", "informacao_insuficiente"] as const;

export interface ContextoFerramentas {
  cliente: ClienteRpc;
  modo: "chat" | "varredura" | "prompt";
  checagemId?: string | null;
  rodadaItemId?: string | null;
  /** Modo prompt: recebe a entrega da IA (a edge grava em gt_tarefa_prompts). */
  entregarPrompt?: (e: EntregaPrompt) => void;
  /** Auditoria de cada chamada (tabela ia_admin_consultas). Nunca deve lançar. */
  auditar?: (log: { ferramenta: string; entrada: string; ok: boolean; linhas?: number; ms?: number; erro?: string }) => Promise<void>;
}

const LIMITE_RESULTADO = 24_000;
const LIMITE_CAMPO = 400;

// Ordem FIXA: o prompt caching casa por prefixo e as ferramentas vêm antes do system.
export const FERRAMENTAS = [
  {
    name: "consultar_banco",
    description:
      "Executa UM SELECT (ou WITH … SELECT) no banco de produção, somente leitura, e devolve até 200 linhas em JSON. " +
      "Use para verificar QUALQUER afirmação antes de fazê-la. Regras: uma consulta por vez, sem ';' no meio e sem comentários; " +
      "só o schema public (pg_catalog/information_schema também); colunas sensíveis (cpf, pix, salário, tokens, senhas, chaves) " +
      "não existem para você — selecione as colunas pelo nome em vez de '*' nas tabelas que as têm. Prefira agregar (count, " +
      "group by) e trazer poucos exemplos com LIMIT. Datas: o banco guarda em UTC; para o dia de Brasília use " +
      "(coluna AT TIME ZONE 'America/Sao_Paulo'). Se der erro, leia a mensagem e corrija a consulta.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A consulta SELECT completa." },
        objetivo: { type: "string", description: "Em poucas palavras, o que esta consulta verifica (aparece para o admin)." },
      },
      required: ["sql", "objetivo"],
    },
    eager_input_streaming: true,
  },
  {
    name: "listar_tabelas",
    description:
      "Lista as tabelas e views do schema public que você pode ler, com linhas estimadas e a descrição. Passe `busca` " +
      "(parte do nome ou da descrição, ex.: 'agend', 'sac', 'rh') para filtrar — sem busca vêm todas, o que é longo.",
    input_schema: {
      type: "object",
      properties: { busca: { type: "string", description: "Parte do nome/descrição da tabela." } },
    },
  },
  {
    name: "descrever_tabela",
    description:
      "Mostra as colunas de uma tabela: tipo, se aceita nulo, se você pode ler (visivel) e a chave estrangeira (referencia). " +
      "Use antes de consultar uma tabela que você não conhece.",
    input_schema: {
      type: "object",
      properties: { tabela: { type: "string", description: "Nome exato da tabela ou view (sem schema)." } },
      required: ["tabela"],
    },
  },
  {
    name: "ver_funcao",
    description:
      "Mostra a definição (código SQL/plpgsql) de uma função ou trigger do schema public — é onde muitas regras de negócio " +
      "vivem (quem vira responsável, quem recebe ponto, o que um gatilho faz). Aceita o nome exato ou parte dele (até 4 resultados).",
    input_schema: {
      type: "object",
      properties: { nome: { type: "string", description: "Nome da função (ou parte)." } },
      required: ["nome"],
    },
  },
  {
    name: "buscar_docs",
    description:
      "Busca na documentação oficial do sistema (docs/, CLAUDE.md e Central de Ajuda): regras de negócio, decisões do diretor, " +
      "incidentes já resolvidos e o porquê de cada coisa. Funciona com e sem acento. Devolve arquivo, seção e um trecho. " +
      "Use SEMPRE antes de dizer que algo é erro: o que parece errado pode ser regra.",
    input_schema: {
      type: "object",
      properties: { consulta: { type: "string", description: "Palavras do assunto (ex.: 'responsável espelho reunião IA')." } },
      required: ["consulta"],
    },
  },
  {
    name: "ler_doc",
    description:
      "Lê um arquivo da documentação. Sem `secao`: devolve o sumário (lista de seções) e o começo. Com `secao`: devolve as " +
      "seções cujo título contém esse texto (até 30 mil caracteres).",
    input_schema: {
      type: "object",
      properties: {
        arquivo: { type: "string", description: "Caminho como aparece na busca (ex.: 'docs/Agendamentos e Reuniões.md') ou parte do nome." },
        secao: { type: "string", description: "Parte do título da seção." },
      },
      required: ["arquivo"],
    },
  },
  {
    name: "listar_achados",
    description:
      "Lista os achados já registrados na fila (os seus e os das varreduras anteriores), para não registrar de novo o que já " +
      "existe e para responder 'o que está aberto'. Filtre por status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["abertos", "resolvidos", "descartados", "todos"], description: "Padrão: abertos." },
      },
    },
  },
  {
    name: "registrar_achado",
    description:
      "Registra (ou atualiza) um PROBLEMA confirmado na fila de achados que os diretores acompanham. Só registre o que você " +
      "verificou com consulta e conferiu na documentação. Um achado = um padrão de problema (não um por caso): os casos vão " +
      "em `evidencias`. A `assinatura` identifica o padrão de forma estável (ex.: 'espelho-reuniao-ia-fora-do-comercial'); " +
      "registrar de novo a mesma assinatura atualiza o achado aberto em vez de duplicar.",
    input_schema: {
      type: "object",
      properties: {
        assinatura: { type: "string", description: "Identificador estável do padrão, em kebab-case." },
        titulo: { type: "string", description: "Uma linha, objetiva, com o problema." },
        gravidade: { type: "string", enum: ["critica", "alta", "media", "baixa"] },
        area: { type: "string", description: "comercial, sac, rh, financeiro, pedagogico, marketing, sistema ou seguranca." },
        resumo: { type: "string", description: "O que acontece, com números. 2 a 5 frases." },
        impacto: { type: "string", description: "Quem é afetado e como (lead perdido, pessoa recebendo cobrança errada, ponto indevido…)." },
        casos: { type: "integer", description: "Quantos casos você contou." },
        evidencias: {
          type: "array",
          description: "Até 10 itens: cada um com o que prova e o SQL que você rodou.",
          items: {
            type: "object",
            properties: {
              descricao: { type: "string" },
              sql: { type: "string" },
              exemplos: { type: "array", items: { type: "string" }, description: "Casos concretos (ids, nomes, datas)." },
            },
            required: ["descricao"],
          },
        },
        causa_provavel: { type: "string", description: "Onde está a causa (função, trigger, tela, processo) — diga se é hipótese." },
        regra_documentada: { type: "string", description: "O que a documentação diz (arquivo › seção) — ou que a regra não está documentada." },
        correcao_imediata: { type: "string", description: "O que alguém pode fazer AGORA, à mão, para os casos atuais." },
        automacao_sugerida: { type: "string", description: "Automação/trava que impediria a repetição (trigger, cron, validação, alerta)." },
        prompt_dev: { type: "string", description: "Prompt completo, em markdown, para colar no Claude Code e corrigir na raiz." },
      },
      required: ["assinatura", "titulo", "gravidade", "area", "resumo"],
    },
    eager_input_streaming: true,
  },
];

/** Só no modo prompt: fecha a demanda do TI com o prompt (ou o motivo de não ter). */
export const FERRAMENTA_ENTREGAR_PROMPT = {
  name: "entregar_prompt",
  description:
    "Entrega o resultado da análise da demanda do TI. Chame UMA vez, no fim. tipo: 'codigo' (resolve mudando código/banco " +
    "do sistema), 'operacao' (resolve pela própria tela do sistema, sem código), 'fora_do_sistema' (equipamento, conta " +
    "externa, compra, treinamento…) ou 'informacao_insuficiente' (não dá para saber o que é pedido).",
  input_schema: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: [...TIPOS_ENTREGA] },
      entendimento: { type: "string", description: "Em 2 a 4 frases: o que a pessoa está pedindo e onde isso vive no sistema." },
      motivo: { type: "string", description: "Para fora_do_sistema/informacao_insuficiente: por que não há prompt. Para os outros: opcional." },
      prompt: {
        type: "string",
        description: "Para 'codigo': o prompt completo, em markdown, para colar no Claude Code (formato de prompt_dev). Para 'operacao': " +
          "o passo a passo na tela e, se valer a pena automatizar, o prompt. Vazio nos outros tipos.",
      },
      perguntas: { type: "string", description: "O que perguntar a quem pediu para fechar o entendimento (lista curta). Opcional." },
    },
    required: ["tipo", "entendimento"],
  },
  eager_input_streaming: true,
};

const SO_LEITURA = new Set(["consultar_banco", "listar_tabelas", "descrever_tabela", "ver_funcao", "buscar_docs", "ler_doc"]);

/** Modo prompt: investiga só lendo (sem fila de achados) e termina entregando o prompt. */
export const FERRAMENTAS_PROMPT = [...FERRAMENTAS.filter((f) => SO_LEITURA.has(f.name)), FERRAMENTA_ENTREGAR_PROMPT];

export class EntradaInvalida extends Error {}

function texto(v: unknown, campo: string, opts: { obrigatorio?: boolean; max: number }): string | null {
  if (v === undefined || v === null || v === "") {
    if (opts.obrigatorio) throw new EntradaInvalida(`Informe ${campo}.`);
    return null;
  }
  if (typeof v !== "string") throw new EntradaInvalida(`${campo} deve ser texto.`);
  const t = v.trim();
  if (!t && opts.obrigatorio) throw new EntradaInvalida(`Informe ${campo}.`);
  if (t.length > opts.max) throw new EntradaInvalida(`${campo} longo demais (máx. ${opts.max} caracteres).`);
  return t || null;
}

/** Tira do texto o que tem cara de segredo (JWT, chave da Anthropic/OpenAI, token da Meta). */
export function redigirSegredos(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[segredo omitido]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{20,})/g, "[segredo omitido]");
}

/** Encurta strings longas de cada linha e corta linhas até caber no limite. */
export function compactarLinhas(linhas: unknown[], limite = LIMITE_RESULTADO): { texto: string; mostradas: number } {
  const curtas = linhas.map((l) => {
    if (!l || typeof l !== "object") return l;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(l as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > LIMITE_CAMPO) o[k] = `${v.slice(0, LIMITE_CAMPO)}… (+${v.length - LIMITE_CAMPO} caracteres)`;
      else if (v && typeof v === "object") {
        const j = JSON.stringify(v);
        o[k] = j.length > LIMITE_CAMPO ? `${j.slice(0, LIMITE_CAMPO)}…` : v;
      } else o[k] = v;
    }
    return o;
  });
  let n = curtas.length;
  let texto = JSON.stringify(curtas);
  while (texto.length > limite && n > 1) {
    n = Math.max(1, Math.floor(n * 0.7));
    texto = JSON.stringify(curtas.slice(0, n));
  }
  return { texto, mostradas: n };
}

const ROTULOS: Record<string, string> = {
  consultar_banco: "Consultando o banco",
  listar_tabelas: "Procurando tabelas",
  descrever_tabela: "Lendo a estrutura da tabela",
  ver_funcao: "Lendo a regra no banco",
  buscar_docs: "Buscando na documentação",
  ler_doc: "Lendo a documentação",
  listar_achados: "Conferindo a fila de achados",
  registrar_achado: "Registrando achado",
  entregar_prompt: "Escrevendo o prompt",
};

export function rotuloDaFerramenta(nome: string, entrada: Record<string, unknown>): string {
  const base = ROTULOS[nome] ?? "Consultando";
  if (nome === "consultar_banco" && typeof entrada.objetivo === "string" && entrada.objetivo.trim()) {
    return `${base}: ${entrada.objetivo.trim().slice(0, 120)}`;
  }
  if (nome === "buscar_docs" && typeof entrada.consulta === "string") return `${base}: "${entrada.consulta.slice(0, 80)}"`;
  if (nome === "ler_doc" && typeof entrada.arquivo === "string") {
    return `${base}: ${entrada.arquivo.replace(/^docs\//, "").slice(0, 80)}${typeof entrada.secao === "string" ? ` › ${entrada.secao.slice(0, 60)}` : ""}`;
  }
  if (nome === "descrever_tabela" && typeof entrada.tabela === "string") return `${base}: ${entrada.tabela.slice(0, 60)}`;
  if (nome === "ver_funcao" && typeof entrada.nome === "string") return `${base}: ${entrada.nome.slice(0, 60)}()`;
  if (nome === "registrar_achado" && typeof entrada.titulo === "string") return `${base}: ${entrada.titulo.slice(0, 100)}`;
  return base;
}

const STATUS_ACHADOS: Record<string, string> = {
  abertos: "status in ('aberto','em_andamento')",
  resolvidos: "status = 'resolvido'",
  descartados: "status = 'descartado'",
  todos: "true",
};

/** Executa uma ferramenta. Nunca lança: erro vira `tool_result` com `is_error`. */
export async function executarFerramenta(
  ctx: ContextoFerramentas,
  nome: string,
  entradaBruta: unknown,
): Promise<ResultadoFerramenta> {
  const entrada = (entradaBruta && typeof entradaBruta === "object" ? entradaBruta : {}) as Record<string, unknown>;
  const etapa: EtapaIa = { ferramenta: nome, rotulo: rotuloDaFerramenta(nome, entrada) };
  const inicio = Date.now();
  let entradaAuditoria = "";

  const falhar = async (msg: string): Promise<ResultadoFerramenta> => {
    etapa.erro = msg;
    await ctx.auditar?.({ ferramenta: nome, entrada: entradaAuditoria || JSON.stringify(entrada).slice(0, 4000), ok: false, erro: msg, ms: Date.now() - inicio });
    return { conteudo: JSON.stringify({ erro: msg }), erro: true, etapa };
  };

  try {
    switch (nome) {
      case "consultar_banco":
      case "listar_achados": {
        let sql: string;
        if (nome === "consultar_banco") {
          sql = texto(entrada.sql, "sql", { obrigatorio: true, max: 20_000 })!;
        } else {
          const filtro = STATUS_ACHADOS[String(entrada.status ?? "abertos")] ?? STATUS_ACHADOS.abertos;
          sql = `select id, assinatura, titulo, gravidade, area, status, casos, vezes_visto, ` +
            `ultima_vez_visto_em, origem, nota from ia_admin_achados where ${filtro} ` +
            `order by ultima_vez_visto_em desc limit 60`;
        }
        entradaAuditoria = sql;
        etapa.detalhe = sql;
        const { data, error } = await ctx.cliente.rpc("ia_admin_sql", { p_sql: sql });
        if (error) return await falhar(`Falha ao consultar: ${error.message}`);
        const r = (data ?? {}) as { erro?: string; linhas?: unknown[]; total?: number; cortado?: boolean; ms?: number };
        if (r.erro) return await falhar(r.erro);
        const linhas = Array.isArray(r.linhas) ? r.linhas : [];
        const { texto: corpo, mostradas } = compactarLinhas(linhas);
        etapa.linhas = r.total ?? linhas.length;
        etapa.ms = r.ms;
        await ctx.auditar?.({ ferramenta: nome, entrada: sql, ok: true, linhas: etapa.linhas, ms: r.ms ?? Date.now() - inicio });
        const aviso = [
          r.cortado ? "Resultado cortado em 200 linhas: agregue ou filtre mais." : "",
          mostradas < linhas.length ? `Só ${mostradas} de ${linhas.length} linhas couberam aqui: agregue ou selecione menos colunas.` : "",
        ].filter(Boolean).join(" ");
        const conteudo = redigirSegredos(`${aviso ? `[${aviso}]\n` : ""}${linhas.length} linha(s):\n${corpo}`);
        const amostra = JSON.stringify(linhas.slice(0, 3)).slice(0, 600);
        return {
          conteudo,
          erro: false,
          etapa,
          memoria: nome === "consultar_banco"
            ? `- ${String(entrada.objetivo ?? "consulta").slice(0, 120)} → ${etapa.linhas} linha(s)\n  SQL: ${sql.replace(/\s+/g, " ").slice(0, 700)}\n  Amostra: ${amostra}`
            : undefined,
        };
      }

      case "listar_tabelas": {
        const busca = texto(entrada.busca, "busca", { max: 80 });
        entradaAuditoria = busca ?? "";
        etapa.detalhe = busca ?? "(todas)";
        const { data, error } = await ctx.cliente.rpc("ia_admin_tabelas", { p_busca: busca });
        if (error) return await falhar(error.message);
        const lista = (Array.isArray(data) ? data : []) as Array<{ tabela: string; tipo: string; linhas_estimadas: number; descricao: string | null }>;
        etapa.linhas = lista.length;
        await ctx.auditar?.({ ferramenta: nome, entrada: entradaAuditoria, ok: true, linhas: lista.length, ms: Date.now() - inicio });
        const corpo = lista.map((t) =>
          `${t.tabela}${t.tipo !== "tabela" ? ` (${t.tipo})` : ""} ~${t.linhas_estimadas}${t.descricao ? ` — ${t.descricao.replace(/\s+/g, " ").slice(0, 140)}` : ""}`
        ).join("\n");
        return { conteudo: (corpo || "Nenhuma tabela com esse nome.").slice(0, LIMITE_RESULTADO), erro: false, etapa };
      }

      case "descrever_tabela": {
        const tabela = texto(entrada.tabela, "tabela", { obrigatorio: true, max: 120 })!;
        entradaAuditoria = tabela;
        etapa.detalhe = tabela;
        const { data, error } = await ctx.cliente.rpc("ia_admin_colunas", { p_tabela: tabela.replace(/^public\./, "") });
        if (error) return await falhar(error.message);
        const cols = (Array.isArray(data) ? data : []) as Array<{ coluna: string; tipo: string; nulo: boolean; visivel: boolean; referencia: string | null; descricao: string | null }>;
        if (!cols.length) return await falhar(`Tabela "${tabela}" não existe no schema public (use listar_tabelas).`);
        await ctx.auditar?.({ ferramenta: nome, entrada: tabela, ok: true, linhas: cols.length, ms: Date.now() - inicio });
        const corpo = cols.map((c) =>
          `${c.coluna} ${c.tipo}${c.nulo ? "" : " not null"}${c.visivel ? "" : " [OCULTA para você]"}` +
          `${c.referencia ? ` → ${c.referencia}` : ""}${c.descricao ? ` — ${c.descricao.replace(/\s+/g, " ").slice(0, 160)}` : ""}`
        ).join("\n");
        return { conteudo: corpo, erro: false, etapa };
      }

      case "ver_funcao": {
        const nomeFn = texto(entrada.nome, "nome", { obrigatorio: true, max: 120 })!;
        entradaAuditoria = nomeFn;
        etapa.detalhe = nomeFn;
        const { data, error } = await ctx.cliente.rpc("ia_admin_funcao", { p_nome: nomeFn.replace(/^public\./, "").replace(/\(.*$/, "") });
        if (error) return await falhar(error.message);
        const fns = (Array.isArray(data) ? data : []) as Array<{ funcao: string; argumentos: string; definicao: string }>;
        if (!fns.length) return await falhar(`Nenhuma função com "${nomeFn}" no nome.`);
        await ctx.auditar?.({ ferramenta: nome, entrada: nomeFn, ok: true, linhas: fns.length, ms: Date.now() - inicio });
        const corpo = fns.map((f) => `-- ${f.funcao}(${f.argumentos})\n${f.definicao}`).join("\n\n");
        return { conteudo: redigirSegredos(corpo).slice(0, 40_000), erro: false, etapa };
      }

      case "buscar_docs": {
        const consulta = texto(entrada.consulta, "consulta", { obrigatorio: true, max: 300 })!;
        entradaAuditoria = consulta;
        etapa.detalhe = consulta;
        const { data, error } = await ctx.cliente.rpc("ia_admin_docs_buscar", { p_consulta: consulta, p_limite: 8 });
        if (error) return await falhar(error.message);
        const itens = (Array.isArray(data) ? data : []) as Array<{ arquivo: string; secao: string; trecho: string }>;
        etapa.linhas = itens.length;
        await ctx.auditar?.({ ferramenta: nome, entrada: consulta, ok: true, linhas: itens.length, ms: Date.now() - inicio });
        if (!itens.length) {
          return { conteudo: "Nada encontrado. Tente outras palavras (sinônimos, nome da tela, nome da tabela) ou leia o mapa do domínio com ler_doc.", erro: false, etapa };
        }
        const corpo = itens.map((i, n) => `${n + 1}. ${i.arquivo} › ${i.secao}\n   ${i.trecho.replace(/\s+/g, " ")}`).join("\n");
        return { conteudo: corpo, erro: false, etapa, memoria: `- Docs: "${consulta}" → ${itens.slice(0, 3).map((i) => `${i.arquivo} › ${i.secao}`).join("; ")}` };
      }

      case "ler_doc": {
        const arquivo = texto(entrada.arquivo, "arquivo", { obrigatorio: true, max: 200 })!;
        const secao = texto(entrada.secao, "secao", { max: 200 });
        entradaAuditoria = `${arquivo}${secao ? ` › ${secao}` : ""}`;
        etapa.detalhe = entradaAuditoria;
        const { data, error } = await ctx.cliente.rpc("ia_admin_docs_ler", { p_arquivo: arquivo, p_secao: secao });
        if (error) return await falhar(error.message);
        const r = (data ?? {}) as { erro?: string };
        if (r.erro) return await falhar(r.erro);
        await ctx.auditar?.({ ferramenta: nome, entrada: entradaAuditoria, ok: true, ms: Date.now() - inicio });
        return { conteudo: JSON.stringify(data).slice(0, 32_000), erro: false, etapa, memoria: `- Leu: ${entradaAuditoria}` };
      }

      case "registrar_achado": {
        const payload: Record<string, unknown> = {
          assinatura: texto(entrada.assinatura, "assinatura", { obrigatorio: true, max: 200 }),
          titulo: texto(entrada.titulo, "titulo", { obrigatorio: true, max: 200 }),
          gravidade: texto(entrada.gravidade, "gravidade", { obrigatorio: true, max: 20 }),
          area: texto(entrada.area, "area", { max: 40 }),
          resumo: texto(entrada.resumo, "resumo", { obrigatorio: true, max: 4000 }),
          impacto: texto(entrada.impacto, "impacto", { max: 3000 }),
          casos: Number.isInteger(entrada.casos) ? entrada.casos : null,
          evidencias: Array.isArray(entrada.evidencias) ? entrada.evidencias.slice(0, 10) : [],
          causa_provavel: texto(entrada.causa_provavel, "causa_provavel", { max: 4000 }),
          regra_documentada: texto(entrada.regra_documentada, "regra_documentada", { max: 4000 }),
          correcao_imediata: texto(entrada.correcao_imediata, "correcao_imediata", { max: 4000 }),
          automacao_sugerida: texto(entrada.automacao_sugerida, "automacao_sugerida", { max: 6000 }),
          prompt_dev: texto(entrada.prompt_dev, "prompt_dev", { max: 20_000 }),
          origem: ctx.modo === "chat" ? "chat" : "varredura",
          checagem_id: ctx.checagemId ?? null,
          rodada_item_id: ctx.rodadaItemId ?? null,
        };
        payload.assinatura = String(payload.assinatura)
          .normalize("NFD").replace(/[̀-ͯ]/g, "")
          .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
        entradaAuditoria = String(payload.assinatura);
        etapa.detalhe = String(payload.titulo);
        const { data, error } = await ctx.cliente.rpc("ia_admin_registrar_achado", { p: payload });
        if (error) return await falhar(error.message);
        const r = (data ?? {}) as { id?: string; novo?: boolean; reapareceu?: boolean; erro?: string };
        if (r.erro || !r.id) return await falhar(r.erro ?? "não foi possível registrar");
        etapa.achado_id = r.id;
        await ctx.auditar?.({ ferramenta: nome, entrada: entradaAuditoria, ok: true, ms: Date.now() - inicio });
        const msg = r.novo
          ? (r.reapareceu ? "Achado registrado (este problema já tinha sido resolvido antes e VOLTOU)." : "Achado novo registrado.")
          : "Achado já estava aberto: atualizado com os dados de agora.";
        return { conteudo: JSON.stringify({ ok: true, id: r.id, mensagem: msg }), erro: false, etapa, memoria: `- Achado registrado: ${String(payload.titulo)} (${r.id})` };
      }

      case "entregar_prompt": {
        if (ctx.modo !== "prompt" || !ctx.entregarPrompt) return await falhar("entregar_prompt só existe na análise de demanda do TI.");
        const tipo = String(entrada.tipo ?? "");
        if (!(TIPOS_ENTREGA as readonly string[]).includes(tipo)) throw new EntradaInvalida(`tipo inválido: use ${TIPOS_ENTREGA.join(", ")}.`);
        const entrega: EntregaPrompt = {
          tipo: tipo as EntregaPrompt["tipo"],
          entendimento: texto(entrada.entendimento, "entendimento", { obrigatorio: true, max: 4000 })!,
          motivo: texto(entrada.motivo, "motivo", { max: 4000 }),
          prompt: texto(entrada.prompt, "prompt", { max: 30_000 }),
          perguntas: texto(entrada.perguntas, "perguntas", { max: 4000 }),
        };
        if ((entrega.tipo === "codigo" || entrega.tipo === "operacao") && !entrega.prompt) {
          throw new EntradaInvalida("tipo codigo/operacao precisa do prompt.");
        }
        entradaAuditoria = entrega.tipo;
        etapa.detalhe = entrega.tipo;
        ctx.entregarPrompt(entrega);
        await ctx.auditar?.({ ferramenta: nome, entrada: entrega.tipo, ok: true, ms: Date.now() - inicio });
        return { conteudo: JSON.stringify({ ok: true, mensagem: "Entregue. Pode encerrar." }), erro: false, etapa, encerra: true };
      }

      default:
        return await falhar(`Ferramenta desconhecida: ${nome}`);
    }
  } catch (e) {
    const msg = e instanceof EntradaInvalida ? e.message : `Erro inesperado: ${(e as Error)?.message ?? String(e)}`;
    return await falhar(msg);
  }
}
