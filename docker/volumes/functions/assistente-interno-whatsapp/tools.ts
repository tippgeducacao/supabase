// Ferramentas do assistente (Fase 1): criar tarefa (com confirmação), ver agenda,
// criar reunião (com confirmação), confirmar/cancelar a ação pendente.
import type { Ctx } from "./db.ts";
import { criarPendente, pendenteAtual, marcarPendente } from "./db.ts";
import { listarEventos, criarReuniao } from "./agenda.ts";
import { fmtData, spToIso, janela } from "./datas.ts";

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
    name: "confirmar",
    description:
      "Executa a ação que está aguardando confirmação (criar tarefa OU criar reunião). Só chame quando o dono confirmar explicitamente (sim, pode, confirmo, isso).",
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
      case "confirmar": return await confirmarPendente(ctx);
      case "cancelar": return await cancelarPendente(ctx);
      default: return { erro: `ferramenta desconhecida: ${nome}` };
    }
  } catch (e) {
    return { status: "erro", mensagem: `Falha ao executar ${nome}: ${(e as Error).message}` };
  }
}

async function resolverColaborador(admin: any, nome: string) {
  const { data } = await admin
    .from("profiles")
    .select("id, name")
    .ilike("name", `%${String(nome).trim()}%`)
    .eq("ativo", true)
    .limit(5);
  return data ?? [];
}

async function proporTarefa(input: any, ctx: Ctx) {
  const cands = await resolverColaborador(ctx.admin, input.responsavel_nome);
  if (cands.length === 0) {
    return { status: "nao_encontrado", mensagem: `Não achei um colaborador ativo chamado "${input.responsavel_nome}".` };
  }
  if (cands.length > 1) {
    return { status: "ambiguo", opcoes: cands.map((c: any) => c.name),
      mensagem: `Achei mais de um: ${cands.map((c: any) => c.name).join(", ")}. Qual deles?` };
  }
  const alvo = cands[0];
  const paraDiretores = input.espaco !== "inbox";
  const prazoTxt = input.prazo ? ` · prazo ${fmtData(input.prazo)}` : "";
  const prioTxt = input.prioridade && input.prioridade !== "normal" ? ` · ${input.prioridade}` : "";
  const espacoTxt = paraDiretores ? "" : " · na lista de novas tarefas do setor";
  const resumo = `📋 Tarefa: "${input.titulo}" para *${alvo.name}*${prazoTxt}${prioTxt}${espacoTxt}`;
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
    const cands = await resolverColaborador(ctx.admin, input.destino_nome);
    if (cands.length === 0) return { status: "nao_encontrado", mensagem: `Não achei um colaborador ativo chamado "${input.destino_nome}".` };
    if (cands.length > 1) return { status: "ambiguo", opcoes: cands.map((c: any) => c.name),
      mensagem: `Achei mais de um: ${cands.map((c: any) => c.name).join(", ")}. Qual deles?` };
    const alvo = cands[0];
    const resumo = `💬 Mensagem no chat interno para *${alvo.name}*:\n"${texto}"`;
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
