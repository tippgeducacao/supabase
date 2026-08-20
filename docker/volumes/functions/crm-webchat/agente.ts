// Cérebro do João para o WEBCHAT (Fase 2) — REUSA os módulos reais do agente de WhatsApp
// (crm-agente-sdr) por import, sem duplicar: router, contexto temporal (com a TABELA DE
// HORÁRIOS DE ATENDIMENTO) e as 9 tools reais. O que NÃO é reusado é só a I/O de WhatsApp
// (buffer/lock/debounce/chunks) — aqui a resposta é síncrona e escrita em webchat_mensagens.
// Não toca no crm-agente-sdr (só importa).
//
// ⚠️ O PROMPT NÃO É MAIS COMPARTILHADO (2026-08-17): o roteiro do chat vive em
// ./prompts-webchat.ts, arquivo próprio deste canal, porque o fluxo diverge do WhatsApp
// (lá o lead chega com nome e curso do webhook e a conversa abre por template; aqui o
// visitante pode chegar sem nada e falar primeiro). Personalidade, travas de "nunca diga"
// e regra da PPG agora existem nos DOIS arquivos — ver o cabeçalho de prompts-webchat.ts.
//
// ⚠️ confirmar_agendamento cria reunião REAL (GCal). envia_informacoes manda material pro
// WhatsApp do lead (ele deu o número). Fluxo/tools = os mesmos do João de WhatsApp.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { WEBCHAT_QUALIFICADOR, WEBCHAT_VALIDACAO } from "./prompts-webchat.ts";
import { montarContextoTemporal, renderPrompt } from "../crm-agente-sdr/contexto.ts";
import { comPresenteEscola, LINK_ESCOLA_GRATUITA } from "../crm-agente-sdr/escolaGratuita.ts";
import { carregarTools, chamarAgentePrincipal, chamarRouter } from "../crm-agente-sdr/agente.ts";
import { executarTool, montarToolResults } from "../crm-agente-sdr/tools.ts";
import { buscarLead, limparParaRouter, sanitizarHistorico } from "../crm-agente-sdr/historico.ts";
// Fracionamento humanizado — o MESMO do João de WhatsApp (saida.ts): humaniza (tira "!"/
// travessão) e quebra em 2-3 frases via gpt-4o-mini. Aqui só GERA os chunks; o espaçamento
// temporal ("digitando" entre balões) é feito no widget (client-side), não no servidor.
import { fracionarResposta, humanizarTexto } from "../crm-agente-sdr/saida.ts";
// Persona da ESCOLA DE ESPECIALIZAÇÃO (produto='escola') — bloco próprio, ver escola.ts.
import { fallbackAberturaEscola, filtrarLinkMatricula, instrucaoAberturaEscola, notaCanalEscola } from "./escola.ts";
import { resultadoToolMockado, toolDeveSerMockada } from "./modoTeste.ts";
// Guardas determinísticas da saída (despedida por motivo, canal, nome inventado, link
// do meet). Régua de o que mora lá: vale SEMPRE e violar custa caro — ver guardas.ts.
import {
  blocoConfirmacao,
  corrigirCanal,
  DESPEDIDA_GENERICA,
  despedidaDe,
  type Encerramento,
  temLinkDeMeet,
  tirarNomeInventado,
} from "./guardas.ts";

