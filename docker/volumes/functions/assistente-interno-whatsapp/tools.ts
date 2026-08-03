// Ferramentas do assistente (Fase 1): criar tarefa (com confirmação), ver agenda,
// criar reunião (com confirmação), confirmar/cancelar a ação pendente.
import type { Ctx } from "./db.ts";
import { criarPendente, pendenteAtual, marcarPendente } from "./db.ts";
import { listarEventos, criarReuniao } from "./agenda.ts";
import { gerarEnviarPdf } from "./documento.ts";
import { fmtData, spToIso, janela, hojeSP } from "./datas.ts";

export const FERRAMENTAS = [
  {
    name: "criar_tarefa",
    description:
      "Propõe criar uma tarefa no Gestor de Tarefas para um colaborador. NÃO cria de imediato — apenas REGISTRA a proposta e devolve um resumo para você mostrar ao dono e pedir confirmação. Use quando o dono pedir para criar tarefa / lembrar alguém / delegar algo.",
    input_schema: {
      type: "object",
      properties: {
        responsavel_nome: { type: "string", description: "Nome do colaborador (ex.: Laura, Adriane)" },
        titulo: { type: "string", description: "Título curto da tarefa" },
        descricao: { type: "string", description: "Detalhes/observações (opcional)" },
        prazo: { type: "string", description: "Prazo YYYY-MM-DD (opcional)" },
        prioridade: { type: "string", enum: ["urgent", "high", "normal", "low"], description: "opcional, padrão normal" },
        espaco: { type: "string", enum: ["diretores", "inbox"], description: "onde criar: 'diretores' (PADRÃO, a lista de Direção do setor) ou 'inbox' (lista de novas tarefas do setor). Use 'inbox' só se o dono pedir explicitamente." },
      },
      required: ["responsavel_nome", "titulo"],
    },
  },
  {
    name: "ver_agenda",
    description:
      "Consulta a agenda (Google Calendar) do próprio dono. Somente leitura. Use para 'o que tenho hoje/amanhã/essa semana'.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", enum: ["hoje", "amanha", "semana"], description: "janela; padrão hoje" },
        de: { type: "string", description: "data inicial YYYY-MM-DD (opcional, sobrepõe periodo)" },
        ate: { type: "string", description: "data final YYYY-MM-DD (opcional)" },
      },
    },
  },
  {
    name: "criar_reuniao",
    description:
      "Propõe criar uma reunião no Google Calendar do dono, com link do Meet e convidados. NÃO cria de imediato — registra a proposta e devolve um resumo para confirmação (o convite vai por e-mail ao convidado). Datas/horas no fuso de Brasília.",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        data: { type: "string", description: "YYYY-MM-DD" },
        hora_inicio: { type: "string", description: "HH:MM (24h)" },
        hora_fim: { type: "string", description: "HH:MM (opcional; padrão +1h)" },
        convidados: { type: "array", items: { type: "string" }, description: "e-mails (opcional)" },
        descricao: { type: "string", description: "opcional" },
        criar_meet: { type: "boolean", description: "criar link do Meet (padrão true)" },
      },
      required: ["titulo", "data", "hora_inicio"],
    },
  },
  {
    name: "enviar_mensagem",
    description:
      "Propõe enviar uma mensagem no CHAT INTERNO do Gestor de Tarefas (NÃO é WhatsApp). Dois destinos, decida pelo jeito que o dono fala:\n" +
      "• PESSOA = chat direto/privado de alguém. Gatilhos: 'manda mensagem PARA a Laura', 'avisa o Derick', 'fala com a Adriane', 'no privado da Fulana', 'manda pra Marisa'. → destino_tipo='pessoa', destino_nome=nome da pessoa.\n" +
      "• CANAL = um canal/grupo. Gatilhos: 'manda no CHAT do Pedagógico', 'no CANAL do Marketing', 'no GRUPO Comercial', 'posta no canal Tecnologia e Dados'. → destino_tipo='canal', destino_nome=nome do canal.\n" +
      "Regra: se citar um NOME DE PESSOA → pessoa; se citar 'chat/canal/grupo de/do <setor/tema>' → canal. Na dúvida, pergunte. NÃO envia de imediato — registra a proposta e devolve um resumo pro dono confirmar.",
    input_schema: {
      type: "object",
      properties: {
        destino_tipo: { type: "string", enum: ["pessoa", "canal"], description: "pessoa = chat direto/privado de alguém; canal = canal/grupo (ex.: 'chat do Pedagógico')" },
        destino_nome: { type: "string", description: "nome da PESSOA (ex.: Laura, Adriane) ou do CANAL (ex.: Pedagógico, Marketing, Comercial, Tecnologia e Dados)" },
        texto: { type: "string", description: "conteúdo da mensagem" },
      },
      required: ["destino_tipo", "destino_nome", "texto"],
    },
  },
  {
    name: "salvar_plano_comercial",
    description:
      "Salva o PLANO GERAL DO COMERCIAL (o alinhamento que os líderes fazem toda manhã: como foi o dia anterior e as ações de hoje). Grava no mesmo lugar que a tela Métricas do Time → Feedback Diário, então o time vê na tela. Use quando o dono ditar/mandar o alinhamento, a reunião da manhã, o plano de ação do dia, 'anota aí o plano', 'salva o alinhamento de hoje'. NÃO salva de imediato — registra a proposta e devolve um resumo pro dono confirmar. Por padrão vai para o dia ANALISADO (dia útil anterior), que é a convenção da tela.",
    input_schema: {
      type: "object",
      properties: {
        texto: {
          type: "string",
          description:
            "O plano em texto corrido, do jeito que o dono ditou. Pode usar linhas começando com '- ' para virar tópicos e **negrito**. Organize em seções se o dono ditou assim (ex.: 'O que aconteceu ontem', 'Ações de hoje'), mas NÃO invente conteúdo que ele não falou.",
        },
        escopo: {
          type: "string",
          enum: ["geral_todos", "geral_vendedor", "geral_sdr"],
          description: "Quem é o público: 'geral_todos' (PADRÃO — comercial inteiro, SDRs + vendedores), 'geral_vendedor' (só vendedores) ou 'geral_sdr' (só SDRs). Só mude se o dono disser que o plano é só de um time.",
        },
        data: { type: "string", description: "YYYY-MM-DD do dia ANALISADO (opcional; padrão = dia útil anterior)" },
        modo: {
          type: "string",
          enum: ["acrescentar", "substituir"],
          description: "Se já existir plano do dia: 'acrescentar' (PADRÃO, junta no final) ou 'substituir' (troca tudo). Só use 'substituir' se o dono pedir.",
        },
      },
      required: ["texto"],
    },
  },
  {
    name: "gerar_pdf",
    description:
      "Gera um PDF e ENVIA aqui no WhatsApp do dono. VOCÊ escreve o conteúdo — a ferramenta só formata e entrega. " +
      "Use quando ele pedir um PDF/documento/relatório/arquivo de algo: relatório de evento, alinhamento de reunião, " +
      "resumo de pesquisa, plano, análise, ata. Envia DIRETO (não precisa de confirmação — é para o próprio dono). " +
      "⚠️ CHAME AGORA, na mesma resposta: nunca diga que 'vai gerar' sem chamar. " +
      "⚠️ O documento é PROPORCIONAL ao material — se houver muito conteúdo (um dia de evento, uma reunião longa), " +
      "escreva um documento LONGO e detalhado; resumir tudo em 2 folhas é erro. " +
      "Se o material vier de uma conversa ao longo do tempo, chame recuperar_conversa ANTES para ter tudo em mãos.",
    input_schema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "título do documento (também vira o nome do arquivo)" },
        conteudo: {
          type: "string",
          description:
            "O texto COMPLETO do documento, já organizado e pronto (é o documento em si — não um resumo dele). " +
            "Hierarquia: '# ' = PARTE (começa em página nova) · '## ' = seção · '### ' = subtítulo · " +
            "'- ' = tópico · '1. ' = lista numerada · '> ' = citação/destaque · linha em branco = parágrafo. " +
            "Um bloco '*Identificação*' com linhas 'Campo: valor' vira o cabeçalho do documento. " +
            "Documento com 2+ partes (ou 8+ seções) ganha capa e sumário automáticos.",
        },
        continuar: {
          type: "boolean",
          description:
            "true = esta é uma PARTE de um documento maior: o texto é guardado e o PDF NÃO é enviado ainda. " +
            "Chame de novo com a próxima parte (mesmo titulo) e, na ÚLTIMA, use continuar=false (ou omita) " +
            "para fechar e enviar o PDF completo. Use quando o documento não couber numa resposta só.",
        },
      },
      required: ["titulo", "conteudo"],
    },
  },
  {
    name: "enviar_cronograma_pdf",
    description:
      "Gera o CRONOGRAMA DO ALUNO de uma TURMA em PDF e ENVIA aqui no WhatsApp do dono. Use quando ele pedir 'me manda o cronograma da turma X em PDF', 'baixa o cronograma da turma Y', 'cronograma do aluno de <curso> <turma>'. Envia DIRETO (é para o próprio dono, não precisa confirmar). Se o nome bater com VÁRIAS turmas, devolve as opções pro dono escolher.",
    input_schema: {
      type: "object",
      properties: { turma: { type: "string", description: "nome da turma (ex.: 'Reprodução, Nutrição e Gestão de Bovinos 01/26 #02' ou 'Nutrição de Bovinos')" } },
      required: ["turma"],
    },
  },
  {
    name: "confirmar",
    description:
      "Executa a ação que está aguardando confirmação (criar tarefa, criar reunião, enviar mensagem OU salvar o plano do comercial). Só chame quando o dono confirmar explicitamente (sim, pode, confirmo, isso).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancelar",
    description: "Cancela a ação que está aguardando confirmação. Chame quando o dono desistir/recusar.",
    input_schema: { type: "object", properties: {} },
  },
];

