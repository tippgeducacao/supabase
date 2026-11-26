// Alerta de Instagram sem acesso (26/11/2026). Régua PURA: sem Deno, sem banco, sem rede — o
// tick (alertaInstagramTick.ts) busca os dados e envia; aqui só se decide O QUE e QUANDO.
//
// Por que existe: o token da @ppgvet_oficial venceu em 23/11/2026 11:28 e a Flávia (IA do
// direct) passou 3 dias sem conseguir responder ninguém — 49 respostas recusadas, 38 pessoas —
// sem que ninguém soubesse. A Meta já dizia o motivo em ig_mensagens.erro (código 190); faltava
// alguém olhar. O estado mora em ig_contas.token_* (migration 20261126100000): o gatilho
// trg_ig_mensagens_token_morto marca "morto" na 1ª recusa e o cron ig-tokens-renovar marca
// "renovacao_falhou" quando a renovação automática não passa.
//
// Diferente do alerta de crédito, aqui não há "volta sozinho": só uma pessoa gerando token novo
// no painel da Meta resolve. Por isso o lembrete é espaçado (6 h) e só para conta com IA — numa
// conta sem IA o aviso sai uma vez e o "voltou" fecha a história.

export const REPETIR_TOKEN_H = 6;
/** Renovação falhando com o token ainda vivo: só avisa quando faltar menos que isto. */
export const AVISAR_ANTES_DIAS = 7;

export interface ContaToken {
  id: string;
  username: string;
  agente_ia_ativo: boolean | null;
  token_status: string | null;
  token_erro: string | null;
  token_falhando_desde: string | null;
  token_alerta_em: string | null;
  token_expira_em: string | null;
}

export type AcaoToken = "alertar" | "lembrar" | "voltou" | "limpar" | "nada";

export interface NumerosApagao { respostas: number; pessoas: number }

/** O token desta conta pede aviso agora? */
export function precisaAviso(c: ContaToken, agora: number): boolean {
  if (c.token_status === "morto") return true;
  if (c.token_status === "renovacao_falhou") {
    const exp = c.token_expira_em ? Date.parse(c.token_expira_em) : NaN;
    return !Number.isFinite(exp) || exp - agora < AVISAR_ANTES_DIAS * 86_400_000;
  }
  return false;
}

/**
 * Decide o que fazer com UMA conta neste tick.
 *  · precisa de aviso e nunca avisou → "alertar";
 *  · já avisou, conta com IA e passaram REPETIR_TOKEN_H → "lembrar" (sem IA: um aviso só);
 *  · voltou a "ok" depois de um aviso → "voltou"; voltou sem aviso nenhum → "limpar" (em silêncio).
 */
export function decidirAcaoToken(c: ContaToken, agora: number): AcaoToken {
  if (precisaAviso(c, agora)) {
    if (!c.token_alerta_em) return "alertar";
    if (!c.agente_ia_ativo) return "nada";
    return agora - Date.parse(c.token_alerta_em) >= REPETIR_TOKEN_H * 3_600_000 ? "lembrar" : "nada";
  }
  if (c.token_status === "ok" && c.token_alerta_em) return "voltou";
  if (c.token_status === "ok" && c.token_falhando_desde) return "limpar";
  return "nada";
}

// Brasília = UTC-3 sem horário de verão desde 2019 (mesma conta do alertaIa.ts).
function dataHoraSP(iso: string): string {
  const d = new Date(Date.parse(iso) - 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function dataSP(iso: string): string {
  return dataHoraSP(iso).slice(0, 5);
}

export function duracaoLonga(deIso: string, ateIso: string): string {
  const min = Math.max(0, Math.round((Date.parse(ateIso) - Date.parse(deIso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h${min % 60 ? String(min % 60).padStart(2, "0") : ""}`;
  return `${Math.floor(h / 24)} dias`;
}

const COMO_RESOLVER = (u: string) => [
  `Resolver: developers.facebook.com → app "App IA CRM - Organicos" → Instagram → Configuração da API → "Gerar token" na @${u} (pede o login do Instagram da conta).`,
  `Depois, no Mac do TI: bash scripts/instagram/trocar-token.sh ${u}`,
].join("\n");

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/** Texto do alerta/lembrete. Não inclui token; o erro da Meta não traz o token. */
export function textoAlertaToken(c: ContaToken, n: NumerosApagao | null, lembrete: boolean, agoraIso: string): string {
  const u = c.username;
  if (c.token_status === "renovacao_falhou") {
    const vence = c.token_expira_em ? dataSP(c.token_expira_em) : "em breve";
    return [
      `🟡 *INSTAGRAM: RENOVAÇÃO DO ACESSO FALHOU — @${u}*`,
      `A autorização do sistema na conta vence em ${vence} e a renovação automática não passou (${(c.token_erro ?? "sem detalhe").slice(0, 160)}).`,
      `Se vencer, ${c.agente_ia_ativo ? "a Flávia (IA do direct) e " : ""}as respostas pelo SAC param de sair no direct.`,
      COMO_RESOLVER(u),
    ].join("\n");
  }
  const desde = c.token_falhando_desde ?? agoraIso;
  const titulo = lembrete ? `⚠️ *INSTAGRAM AINDA SEM ACESSO — @${u}*` : `🚨 *INSTAGRAM SEM ACESSO — @${u}*`;
  const impacto = n && n.respostas > 0
    ? ` ${plural(n.respostas, "resposta recusada", "respostas recusadas")} para ${plural(n.pessoas, "pessoa", "pessoas")} até agora.`
    : "";
  const quem = c.agente_ia_ativo
    ? "A Flávia (IA do direct) não consegue responder ninguém e as respostas pelo SAC também não saem."
    : "As respostas pelo SAC não saem.";
  return [
    titulo,
    `O sistema perdeu o acesso à conta em ${dataHoraSP(desde)} (há ${duracaoLonga(desde, agoraIso)}): a Meta recusa o token (vencido ou senha trocada).`,
    `${quem}${impacto} As mensagens continuam chegando no SAC.`,
    COMO_RESOLVER(u),
    c.agente_ia_ativo ? `Novo aviso em ${REPETIR_TOKEN_H} h se continuar; aviso quando voltar.` : "Aviso quando voltar.",
  ].join("\n");
}

export function textoVoltouToken(c: ContaToken, n: NumerosApagao | null, agoraIso: string): string {
  const desde = c.token_falhando_desde;
  const periodo = desde
    ? ` Ficou fora de ${dataHoraSP(desde)} a ${dataHoraSP(agoraIso)} (${duracaoLonga(desde, agoraIso)}).`
    : "";
  const numeros = n && n.respostas > 0
    ? ` ${plural(n.respostas, "resposta não saiu", "respostas não saíram")} para ${plural(n.pessoas, "pessoa", "pessoas")}.`
    : "";
  return [
    `✅ *INSTAGRAM VOLTOU — @${c.username}*`,
    `O acesso foi renovado.${periodo}${numeros}`,
    c.agente_ia_ativo
      ? `A Flávia responde quem ficou sem resposta quando a pessoa mandar a próxima mensagem. Reenvio antes disso: ver "Token morto" em docs/Instagram (IA + Chat).md.`
      : "",
  ].filter(Boolean).join("\n");
}
