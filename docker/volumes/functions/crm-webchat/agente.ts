// Cérebro do João para o WEBCHAT (Fase 2) — REUSA os módulos reais do agente de WhatsApp
// (crm-agente-sdr) por import, sem duplicar: PARIDADE TOTAL de prompts, router, contexto
// temporal (com a TABELA DE HORÁRIOS DE ATENDIMENTO) e as 9 tools reais. O que NÃO é
// reusado é só a I/O de WhatsApp (buffer/lock/debounce/chunks) — aqui a resposta é síncrona
// e escrita em webchat_mensagens. Não toca no crm-agente-sdr (só importa).
//
// ⚠️ confirmar_agendamento cria reunião REAL (GCal). envia_informacoes manda material pro
// WhatsApp do lead (ele deu o número). Fluxo/tools = os mesmos do João de WhatsApp.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from "../crm-agente-sdr/prompts.ts";
import { montarContextoTemporal, renderPrompt } from "../crm-agente-sdr/contexto.ts";
import { carregarTools, chamarAgentePrincipal, chamarRouter } from "../crm-agente-sdr/agente.ts";
import { executarTool, montarToolResults } from "../crm-agente-sdr/tools.ts";
import { limparParaRouter, sanitizarHistorico } from "../crm-agente-sdr/historico.ts";

const ANTHROPIC_KEY = Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODELO = Deno.env.get("AGENTE_SDR_MODEL") ?? "claude-sonnet-4-6";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const MAX_RODADAS = 6;

export type Estagio = "validacao" | "qualificador";
type Msg = { role: "user" | "assistant"; content: any };
// CtxConversa do agente real — no webchat waAccountId/oportunidadeId ficam nulos.
type CtxConversa = { remotejid: string; telefone: string; waAccountId: string | null; leadId: string | null; oportunidadeId: string | null };

function limparCurso(c: string | null): string {
  if (!c) return "";
  return c.replace(/^p[oó]s\s*\|\s*/i, "").replace(/^mba\s*\|\s*/i, "MBA ").replace(/^curso\s*\|\s*/i, "").trim();
}

// Nota do CANAL apensada ao prompt real (o João de WhatsApp não sabe que aqui é chat de site).
function notaCanal(curso: string | null): string {
  const cursoLimpo = limparCurso(curso);
  return [
    "", "---",
    "## ⚙️ CANAL: CHAT DO SITE (não é WhatsApp)",
    "- O visitante te vê em TEMPO REAL na página; seja ágil. Confirmações/lembretes da reunião chegam pelo WhatsApp dele (já temos o número).",
    "- ⛔ Catálogo é SÓ agro/veterinária/agronegócio. Em dúvida do curso, use `consulta_pos_disponiveis`. Área fora do escopo (odontologia, direito, medicina humana…) → diga com gentileza que a PPG é especializada em agro/vet, sem inventar curso.",
    cursoLimpo ? `- ⭐ Esta conversa veio da página da pós **"${cursoLimpo}"** — ancore nela.` : "",
  ].filter(Boolean).join("\n");
}

function promptDoEstagio(nome: string, curso: string | null, estagio: Estagio): string {
  const base = estagio === "qualificador" ? AGENTE_QUALIFICADOR : AGENTE_VALIDACAO;
  const rendered = renderPrompt(base, {
    nome: (nome || "").trim(),
    curso_interesse_original: limparCurso(curso) || "(não informado — descubra sem inventar)",
    pergunta_formacao: "me confirma rapidinho: qual é a sua formação (graduação)? e o que te levou a buscar essa pós agora?",
  });
  return rendered + notaCanal(curso);
}

function ctxDe(telefone: string, leadId: string | null): CtxConversa {
  return { remotejid: telefone, telefone, waAccountId: null, leadId, oportunidadeId: null };
}

