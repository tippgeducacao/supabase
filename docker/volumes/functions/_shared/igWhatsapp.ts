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
export function notaParaOAgente(situacao: string | null, dataFormacao: string | null): string {
  const quem = situacao === "formado"
    ? "Disse que já concluiu a graduação."
    : situacao === "estudante"
    ? `Disse que ainda está na graduação${dataFormacao ? ` e se forma em ${dataFormacao.slice(5, 7)}/${dataFormacao.slice(0, 4)}` : ""}.`
    : "";
  return [
    "[INSTAGRAM] Esta pessoa veio do direct do Instagram da PPGVET: pediu o portfólio das pós-graduações e passou este WhatsApp.",
    quem,
    `O sistema está enviando agora o portfólio em PDF ("${IG_PORTFOLIO_ARQUIVO}"). Não reenvie o portfólio; siga a conversa a partir daqui.`,
  ].filter(Boolean).join(" ");
}