export async function executarFerramenta(nome: string, input: any, ctx: Ctx): Promise<any> {
  try {
    switch (nome) {
      case "criar_tarefa": return await proporTarefa(input, ctx);
      case "ver_agenda": return await verAgenda(input, ctx);
      case "criar_reuniao": return await proporReuniao(input, ctx);
      case "enviar_mensagem": return await proporMensagem(input, ctx);
      case "salvar_plano_comercial": return await proporPlano(input, ctx);
      case "gerar_pdf": return await gerarEnviarPdf(input, ctx);
      case "enviar_cronograma_pdf": return await enviarCronogramaPdf(input, ctx);
      case "confirmar": return await confirmarPendente(ctx);
      case "cancelar": return await cancelarPendente(ctx);
      default: return { erro: `ferramenta desconhecida: ${nome}` };
    }
  } catch (e) {
    return { status: "erro", mensagem: `Falha ao executar ${nome}: ${(e as Error).message}` };
  }
}

type Colab = { id: string; name: string; email: string | null; setor: string | null; ativo: boolean };

/** Rótulo com IDENTIFICADOR: o cadastro não tem "@" — o e-mail (+ setor) é o que diferencia
 *  dois "Carlos"/"Debora". Sempre mostre isso ao dono antes de agir. */
function rotulo(c: Colab): string {
  const extra = [c.setor, c.email].filter(Boolean).join(" · ");
  return extra ? `${c.name} (${extra})` : c.name;
}

