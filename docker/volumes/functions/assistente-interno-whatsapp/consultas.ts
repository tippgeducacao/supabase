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
      "Vendas de um período, separadas em APROVADAS (a secretaria já aprovou) e AGUARDANDO APROVAÇÃO (o vendedor enviou, a secretaria ainda não aprovou — ficam na tela Gerenciar Vendas), com faturamento, ticket médio e quebra por tipo (pós/curso/módulo). Use para 'quantas vendas tivemos hoje/ontem/essa semana', 'quanto vendemos', 'ticket médio', 'faturamento das vendas', 'tem venda para aprovar?'. Sempre reporte os dois números — só as aprovadas dá um retrato incompleto do dia.",
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
    name: "consultar_vendas_por_origem",
    description:
      "Vendas/matrículas por ORIGEM (de onde veio a venda: Meta Ads, Google, Indicação, Orgânico, Formulário direto, GreatPages…), com quebra por produto (pós/curso/módulo) e total, num período. Use para 'de onde vieram as vendas', 'vendas por fonte/canal', 'origem das matrículas'.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "ontem", "semana", "semana_passada", "mes", "mes_passado"] },
        de: { type: "string" }, ate: { type: "string" },
      },
    },
  },
  {
    name: "consultar_vendas_por_vendedor",
    description:
      "Vendas por VENDEDOR num período: quantas vendas CADA vendedor fez (lançou), com quebra por STATUS (matriculada = já assinada/aprovada; pendente = aguardando aprovação da secretaria; outras = rejeitada/cancelada) e por produto (pós/curso/módulo). Ancorado na data de ENVIO (quando o vendedor lançou), então mostra TAMBÉM as pendentes do dia — dá pra saber quem fechou as vendas de hoje mesmo antes de assinarem o contrato. Use para 'quantas vendas cada vendedor fez hoje/no período', 'quem vendeu o quê', 'ranking de vendedores', 'quem fechou as pós de hoje'. (Para premiação/atingimento use consultar_comissao.)",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "ontem", "semana", "semana_passada", "mes", "mes_passado"] },
        de: { type: "string" }, ate: { type: "string" },
      },
    },
  },
  {
    name: "consultar_reunioes",
    description:
      "Reuniões, TAXA DE COMPARECIMENTO e TAXA DE CONVERSÃO de um período (mês/semana/custom), AGREGADO e POR VENDEDOR. Traz por vendedor: reuniões marcadas, comparecidas, não compareceu, canceladas, sem resultado (ainda sem desfecho), matrículas, taxa de comparecimento % e taxa de conversão %. Use para 'taxa de comparecimento do mês/da semana', 'quantas reuniões cada vendedor teve/compareceu', 'volume de reuniões por vendedor nos últimos 30 dias', 'taxa de conversão por vendedor', 'comparecimento e conversão da equipe/do time'. É a régua de ouro do sistema (bate com Métricas do Time). SEMPRE use esta ferramenta para comparecimento/volume de reuniões por período — NÃO diga que não consegue.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "ontem", "semana", "semana_passada", "mes", "mes_passado"] },
        de: { type: "string", description: "YYYY-MM-DD (opcional, período custom — ex.: últimos 30 dias)" },
        ate: { type: "string" },
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
    name: "consultar_metricas_colaborador",
    description:
      "Métricas do TIME de UMA pessoa específica do comercial (vendedor ou SDR), pelo NOME. Traz: atingimento das últimas 4 semanas (média, como o tile da tela) com a quebra por semana, pontos e atingimento da SEMANA atual, e tempo no 3C (semana e hoje) + atividade de hoje (reuniões, vendas). Use para 'como está a Aline', 'qual o atingimento do Fulano nas últimas 4 semanas', 'quantos pontos a Fulana tem', 'quanto tempo o Fulano passou no 3C', 'métricas da Fulana'. Para a lista de TODOS (premiação/ranking) use consultar_comissao.",
    input_schema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome da pessoa do comercial (ex.: Aline, Pedro Flores)" },
        data: { type: "string", description: "YYYY-MM-DD dentro da semana desejada (opcional; padrão = semana atual)" },
      },
      required: ["nome"],
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
    name: "consultar_quadro",
    description:
      "Explora um QUADRO do Gestor de Tarefas pelo nome: total de tarefas, quantidade POR COLUNA/FUNIL, tarefas ATRASADAS (prazo vencido, não concluída) e PRÓXIMAS ENTREGAS/DATAS (com responsável). Serve p/ QUALQUER quadro — ex.: 'TCC e Certificação' (quantos TCCs, alunos por funil, atrasados, quantos p/ emitir certificado), 'Projetos' / 'Novos Projetos' (datas das ABERTURAS de turma/curso), 'Certificado', 'Cursos EAD', 'Módulos Práticos', 'Eventos'. Use para 'quantos X por coluna/etapa', 'quantos atrasados', 'quais as próximas datas / aberturas / turmas', 'como está o quadro Y'. Se o nome bater com vários quadros, devolve as opções p/ o dono escolher o nome exato.",
    input_schema: {
      type: "object",
      properties: { quadro: { type: "string", description: "nome (ou parte) do quadro — ex.: 'TCC', 'Projetos', 'Certificado', 'Módulos Práticos'" } },
      required: ["quadro"],
    },
  },
  {
    name: "consultar_curso",
    description:
      "Cursos do Pedagógico (Gestão Acadêmica). SEM nome = LISTA os cursos ATIVOS por área (modalidade, nº de módulos/aulas/turmas, ativo/arquivado). COM nome = DETALHE do curso: módulos (ao vivo/gravado/EAD), aulas e EMENTA por módulo, professores (coordenador/convidado), modalidade e se está ativo. Use para 'quais cursos tem na área X', 'quais módulos/aulas/ementa do curso Y', 'esse curso está ativo?', 'quem são os professores do curso Z'.",
    input_schema: { type: "object", properties: { curso: { type: "string", description: "nome (ou parte) do curso, ou uma ÁREA (ex.: Bovinos). Vazio = lista todos os ativos." } } },
  },
  {
    name: "consultar_turmas",
    description:
      "Turmas do Pedagógico: quais turmas existem, com SITUAÇÃO (em andamento/próxima/encerrada), datas, horário e progresso (aulas realizadas/total). Filtre por curso ou área no 'busca'. Use para 'quais turmas do curso X', 'turmas de Bovinos', 'quantas turmas em andamento'. Pra ver o cronograma/aulas de UMA turma, use consultar_cronograma_turma.",
    input_schema: { type: "object", properties: { busca: { type: "string", description: "nome do curso, da turma ou da área (ex.: 'Reprodução de Bovinos', 'Bovinos'). Vazio = todas as turmas." } } },
  },
  {
    name: "consultar_cronograma_turma",
    description:
      "Cronograma do aluno de UMA turma: as AULAS (data, horário, título, ementa, status), os PROFESSORES vinculados e se estão CONFIRMADOS (confirmado / aguardando / não enviado). Use para 'me mostra o cronograma da turma X', 'quais aulas/professores da turma Y', 'os professores da turma Z estão confirmados?'. Se o nome bater com várias turmas, devolve as opções. (Pra ENVIAR o cronograma em PDF no WhatsApp, use a ferramenta enviar_cronograma_pdf.)",
    input_schema: { type: "object", properties: { turma: { type: "string", description: "nome da turma (ex.: 'Reprodução, Nutrição e Gestão de Bovinos 01/26 #02')" } }, required: ["turma"] },
  },
  {
    name: "ultima_transcricao",
    description:
      "Recupera o TEXTO da última reunião que você transcreveu (a transcrição/resumo completo). Use quando o dono pedir para 'pegar o texto que você transcreveu', 'fazer um PDF da reunião', 'me manda de novo o resumo da reunião', 'usa aquela transcrição', etc.",
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
      case "consultar_vendas_por_origem": return await cVendasPorOrigem(input, ctx);
      case "consultar_vendas_por_vendedor": return await cVendasPorVendedor(input, ctx);
      case "consultar_reunioes": return await cReunioes(input, ctx);
      case "consultar_faturamento_por_curso": return await cFaturamentoPorCurso(input, ctx);
      case "consultar_cobranca": return await cCobranca(input, ctx);
      case "consultar_cobranca_periodo": return await cCobrancaPeriodo(input, ctx);
      case "consultar_comissao": return await cComissao(input, ctx);
      case "consultar_metricas_colaborador": return await cMetricasColaborador(input, ctx);
      case "consultar_leads": return await cLeads(input, ctx);
      case "consultar_midia": return await cMidia(input, ctx);
      case "consultar_aulas_nao_confirmadas": return await cAulas(ctx);
      case "consultar_quadro": return await cQuadro(input, ctx);
      case "consultar_curso": return await cCurso(input, ctx);
      case "consultar_turmas": return await cTurmas(input, ctx);
      case "consultar_cronograma_turma": return await cCronogramaTurma(input, ctx);
      case "consultar_tarefa": return await cTarefa(input, ctx);
      case "ultima_transcricao": return await cUltimaTranscricao(ctx);
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
  // APROVADAS (canônica, bate com o dashboard) + AGUARDANDO APROVAÇÃO (secretaria ainda não
  // aprovou). As duas juntas = o que o time realmente vendeu no período. Buscar as duas em
  // paralelo; a pendente é best-effort pra nunca derrubar a resposta das aprovadas.
  const [aprov, pend] = await Promise.all([
    ctx.admin.rpc("get_vendas_aprovadas_por_semana", {
      p_inicio: p.de, p_fim: p.ate, p_vendedor_id: null, p_tipos: TIPOS_VENDA,
    }),
    ctx.admin.rpc("assist_vendas_pendentes", { p_de: p.de, p_ate: p.ate }),
  ]);
  if (aprov.error) throw new Error(aprov.error.message);
  const linhas = aprov.data ?? [];
  const s = (k: string) => linhas.reduce((a: number, r: any) => a + Number(r[k] || 0), 0);
  const qtd = s("qtd"), fat = s("faturamento");

  // pendentes: se a RPC falhar, DIZ que falhou — nunca omite em silêncio (foi o bug original).
  const pj: any = pend.error ? null : (pend.data ?? null);
  const pQtd = Number(pj?.qtd || 0);
  const pFat = Number(pj?.faturamento || 0);

  return {
    periodo: p.label, de: p.de, ate: p.ate,
    aprovadas: {
      qtd,
      faturamento: r2(fat),
      ticket_medio: qtd ? r2(fat / qtd) : 0,
      quebra: {
        pos: { qtd: s("qtd_pos"), faturamento: r2(s("fat_pos")) },
        cursos: { qtd: s("qtd_cursos"), faturamento: r2(s("fat_cursos")) },
        modulos: { qtd: s("qtd_modulos"), faturamento: r2(s("fat_modulos")) },
      },
    },
    aguardando_aprovacao: pend.error
      ? { erro: `não consegui checar as pendentes: ${pend.error.message}` }
      : {
          qtd: pQtd,
          faturamento: r2(pFat),
          quebra: {
            pos: { qtd: Number(pj?.quebra?.pos?.qtd || 0), faturamento: r2(pj?.quebra?.pos?.faturamento) },
            cursos: { qtd: Number(pj?.quebra?.cursos?.qtd || 0), faturamento: r2(pj?.quebra?.cursos?.faturamento) },
            modulos: { qtd: Number(pj?.quebra?.modulos?.qtd || 0), faturamento: r2(pj?.quebra?.modulos?.faturamento) },
          },
        },
    total_vendido_no_periodo: pend.error ? null : { qtd: qtd + pQtd, faturamento: r2(fat + pFat) },
    _nota:
      "SEMPRE informe os DOIS números quando perguntarem quantas vendas houve: as APROVADAS e as que estão AGUARDANDO APROVAÇÃO da secretaria. " +
      "Formato sugerido: 'X vendas aprovadas (R$ ...) + Y aguardando aprovação (R$ ...) — total de Z no período'. " +
      "Aprovadas = a secretaria já aprovou (viraram matrícula), ancoradas na data de assinatura do contrato. " +
      "Aguardando aprovação = o vendedor já enviou e a secretaria ainda não aprovou, ancoradas na data de ENVIO; " +
      "o faturamento delas é POTENCIAL (ainda não é receita e pode mudar/cair na aprovação). O ticket médio é só das aprovadas.",
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

async function cVendasPorOrigem(input: any, ctx: Ctx) {
  const p = resolverPeriodo(input);
  const { data, error } = await ctx.admin.rpc("assist_vendas_por_origem", { p_de: p.de, p_ate: p.ate });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  const totalQtd = rows.reduce((a: number, r: any) => a + Number(r.qtd_total || 0), 0);
  const totalFat = rows.reduce((a: number, r: any) => a + Number(r.fat_total || 0), 0);
  return {
    periodo: p.label, matriculas: totalQtd, faturamento_total: r2(totalFat),
    por_origem: rows.map((r: any) => ({
      origem: r.origem, matriculas: Number(r.qtd_total || 0), faturamento: r2(r.fat_total),
      pos: Number(r.qtd_pos || 0), curso: Number(r.qtd_curso || 0), modulo: Number(r.qtd_modulo || 0),
    })),
    _nota: "Origem = fonte do lead que converteu (Meta/mídia, Google, Indicação, Orgânico, Formulário direto, GreatPages…). 'Origem desconhecida' = matrícula sem lead casado. Formulário direto = sem UTM de mídia (não é mídia paga).",
  };
}

async function cVendasPorVendedor(input: any, ctx: Ctx) {
  const p = resolverPeriodo(input);
  const { data, error } = await ctx.admin.rpc("assist_vendas_por_vendedor", { p_de: p.de, p_ate: p.ate });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  const soma = (k: string) => rows.reduce((a: number, r: any) => a + Number(r[k] || 0), 0);
  return {
    periodo: p.label, de: p.de, ate: p.ate,
    total_vendas: soma("total"),
    total_matriculadas: soma("matriculadas"),
    total_pendentes: soma("pendentes"),
    vendedores: rows.map((r: any) => ({
      vendedor: r.vendedor, total: Number(r.total || 0),
      matriculadas: Number(r.matriculadas || 0), pendentes: Number(r.pendentes || 0), outras: Number(r.outras || 0),
      pos: Number(r.pos || 0), curso: Number(r.curso || 0), modulo: Number(r.modulo || 0),
    })),
    _nota:
      "Vendas por vendedor, ancoradas na data de ENVIO (quando o vendedor lançou) — por isso aparecem também as PENDENTES do dia (aguardando aprovação da secretaria), que é como dá pra saber quem fechou as vendas de hoje ANTES de assinarem o contrato. " +
      "'matriculada' = já aprovada/assinada; 'pendente' = na fila da secretaria (Gerenciar Vendas); 'outras' = rejeitada/cancelada/desistiu. " +
      "⚠️ NÃO é a régua de comissão (a premiação usa a data de ASSINATURA) — para premiação/atingimento use consultar_comissao.",
  };
}

async function cReunioes(input: any, ctx: Ctx) {
  const p = resolverPeriodo(input);
  const { data, error } = await ctx.admin.rpc("assist_reunioes_periodo", { p_de: p.de, p_ate: p.ate });
  if (error) throw new Error(error.message);
  const d = data || {};
  return {
    periodo: p.label, de: p.de, ate: p.ate,
    agregado: d.agregado ?? null,
    por_vendedor: d.por_vendedor ?? [],
    _nota:
      "RÉGUA DE OURO (bate com Métricas do Time). Comparecimento = comparecidas ÷ VÁLIDAS (marcadas − canceladas − desqualificadas); reunião cancelada/desqualificada NÃO entra na conta. " +
      "'sem_resultado' = reunião ainda sem desfecho marcado (agendada/futura ou não marcada) — ela ENTRA no denominador do comparecimento, então NO MEIO DO MÊS o comparecimento pode parecer menor do que será no fechamento. " +
      "Conversão = matrículas assinadas no período (data de assinatura ?? envio, somando as 3 tabelas) ÷ comparecidas — pode passar de 100% (venda antiga assinando agora). Reuniões ancoradas na data do agendamento (fuso de Brasília). " +
      "Se houver B2B com reunião no período, ele aparece junto. Sempre mostre 2 casas decimais.",
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

// coorte do comercial (quem tem métricas de time): vendedores + SDRs ativos.
const COORTE_COMERCIAL = [
  "vendedor", "vendedor_vendas_ativas", "coordenador",
  "sdr", "sdr_inbound", "sdr_outbound", "sdr_vendas_diretas", "sdr_coordenador",
];
// normaliza nome p/ casar: sem acento, minúsculo, colapsa letras repetidas ("Wellinton"→"welinton").
function normNome(s: string): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/(.)\1+/g, "$1").replace(/\s+/g, " ").trim();
}

async function cMetricasColaborador(input: any, ctx: Ctx) {
  const nome = String(input?.nome ?? "").trim();
  if (!nome) return { erro: "Diga o nome da pessoa do comercial que você quer ver." };

  // resolve na coorte comercial ativa (lista pequena) — casa por conter as palavras do que foi pedido
  const { data: pessoas, error: e1 } = await ctx.admin
    .from("profiles")
    .select("id, name, user_type")
    .in("user_type", COORTE_COMERCIAL)
    .eq("ativo", true);
  if (e1) throw new Error(e1.message);
  const alvo = normNome(nome);
  const termos = alvo.split(" ").filter(Boolean);
  const cands = (pessoas ?? []).filter((p: any) => {
    const n = normNome(p.name);
    return termos.every((t) => n.includes(t));
  });

  if (cands.length === 0) {
    return { erro: `Não achei ninguém no comercial chamado "${nome}" (só vejo vendedores e SDRs ativos).` };
  }
  if (cands.length > 1) {
    return {
      ambiguo: true,
      mensagem: `Achei mais de um: ${cands.map((c: any) => c.name).join(" · ")}. De qual você quer? (diga o nome completo)`,
      opcoes: cands.map((c: any) => c.name),
    };
  }

  const alvoId = cands[0].id;
  const ref = input?.data ? String(input.data).slice(0, 10) : undefined;
  const { data, error } = await ctx.admin.rpc("assist_metricas_colaborador", { p_profile_id: alvoId, p_ref: ref ?? null });
  if (error) throw new Error(error.message);
  return data;
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

async function cCurso(input: any, ctx: Ctx) {
  const busca = String(input?.curso || "").trim();
  const { data, error } = await ctx.admin.rpc("assist_ped_cursos", { p_busca: busca || null });
  if (error) throw new Error(error.message);
  const cursos = Array.isArray(data) ? data : [];
  if (!busca) {
    return { modo: "lista", total: cursos.length, cursos,
      _nota: "Cursos ATIVOS por área. Peça o DETALHE de um curso pelo nome pra ver módulos, ementas, aulas e professores." };
  }
  if (cursos.length === 0) return { encontrou: false, mensagem: `Não achei curso com "${busca}".` };
  const exato = cursos.find((c: any) => String(c.nome).toLowerCase() === busca.toLowerCase());
  const alvo = exato || (cursos.length === 1 ? cursos[0] : null);
  if (!alvo) {
    return { modo: "varios", mensagem: `Achei ${cursos.length} cursos com "${busca}". Qual?`,
      opcoes: cursos.map((c: any) => ({ nome: c.nome, area: c.area, ativo: c.ativo })) };
  }
  const { data: det, error: e2 } = await ctx.admin.rpc("assist_ped_curso_detalhe", { p_id: alvo.id });
  if (e2) throw new Error(e2.message);
  return { modo: "detalhe", ...det,
    _nota: "Detalhe do curso: módulos (tipo ao vivo/gravado), aulas + ementa por módulo, professores (coordenador/convidado), modalidade e ativo. Pra ver as turmas, use consultar_turmas." };
}

async function cTurmas(input: any, ctx: Ctx) {
  const busca = String(input?.busca || input?.curso || "").trim();
  const { data, error } = await ctx.admin.rpc("assist_ped_turmas", { p_curso: null, p_busca: busca || null });
  if (error) throw new Error(error.message);
  const turmas = Array.isArray(data) ? data : [];
  return { total: turmas.length, turmas: turmas.slice(0, 60),
    _nota: "Turmas não arquivadas com situação (em andamento/próxima/encerrada), datas, horário e progresso (realizadas/total). Filtre por curso/área no 'busca'. Pra o cronograma de UMA turma, use consultar_cronograma_turma." };
}

async function cCronogramaTurma(input: any, ctx: Ctx) {
  const busca = String(input?.turma || "").trim();
  if (busca.length < 3) return { erro: "diga o nome da turma (ex.: 'Reprodução de Bovinos 01/26 #02')" };
  const { data: turmas, error } = await ctx.admin.rpc("assist_ped_turmas", { p_curso: null, p_busca: busca });
  if (error) throw new Error(error.message);
  const lista = Array.isArray(turmas) ? turmas : [];
  if (lista.length === 0) return { encontrou: false, mensagem: `Não achei turma com "${busca}".` };
  if (lista.length > 1) {
    return { ambiguo: true, mensagem: `Achei ${lista.length} turmas — qual?`, opcoes: lista.map((t: any) => t.turma) };
  }
  const { data: cron, error: e2 } = await ctx.admin.rpc("assist_ped_turma_cronograma", { p_turma_id: lista[0].id });
  if (e2) throw new Error(e2.message);
  return { ...cron,
    _nota: "Cronograma do aluno: aulas (data/título/ementa/professor/status) + resumo de professores com confirmação (confirmado/aguardando/não enviado). Pra ENVIAR em PDF no WhatsApp, use enviar_cronograma_pdf." };
}

async function cQuadro(input: any, ctx: Ctx) {
  const q = String(input?.quadro || "").trim();
  if (q.length < 2) return { erro: "diga o nome do quadro (ex.: TCC, Projetos, Certificado)" };
  const { data, error } = await ctx.admin.rpc("assist_gt_quadro", { p_busca: q });
  if (error) throw new Error(error.message);
  return {
    ...data,
    _nota:
      "Fonte = Gestor de Tarefas (o quadro real, ao vivo). 'colunas' = o funil (quantas tarefas em cada etapa/coluna). " +
      "'atrasadas' = prazo vencido e ainda não concluída. 'proximas_entregas' = próximas datas (ex.: aberturas de turma/curso, com o responsável). " +
      "Cada tarefa costuma ser 1 aluno (no TCC) ou 1 projeto/abertura. Se vier 'encontrou:false' com candidatos, mostre as opções e peça o nome exato.",
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

async function cUltimaTranscricao(ctx: Ctx) {
  // Reunião em áudio vira 2 jobs (tipo 'audio' = RESUMO/ata · 'transcricao' = verbatim). Aqui
  // preferimos o RESUMO — é o que "o texto da reunião" costuma significar; o verbatim é enorme.
  const { data: resumo } = await ctx.admin
    .from("assistente_transcricoes")
    .select("resultado, status, criado_em")
    .eq("canon", ctx.canon)
    .in("tipo", ["audio", "video"])
    .eq("status", "pronto")
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (resumo?.resultado) {
    return { encontrou: true, transcricao: resumo.resultado,
      _instrucao: "Resumo/ata da última reunião. Use como o dono pediu (ex.: chamar gerar_pdf com este texto)." };
  }
  // Nenhum resumo pronto ainda: ou está processando, ou nunca houve.
  const { data: qualquer } = await ctx.admin
    .from("assistente_transcricoes")
    .select("status, criado_em")
    .eq("canon", ctx.canon)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (qualquer?.status === "processando" || qualquer?.status === "fila") {
    return { encontrou: false, mensagem: "Ainda estou transcrevendo/resumindo a última reunião — daqui a pouco fica pronta." };
  }
  return { encontrou: false, mensagem: "Não achei nenhuma reunião transcrita ainda." };
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
