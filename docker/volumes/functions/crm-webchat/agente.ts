// Cérebro do João para o WEBCHAT (Fase 2) — ISOLADO do agente de WhatsApp.
// Roda um turno SÍNCRONO: persona do João + loop Anthropic com 2 tools que batem na
// MESMA sdr-api (disponibilidade + criar reunião). Sem tocar em crm-agente-sdr.
//
// v1: agenda a reunião (POST sdr-api/agendamentos) — a CONVERSÃO que o teste quer medir.
// O link do Google Meet fica pra uma 2ª etapa (o agendamento entra no fluxo normal de
// lembretes por WhatsApp). Curso/Meet e mais tools (objeções, envia_informacoes) depois.

const ANTHROPIC_KEY = Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODELO = Deno.env.get("AGENTE_SDR_MODEL") ?? "claude-sonnet-4-6";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SDR_API_URL = (Deno.env.get("AGENTE_SDR_SDRAPI_URL") ?? `${SUPABASE_URL}/functions/v1/sdr-api`).replace(/\/$/, "");
const SDR_API_KEY = Deno.env.get("AGENTE_SDR_SDRAPI_KEY") ?? "";

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

// ── persona do João (webchat) ────────────────────────────────────────────────
function systemPrompt(nome: string, curso: string | null): string {
  return [
    "Você é o **João**, SDR (consultor) da PPG Educação, atendendo pelo CHAT do site em português brasileiro.",
    `Você está falando com **${nome || "o visitante"}**${curso ? `, que demonstrou interesse em: ${curso}.` : "."}`,
    contextoTemporal(),
    "",
    "## Sua missão",
    "1. Acolher e entender rápido o interesse da pessoa (qual pós/área, formação).",
    "2. Oferecer uma **conversa rápida no Google Meet com um monitor especialista** para tirar dúvidas.",
    "3. Se a pessoa topar, use a ferramenta `consulta_disponibilidade` para trazer HORÁRIOS REAIS e deixe ela escolher.",
    "4. Quando ela escolher um horário, use `confirmar_agendamento` para marcar a reunião.",
    "",
    "## Regras de ouro (invioláveis)",
    "- Envie só a mensagem final, natural e curta — NUNCA escreva seu raciocínio, plano ou 'a função retornou'.",
    "- NUNCA invente horário. Só ofereça horários que vieram de `consulta_disponibilidade`.",
    "- O dia da semana que a ferramenta devolve é o correto — use-o exatamente, não recalcule.",
    "- Uma ideia por mensagem, tom acolhedor e consultivo, sem parecer robô. Emojis com moderação.",
    "- Só chame `confirmar_agendamento` depois que a pessoa escolher explicitamente um dos horários oferecidos.",
    "- Se a ferramenta de agenda falhar, NÃO diga que não há horários; diga que vai confirmar com o time e já retorna.",
  ].join("\n");
}

// ── tools (schema Anthropic) ─────────────────────────────────────────────────
const TOOLS = [
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

// ── execução das tools (via sdr-api) ─────────────────────────────────────────
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

// Recebe o histórico (mais antigo→recente) do webchat + gera a resposta do João.
// history: [{ role:'user'|'assistant', text }]
export async function responderWebchat(
  nome: string,
  telefone: string,
  curso: string | null,
  history: { role: "user" | "assistant"; text: string }[],
): Promise<string> {
  if (!ANTHROPIC_KEY) return "Estou com uma instabilidade aqui, já te respondo. 🙏";
  const system = systemPrompt(nome, curso);
  const messages: Msg[] = history.map((m) => ({ role: m.role, content: m.text }));

  for (let passo = 0; passo < 4; passo++) {
    const resp = await anthropic(system, messages);
    const blocos: any[] = resp.content ?? [];
    const toolUses = blocos.filter((b) => b.type === "tool_use");
    const texto = blocos.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

    if (!toolUses.length) {
      return texto || "Pode me contar um pouco mais sobre o que você procura? 😊";
    }

    // executa as tools e devolve os resultados
    messages.push({ role: "assistant", content: blocos });
    const resultados: any[] = [];
    for (const tu of toolUses) {
      let out = "";
      if (tu.name === "consulta_disponibilidade") out = await execDisponibilidade(tu.input);
      else if (tu.name === "confirmar_agendamento") out = await execAgendar(tu.input, telefone);
      else out = "Ferramenta desconhecida.";
      resultados.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    messages.push({ role: "user", content: resultados });
  }

  // salvaguarda: estourou o nº de passos com tools — pede continuidade
  return "Deixa eu confirmar uma coisa aqui rapidinho e já te falo. 🙌";
}