/** Normaliza p/ busca tolerante: sem acento, minúsculo, SEM letras repetidas.
 *  É o que faz "Wellinton" (2 Ls) achar o cadastro "Welinton" (1 L), "Marissa"→"Marisa" etc. */
function normNome(s: string): string {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/(.)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const mapearColab = (rows: any[]): Colab[] =>
  (rows ?? []).map((p: any) => ({
    id: p.id, name: p.name, email: p.email ?? null,
    setor: p.departamentos?.nome ?? null, ativo: !!p.ativo,
  }));

/** Busca por nome — traz ATIVOS e INATIVOS (p/ avisar "existe, mas está inativo").
 *  1ª passada literal (ILIKE); se não achar nada, 2ª passada TOLERANTE a grafia. */
async function resolverColaborador(admin: any, nome: string): Promise<{ cands: Colab[]; inativos: Colab[] }> {
  const q = String(nome).trim();
  const sel = "id, name, email, ativo, departamentos:departamento_id(nome)";
  const { data } = await admin.from("profiles").select(sel).ilike("name", `%${q}%`).limit(10);
  let todos = mapearColab(data);

  if (todos.length === 0) {
    const { data: all } = await admin.from("profiles").select(sel).limit(500);
    const nq = normNome(q);
    if (nq) {
      todos = mapearColab(all).filter((c) => {
        const nn = normNome(c.name);
        return nn.includes(nq) || nn.split(" ").some((t) => t.startsWith(nq) || nq.startsWith(t));
      });
    }
  }

  const ativos = todos.filter((c) => c.ativo);
  // nome EXATO vence a busca parcial (evita ambiguidade boba)
  const exato = ativos.filter((c) => c.name.trim().toLowerCase() === q.toLowerCase());
  return { cands: exato.length === 1 ? exato : ativos, inativos: todos.filter((c) => !c.ativo) };
}

async function proporTarefa(input: any, ctx: Ctx) {
  const { cands, inativos } = await resolverColaborador(ctx.admin, input.responsavel_nome);
  if (cands.length === 0) {
    if (inativos.length > 0) {
      return { status: "inativo", opcoes: inativos.map(rotulo),
        mensagem: `Existe "${inativos.map(rotulo).join(" | ")}", mas está INATIVO no sistema — não dá pra atribuir tarefa.` };
    }
    return { status: "nao_encontrado", mensagem: `Não achei ninguém chamado "${input.responsavel_nome}" no cadastro.` };
  }
  if (cands.length > 1) {
    return { status: "ambiguo", opcoes: cands.map(rotulo),
      mensagem: `Achei mais de um: ${cands.map(rotulo).join(" | ")}. Qual deles? MOSTRE o setor e o e-mail pro dono escolher.` };
  }
  const alvo = cands[0];
  const paraDiretores = input.espaco !== "inbox";
  const prazoTxt = input.prazo ? ` · prazo ${fmtData(input.prazo)}` : "";
  const prioTxt = input.prioridade && input.prioridade !== "normal" ? ` · ${input.prioridade}` : "";
  const espacoTxt = paraDiretores ? "" : " · na lista de novas tarefas do setor";
  const resumo = `📋 Tarefa: "${input.titulo}" para *${rotulo(alvo)}*${prazoTxt}${prioTxt}${espacoTxt}`;
  await criarPendente(ctx.admin, ctx.canon, "criar_tarefa", {
    actor: ctx.dono.profile_id, assignee: alvo.id, assignee_nome: alvo.name,
    titulo: input.titulo, descricao: input.descricao ?? "", prazo: input.prazo ?? null,
    prioridade: input.prioridade ?? "normal", para_diretores: paraDiretores,
  }, resumo);
  return {
    status: "aguardando_confirmacao", resumo,
    instrucao: "Mostre o resumo ao dono e peça confirmação. NÃO chame 'confirmar' até ele responder que sim.",
  };
}

async function resolverCanal(admin: any, nome: string) {
  const q = String(nome).trim();
  const { data } = await admin
    .from("gt_chat_channels")
    .select("id, name, type")
    .in("type", ["channel", "group", "announcement", "department", "project"])
    .is("archived_at", null)
    .ilike("name", `%${q}%`)
    .limit(8);
  const lista = data ?? [];
  // Nome EXATO vence: "Pedagógico" → canal "PEDAGÓGICO" (e não "SUPORTE X PEDAGÓGICO"),
  // senão o dono teria de desambiguar em todo pedido.
  const exato = lista.filter((c: any) => String(c.name).trim().toLowerCase() === q.toLowerCase());
  return exato.length === 1 ? exato : lista;
}

async function proporMensagem(input: any, ctx: Ctx) {
  const texto = String(input.texto ?? "").trim();
  if (!texto) return { status: "sem_texto", mensagem: "Qual é a mensagem que devo enviar?" };
  const tipo = input.destino_tipo === "canal" ? "canal" : "pessoa";

  if (tipo === "pessoa") {
    const { cands, inativos } = await resolverColaborador(ctx.admin, input.destino_nome);
    if (cands.length === 0) {
      if (inativos.length > 0) return { status: "inativo", opcoes: inativos.map(rotulo),
        mensagem: `Existe "${inativos.map(rotulo).join(" | ")}", mas está INATIVO — não dá pra mandar mensagem.` };
      return { status: "nao_encontrado", mensagem: `Não achei ninguém chamado "${input.destino_nome}" no cadastro.` };
    }
    if (cands.length > 1) return { status: "ambiguo", opcoes: cands.map(rotulo),
      mensagem: `Achei mais de um: ${cands.map(rotulo).join(" | ")}. Qual deles? MOSTRE o setor e o e-mail pro dono escolher.` };
    const alvo = cands[0];
    const resumo = `💬 Mensagem no chat interno para *${rotulo(alvo)}*:\n"${texto}"`;
    await criarPendente(ctx.admin, ctx.canon, "enviar_mensagem", {
      actor: ctx.dono.profile_id, tipo: "pessoa", pessoa_id: alvo.id, destino_nome: alvo.name, texto,
    }, resumo);
    return { status: "aguardando_confirmacao", resumo, instrucao: "Mostre o resumo e peça confirmação antes de 'confirmar'." };
  }

  const canais = await resolverCanal(ctx.admin, input.destino_nome);
  if (canais.length === 0) return { status: "nao_encontrado", mensagem: `Não achei um canal chamado "${input.destino_nome}" no Gestor.` };
  if (canais.length > 1) return { status: "ambiguo", opcoes: canais.map((c: any) => c.name),
    mensagem: `Achei mais de um canal: ${canais.map((c: any) => c.name).join(", ")}. Qual?` };
  const canal = canais[0];
  const resumo = `💬 Mensagem no canal *${canal.name}*:\n"${texto}"`;
  await criarPendente(ctx.admin, ctx.canon, "enviar_mensagem", {
    actor: ctx.dono.profile_id, tipo: "canal", canal_id: canal.id, destino_nome: canal.name, texto,
  }, resumo);
  return { status: "aguardando_confirmacao", resumo, instrucao: "Mostre o resumo e peça confirmação antes de 'confirmar'." };
}

// Texto ditado → HTML do editor do plano (o front renderiza com DOMPurify, classe gt-rich-content).
// ESCAPA tudo antes: o texto vem de ditado/transcrição e NÃO pode injetar HTML. Suporta só o
// mínimo: linhas "- item" viram <ul><li>, **negrito** vira <strong>, resto vira <p>.
function textoParaHtml(texto: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const negrito = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const linhas = String(texto ?? "").split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  let lista: string[] = [];
  const fecharLista = () => {
    if (lista.length) { out.push(`<ul>${lista.map((li) => `<li>${li}</li>`).join("")}</ul>`); lista = []; }
  };
  for (const l of linhas) {
    if (!l) { fecharLista(); continue; }
    const m = l.match(/^[-•*]\s+(.*)$/);
    if (m) lista.push(negrito(m[1]));
    else { fecharLista(); out.push(`<p>${negrito(l)}</p>`); }
  }
  fecharLista();
  return out.join("") || `<p>${negrito(String(texto ?? "").trim())}</p>`;
}

const ESCOPO_LABEL: Record<string, string> = {
  geral_todos: "todo o comercial (SDRs + vendedores)",
  geral_vendedor: "só os vendedores",
  geral_sdr: "só os SDRs",
};

async function proporPlano(input: any, ctx: Ctx) {
  const texto = String(input.texto ?? "").trim();
  if (!texto) return { status: "sem_texto", mensagem: "Qual é o plano/alinhamento que devo salvar?" };
  const escopo = ["geral_todos", "geral_vendedor", "geral_sdr"].includes(input.escopo) ? input.escopo : "geral_todos";
  const modo = input.modo === "substituir" ? "substituir" : "acrescentar";
  const html = textoParaHtml(texto);

  // Dia analisado: por padrão o dia útil anterior (mesma âncora da tela). Resolvido no banco p/ não
  // divergir da régua (sábado é dia de trabalho; domingo/feriado ficam fora).
  let data: string | null = typeof input.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.data) ? input.data : null;
  if (!data) {
    const { data: d } = await ctx.admin.rpc("feedback_dia_util_anterior", { p_ref: hojeSP() });
    data = (d as unknown as string) ?? null;
  }

  // Já existe plano desse dia/escopo? (não destrói nada sem o dono mandar)
  let jaExiste = false;
  if (data) {
    const { data: ex } = await ctx.admin
      .from("feedback_diario_planos")
      .select("id")
      .eq("data_referencia", data).is("colaborador_id", null).eq("indicador", escopo)
      .limit(1);
    jaExiste = (ex ?? []).length > 0;
  }

  const resumo =
    `📋 *Plano geral do comercial* — ${data ? fmtData(data) : "dia útil anterior"} · ${ESCOPO_LABEL[escopo]}\n\n` +
    texto +
    (jaExiste
      ? `\n\n⚠️ Já existe um plano salvo nesse dia — vou *${modo === "substituir" ? "SUBSTITUIR" : "ACRESCENTAR ao final"}*.`
      : "");

  await criarPendente(ctx.admin, ctx.canon, "salvar_plano", {
    actor: ctx.dono.profile_id, texto: html, data, escopo, modo,
  }, resumo);

  return {
    status: "aguardando_confirmacao", resumo, ja_existe: jaExiste,
    instrucao:
      "Mostre o resumo ao dono e peça confirmação. NÃO chame 'confirmar' até ele responder que sim. " +
      (jaExiste ? "Avise que já existe plano no dia e que o padrão é acrescentar (ele pode pedir 'substituir')." : ""),
  };
}

