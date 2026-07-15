// Consultas ao vivo (BI) — cada número vem da FONTE CANÔNICA do sistema (bate com o dashboard).
// SOMENTE LEITURA. Assinaturas de RPC confirmadas no banco.
import type { Ctx } from "./db.ts";
import { resolverPeriodo, hojeSP, addDiasYmd } from "./datas.ts";

const TIPOS_VENDA = ["pos_graduacao", "curso_livre", "modulo_pratico"];
const r2 = (n: number) => Number((Number(n) || 0).toFixed(2));

export const FERRAMENTAS_CONSULTA = [
  {
    name: "consultar_financeiro",
    description:
      "Financeiro do mês: faturamento (o que VENDEMOS), despesas, entradas (dinheiro RECEBIDO/aprovado no caixa) e resultado (EBITDA). Faturamento e entradas são números DIFERENTES (a pós é parcelada). Use para 'quanto faturamos/gastamos/entrou/resultado do mês'.",
    input_schema: { type: "object", properties: { mes: { type: "string", description: "'YYYY-MM' (opcional; padrão mês atual)" } } },
  },
  {
    name: "consultar_vendas",
    description:
      "Vendas/matrículas de um período: quantidade, faturamento total, ticket médio e quebra por tipo (pós/curso/módulo). Use para 'quanto vendemos essa semana/mês', 'ticket médio', 'faturamento total das vendas'.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "ontem", "semana", "semana_passada", "mes", "mes_passado"] },
        de: { type: "string", description: "YYYY-MM-DD (opcional, período custom)" },
        ate: { type: "string", description: "YYYY-MM-DD (opcional)" },
      },
    },
  },
  {
    name: "consultar_cursos_matriculados",
    description: "Lista quais CURSOS tiveram matrícula no período (com a contagem por curso). Use para 'quais cursos venderam/tiveram matrícula'.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "semana", "mes", "mes_passado"] },
        de: { type: "string" }, ate: { type: "string" },
      },
    },
  },
  {
    name: "consultar_faturamento_por_curso",
    description:
      "Faturamento (R$) POR CURSO num período: quanto CADA curso faturou (e quantas matrículas). Use para 'faturamento por curso', 'qual curso mais faturou', 'quanto a pós de X faturou'. (Para o total geral e ticket, use consultar_vendas.)",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "ontem", "semana", "semana_passada", "mes", "mes_passado"] },
        de: { type: "string" }, ate: { type: "string" },
        curso: { type: "string", description: "filtra por nome do curso (ex.: Bovinos)" },
      },
    },
  },
  {
    name: "consultar_cobranca",
    description:
      "Cobrança do mês: inadimplência %, quanto foi recuperado, premiação por atendente, indicações e se bateu a meta de inadimplência < 15%. Use para qualquer pergunta de cobrança por MÊS.",
    input_schema: { type: "object", properties: { mes: { type: "string", description: "'YYYY-MM' (opcional; padrão mês atual)" } } },
  },
  {
    name: "consultar_cobranca_periodo",
    description:
      "Cobrança por SEMANA ou período custom: quanto foi recuperado e quantas indicações a equipe coletou no intervalo. Use para 'quanto recuperamos esta semana', 'indicações desta semana'. (Inadimplência % e premiação são por MÊS — use consultar_cobranca.)",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "ontem", "semana", "semana_passada", "mes", "mes_passado"] },
        de: { type: "string" }, ate: { type: "string" },
      },
    },
  },
  {
    name: "consultar_comissao",
    description:
      "Comissão/premiação e ATINGIMENTO de meta por colaborador (vendedores E SDRs) numa SEMANA comercial (quarta→terça): pontos, meta, atingimento %, nível, variável, multiplicador e prêmio R$. Use para 'premiação/comissão dos vendedores/SDRs', 'quanto o Fulano vai receber', 'quem bateu a meta', 'atingimento'. Padrão = semana atual (em andamento); para semana fechada use periodo 'semana_passada' ou uma data.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["semana", "semana_passada"] },
        data: { type: "string", description: "YYYY-MM-DD dentro da semana desejada (opcional)" },
      },
    },
  },
  {
    name: "consultar_leads",
    description:
      "Leads (chegada de demanda). recorte: 'total' (quantos chegaram), 'por_fonte' (quebra por fonte: Meta Ads/Formulário/Google/Orgânico/Indicação), 'pago_organico' (mídia × orgânico + CPL/CAC), 'por_curso' (leads por curso/página, ex.: Sanidade Avícola). Mídia = Meta Ads + Formulário Direto + Google.",
    input_schema: {
      type: "object",
      properties: {
        recorte: { type: "string", enum: ["total", "por_fonte", "pago_organico", "por_curso"] },
        periodo: { type: "string", enum: ["hoje", "ontem", "semana", "mes", "mes_passado"] },
        de: { type: "string" }, ate: { type: "string" },
        curso: { type: "string", description: "nome do curso p/ recorte por_curso (ex.: Sanidade Avícola)" },
      },
      required: ["recorte"],
    },
  },
  {
    name: "consultar_midia",
    description:
      "Investimento de mídia (Meta): quanto investimos HOJE, ONTEM e no MÊS, a quebra por conta/BM, o orçado e o ritmo (disponível por dia). Use para 'quanto investimos hoje/este mês em cada conta'.",
    input_schema: { type: "object", properties: { mes: { type: "string", description: "'YYYY-MM' (opcional; padrão mês atual)" } } },
  },
  {
    name: "consultar_aulas_nao_confirmadas",
    description: "Lista as aulas dos próximos 30 dias que ainda NÃO têm professor confirmado (mesma fonte do aviso do Pedagógico).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "consultar_tarefa",
    description:
      "Busca uma tarefa no Gestor por texto (título/descrição) e traz status, responsáveis, prazo, descrição e TODOS os comentários — para você RESUMIR/ANALISAR a situação. Use para 'como está a tarefa X', 'me dá um resumo da tarefa Y'.",
    input_schema: { type: "object", properties: { busca: { type: "string" } }, required: ["busca"] },
  },
];

