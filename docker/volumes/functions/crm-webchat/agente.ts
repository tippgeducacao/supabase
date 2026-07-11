// Cérebro do João para o WEBCHAT (Fase 2) — ISOLADO do agente de WhatsApp.
// Roda um turno SÍNCRONO: persona do João + loop Anthropic com 2 tools que batem na
// MESMA sdr-api (disponibilidade + criar reunião). Sem tocar em crm-agente-sdr.
//
// v1: agenda a reunião (POST sdr-api/agendamentos) — a CONVERSÃO que o teste quer medir.
// O link do Google Meet fica pra uma 2ª etapa (o agendamento entra no fluxo normal de
// lembretes por WhatsApp). Curso/Meet e mais tools (objeções, envia_informacoes) depois.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
// Reusa os PROMPTS REAIS do João de WhatsApp (byte-idênticos ao de produção) — sem drift.
// São dois estágios + router (igual ao agente real): VALIDACAO (abertura/qualificação/
// horários) → o router detecta que o lead escolheu um horário → QUALIFICADOR (fecha:
// formação + agendamento). Se o cross-import falhar no deploy, o fallback assume.
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO, PROMPT_ROUTER } from "../crm-agente-sdr/prompts.ts";

const ANTHROPIC_KEY = Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODELO = Deno.env.get("AGENTE_SDR_MODEL") ?? "claude-sonnet-4-6";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SDR_API_URL = (Deno.env.get("AGENTE_SDR_SDRAPI_URL") ?? `${SUPABASE_URL}/functions/v1/sdr-api`).replace(/\/$/, "");
const SDR_API_KEY = Deno.env.get("AGENTE_SDR_SDRAPI_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");
const DIA_SEMANA_BR = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function toBrasilia(isoUtc: string) {
  const br = new Date(new Date(isoUtc).getTime() - BR_OFFSET_MS);
  const hh = pad(br.getUTCHours());
  const mm = pad(br.getUTCMinutes());
  return {
    data: `${br.getUTCFullYear()}-${pad(br.getUTCMonth() + 1)}-${pad(br.getUTCDate())}`,
    horario: `${hh}:${mm}`,
    display: mm === "00" ? `${hh}h` : `${hh}h${mm}`,
    diaSemana: DIA_SEMANA_BR[br.getUTCDay()],
  };
}

function contextoTemporal(): string {
  const agora = new Date(Date.now() - BR_OFFSET_MS);
  return `Agora em Brasília: ${DIA_SEMANA_BR[agora.getUTCDay()]}, ${pad(agora.getUTCDate())}/${pad(agora.getUTCMonth() + 1)}/${agora.getUTCFullYear()} às ${pad(agora.getUTCHours())}:${pad(agora.getUTCMinutes())}.`;
}

function sdrApi(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SDR_API_URL}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SDR_API_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

