// Instagram → WhatsApp (25/09/2026): as peças PURAS da passagem do direct para o
// WhatsApp, usadas pelo ig-agente (manda o recibo) e pelo crm-whatsapp-webhook (manda o
// PDF quando a pessoa responde). Mapa: docs/Instagram (IA + Chat).md
//
// Por que um RECIBO e não o template do portfólio: nas 5 BMs a Meta converte em
// MARKETING tudo que apresenta os cursos, mesmo pedido pela pessoa; o recibo de cadastro
// (comprovante_cadastro_utility) segue UTILIDADE. Ele abre a conversa; a resposta da
// pessoa abre a janela de 24 h e o PDF vai como mensagem comum, sem template.
// ⚠️ O texto do recibo é FIXO (aprovado na Meta): só os três espaços mudam. Editar o
// template o manda de volta para revisão, e ele pode voltar MARKETING.
import { limiteFormatura } from "../crm-agente-sdr/elegibilidadeFormatura.ts";
import { LINK_ESCOLA_GRATUITA } from "../crm-agente-sdr/escolaGratuita.ts";

/** PPGVET Educação - Pós-graduação (46 9 9901-2001): GREEN, nome aprovado, recibo UTILIDADE. */
export const IG_WA_ACCOUNT_ID = "0a17bea3-869d-4a95-bbc7-d0a5755e5b05";
export const IG_WA_NUMERO_EXIBIDO = "(46) 9 9901-2001";

export const IG_RECIBO_TEMPLATE = "comprovante_cadastro_utility";
export const IG_RECIBO_IDIOMA = "pt_BR";

export const IG_PORTFOLIO_URL =
  "https://api.ppgeducacao.site/storage/v1/object/public/materiais-comerciais/Portifolio_2026.pdf";
export const IG_PORTFOLIO_ARQUIVO = "Portfolio PPGVET 2026.pdf";
export const IG_PORTFOLIO_LEGENDA = "Aqui está o portfólio das nossas pós-graduações que você pediu no Instagram 📄";

/**
 * {{1}} do recibo: o primeiro nome quando ele parece nome de gente; senão o @ do
 * Instagram (perfis de marca, "JS MIMOS"); sem nenhum dos dois, o nome do perfil cru.
 * A Meta recusa parâmetro vazio.
 */
export function nomeDoRecibo(primeiroNome: string | null, username: string | null, nomePerfil: string | null): string {
  const nome = String(primeiroNome ?? "").trim();
  if (nome) return nome;
  const arroba = String(username ?? "").trim().replace(/^@+/, "");
  if (arroba) return `@${arroba}`;
  return String(nomePerfil ?? "").trim() || "tudo bem";
}

/**
 * {{2}} do recibo ("pós-graduação em {{2}}"). Não sabemos o curso; a regra aprovada é:
 * quem é (ou estuda) veterinária → "Medicina Veterinária"; o resto → "Veterinária e Agro".
 */
export function areaDoRecibo(area: string | null | undefined): string {
  return /vet/i.test(String(area ?? "")) ? "Medicina Veterinária" : "Veterinária e Agro";
}

/** {{3}} do recibo ("realizado em {{3}}"): a data de hoje em Brasília + a origem. */
export function dataDoRecibo(agora: Date = new Date()): string {
  const br = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const [ano, mes, dia] = br.toISOString().slice(0, 10).split("-");
  return `${dia}/${mes}/${ano}, pelo Instagram`;
}

/** `template_components` no formato do crm-whatsapp-send. */
export function componentesDoRecibo(nome: string, area: string, data: string) {
  return [{
    type: "body",
    parameters: [nome, area, data].map((text) => ({ type: "text", text })),
  }];
}

/**
 * Nota para a memória do agente do WhatsApp (cliente_ppg_mensagens_sdr, role
 * assistant). Documento mandado pelo sistema não entra sozinho na memória dele — sem a
 * nota, a IA não saberia que o PDF saiu nem de onde a pessoa veio.
 */