const NOMES = new Set(FERRAMENTAS_CONSULTA.map((t) => t.name));
export function ehConsulta(nome: string): boolean { return NOMES.has(nome); }

export async function executarConsulta(nome: string, input: any, ctx: Ctx): Promise<any> {
  try {
    switch (nome) {
      case "consultar_financeiro": return await cFinanceiro(input, ctx);
      case "consultar_vendas": return await cVendas(input, ctx);
      case "consultar_cursos_matriculados": return await cCursos(input, ctx);
      case "consultar_faturamento_por_curso": return await cFaturamentoPorCurso(input, ctx);
      case "consultar_cobranca": return await cCobranca(input, ctx);
      case "consultar_cobranca_periodo": return await cCobrancaPeriodo(input, ctx);
      case "consultar_comissao": return await cComissao(input, ctx);
      case "consultar_leads": return await cLeads(input, ctx);
      case "consultar_midia": return await cMidia(input, ctx);
      case "consultar_aulas_nao_confirmadas": return await cAulas(ctx);
      case "consultar_tarefa": return await cTarefa(input, ctx);
      default: return { erro: `consulta desconhecida: ${nome}` };
    }
  } catch (e) {
    return { erro: `Falha na consulta ${nome}: ${(e as Error).message}` };
  }
}

async function cFinanceiro(input: any, ctx: Ctx) {
  const mes = `${(input?.mes ? String(input.mes) : hojeSP()).slice(0, 7)}-01`;
  const { data, error } = await ctx.admin.rpc("assist_financeiro_mes", { p_mes: mes });
  if (error) throw new Error(error.message);
  const atual = mes.slice(0, 7) === hojeSP().slice(0, 7);
  return {
    ...data,
    _nota: "Faturamento = o que foi VENDIDO (não é o que entrou; a pós é parcelada). Entradas = mensalidades já aprovadas/lançadas no caixa." +
      (atual ? " ⚠️ O mês atual pode estar incompleto — o lançamento de entradas ainda está em andamento." : ""),
  };
}