async function enviarCronogramaPdf(input: any, ctx: Ctx) {
  const busca = String(input?.turma || "").trim();
  if (busca.length < 3) return { status: "erro", mensagem: "Diga o nome da turma (ex.: 'Reprodução de Bovinos 01/26 #02')." };
  const { data: turmas, error } = await ctx.admin.rpc("assist_ped_turmas", { p_curso: null, p_busca: busca });
  if (error) throw new Error(error.message);
  const lista = Array.isArray(turmas) ? turmas : [];
  if (lista.length === 0) return { status: "nao_encontrado", mensagem: `Não achei turma com "${busca}".` };
  if (lista.length > 1) {
    return { status: "ambiguo", opcoes: lista.map((t: any) => t.turma),
      mensagem: `Achei ${lista.length} turmas com "${busca}". Qual? ${lista.map((t: any) => t.turma).join(" | ")}` };
  }
  const turma = lista[0];
  const { data: cron, error: e2 } = await ctx.admin.rpc("assist_ped_turma_cronograma", { p_turma_id: turma.id });
  if (e2) throw new Error(e2.message);
  const t = (cron?.turma ?? {}) as any;
  const aulas: any[] = Array.isArray(cron?.cronograma) ? cron.cronograma : [];
  const linhas: string[] = [
    `# ${t.curso ?? ""}`,
    `${t.turma ?? ""}`,
    `Situacao: ${t.situacao ?? "-"} · inicio ${t.data_inicio ? fmtData(t.data_inicio) : "a definir"}` +
      `${t.data_fim ? ` · fim ${fmtData(t.data_fim)}` : ""}${t.modalidade ? ` · ${t.modalidade}` : ""}`,
    "",
    `# Cronograma (${aulas.length} aulas)`,
  ];
  for (const a of aulas) {
    const data = a.data ? fmtData(a.data) : "a definir";
    const hora = a.horario ? ` · ${a.horario}` : "";
    linhas.push(`- ${data}${hora} — ${a.titulo ?? ""}`);
    if (a.ementa) linhas.push(String(a.ementa));
    if (a.professor) linhas.push(`Prof.: ${a.professor}`);
    linhas.push("");
  }
  const titulo = `Cronograma - ${t.turma ?? busca}`.slice(0, 90);
  const r = await gerarEnviarPdf({ titulo, conteudo: linhas.join("\n") }, ctx);
  if (r.status !== "enviado") return r;
  return {
    status: "enviado",
    mensagem: `✅ Cronograma da turma "${t.turma}" enviado em PDF (${aulas.length} aulas).`,
    _instrucao: "O PDF JÁ foi enviado ao dono. Responda em 1 linha; NÃO repita o cronograma inteiro.",
  };
}