const ANTHROPIC_KEY = Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODELO = Deno.env.get("AGENTE_SDR_MODEL") ?? "claude-sonnet-5";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SDR_API_URL = (Deno.env.get("AGENTE_SDR_SDRAPI_URL") ?? `${SUPABASE_URL}/functions/v1/sdr-api`).replace(/\/$/, "");
const SDR_API_KEY = Deno.env.get("AGENTE_SDR_SDRAPI_KEY") ?? "";
// Linha Web (Uazapi, wa_conexoes.id) por onde o WEBCHAT envia o cronograma — o lead do
// site não tem janela de 24h no Cloud API. Vazio = cai no comportamento padrão (Cloud).
const WEBCHAT_WA_CONEXAO_ID = Deno.env.get("WEBCHAT_WA_CONEXAO_ID") ?? "";
// TEMPLATE OFICIAL DO CRONOGRAMA (2026-08-19). O visitante do site nunca mandou mensagem
// pro número, então NÃO existe janela de 24h e envio solto é recusado. Template de
// UTILIDADE com o PDF no cabeçalho é o caminho oficial, e não depende de janela — além de
// não depender de número Web (Uazapi), que vive caindo ou sendo restringido.
// Default no código pra funcionar sem mexer no .env da VPS; env sobrescreve se precisar.
const WEBCHAT_TEMPLATE_CRONOGRAMA = Deno.env.get("WEBCHAT_TEMPLATE_CRONOGRAMA")
  ?? "confirmacao_de_provas_alunos_pdf_utility_pos_ia";
// Conta "PPGVET - Pós-graduação IA" (+55 46 99907-1093) — é a WABA onde o template acima
// está aprovado. Template vive POR WABA: trocar de número exige recriar o template lá.
const WEBCHAT_WA_ACCOUNT_ID = Deno.env.get("WEBCHAT_WA_ACCOUNT_ID")
  ?? "d2984495-f70e-4c40-a47b-4b969d735a07";
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const MAX_RODADAS = 6;

export type Estagio = "validacao" | "qualificador";
/** De onde veio a sessão: LP de pós (padrão) ou a Escola de Especialização. */
export type Produto = "pos" | "escola";
export type WebchatToolChamada = {
  nome: string;
  input: Record<string, unknown>;
  mockado: boolean;
};
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

function promptDoEstagio(nome: string, curso: string | null, estagio: Estagio, produto: Produto = "pos"): string {
  const base = estagio === "qualificador" ? WEBCHAT_QUALIFICADOR : WEBCHAT_VALIDACAO;
  const rendered = renderPrompt(base, {
    nome: (nome || "").trim(),
    curso_interesse_original: limparCurso(curso) || "(não informado — descubra sem inventar)",
    pergunta_formacao: "me confirma rapidinho: qual é a sua formação (graduação)? e o que te levou a buscar essa pós agora?",
  });
  // ESCOLA: o chat roda DENTRO da biblioteca gratuita → nota de canal própria e SEM o
  // presente da Escola (convidar pra Escola quem já está lá dentro é absurdo).
  if (produto === "escola") return rendered + notaCanalEscola(limparCurso(curso));
  // Presente da Escola (2026-08-05): mesma régua do WhatsApp — conversa que acaba sem
  // reunião leva o convite da biblioteca gratuita junto da despedida. Fonte única em
  // crm-agente-sdr/escolaGratuita.ts; apensado DEPOIS do render (o bloco não tem placeholder).
  return comPresenteEscola(rendered) + notaCanal(curso);
}

// ⚠️ canal:'webchat' — marca o canal pras tools compartilhadas. Efeito hoje: a
// consulta_disponibilidade NÃO manda o telefone, então o webchat segue no RODÍZIO
// entre os vendedores da pós (decisão do usuário 2026-08-07: a régua "quem recebeu o
// lead recebe a reunião" é só do WhatsApp, o canal maior).
function ctxDe(telefone: string, leadId: string | null): CtxConversa {
  return { remotejid: telefone, telefone, waAccountId: null, leadId, oportunidadeId: null, canal: 'webchat' };
}

