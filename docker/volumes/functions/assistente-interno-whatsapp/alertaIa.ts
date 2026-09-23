// Alerta de IA sem crédito / chave morta (23/09/2026). Régua PURA: sem Deno, sem banco, sem
// rede — o tick (alertaIaTick.ts) busca os dados e envia; aqui só se decide O QUE e QUANDO.
//
// Por que existe: o João (crm-agente-sdr) ficou sem crédito da Anthropic 3 vezes em 9 dias
// (14/09: 319 rodadas mortas, 17/09: 158, 22/09: 867) e ninguém foi avisado: os leads ficaram
// horas no vácuo até alguém estranhar. A falha já estava gravada em crm_agente_sdr_eventos.erro
// ("Anthropic: HTTP 400: ... credit balance is too low ..."); faltava alguém olhar.
//
// Só entra aqui falha que NÃO se cura sozinha: sem crédito/quota, chave inválida e conta
// bloqueada. Sobrecarga (529), rate limit comum (429 sem quota) e timeout passam sozinhos e
// não geram alerta: alerta que grita sem motivo vira ruído e para de ser lido.

export type ProvedorIa = "anthropic" | "openai" | "deepseek";
export type MotivoIa = "sem_credito" | "chave_invalida" | "conta_bloqueada";

/** Janela olhada a cada tick. O cron roda a cada 2 min; 10 min cobre tick perdido. */
export const JANELA_MIN = 10;
/** Falhas na janela para disparar. Crédito zerado é determinístico: 2 já é certeza. */
export const LIMIAR_FALHAS = 2;
/** Enquanto continuar falhando, no máximo 1 mensagem por provedor a cada 60 min. */
export const REPETIR_MIN = 60;
/** Estado "falhando" sem nenhuma falha nova por 24 h é esquecido em silêncio (provedor desligado). */
export const ESQUECER_MIN = 24 * 60;

const NOME: Record<ProvedorIa, string> = { anthropic: "Anthropic (Claude)", openai: "OpenAI", deepseek: "DeepSeek" };
const MOTIVO_TXT: Record<MotivoIa, string> = {
  sem_credito: "sem crédito / quota esgotada",
  chave_invalida: "chave de API inválida ou revogada",
  conta_bloqueada: "conta ou organização bloqueada",
};
const ONDE_RESOLVER: Record<ProvedorIa, string> = {
  anthropic: "console.anthropic.com → Settings → Billing (recarregar crédito) / API Keys",
  openai: "platform.openai.com → Settings → Billing / API keys",
  deepseek: "platform.deepseek.com → Top up / API keys",
};

/**
 * Lê o texto de erro que o crm-agente-sdr grava (agente.ts: `${provedor}: HTTP <status>: <corpo>`)
 * e diz se é falha de cobrança/chave. `null` = outro erro (não alerta).
 */
export function classificarErroIa(erro: string | null | undefined): { provedor: ProvedorIa; motivo: MotivoIa } | null {
  const t = String(erro ?? "");
  let provedor: ProvedorIa | null = null;
  if (/^\s*Anthropic:/i.test(t)) provedor = "anthropic";
  else if (/^\s*OpenAI:/i.test(t)) provedor = "openai";
  else if (/^\s*deepseek:/i.test(t)) provedor = "deepseek";
  if (!provedor) return null;

  if (/credit balance is too low|insufficient_quota|exceeded your current quota|billing_hard_limit|insufficient balance/i.test(t)
    || (provedor === "deepseek" && /HTTP 402/.test(t))) {
    return { provedor, motivo: "sem_credito" };
  }
  if (/HTTP 401|authentication_error|invalid[_ ]api[_ -]key|invalid x-api-key|incorrect api key/i.test(t)) {
    return { provedor, motivo: "chave_invalida" };
  }
  if (/HTTP 403/.test(t) && /permission_error|account_deactivated|organization.*(disabled|deactivated)|access_terminated/i.test(t)) {
    return { provedor, motivo: "conta_bloqueada" };
  }
  return null;
}

export interface EventoErro { erro: string | null; remotejid: string | null; criado_em: string }
export interface ResumoFalhas {
  provedor: ProvedorIa;
  motivo: MotivoIa;
  n: number;
  leads: number;
  primeira: string;
  ultima: string;
}

/** Agrupa os erros da janela por provedor. O motivo é o mais frequente (empate: o mais recente). */
export function resumirFalhas(eventos: EventoErro[]): Map<ProvedorIa, ResumoFalhas> {
  const acc = new Map<ProvedorIa, { n: number; jids: Set<string>; primeira: string; ultima: string; motivos: Map<MotivoIa, number>; motivoUltimo: MotivoIa }>();
  for (const ev of eventos) {
    const c = classificarErroIa(ev.erro);
    if (!c) continue;
    let a = acc.get(c.provedor);
    if (!a) {
      a = { n: 0, jids: new Set(), primeira: ev.criado_em, ultima: ev.criado_em, motivos: new Map(), motivoUltimo: c.motivo };
      acc.set(c.provedor, a);
    }
    a.n++;
    if (ev.remotejid) a.jids.add(ev.remotejid);
    if (ev.criado_em < a.primeira) a.primeira = ev.criado_em;
    if (ev.criado_em >= a.ultima) { a.ultima = ev.criado_em; a.motivoUltimo = c.motivo; }
    a.motivos.set(c.motivo, (a.motivos.get(c.motivo) ?? 0) + 1);
  }
  const out = new Map<ProvedorIa, ResumoFalhas>();
  for (const [provedor, a] of acc) {
    let motivo = a.motivoUltimo;
    let max = a.motivos.get(motivo) ?? 0;
    for (const [m, q] of a.motivos) if (q > max) { motivo = m; max = q; }
    out.set(provedor, { provedor, motivo, n: a.n, leads: a.jids.size, primeira: a.primeira, ultima: a.ultima });
  }
  return out;
}