// ── persona do João (webchat) = PROMPT REAL do WhatsApp + nota do canal ───────
// Substitui os placeholders n8n mantidos no prompt ({{ $json.nome }} etc.) — mesmo
// regex do renderPrompt de contexto.ts (replicado inline p/ não importar mais um módulo).
function render(p: string, vars: Record<string, string>): string {
  return p.replace(/\{\{\s*\$json\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, k) => vars[k] ?? m);
}
function limparCurso(c: string | null): string {
  if (!c) return "";
  return c.replace(/^p[oó]s\s*\|\s*/i, "").replace(/^mba\s*\|\s*/i, "MBA ").replace(/^curso\s*\|\s*/i, "").trim();
}
// Fallback caso o import cross-function do prompt real não resolva no deploy.
const PROMPT_FALLBACK = "Você é o **João**, consultor (SDR) da **PPG Educação**, instituição especializada em pós-graduações e MBAs de **AGRONEGÓCIO e MEDICINA VETERINÁRIA**. Fale português brasileiro, tom acolhedor e consultivo. Missão: entender o interesse e a formação da pessoa, oferecer uma conversa rápida no Google Meet com um monitor especialista, e (se topar) usar as ferramentas p/ horários reais e marcar. NUNCA invente curso — catálogo só agro/vet; em dúvida use `consulta_pos_disponiveis`. NUNCA invente horário — só os de `consulta_disponibilidade`.";

type Estagio = "validacao" | "qualificador";

function systemPrompt(nome: string, curso: string | null, estagio: Estagio): string {
  const real = estagio === "qualificador" ? AGENTE_QUALIFICADOR : AGENTE_VALIDACAO;
  const base = (typeof real === "string" && real) ? real : PROMPT_FALLBACK;
  const cursoLimpo = limparCurso(curso);
  const rendered = render(base, {
    nome: (nome || "").trim(),
    curso_interesse_original: cursoLimpo || "(não informado — descubra na conversa, sem inventar)",
    pergunta_formacao: "me confirma rapidinho: qual é a sua formação (graduação)? e o que te levou a buscar essa pós agora?",
  });
  const notaCanal = [
    "", "---",
    "## ⚙️ ESTE CANAL É O CHAT DO SITE (não é WhatsApp)",
    "- A pessoa está te vendo em TEMPO REAL na página — seja ágil e direto.",
    "- As confirmações e lembretes da reunião chegam pelo WhatsApp dela (já temos o número).",
    "- Ferramentas disponíveis AQUI: `consulta_pos_disponiveis` (catálogo REAL), `consulta_disponibilidade` (horários), `confirmar_agendamento` (marcar). Não há outras neste canal — se precisar de algo além, conduza pela conversa.",
    "- ⛔ NUNCA invente um curso: o catálogo é SÓ agro/veterinária/agronegócio. Em dúvida, chame `consulta_pos_disponiveis`. Área fora do escopo (odontologia, direito, medicina humana…) → diga com gentileza que a PPG é especializada em agro/vet e redirecione, sem inventar curso.",
    curso ? `- ⭐ Esta conversa veio da página da pós **"${cursoLimpo}"** — ancore nela.` : "",
  ].filter(Boolean).join("\n");
  return contextoTemporal() + "\n\n" + rendered + notaCanal;
}

// ── tools (schema Anthropic) ─────────────────────────────────────────────────
const TOOLS = [
  {
    name: "consulta_pos_disponiveis",
    description: "Lista as pós-graduações REAIS e ativas da PPG (agro/veterinária). Use SEMPRE que não tiver certeza de qual pós a pessoa quer, ou quando ela perguntar o que existe. NUNCA invente um curso — consulte aqui primeiro.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "consulta_disponibilidade",
    description: "Busca horários REAIS disponíveis para a reunião no Google Meet com um monitor. Use sempre que a pessoa topar conversar ou pedir horários. Nunca ofereça horário que não tenha vindo daqui.",
    input_schema: {
      type: "object",
      properties: {
        curso_escolhido: { type: "string", description: "Nome da pós/curso de interesse (ex.: 'Clínica de Felinos'). Use o que a pessoa disse." },
        data_desejada: { type: "string", description: "Opcional. Data específica AAAA-MM-DD se a pessoa pediu um dia." },
        periodo_desejado: { type: "string", description: "Opcional: 'manha', 'tarde' ou 'noite' se a pessoa preferiu um período." },
      },
      required: ["curso_escolhido"],
    },
  },
  {
    name: "confirmar_agendamento",
    description: "Marca a reunião no horário que a pessoa ESCOLHEU. Só chame depois de ela escolher explicitamente um dos horários oferecidos por consulta_disponibilidade.",
    input_schema: {
      type: "object",
      properties: {
        curso_escolhido: { type: "string", description: "Nome da pós/curso de interesse." },
        vendedor_id: { type: "string", description: "vendedor_id do slot escolhido (veio de consulta_disponibilidade)." },
        data_escolhida: { type: "string", description: "Data do slot escolhido, AAAA-MM-DD." },
        horario_escolhido: { type: "string", description: "Horário do slot escolhido, HH:MM (24h)." },
      },
      required: ["curso_escolhido", "vendedor_id", "data_escolhida", "horario_escolhido"],
    },
  },
];

// ── execução das tools ───────────────────────────────────────────────────────
async function execCatalogo(): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("cursos")
      .select("nome")
      .eq("ativo", true)
      .eq("modalidade", "Pós-Graduação")
      .order("nome");
    if (error || !data?.length) {
      return "Não consegui puxar o catálogo agora. NÃO invente cursos — ofereça a conversa com o especialista pra detalhar.";
    }
    const lista = (data as { nome: string }[]).map((c) => `- ${c.nome}`).join("\n");
    return `Pós-graduações ATIVAS da PPG (fale o nome NATURAL, sem os prefixos "PÓS |"/"MBA |"; cite só 2-4 relevantes ao interesse da pessoa):\n${lista}`;
  } catch (_e) {
    return "Não consegui puxar o catálogo agora. NÃO invente cursos — ofereça a conversa com o especialista.";
  }
}