async function cVendas(input: any, ctx: Ctx) {
  const p = resolverPeriodo(input);
  const { data, error } = await ctx.admin.rpc("get_vendas_aprovadas_por_semana", {
    p_inicio: p.de, p_fim: p.ate, p_vendedor_id: null, p_tipos: TIPOS_VENDA,
  });
  if (error) throw new Error(error.message);
  const linhas = data ?? [];
  const s = (k: string) => linhas.reduce((a: number, r: any) => a + Number(r[k] || 0), 0);
  const qtd = s("qtd"), fat = s("faturamento");
  return {
    periodo: p.label, de: p.de, ate: p.ate,
    matriculas: qtd,
    faturamento: r2(fat),
    ticket_medio: qtd ? r2(fat / qtd) : 0,
    quebra: {
      pos: { qtd: s("qtd_pos"), faturamento: r2(s("fat_pos")) },
      cursos: { qtd: s("qtd_cursos"), faturamento: r2(s("fat_cursos")) },
      modulos: { qtd: s("qtd_modulos"), faturamento: r2(s("fat_modulos")) },
    },
  };
}

async function cCursos(input: any, ctx: Ctx) {
  const p = resolverPeriodo(input);
  const { data, error } = await ctx.admin.rpc("get_vendas_aprovadas_semana_detalhe", {
    p_inicio: p.de, p_fim: p.ate, p_vendedor_id: null,
  });
  if (error) throw new Error(error.message);
  const arr = Array.isArray(data) ? data : [];
  const cont: Record<string, number> = {};
  for (const v of arr) {
    const nome = v?.curso?.nome || v?.curso_nome || "(sem curso)";
    cont[nome] = (cont[nome] || 0) + 1;
  }
  const cursos = Object.entries(cont)
    .map(([curso, matriculas]) => ({ curso, matriculas }))
    .sort((a, b) => b.matriculas - a.matriculas);
  return { periodo: p.label, total_matriculas: arr.length, cursos };
}

async function cFaturamentoPorCurso(input: any, ctx: Ctx) {
  const p = resolverPeriodo(input);
  const { data, error } = await ctx.admin.rpc("assist_faturamento_por_curso", { p_de: p.de, p_ate: p.ate });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  let lista = rows.map((r: any) => ({ curso: r.curso_nome, matriculas: Number(r.qtd || 0), faturamento: r2(r.faturamento) }));
  if (input?.curso) {
    const q = String(input.curso).toLowerCase();
    lista = lista.filter((r: any) => String(r.curso).toLowerCase().includes(q));
  }
  const total = lista.reduce((a: number, r: any) => a + Number(r.faturamento || 0), 0);
  return {
    periodo: p.label, total_faturamento: r2(total), cursos: lista.slice(0, 30),
    _nota: "Faturamento por curso = valor cheio da venda (pós = contrato + matrícula), por data de assinatura/envio. Cursos gêmeos somam no principal.",
  };
}

async function cCobranca(input: any, ctx: Ctx) {
  const mesStr = (input?.mes ? String(input.mes) : hojeSP()).slice(0, 7);
  const [ano, mes] = mesStr.split("-").map(Number);
  const { data, error } = await ctx.admin.rpc("cob_relatorio_mensal_dados", { p_ano: ano, p_mes: mes });
  if (error) throw new Error(error.message);
  const d = data || {};
  const resumo = d.resumo || {}, equipe = d.equipe || {}, receb = d.recebimento || {};
  return {
    mes: mesStr,
    inadimplencia_pct: resumo.inadimplencia_pct ?? equipe.pct_inadimplencia ?? null,
    bateu_meta_15pct: equipe.artilheiro_liberado ?? null,
    recuperado_mes: receb?.total?.mes ?? null,
    recuperado_30d_mes: receb?.recuperado_30d?.mes ?? null,
    premiacao_por_atendente: (equipe.linhas || []).map((l: any) => ({
      nome: l.nome, recebido: l.recebido, indicacoes: l.indicacoes,
      premio_indicacoes: l.premio_indicacoes, premio_artilheiro: l.premio_artilheiro,
      premio_recuperacao: l.premio_recuperacao, total: l.total,
    })),
    _nota: "Mês da cobrança = mês PPG (semanas comerciais). Inadimplência = vencido ÷ projetado; meta < 15% libera o artilheiro.",
  };
}