async function verAgenda(input: any, ctx: Ctx) {
  if (!ctx.dono.calendar_integration_id) {
    return { status: "sem_agenda", mensagem: `A agenda do Google de ${ctx.dono.nome} ainda não está conectada.` };
  }
  const { de, ate } = janela(input);
  const eventos = await listarEventos(ctx.admin, ctx.dono.calendar_integration_id, de, ate);
  return { status: "ok", total: eventos.length, eventos };
}

async function proporReuniao(input: any, ctx: Ctx) {
  if (!ctx.dono.calendar_integration_id) {
    return { status: "sem_agenda", mensagem: `A agenda do Google de ${ctx.dono.nome} ainda não está conectada, então não dá pra criar reunião ainda.` };
  }
  const inicioIso = spToIso(input.data, input.hora_inicio);
  const fimIso = input.hora_fim
    ? spToIso(input.data, input.hora_fim)
    : new Date(new Date(inicioIso).getTime() + 60 * 60000).toISOString();
  const convidados = (input.convidados ?? []).filter((e: any) => typeof e === "string" && e.includes("@"));
  const meet = input.criar_meet !== false;
  const resumo =
    `📅 Reunião: "${input.titulo}" em ${fmtData(input.data)} às ${input.hora_inicio}` +
    `${input.hora_fim ? `–${input.hora_fim}` : ""}` +
    `${convidados.length ? ` · com ${convidados.join(", ")}` : ""}` +
    `${meet ? " · com link do Meet" : ""}`;
  await criarPendente(ctx.admin, ctx.canon, "criar_reuniao", {
    titulo: input.titulo, inicioIso, fimIso, convidados, descricao: input.descricao ?? "", criar_meet: meet,
  }, resumo);
  return {
    status: "aguardando_confirmacao", resumo,
    aviso: convidados.length ? "Ao confirmar, o convite vai por e-mail ao convidado." : null,
    instrucao: "Mostre o resumo e peça confirmação antes de chamar 'confirmar'.",
  };
}