async function execDisponibilidade(input: any): Promise<string> {
  const qs = new URLSearchParams({ pos: input.curso_escolhido ?? "", limite: "6" });
  if (input.data_desejada) qs.set("data", input.data_desejada);
  if (input.periodo_desejado) qs.set("periodo", input.periodo_desejado);

  let resultado: any = {};
  let erro: string | null = null;
  for (let t = 1; t <= 2; t++) {
    try {
      const res = await sdrApi(`disponibilidade?${qs.toString()}`);
      resultado = await res.json().catch(() => ({}));
      if (res.ok && resultado?.success !== false) { erro = null; break; }
      erro = `HTTP ${res.status}`;
    } catch (e) { erro = (e as Error).message; }
    if (t < 2) await new Promise((r) => setTimeout(r, 600));
  }
  if (erro) {
    return "ERRO técnico ao consultar a agenda (NÃO é falta de horário). Não diga que não há horários; diga que vai confirmar com o time e já retorna.";
  }
  const slots: any[] = resultado.data?.slots || resultado.slots || [];
  if (!slots.length) return "Nenhum horário disponível para o período solicitado. Ofereça outro dia/período.";
  const linhas = slots.map((s) => {
    const b = toBrasilia(s.inicio);
    return `- ${b.display} de ${b.diaSemana}, dia ${b.data} (vendedor_id: ${s.vendedor_id}, nome: ${s.vendedor_nome})`;
  });
  return `Horários disponíveis (Brasília) — use o dia da semana exatamente como está:\n${linhas.join("\n")}`;
}

async function execAgendar(input: any, telefone: string): Promise<string> {
  try {
    const post = await sdrApi("agendamentos", {
      method: "POST",
      body: JSON.stringify({
        lead: { whatsapp: telefone },
        pos_graduacao_interesse: input.curso_escolhido,
        vendedor_id: input.vendedor_id,
        data_agendamento: `${input.data_escolhida}T${input.horario_escolhido}:00-03:00`,
      }),
    });
    const resp = await post.json().catch(() => ({}));
    if (!post.ok || resp.error || !resp.data) {
      throw new Error(typeof resp.error === "string" ? resp.error : `HTTP ${post.status}`);
    }
    return `Reunião marcada com sucesso para ${input.data_escolhida} às ${input.horario_escolhido} (Brasília). Confirme pra pessoa de forma calorosa e diga que os detalhes chegam pelo WhatsApp.`;
  } catch (e) {
    return `ERRO técnico ao marcar (NÃO é culpa da pessoa): ${(e as Error).message}. Peça desculpas breves e diga que vai confirmar com o time e já retorna.`;
  }
}

// ── loop Anthropic ───────────────────────────────────────────────────────────
type Msg = { role: "user" | "assistant"; content: any };

async function anthropic(system: string, messages: Msg[]): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODELO, max_tokens: 1024, system, tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

// Abertura PROATIVA: o João manda a 1ª mensagem já puxando conversa. ALINHADA AO ROTEIRO
// DE VALIDAÇÃO real: cumprimenta + menciona o curso + OFERECE a conversa no Meet (não
// pergunta formação/graduação aqui — isso é do fechamento/qualificador). Sem tools.
export async function aberturaWebchat(nome: string, curso: string | null): Promise<string> {
  const primeiro = (nome || "").trim().split(/\s+/)[0] || "";
  const fallback = `Oi${primeiro ? ", " + primeiro : ""}! 👋 Que bom te ver por aqui. Vi seu interesse na nossa pós — que tal uma conversa rápida no Google Meet com um monitor especialista pra te mostrar tudo? Topa que eu já procuro um horário?`;
  if (!ANTHROPIC_KEY) return fallback;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 300,
        system: systemPrompt(nome, curso, "validacao"), // abertura é sempre validação
        messages: [{
          role: "user",
          content: "[SISTEMA — não é o visitante] O visitante acabou de abrir o chat vindo da página da pós de interesse e ainda NÃO escreveu nada. Faça a ABERTURA conforme o SEU roteiro de validação: cumprimente pelo primeiro nome, diga que viu o interesse na pós (mencione o curso) e conduza OFERECENDO a conversa rápida no Google Meet com um monitor especialista (condição especial + metodologia + cronograma + professores). Termine com uma pergunta convidando a marcar. ⛔ NÃO pergunte a formação/graduação agora — isso é do fechamento, depois de escolher o horário. Curto, caloroso, português. Envie só a mensagem final.",
        }],
      }),
    });
    const data = await res.json();
    const txt = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    return txt || fallback;
  } catch (_e) {
    return fallback;
  }
}