async function cCobrancaPeriodo(input: any, ctx: Ctx) {
  const p = resolverPeriodo(input);
  const { data, error } = await ctx.admin.rpc("assist_cobranca_periodo", { p_de: p.de, p_ate: p.ate });
  if (error) throw new Error(error.message);
  return {
    periodo: p.label, ...data,
    _nota: "Recuperado = lançamentos recebidos no intervalo (por data de pagamento). Indicações = coletadas pela equipe da cobrança.",
  };
}

async function cComissao(input: any, ctx: Ctx) {
  const hoje = hojeSP();
  const ref = input?.data ? String(input.data).slice(0, 10)
    : input?.periodo === "semana_passada" ? addDiasYmd(hoje, -7)
    : hoje;
  const { data, error } = await ctx.admin.rpc("assist_comissao_semana", { p_ref: ref });
  if (error) throw new Error(error.message);
  return {
    ...data,
    _nota: "Comissão da SEMANA COMERCIAL (quarta→terça). Prêmio = variável do nível × multiplicador (definido pelo atingimento). " +
      (data?.semana?.em_andamento ? "⚠️ Semana em ANDAMENTO — números parciais até fechar na terça." : ""),
  };
}

async function cLeads(input: any, ctx: Ctx) {
  const recorte = input?.recorte || "total";
  const p = resolverPeriodo(input);

  if (recorte === "total") {
    const per = input?.periodo;
    if ((per === "hoje" || per === "semana") && !input?.de) {
      const { data, error } = await ctx.admin.rpc("get_codigo_2200_publico");
      if (error) throw new Error(error.message);
      const at = data?.atividade || {};
      return per === "semana"
        ? { periodo: "esta semana", leads: at.leads_semana, importados: at.leads_importados_semana }
        : { periodo: "hoje", leads: at.leads_dia, importados: at.leads_importados_dia };
    }
    const { data, error } = await ctx.admin.rpc("assist_leads_periodo", { p_de: p.de, p_ate: p.ate });
    if (error) throw new Error(error.message);
    return { periodo: p.label, ...data };
  }

  if (recorte === "por_fonte") {
    const { data, error } = await ctx.admin.rpc("assist_leads_por_fonte", { p_de: p.de, p_ate: p.ate });
    if (error) throw new Error(error.message);
    return {
      periodo: p.label, fontes: data,
      _nota: "Mídia = Meta Ads (METAADS/metaads/meta+) + Formulário Direto + Google. 'Importação CRM' é disparo por planilha, não demanda de mídia.",
    };
  }

  if (recorte === "pago_organico") {
    const { data, error } = await ctx.admin.rpc("mkt_operacao_pago_organico", {
      p_inicio: p.de, p_fim: p.ate, p_tipos: null, p_curso_ids: null,
    });
    if (error) throw new Error(error.message);
    return { periodo: p.label, ...data };
  }

  // por_curso
  const { data, error } = await ctx.admin.rpc("mkt_leads_por_curso", { p_inicio: p.de, p_fim: p.ate });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  const ids = [...new Set(rows.map((r: any) => r.curso_id).filter(Boolean))];
  let nomes: Record<string, string> = {};
  if (ids.length) {
    const { data: cs } = await ctx.admin.from("cursos").select("id, nome").in("id", ids);
    nomes = Object.fromEntries((cs || []).map((c: any) => [c.id, c.nome]));
  }
  let lista = rows.map((r: any) => ({ curso: nomes[r.curso_id] || r.curso_id, leads: r.leads, qualificados: r.qualificados }));
  if (input?.curso) {
    const q = String(input.curso).toLowerCase();
    lista = lista.filter((r: any) => String(r.curso).toLowerCase().includes(q));
  }
  lista.sort((a: any, b: any) => (b.leads || 0) - (a.leads || 0));
  return {
    periodo: p.label, cursos: lista.slice(0, 30),
    _nota: "Conta só leads de mídia (com página); 'qualificado' pela régua do marketing (profissão).",
  };
}

