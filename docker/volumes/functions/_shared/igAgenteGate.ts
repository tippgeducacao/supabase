// Quem a IA do direct do Instagram pode atender — régua ÚNICA, usada pelo ig-webhook
// (decide se aciona o ig-agente) e pelo próprio ig-agente (confere de novo antes de
// falar). Pura, sem banco: quem chama lê ig_agente_config, ig_contas e ig_perfis.
//
// Modos: 'desligado', 'teste' (só os @ de usernames_teste) e, desde 26/09/2026, 'ligado'
// (qualquer pessoa — o fim de semana de teste com leads reais, pedido do Gustavo). O que
// impede a IA de falar por cima do TIME no modo ligado é `conversaComecadaPeloTime` abaixo,
// conferida pelo ig-agente antes de entrar numa conversa nova.

export type ModoIaInstagram = "desligado" | "teste" | "ligado";

export type EntradaGateIg = {
  modo: string | null | undefined;
  usernamesTeste: string[] | null | undefined;
  contaIaAtiva: boolean;
  /** @ de quem mandou a DM (ig_perfis). Sem ele o teste não tem como conferir. */
  username: string | null | undefined;
};

export type ResultadoGateIg =
  | { liberado: true; motivo: "teste" | "ligado" }
  | { liberado: false; motivo: "ia_desligada" | "conta_sem_ia" | "sem_username" | "fora_do_teste" };

/** "@Sutil_Gu " → "sutil_gu". */
export function normalizarUsername(valor: string | null | undefined): string {
  return String(valor ?? "").trim().replace(/^@+/, "").toLowerCase();
}

export function avaliarGateIg(e: EntradaGateIg): ResultadoGateIg {
  if (e.modo !== "teste" && e.modo !== "ligado") return { liberado: false, motivo: "ia_desligada" };
  if (!e.contaIaAtiva) return { liberado: false, motivo: "conta_sem_ia" };
  // Ligado: todo mundo. O @ só importa para a lista do teste.
  if (e.modo === "ligado") return { liberado: true, motivo: "ligado" };
  const username = normalizarUsername(e.username);
  // Sem @ resolvido (token da conta morto, perfil ainda não buscado) = NÃO fala.
  // Falhar fechado é o ponto: no teste, falar com a pessoa errada é o único erro grave.
  if (!username) return { liberado: false, motivo: "sem_username" };
  const lista = (e.usernamesTeste ?? []).map(normalizarUsername).filter(Boolean);
  if (!lista.includes(username)) return { liberado: false, motivo: "fora_do_teste" };
  return { liberado: true, motivo: "teste" };
}

// ── Conversa do TIME: a IA não entra (26/09/2026) ──────────────────────────────
// O time prospecta pela mesma conta ("Sou a Flávia aqui da PPGVET! 💜 Vi seu perfil…", o
// Wellyngton…). Se a pessoa responde uma mensagem DELES, a IA não pode chegar com "Tudo
// ótimo por aqui! Sou a Flávia" por cima. Decisão do Gustavo: a IA só entra onde o
// ManyChat abriu (o "Oii, tudo bem?" ou um card com botões dele) ou onde a pessoa
// escreveu primeiro. O eco do ManyChat é idêntico ao de um humano (sem app_id) — por isso
// a régua é o TEXTO.
export const JANELA_CONVERSA_DO_TIME_DIAS = 7;

export type SaidaRecente = { tipo?: string | null; conteudo?: string | null; origem?: string | null };

/** Mensagem nossa que veio do ManyChat (não conta como conversa do time). */
export function ehMensagemDoManychat(m: SaidaRecente): boolean {
  if (m.tipo === "template") return true;
  const t = String(m.conteudo ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return t.startsWith("oii, tudo bem") || t.startsWith("oi, tudo bem");
}

/** Mensagens NOSSAS dos últimos dias → alguém do time já está falando com a pessoa? */
export function conversaComecadaPeloTime(saidas: SaidaRecente[]): boolean {
  return saidas.some((m) => m.origem !== "ia" && m.origem !== "sistema" && !ehMensagemDoManychat(m));
}