// Router: decide validação × qualificador pelo MESMO critério do agente real
// (PROMPT_ROUTER: o lead já escolheu um horário concreto? → qualificador). Tool forçada,
// temp 0. Falha/sem-chave → 'validacao' (estágio seguro de abertura).
async function roteador(messages: Msg[]): Promise<Estagio> {
  if (!ANTHROPIC_KEY || typeof PROMPT_ROUTER !== "string" || !PROMPT_ROUTER) return "validacao";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "structured-outputs-2025-11-13",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 512,
        temperature: 0,
        system: PROMPT_ROUTER,
        messages,
        tools: [{
          name: "router_output",
          description: "Seleciona o agente correto para responder a mensagem.",
          input_schema: {
            type: "object",
            properties: { agent: { type: "string", enum: ["agente_validacao", "agente_qualificador"] } },
            required: ["agent"],
            additionalProperties: false,
          },
        }],
        tool_choice: { type: "tool", name: "router_output" },
      }),
    });
    const data = await res.json();
    const bloco = (data.content ?? []).find((b: any) => b.type === "tool_use");
    return bloco?.input?.agent === "agente_qualificador" ? "qualificador" : "validacao";
  } catch (_e) {
    return "validacao";
  }
}

// Recebe o histórico (mais antigo→recente) do webchat + gera a resposta do João.
// Roteia validação×qualificador com RATCHET persistido (como o agente real): a edge
// passa o estágio salvo da sessão; se já é 'qualificador', nem chama o router (não
// regride); senão roteia e devolve o estágio usado pra edge persistir a promoção.
export async function responderWebchat(
  nome: string,
  telefone: string,
  curso: string | null,
  history: { role: "user" | "assistant"; text: string }[],
  estagioSalvo: Estagio = "validacao",
): Promise<{ texto: string; estagio: Estagio }> {
  if (!ANTHROPIC_KEY) return { texto: "Estou com uma instabilidade aqui, já te respondo. 🙏", estagio: estagioSalvo };
  const messages: Msg[] = history.map((m) => ({ role: m.role, content: m.text }));
  const estagio: Estagio = estagioSalvo === "qualificador" ? "qualificador" : await roteador(messages);
  const system = systemPrompt(nome, curso, estagio);

  for (let passo = 0; passo < 4; passo++) {
    const resp = await anthropic(system, messages);
    const blocos: any[] = resp.content ?? [];
    const toolUses = blocos.filter((b) => b.type === "tool_use");
    const texto = blocos.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

    if (!toolUses.length) {
      return { texto: texto || "Pode me contar um pouco mais sobre o que você procura? 😊", estagio };
    }

    // executa as tools e devolve os resultados
    messages.push({ role: "assistant", content: blocos });
    const resultados: any[] = [];
    for (const tu of toolUses) {
      let out = "";
      if (tu.name === "consulta_pos_disponiveis") out = await execCatalogo();
      else if (tu.name === "consulta_disponibilidade") out = await execDisponibilidade(tu.input);
      else if (tu.name === "confirmar_agendamento") out = await execAgendar(tu.input, telefone);
      else out = "Ferramenta desconhecida.";
      resultados.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    messages.push({ role: "user", content: resultados });
  }

  // salvaguarda: estourou o nº de passos com tools — pede continuidade
  return { texto: "Deixa eu confirmar uma coisa aqui rapidinho e já te falo. 🙌", estagio };
}