export function notaParaOAgente(
  situacao: string | null,
  dataFormacao: string | null,
  agora: Date = new Date(),
  area: string | null = null,
): string {
  const em = area ? ` em ${area}` : "";
  const quem = situacao === "formado"
    ? `Disse que já concluiu a graduação${em}.`
    : situacao === "estudante"
    ? `Disse que ainda está na graduação${em}${dataFormacao ? ` e se forma em ${dataFormacao.slice(5, 7)}/${dataFormacao.slice(0, 4)}` : ""}.`
    : "";
  return [
    "[INSTAGRAM] Esta pessoa veio do direct do Instagram da PPGVET: pediu o portfólio das pós-graduações e passou este WhatsApp.",
    quem,
    // Caso Jucileia (28/09/2026): o João procurou um curso chamado "Veterinária e Agro" (o
    // texto do recibo), não achou e abriu com "a gente não tem uma pós chamada assim".
    "O \"pós-graduação em …\" do recibo é texto padrão: ela NÃO escolheu um curso com esse nome — não procure curso por ele; descubra a área de interesse.",
    `O sistema está enviando agora o portfólio em PDF ("${IG_PORTFOLIO_ARQUIVO}"). Não reenvie o portfólio; siga a conversa a partir daqui.`,
    instrucaoForaDoPrazo(situacao, dataFormacao, agora),
  ].filter(Boolean).join(" ");
}

/**
 * Quem se forma DEPOIS da data-limite de matrícula (a régua do João, `limiteFormatura`)
 * pediu o portfólio no Instagram, mas ainda não pode fazer a pós. Pedido do Gustavo
 * (26/09/2026): "os leads que vão se formar além de janeiro, que não podem fazer a pós, a
 * IA do WhatsApp deveria avisar e deixar por enquanto o link da Escola de Especialização".
 * A data já veio do direct, então o João não chega a checar sozinho — a nota diz o que
 * fazer. O mesmo caminho que ele segue quando descobre a data na conversa
 * (REPROVADO_PRAZO em tools.ts): avisa, agenda o retorno da formatura e, na despedida, o
 * presente da Escola — que o CÓDIGO anexa (`comPresenteNaDespedida`, ao chamar
 * agendar_retorno).
 * ⚠️ NÃO ponha o link da Escola nesta nota: a guarda do presente procura o link no
 * histórico e, achando, conclui que ele já foi mandado — e não anexa (visto no simulador
 * em 26/09: a despedida saiu sem o link).
 */
export function instrucaoForaDoPrazo(situacao: string | null, dataFormacao: string | null, agora: Date = new Date()): string {
  if (mesesAteFormatura(situacao, dataFormacao, agora) == null) return "";
  // 28/09/2026: o João NEM entra nessa conversa ("quando a pessoa não pode ir para a
  // reunião, a IA do WhatsApp nem deveria iniciar o agendamento, só enviar o portfólio e
  // pausar" — Gustavo). A nota fica para quem abrir a conversa depois (time ou IA na volta).
  return "Ela se forma DEPOIS do prazo da turma: não pode ir para a reunião agora. O sistema já mandou o"
    + " portfólio e o aviso (a pós exige a graduação concluída) com a Escola de Especialização gratuita,"
    + " agendou o retorno para perto da formatura e PAUSOU a IA nesta conversa. Não ofereça reunião, horário"
    + " nem aula.";
}

/**
 * Meses até a formatura de quem se forma DEPOIS da data-limite de matrícula (a régua do
 * João); null = pode ir para a reunião (formado, forma até o limite ou sem data).
 */
export function mesesAteFormatura(situacao: string | null, dataFormacao: string | null, agora: Date = new Date()): number | null {
  if (situacao !== "estudante" || !/^\d{4}-\d{2}-\d{2}$/.test(String(dataFormacao ?? ""))) return null;
  const conclusao = new Date(`${dataFormacao}T12:00:00Z`);
  if (!(conclusao > limiteFormatura(agora))) return null;
  return Math.max(1, (conclusao.getUTCFullYear() - agora.getUTCFullYear()) * 12
    + conclusao.getUTCMonth() - agora.getUTCMonth());
}

/**
 * O que o sistema manda no WhatsApp, depois do PDF, para quem ainda não pode fazer a pós
 * (26/09: "avisar e deixar por enquanto o link da Escola"; 28/09: sem o João, só o
 * portfólio e a pausa). Texto fixo — nenhuma IA escreve.
 */
export const IG_AVISO_FORA_DO_PRAZO =
  "Como você ainda está na graduação, a pós só pode começar depois da sua formatura (ela exige a graduação"
  + " concluída). A gente te procura quando você estiver terminando o curso! 😉\n\nEnquanto isso, aproveita a"
  + " nossa Escola de Especialização gratuita, com mais de 10 cursos, além de artigos, e-books e podcasts: "
  + LINK_ESCOLA_GRATUITA;
