// Quem a IA do direct do Instagram pode atender — régua ÚNICA, usada pelo ig-webhook
// (decide se aciona o ig-agente) e pelo próprio ig-agente (confere de novo antes de
// falar). Pura, sem banco: quem chama lê ig_agente_config, ig_contas e ig_perfis.
//
// Só existem 'desligado' e 'teste' (ver a migration 20260924163000_ig_agente_teste.sql):
// o teste simula agendamento e cronograma, então nenhum outro modo pode deixar passar.

export type ModoIaInstagram = "desligado" | "teste";

export type EntradaGateIg = {
  modo: string | null | undefined;
  usernamesTeste: string[] | null | undefined;
  contaIaAtiva: boolean;
  /** @ de quem mandou a DM (ig_perfis). Sem ele o teste não tem como conferir. */
  username: string | null | undefined;
};

export type ResultadoGateIg =
  | { liberado: true; motivo: "teste" }
  | { liberado: false; motivo: "ia_desligada" | "conta_sem_ia" | "sem_username" | "fora_do_teste" };

/** "@Sutil_Gu " → "sutil_gu". */
export function normalizarUsername(valor: string | null | undefined): string {
  return String(valor ?? "").trim().replace(/^@+/, "").toLowerCase();
}

export function avaliarGateIg(e: EntradaGateIg): ResultadoGateIg {
  if (e.modo !== "teste") return { liberado: false, motivo: "ia_desligada" };
  if (!e.contaIaAtiva) return { liberado: false, motivo: "conta_sem_ia" };
  const username = normalizarUsername(e.username);
  // Sem @ resolvido (token da conta morto, perfil ainda não buscado) = NÃO fala.
  // Falhar fechado é o ponto: no teste, falar com a pessoa errada é o único erro grave.
  if (!username) return { liberado: false, motivo: "sem_username" };
  const lista = (e.usernamesTeste ?? []).map(normalizarUsername).filter(Boolean);
  if (!lista.includes(username)) return { liberado: false, motivo: "fora_do_teste" };
  return { liberado: true, motivo: "teste" };
}