async function cMidia(input: any, ctx: Ctx) {
  const mes = input?.mes ? `${String(input.mes).slice(0, 7)}-01` : null;
  const { data, error } = await ctx.admin.rpc("mkt_investimento_mes", mes ? { p_mes: mes } : {});
  if (error) throw new Error(error.message);
  return {
    ...data,
    _nota: "A 'conta' já é o BM (o nome carrega o rótulo). Gasto é líquido (sem imposto). 'Hoje' é parcial; 'ontem' é o dia fechado.",
  };
}

async function cAulas(ctx: Ctx) {
  // Fonte = o MESMO aviso do sino do Pedagógico (zero divergência).
  const { data } = await ctx.admin
    .from("ped_portal_avisos")
    .select("titulo, mensagem, ativo")
    .eq("id", "9ed0a30d-0000-4000-8000-a41a530dc0de")
    .maybeSingle();
  if (!data || !data.ativo) {
    return { ha_pendencia: false, mensagem: "Não há aulas sem professor confirmado nos próximos 30 dias. ✅" };
  }
  return { ha_pendencia: true, titulo: data.titulo, detalhe: data.mensagem };
}

function stripHtml(s: string): string {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function cTarefa(input: any, ctx: Ctx) {
  const q = String(input?.busca || "").trim();
  if (q.length < 2) return { erro: "diga um trecho do nome da tarefa" };
  const like = `%${q}%`;
  const { data: tarefas, error } = await ctx.admin
    .from("gt_tasks")
    .select("id, title, description, status_id, priority, due_date, due_at, list_id, updated_at")
    .or(`title.ilike.${like},description.ilike.${like}`)
    .eq("is_archived", false)
    .is("merged_into_task_id", null)
    .order("updated_at", { ascending: false })
    .limit(6);
  if (error) throw new Error(error.message);
  if (!tarefas?.length) return { encontrou: false, mensagem: `Não achei tarefa com "${q}".` };
  if (tarefas.length > 1) {
    return {
      encontrou: true, ambiguo: true,
      opcoes: tarefas.map((t: any) => ({ id: t.id, titulo: t.title })),
      mensagem: "Achei mais de uma tarefa — peça pro dono escolher pelo título.",
    };
  }
  const t = tarefas[0];
  const [status, assignees, comentarios] = await Promise.all([
    ctx.admin.from("gt_list_statuses").select("name, is_done").eq("id", t.status_id).maybeSingle(),
    ctx.admin.from("gt_task_assignees").select("user_id").eq("task_id", t.id),
    ctx.admin.from("gt_task_comments").select("content, created_at, user_id").eq("task_id", t.id).order("created_at", { ascending: true }),
  ]);
  const userIds = [
    ...new Set([...(assignees.data || []).map((a: any) => a.user_id), ...(comentarios.data || []).map((c: any) => c.user_id)].filter(Boolean)),
  ];
  let nomes: Record<string, string> = {};
  if (userIds.length) {
    const { data: profs } = await ctx.admin.from("profiles").select("id, name").in("id", userIds);
    nomes = Object.fromEntries((profs || []).map((p: any) => [p.id, p.name]));
  }
  return {
    encontrou: true,
    tarefa: {
      titulo: t.title,
      status: status.data?.name ?? "(sem status)",
      concluida: !!status.data?.is_done,
      prioridade: t.priority,
      prazo: t.due_date || (t.due_at ? String(t.due_at).slice(0, 10) : null),
      responsaveis: (assignees.data || []).map((a: any) => nomes[a.user_id] || "?"),
      descricao: stripHtml(t.description),
    },
    comentarios: (comentarios.data || []).map((c: any) => ({
      autor: nomes[c.user_id] || "?",
      quando: String(c.created_at).slice(0, 10),
      texto: stripHtml(c.content),
    })),
    _instrucao: "Resuma a SITUAÇÃO da tarefa a partir da descrição + comentários (não liste tudo cru): onde está, o que falta, bloqueios, próximos passos.",
  };
}