function textoDe(blocos: any[]): string {
  return (blocos ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Resposta final → balões (humaniza + fraciona). Fallback = balão único (resposta > silêncio).
// ⚠️ humanizarTexto REMOVE raciocínio vazado em <thinking>…</thinking> — se o modelo só
// pensou (sem resposta), o texto zera: devolve [] e quem chama usa o fallback, nunca balão vazio.
async function emChunks(texto: string): Promise<string[]> {
  const limpo = humanizarTexto(texto);
  if (!limpo) return [];
  const chunks = (await fracionarResposta(limpo)).filter((c) => c.trim().length > 0);
  return chunks.length ? chunks : [limpo];
}

// Abertura → SEMPRE 2 balões, de forma DETERMINÍSTICA (sem o fracionador/LLM): quebra pelos
// parágrafos (saudação + oferta) ou, se vier num parágrafo só, na 1ª fronteira de frase.
function dividirAberturaEm2(texto: string): string[] {
  const t = humanizarTexto(texto || "").trim();
  if (!t) return []; // só raciocínio (<thinking>) ou vazio → quem chama usa o fallback
  const paras = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (paras.length >= 2) return [paras[0], paras.slice(1).join("\n\n")];
  const m = t.match(/^(.+?[.?!])\s+(.+)$/s);
  if (m && m[1].length >= 15 && m[2].length >= 10) return [m[1].trim(), m[2].trim()];
  return [t];
}

// envia_informacoes do WEBCHAT: roteia o cronograma por uma LINHA WEB (Uazapi) via
// wa_conexao_id — o lead do site não tem janela de 24h no Cloud API. Reusa a MESMA
// sdr-api/envia-informacoes (resolve curso, cronograma, valores); só troca o canal.
// O corpo do template é "Oi {{1}}. / {{2}} / Consegue confirmar?" — {{1}} é o NOME e o
// {{2}} tem que terminar puxando algo que "Consegue confirmar?" complete, senão a última
// linha fica órfã ("confirmar o quê?").
// ⚠️ Uma linha só: parâmetro de corpo com quebra de linha faz a Meta recusar o envio.
export function frasePedidoCronograma(curso: string): string {
  const oQue = /^mba\b/i.test(curso.trim()) ? `do ${curso}` : `da pós em ${curso}`;
  return `Segue o cronograma ${oQue}, que vc pediu no site. Pra eu seguir com o seu atendimento, `
    + "preciso saber se é essa mesmo a pós que te interessa.";
}

async function webchatEnviaInformacoes(
  tu: any,
  telefone: string,
  curso: string | null,
  nome: string,
  sessaoId: string | null = null,
): Promise<Record<string, unknown>> {
  const input = tu.input ?? {};
  const conteudo = input.conteudo || "cronograma";
  const pos = String(input.curso_escolhido ?? "").trim() || limparCurso(curso);
  if (!pos) return { resultado: "Curso não informado — diga que envia em seguida e conduza a conversa.", id: tu.id };

  const mandaCronograma = /cronograma/i.test(String(conteudo));

  // GATE DE FORMAÇÃO (cron-04): cronograma é a TROCA pelo dado. Sem a graduação a
  // gente nem sabe se a pessoa pode cursar, e mandar antes é entregar material pra
  // quem talvez não seja elegível. Mesmo formato do gate do confirmar_agendamento:
  // recusa + instrução do que fazer. Fail-open em erro de leitura — a trava protege
  // o funil, não pode derrubar atendimento por causa de infra.
  if (mandaCronograma) {
    try {
      const lead = await buscarLead(supabase, telefone);
      if (lead && !String(lead.formacao_academica ?? "").trim()) {
        return {
          resultado: "RECUSADO: a graduação deste lead ainda não foi registrada.",
          instrucao: "NÃO diga que mandou. Peça a graduação em UMA linha (\"te mando sim. só me "
            + "confirma antes: qual é a sua graduação? e já concluiu?\"), registre a resposta com "
            + "atualizar_dados_lead e SÓ ENTÃO chame envia_informacoes de novo. Se ele já disse a "
            + "graduação nesta conversa, registre-a primeiro e mande na sequência.",
          id: tu.id,
        };
      }
    } catch (e) {
      console.log(`[crm-webchat] gate de formação do cronograma falhou (segue): ${(e as Error).message}`);
    }
  }

  // IDEMPOTÊNCIA (cron-03): mesmo cronograma saiu duas vezes com 1 minuto de
  // diferença. O roteiro já proibia reenviar, mas isso não pode depender do modelo
  // lembrar — o registro do que já foi é por SESSÃO.
  const chaveCurso = pos.toLowerCase().trim();
  let jaEnviados: string[] = [];
  if (mandaCronograma && sessaoId) {
    try {
      const { data } = await supabase
        .from("webchat_sessoes").select("cronogramas_enviados").eq("id", sessaoId).maybeSingle();
      jaEnviados = ((data as { cronogramas_enviados?: string[] } | null)?.cronogramas_enviados ?? []);
      if (jaEnviados.includes(chaveCurso)) {
        console.log(`[crm-webchat] cronograma de "${pos}" já saiu nesta sessão — não reenvia`);
        return {
          resultado: `O cronograma de ${pos} JÁ FOI ENVIADO no WhatsApp nesta conversa. NÃO reenvie.`,
          instrucao: "Diga que o material já está com ele, sem reenviar. Se precisar só do valor, "
            + "chame de novo com conteudo=\"valor\".",
          id: tu.id,
        };
      }
    } catch (e) {
      console.log(`[crm-webchat] leitura de cronogramas_enviados falhou (segue): ${(e as Error).message}`);
    }
  }
  try {
    const r = await fetch(`${SDR_API_URL}/envia-informacoes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SDR_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        whatsapp: telefone, pos, conteudo,
        template_name: WEBCHAT_TEMPLATE_CRONOGRAMA,
        template_lang: "pt_BR",
        template_params: [(nome || "").trim().split(/\s+/)[0] || "tudo bem", frasePedidoCronograma(pos)],
        wa_account_id: WEBCHAT_WA_ACCOUNT_ID || null,
        // Plano B do sdr-api: se o template falhar (não aprovado no número, upload
        // recusado, número restrito), ele reenvia por esta linha Web em vez de não entregar.
        wa_conexao_id: WEBCHAT_WA_CONEXAO_ID || null,
      }),
    });
    const b: any = await r.json().catch(() => ({}));
    const d = b?.data ?? {};
    if (r.status < 200 || r.status >= 300) {
      const code = d.code || b?.code || "";
      if (code === "cronograma_nao_cadastrado") return { resultado: "Cronograma ainda não cadastrado pra esse curso. Diga que manda o material em seguida e conduza a conversa.", id: tu.id };
      return { resultado: `Não consegui enviar agora (${d.error || b?.error || r.status}). Diga que vai enviar em seguida e conduza, sem citar o erro.`, id: tu.id };
    }
    const partes: string[] = [];
    if (d.cronograma_enviado) {
      partes.push("Cronograma ENVIADO no WHATSAPP do visitante. ⛔ Ele NÃO aparece neste chat: NUNCA diga \"aqui em cima\" nem \"acima\". Confirme dizendo o canal (ex.: \"acabei de mandar no seu whats\").");
      // Anota que ESTE curso já saiu nesta conversa — é o que impede o reenvio.
      if (sessaoId) {
        try {
          await supabase.from("webchat_sessoes")
            .update({ cronogramas_enviados: [...jaEnviados, chaveCurso] })
            .eq("id", sessaoId);
        } catch (e) {
          console.log(`[crm-webchat] registrar cronograma enviado falhou (segue): ${(e as Error).message}`);
        }
      }
    }
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
//
// ⚠️ A instrução MUDA conforme sabemos ou não a pós (2026-08-17): a versão única mandava
// "diga que viu o interesse na pós (mencione o curso)" mesmo sem curso nenhum, e na home o
// João abria com "vi aqui que vc se interessou pela nossa pós" — qual pós? Ele não sabia, e
// a frase fingia saber. Sem curso, a abertura PERGUNTA a área em vez de fingir.
function instrucaoAbertura(curso: string): string {
  const base = "[SISTEMA — não é o visitante] O visitante acabou de abrir o chat no site e ainda NÃO escreveu nada. "
    + "Faça a ABERTURA conforme o SEU roteiro de validação: cumprimente pelo primeiro nome. "
    + "⛔ NÃO pergunte a formação/graduação agora. ⛔ NÃO diga que a secretaria liberou uma condição "
    + "especial: ninguém prometeu isso a ele, ele só entrou no site. Envie só a mensagem final, curta e calorosa.";
  return curso
    ? base + ` O visitante veio da página da pós **${curso}** — ancore nela pelo nome e conduza `
      + "OFERECENDO a conversa rápida no Google Meet com um monitor especialista. Termine com uma pergunta convidando a marcar."
    : base + " ⚠️ Ele veio da HOME e vc NÃO SABE qual pós interessa a ele. É PROIBIDO dizer que viu o interesse dele "
      + "'na nossa pós' ou em qualquer curso específico — vc não viu. Pergunte, em UMA frase curta, qual área ele quer, "
      + "citando as que existem: bovinos e leite, aves, suínos, animais de companhia, gestão e agronegócio, saúde e alimentos. "
      + "NÃO ofereça o Meet ainda: primeiro descubra o assunto.";
}
export async function aberturaWebchat(nome: string, curso: string | null, produto: Produto = "pos"): Promise<string[]> {
  const primeiro = (nome || "").trim().split(/\s+/)[0] || "";
  const escola = produto === "escola";
  const fallback = escola
    ? fallbackAberturaEscola(primeiro, limparCurso(curso))
    // ⚠️ Fallback estático (só entra se a chamada ao modelo falhar). Também não pode fingir
    // que sabe a pós: sem curso na sessão, ele PERGUNTA a área em vez de afirmar interesse.
    : limparCurso(curso)
      ? `Oi${primeiro ? ", " + primeiro : ""}, tudo bem? Vi que vc tá de olho na pós em ${limparCurso(curso)}. Que tal uma conversa rápida no Google Meet com um monitor especialista pra te mostrar tudo? Topa que eu já procuro um horário?`
      : `Oi${primeiro ? ", " + primeiro : ""}, tudo bem? Me conta rapidinho qual área vc tá querendo, pra eu te falar da pós certa: bovinos e leite, aves, suínos, animais de companhia, gestão e agronegócio, ou saúde e alimentos?`;
  if (!ANTHROPIC_KEY) return dividirAberturaEm2(fallback);
  try {
    // sem tools na abertura (é só a saudação/oferta); usa o prompt real de validação +
    // o contexto temporal (pra não falar de horário fora da hora).
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 400,
        // disabled EXPLÍCITO: no Sonnet 5, omitir liga o thinking adaptativo — que em
        // 400 tokens engoliria a saudação inteira e cairia sempre no fallback estático.
        thinking: { type: "disabled" },
        system: [
          { type: "text", text: promptDoEstagio(nome, curso, "validacao", produto) },
          { type: "text", text: montarContextoTemporal() },
        ],
        messages: [{
          role: "user",
          content: escola
            ? instrucaoAberturaEscola(limparCurso(curso))
            : instrucaoAbertura(limparCurso(curso)),
        }],
      }),
    });
    const data = await res.json();
    const texto = textoDe(data.content);
    // abertura em 2 balões MANUAIS (sem fracionador) — pedido do diretor
    const baloes = texto ? dividirAberturaEm2(texto) : [];
    return baloes.length ? baloes : dividirAberturaEm2(fallback);
  } catch (_e) {
    return dividirAberturaEm2(fallback);
  }
}

// ── ENCERRAMENTO: a tool que pausa vem SEM texto junto ───────────────────────────
// Medido no WhatsApp (67 de 69 casos) e reproduzido aqui pelo harness da Escola: quando o
// modelo chama `pausa_ia`, o loop dá mais uma volta pro texto — e nessa volta, sem nada a
// dizer, ele devolve VAZIO. Sem a instrução abaixo o webchat caía no fallback genérico
// "Pode me contar um pouco mais? 😊" logo depois de "não tenho faculdade, só ensino médio"
// ou "quero falar com uma pessoa de verdade" — o pior momento possível pra pedir mais.
// ⚠️ EFÊMERA (vai no contexto temporal, fora do prefixo cacheado; nunca no histórico).
// ⚠️ `agendar_retorno` NÃO entra aqui (saiu em 20/08/2026): ela não pausa a IA de
// propósito — o lead pode voltar antes do prazo e o João atende. Enquanto esteve na
// lista, "pode ser na sexta" era respondido com a despedida de quem desistiu (q-06),
// que é justamente o que o roteiro manda NÃO fazer.
const TOOLS_QUE_PAUSAM = new Set(["pausa_ia", "temporizador_proxima_turma"]);

function instrucaoPosPausa(produto: Produto): string {
  const presente = produto === "escola"
    // ⛔ a pessoa JÁ está dentro da Escola — convidá-la pra lá seria absurdo.
    ? "NÃO convide pra Escola de Especialização nem mande link dela: a pessoa já está dentro."
    : "Se ainda não convidou nesta conversa, inclua o presente da Escola: "
      + `"a ppgvet tem uma biblioteca aberta e gratuita, com mais de 30 cursos, artigos, e-books e certificados — aproveita: ${LINK_ESCOLA_GRATUITA}"`;
  return [
    "[SISTEMA — você acabou de encerrar/pausar este atendimento. NÃO relate isso e NÃO descreva o estado do atendimento.]",
    'Escreva SÓ a despedida curta ao visitante, no seu tom (ex.: "tranquilo, agradeço sua preferência pelo Grupo PPG e fico à disposição se precisar").',
    presente,
    'NUNCA escreva frases como "sem resposta necessária", "atendimento pausado" ou "nenhuma ação necessária": elas aparecem na tela do visitante.',
    "Se a despedida já foi enviada nesta conversa, responda com texto vazio.",
  ].join("\n");
}

// A despedida saiu daqui em 20/08/2026: era UMA frase pra toda tool que encerra, e ela
// é a de quem DESISTIU. Agora quem escolhe é despedidaDe() em guardas.ts, por motivo.

// ── Turno do João: router (validação×qualificador c/ ratchet) + loop de tools REAIS ──
export async function responderWebchat(
  nome: string,
  telefone: string,
  curso: string | null,
  history: { role: "user" | "assistant"; text: string }[],
  estagioSalvo: Estagio = "validacao",
  leadId: string | null = null,
  produto: Produto = "pos",
  modoTeste = false,
  // Escopo de CONVERSA pro cronograma: sem ele não dá pra saber que já foi enviado
  // nesta sessão, e o mesmo PDF sai duas vezes (cron-03).
  sessaoId: string | null = null,
): Promise<{ chunks: string[]; estagio: Estagio; tools: WebchatToolChamada[] }> {
  const chamadas: WebchatToolChamada[] = [];
  const raw: Msg[] = history.map((m) => ({ role: m.role, content: m.text })).filter((m) => m.content);
  if (!ANTHROPIC_KEY || !raw.length) {
    return { chunks: ["Pode me contar um pouco mais sobre o que você procura? 😊"], estagio: estagioSalvo, tools: chamadas };
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
  const promptAgente = promptDoEstagio(nome, curso, estagio, produto);
  const contextoTemporal = montarContextoTemporal();
  const ctx = ctxDe(telefone, leadId);

  let tools: any[] = [];
  try { tools = await carregarTools(supabase, agente); } catch (e) { console.error(`[crm-webchat] carregarTools: ${(e as Error).message}`); }

  const messages: Msg[] = [...base];
  // Não basta saber QUE encerrou: a despedida depende do motivo. Guarda a chamada.
  let encerramento: Encerramento | null = null;
  // Retorno do confirmar_agendamento desta rodada — é dele que sai o link do meet.
  let agendou: string | null = null;
  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    const resp = await chamarAgentePrincipal({
      promptAgente,
      contextoTemporal: encerramento ? `${contextoTemporal}\n\n${instrucaoPosPausa(produto)}` : contextoTemporal,
      messages,
      tools,
    });
    const blocos: any[] = resp.content ?? [];
    const toolUses = blocos.filter((b) => b.type === "tool_use");

    if (!toolUses.length) {
      // ENCERRAMENTO COM MOTIVO CONHECIDO: o texto é NOSSO. O modelo decide qual é a
      // situação (chamando a tool com o tipo/motivo certo); a frase quem escolhe é a
      // guarda. Foi assim que a despedida de quem desistiu foi parar em lead sem
      // graduação, em quem já era aluno e em quem pediu humano (q-01/q-04/q-05).
      const despedida = despedidaDe(encerramento);
      const fallback = encerramento ? DESPEDIDA_GENERICA : "Pode me contar um pouco mais? 😊";
      let chunks = despedida ? [despedida] : await emChunks(textoDe(blocos) || fallback);
      if (!chunks.length) chunks = [fallback];
      if (despedida) console.log(`[crm-webchat] despedida determinística: ${encerramento?.tool}`);
      // ESCOLA: link de matrícula só sai se a pessoa pediu (régua em código — ver escola.ts).
      if (produto === "escola") {
        const ultimaDoLead = [...history].reverse().find((m) => m.role === "user")?.text ?? "";
        const antes = chunks.length;
        chunks = filtrarLinkMatricula(chunks, ultimaDoLead);
        if (chunks.length !== antes) console.log("[crm-webchat] escola: link de matrícula removido (não foi pedido)");
      }
      // O material sai por WhatsApp e NÃO aparece no chat: "te mandei aqui em cima"
      // manda o visitante procurar um PDF que não está aqui (cron-04).
      chunks = chunks.map((c) => {
        const r = corrigirCanal(c);
        if (r.trocou) console.log("[crm-webchat] guarda de canal corrigiu a fala");
        return r.texto;
      });
      // Nome que o visitante nunca disse (q-03: "tranquilo, bruno"). Guarda estreita e
      // logada — se um dia comer algo legítimo, aparece aqui.
      chunks = chunks.map((c) => {
        const r = tirarNomeInventado(c, nome);
        if (r.removidos.length) console.log(`[crm-webchat] nome inventado removido: ${r.removidos.join(", ")}`);
        return r.texto;
      });
      // Reunião criada e o link não saiu? o dado está no retorno da tool, não pode
      // depender do modelo copiar (ag-07).
      if (agendou && !temLinkDeMeet(chunks)) {
        const bloco = blocoConfirmacao(agendou);
        if (bloco) {
          console.log("[crm-webchat] confirmação de reunião anexada (modelo não mandou o link)");
          chunks.push(bloco);
        }
      }
      return { chunks, estagio, tools: chamadas };
    }

    // executa as tools REAIS (mesma implementação do WhatsApp) e continua o loop.
    // ÚNICA exceção: envia_informacoes é interceptado pra rotear o cronograma pela
    // linha WEB (Uazapi), já que o lead do site não tem janela de 24h no Cloud.
    messages.push({ role: "assistant", content: blocos });
    const outputs: Record<string, unknown>[] = [];
    for (const tu of toolUses) {
      const nomeTool = String(tu.name ?? "");
      const input = (tu.input && typeof tu.input === "object" ? tu.input : {}) as Record<string, unknown>;
      if (TOOLS_QUE_PAUSAM.has(nomeTool)) encerramento = { tool: nomeTool, input };
      const mockado = toolDeveSerMockada(modoTeste, nomeTool);
      chamadas.push({ nome: nomeTool, input, mockado });
      let saidaTool: Record<string, unknown>;
      if (mockado) saidaTool = resultadoToolMockado(tu, limparCurso(curso));
      else if (nomeTool === "envia_informacoes") saidaTool = await webchatEnviaInformacoes(tu, telefone, curso, nome, sessaoId);
      else saidaTool = await executarTool(supabase, tu, ctx);
      // Reunião criada: guarda o retorno pra garantir o link na saída, aconteça o que
      // acontecer com o texto do modelo (ag-07 marcou reunião e não mandou o link).
      if (nomeTool === "confirmar_agendamento" && !mockado && saidaTool?.agendamento_id) {
        agendou = String(saidaTool.resultado ?? "");
      }
      outputs.push(saidaTool);
    }
    messages.push({ role: "user", content: montarToolResults(outputs) });
  }
  return { chunks: ["Deixa eu confirmar uma coisa aqui rapidinho e já te falo. 🙌"], estagio, tools: chamadas };
}
