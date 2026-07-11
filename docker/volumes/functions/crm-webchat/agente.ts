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
// Fracionamento humanizado — o MESMO do João de WhatsApp (saida.ts): humaniza (tira "!"/
// travessão) e quebra em 2-3 frases via gpt-4o-mini. Aqui só GERA os chunks; o espaçamento
// temporal ("digitando" entre balões) é feito no widget (client-side), não no servidor.
import { fracionarResposta, humanizarTexto } from "../crm-agente-sdr/saida.ts";

const ANTHROPIC_KEY = Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODELO = Deno.env.get("AGENTE_SDR_MODEL") ?? "claude-sonnet-4-6";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SDR_API_URL = (Deno.env.get("AGENTE_SDR_SDRAPI_URL") ?? `${SUPABASE_URL}/functions/v1/sdr-api`).replace(/\/$/, "");
const SDR_API_KEY = Deno.env.get("AGENTE_SDR_SDRAPI_KEY") ?? "";
// Linha Web (Uazapi, wa_conexoes.id) por onde o WEBCHAT envia o cronograma — o lead do
// site não tem janela de 24h no Cloud API. Vazio = cai no comportamento padrão (Cloud).
const WEBCHAT_WA_CONEXAO_ID = Deno.env.get("WEBCHAT_WA_CONEXAO_ID") ?? "";
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
    "- ⛔ NUNCA REPITA o que você JÁ disse nesta conversa. Antes de responder, RELEIA suas mensagens anteriores: valor integral, link de matrícula, condição especial da secretaria e a oferta do Meet só podem aparecer UMA vez cada — depois disso, apenas REFERENCIE em meia frase ('o valor é o que te passei acima'). Se o lead insistir num ponto já respondido, responda SÓ o que há de NOVO na mensagem dele, em 1-2 frases curtas, com outras palavras — re-enviar o mesmo bloco soa robótico e irrita.",
    "- Cada resposta sua deve ser CURTA (1 a 3 frases) e reagir à ÚLTIMA mensagem do lead — não re-apresente o pitch inteiro a cada turno.",
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

// Resposta final → balões (humaniza + fraciona). Fallback = balão único (resposta > silêncio).
async function emChunks(texto: string): Promise<string[]> {
  const limpo = humanizarTexto(texto);
  const chunks = await fracionarResposta(limpo);
  return chunks.length ? chunks : [limpo];
}

// Abertura → SEMPRE 2 balões, de forma DETERMINÍSTICA (sem o fracionador/LLM): quebra pelos
// parágrafos (saudação + oferta) ou, se vier num parágrafo só, na 1ª fronteira de frase.
function dividirAberturaEm2(texto: string): string[] {
  const t = humanizarTexto(texto || "").trim();
  if (!t) return [t];
  const paras = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (paras.length >= 2) return [paras[0], paras.slice(1).join("\n\n")];
  const m = t.match(/^(.+?[.?!])\s+(.+)$/s);
  if (m && m[1].length >= 15 && m[2].length >= 10) return [m[1].trim(), m[2].trim()];
  return [t];
}

// envia_informacoes do WEBCHAT: roteia o cronograma por uma LINHA WEB (Uazapi) via
// wa_conexao_id — o lead do site não tem janela de 24h no Cloud API. Reusa a MESMA
// sdr-api/envia-informacoes (resolve curso, cronograma, valores); só troca o canal.
async function webchatEnviaInformacoes(tu: any, telefone: string, curso: string | null): Promise<Record<string, unknown>> {
  const input = tu.input ?? {};
  const conteudo = input.conteudo || "cronograma";
  const pos = String(input.curso_escolhido ?? "").trim() || limparCurso(curso);
  if (!pos) return { resultado: "Curso não informado — diga que envia em seguida e conduza a conversa.", id: tu.id };
  try {
    const r = await fetch(`${SDR_API_URL}/envia-informacoes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SDR_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ whatsapp: telefone, pos, conteudo, wa_conexao_id: WEBCHAT_WA_CONEXAO_ID || null }),
    });
    const b: any = await r.json().catch(() => ({}));
    const d = b?.data ?? {};
    if (r.status < 200 || r.status >= 300) {
      const code = d.code || b?.code || "";
      if (code === "cronograma_nao_cadastrado") return { resultado: "Cronograma ainda não cadastrado pra esse curso. Diga que manda o material em seguida e conduza a conversa.", id: tu.id };
      return { resultado: `Não consegui enviar agora (${d.error || b?.error || r.status}). Diga que vai enviar em seguida e conduza, sem citar o erro.`, id: tu.id };
    }
    const partes: string[] = [];
    if (d.cronograma_enviado) partes.push("Cronograma ENVIADO no WhatsApp do lead — confirme pra ele com naturalidade.");
    else if (d.cronograma_erro) partes.push(`Cronograma NÃO enviado (${d.cronograma_erro}) — diga que manda em seguida, sem citar erro técnico.`);
    if (d.valor_integral) partes.push(`Valor integral da pós: ${d.valor_integral}.`);
    if (d.valor_matricula) partes.push(`Valor da matrícula (garante a vaga): ${d.valor_matricula}.`);
    return { resultado: partes.join(" ") || "Feito.", id: tu.id };
  } catch (e) {
    return { resultado: `Erro técnico ao enviar (${(e as Error).message}). Diga que envia em seguida e conduza.`, id: tu.id };
  }
}

// ── Abertura PROATIVA (estágio validação): oferece o Meet, não pergunta formação ──────
// Devolve os BALÕES (chunks) da abertura — o widget mostra um a um com "digitando".
export async function aberturaWebchat(nome: string, curso: string | null): Promise<string[]> {
  const primeiro = (nome || "").trim().split(/\s+/)[0] || "";
  const fallback = `Oi${primeiro ? ", " + primeiro : ""}! 👋 Vi seu interesse na nossa pós — que tal uma conversa rápida no Google Meet com um monitor especialista pra te mostrar tudo? Topa que eu já procuro um horário?`;
  if (!ANTHROPIC_KEY) return [fallback];
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
    const texto = textoDe(data.content);
    // abertura em 2 balões MANUAIS (sem fracionador) — pedido do diretor
    return texto ? dividirAberturaEm2(texto) : [fallback];
  } catch (_e) {
    return [fallback];
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
): Promise<{ chunks: string[]; estagio: Estagio }> {
  const raw: Msg[] = history.map((m) => ({ role: m.role, content: m.text })).filter((m) => m.content);
  if (!ANTHROPIC_KEY || !raw.length) {
    return { chunks: ["Pode me contar um pouco mais sobre o que você procura? 😊"], estagio: estagioSalvo };
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
      return { chunks: await emChunks(textoDe(blocos) || "Pode me contar um pouco mais? 😊"), estagio };
    }

    // executa as tools REAIS (mesma implementação do WhatsApp) e continua o loop.
    // ÚNICA exceção: envia_informacoes é interceptado pra rotear o cronograma pela
    // linha WEB (Uazapi), já que o lead do site não tem janela de 24h no Cloud.
    messages.push({ role: "assistant", content: blocos });
    const outputs: Record<string, unknown>[] = [];
    for (const tu of toolUses) {
      if (tu.name === "envia_informacoes") outputs.push(await webchatEnviaInformacoes(tu, telefone, curso));
      else outputs.push(await executarTool(supabase, tu, ctx));
    }
    messages.push({ role: "user", content: montarToolResults(outputs) });
  }
  return { chunks: ["Deixa eu confirmar uma coisa aqui rapidinho e já te falo. 🙌"], estagio };
}