export interface EstadoIa {
  provedor: string;
  falhando_desde: string | null;
  ultima_falha_em: string | null;
  ultimo_alerta_em: string | null;
}

export type AcaoIa = "alertar" | "lembrar" | "voltou" | "esquecer" | "nada";

/**
 * Decide o que fazer com UM provedor neste tick.
 *  · falhas ≥ limiar e sem alerta há REPETIR_MIN → "alertar" (1º do apagão) ou "lembrar";
 *  · estava falhando, zero falhas na janela e houve chamada BEM-SUCEDIDA depois da última
 *    falha → "voltou" (sem sucesso não se afirma nada: de madrugada não há tráfego);
 *  · estava falhando e nada acontece há ESQUECER_MIN → "esquecer" (limpa sem mensagem).
 */
export function decidirAcao(opts: {
  falhas: ResumoFalhas | undefined;
  estado: EstadoIa | undefined;
  ultimoSucesso: string | null;
  agora: number;
}): AcaoIa {
  const { falhas, estado, ultimoSucesso, agora } = opts;
  if (falhas && falhas.n >= LIMIAR_FALHAS) {
    const ult = estado?.ultimo_alerta_em ? new Date(estado.ultimo_alerta_em).getTime() : null;
    if (ult !== null && agora - ult < REPETIR_MIN * 60000) return "nada";
    return estado?.falhando_desde ? "lembrar" : "alertar";
  }
  if (!estado?.falhando_desde || falhas) return "nada";
  const ultimaFalha = estado.ultima_falha_em ?? estado.falhando_desde;
  if (ultimoSucesso && ultimoSucesso > ultimaFalha) return "voltou";
  if (agora - new Date(ultimaFalha).getTime() >= ESQUECER_MIN * 60000) return "esquecer";
  return "nada";
}

// Brasília = UTC-3 sem horário de verão desde 2019 (mesma conta do entrevistas.ts).
export function horaSP(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 3 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${d.toISOString().slice(11, 16)}`;
}

export function duracao(deIso: string, ateIso: string): string {
  const min = Math.max(0, Math.round((new Date(ateIso).getTime() - new Date(deIso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

/** Texto do alerta. Nunca inclui o corpo do erro: o 401 da OpenAI traz a chave mascarada. */
export function textoAlerta(f: ResumoFalhas, falhandoDesde: string | null, lembrete: boolean): string {
  const desde = falhandoDesde ?? f.primeira;
  const titulo = lembrete ? `⚠️ *IA AINDA FORA — ${NOME[f.provedor]}*` : `🚨 *IA FORA DO AR — ${NOME[f.provedor]}*`;
  return [
    titulo,
    `Motivo: ${MOTIVO_TXT[f.motivo]}.`,
    `O João (Agente SDR) está falhando desde ${horaSP(desde)}: ${f.n} rodada${f.n === 1 ? "" : "s"} em ${f.leads} lead${f.leads === 1 ? "" : "s"} nos últimos ${JANELA_MIN} min. Os leads estão ficando SEM resposta.`,
    `Resolver em: ${ONDE_RESOLVER[f.provedor]}.`,
    `O crédito é da conta inteira: outras IAs do sistema também param.`,
    `Novo aviso em ${REPETIR_MIN} min se continuar; aviso quando voltar.`,
  ].join("\n");
}

export function textoVoltou(provedor: ProvedorIa, falhandoDesde: string, ultimaFalha: string, total: number | null, leads: number | null): string {
  const numeros = total !== null
    ? ` ${total} rodada${total === 1 ? "" : "s"} morreram${leads !== null ? ` em ${leads} lead${leads === 1 ? "" : "s"}` : ""}.`
    : "";
  return [
    `✅ *IA VOLTOU — ${NOME[provedor]}*`,
    `O João voltou a responder. Ficou fora de ${horaSP(falhandoDesde)} a ${horaSP(ultimaFalha)} (${duracao(falhandoDesde, ultimaFalha)}).${numeros}`,
    `Quem escreveu nesse intervalo NÃO é resgatado sozinho: ver "Quando a IA cai" em docs/IA e Copilotos.md antes de qualquer replay.`,
  ].join("\n");
}

/** Telefone para envio (55 + DDD + número). `null` = vazio, placeholder (000…) ou implausível. */
export function telefoneParaEnvio(raw: string | null | undefined): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d || /^(\d)\1+$/.test(d)) return null;
  d = d.replace(/^0+/, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  if (Number(d.slice(0, 2)) < 11) return null;
  return `55${d}`;
}