async function confirmarPendente(ctx: Ctx) {
  const p = await pendenteAtual(ctx.admin, ctx.canon);
  if (!p) return { status: "nada_pendente", mensagem: "Não há nenhuma ação aguardando confirmação." };

  // CLAIM atômico: só ESTA invocação executa (evita duplicar tarefa/reunião sob concorrência —
  // "confirma" duplo ou reentrega do webhook). A ação em si (INSERT) não é idempotente.
  const { data: claim } = await ctx.admin
    .from("assistente_acoes_pendentes")
    .update({ status: "confirmada" })
    .eq("id", p.id)
    .eq("status", "pendente")
    .select("id");
  if (!claim || claim.length !== 1) {
    return { status: "ja_processada", mensagem: "Essa ação já foi confirmada." };
  }

  try {
    if (p.tipo === "criar_tarefa") {
      const pl = p.payload;
      const { data, error } = await ctx.admin.rpc("gt_bot_criar_tarefa", {
        p_actor: pl.actor, p_assignee: pl.assignee, p_title: pl.titulo,
        p_description: pl.descricao ?? "", p_due_date: pl.prazo ?? null,
        p_priority: pl.prioridade ?? "normal", p_list_id: null,
        p_para_diretores: pl.para_diretores ?? true,
      });
      if (error) throw new Error(error.message);
      return { status: "criada", tipo: "tarefa", task_id: data?.task_id,
        mensagem: `✅ Tarefa criada e ${pl.assignee_nome} foi avisada no Gestor.` };
    }
    if (p.tipo === "enviar_mensagem") {
      const pl = p.payload;
      const { error } = await ctx.admin.rpc("assistente_enviar_chat_mensagem", {
        p_actor: pl.actor, p_tipo: pl.tipo, p_pessoa_id: pl.pessoa_id ?? null,
        p_canal_id: pl.canal_id ?? null, p_content: pl.texto, p_mentions: [],
      });
      if (error) throw new Error(error.message);
      return { status: "enviada", tipo: "mensagem",
        mensagem: `✅ Mensagem enviada no chat interno para ${pl.destino_nome}.` };
    }
    if (p.tipo === "criar_reuniao") {
      const pl = p.payload;
      const r = await criarReuniao(ctx.admin, ctx.dono.calendar_integration_id!, pl);
      return { status: "criada", tipo: "reuniao", meetLink: r.meetLink,
        mensagem: `✅ Reunião criada${r.meetLink ? `. Link do Meet: ${r.meetLink}` : ""}.` };
    }
    if (p.tipo === "salvar_plano") {
      const pl = p.payload;
      const { data, error } = await ctx.admin.rpc("assistente_salvar_plano_comercial", {
        p_actor: pl.actor, p_texto: pl.texto, p_data: pl.data ?? null,
        p_escopo: pl.escopo ?? "geral_todos", p_modo: pl.modo ?? "acrescentar",
      });
      if (error) throw new Error(error.message);
      const acao = (data as any)?.acao ?? "salvo";
      const dia = (data as any)?.data_referencia;
      return {
        status: "salvo", tipo: "plano", plano_id: (data as any)?.id,
        mensagem:
          `✅ Plano geral do comercial ${acao} para ${dia ? fmtData(dia) : "o dia útil anterior"}. ` +
          `O time já vê na tela (Métricas do Time → Feedback Diário).`,
      };
    }
    return { status: "tipo_desconhecido" };
  } catch (e) {
    // falhou ao executar: reverte o claim p/ o dono poder confirmar de novo
    await marcarPendente(ctx.admin, p.id, "pendente");
    throw e;
  }
}

async function cancelarPendente(ctx: Ctx) {
  const p = await pendenteAtual(ctx.admin, ctx.canon);
  if (!p) return { status: "nada_pendente", mensagem: "Não havia nada pendente." };
  await marcarPendente(ctx.admin, p.id, "cancelada");
  return { status: "cancelada", mensagem: "Ok, cancelei essa ação." };
}