function textoDe(blocos: any[]): string {
  return (blocos ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// ── Abertura PROATIVA (estágio validação): oferece o Meet, não pergunta formação ──────
export async function aberturaWebchat(nome: string, curso: string | null): Promise<string> {
  const primeiro = (nome || "").trim().split(/\s+/)[0] || "";
  const fallback = `Oi${primeiro ? ", " + primeiro : ""}! 👋 Vi seu interesse na nossa pós — que tal uma conversa rápida no Google Meet com um monitor especialista pra te mostrar tudo? Topa que eu já procuro um horário?`;
  if (!ANTHROPIC_KEY) return fallback;
  try {
    // sem tools na abertura (é só a saudação/oferta); usa o prompt real de validação +
    // o contexto temporal (pra não falar de horário fora da hora).
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 400,
        system: [
          { type: "text", text: promptDoEstagio(nome, curso, "validacao") },
          { type: "text", text: montarContextoTemporal() },
        ],
        messages: [{
          role: "user",
          content: "[SISTEMA — não é o visitante] O visitante acabou de abrir o chat vindo da página da pós de interesse e ainda NÃO escreveu nada. Faça a ABERTURA conforme o SEU roteiro de validação: cumprimente pelo primeiro nome, diga que viu o interesse na pós (mencione o curso) e conduza OFERECENDO a conversa rápida no Google Meet com um monitor especialista. Termine com uma pergunta convidando a marcar. ⛔ NÃO pergunte a formação/graduação agora. Envie só a mensagem final, curta e calorosa.",
        }],
      }),
    });
    const data = await res.json();
    return textoDe(data.content) || fallback;
  } catch (_e) {
    return fallback;
  }
}

// ── Turno do João: router (validação×qualificador c/ ratchet) + loop de tools REAIS ──
export async function responderWebchat(
  nome: string,
  telefone: string,
  curso: string | null,
  history: { role: "user" | "assistant"; text: string }[],
  estagioSalvo: Estagio = "validacao",
  leadId: string | null = null,
): Promise<{ texto: string; estagio: Estagio }> {
  const raw: Msg[] = history.map((m) => ({ role: m.role, content: m.text })).filter((m) => m.content);
  if (!ANTHROPIC_KEY || !raw.length) {
    return { texto: "Pode me contar um pouco mais sobre o que você procura? 😊", estagio: estagioSalvo };
  }
  // A conversa do webchat começa com a ABERTURA (assistant); a Anthropic exige início
  // 'user'. Prepende um marcador de abertura (o limparParaRouter/sanitizarHistorico do
  // agente real cuidam do resto: fundir turnos, parear tools, primeira msg user).
  if (raw[0].role === "assistant") raw.unshift({ role: "user", content: "[o visitante abriu o chat]" });
  const base = sanitizarHistorico(raw);

  // ratchet: se já é qualificador, não chama o router (não regride); senão roteia.
  let estagio: Estagio = estagioSalvo;
  if (estagio !== "qualificador") {
    try {
      estagio = (await chamarRouter(limparParaRouter(raw))) === "agente_qualificador" ? "qualificador" : "validacao";
    } catch { estagio = "validacao"; }
  }
  const agente = estagio === "qualificador" ? "agente_qualificador" : "agente_validacao";
  const promptAgente = promptDoEstagio(nome, curso, estagio);
  const contextoTemporal = montarContextoTemporal();
  const ctx = ctxDe(telefone, leadId);

  let tools: any[] = [];
  try { tools = await carregarTools(supabase, agente); } catch (e) { console.error(`[crm-webchat] carregarTools: ${(e as Error).message}`); }

  const messages: Msg[] = [...base];
  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    const resp = await chamarAgentePrincipal({ promptAgente, contextoTemporal, messages, tools });
    const blocos: any[] = resp.content ?? [];
    const toolUses = blocos.filter((b) => b.type === "tool_use");

    if (!toolUses.length) {
      return { texto: textoDe(blocos) || "Pode me contar um pouco mais? 😊", estagio };
    }

    // executa as tools REAIS (mesma implementação do WhatsApp) e continua o loop
    messages.push({ role: "assistant", content: blocos });
    const outputs: Record<string, unknown>[] = [];
    for (const tu of toolUses) {
      outputs.push(await executarTool(supabase, tu, ctx));
    }
    messages.push({ role: "user", content: montarToolResults(outputs) });
  }
  return { texto: "Deixa eu confirmar uma coisa aqui rapidinho e já te falo. 🙌", estagio };
}
