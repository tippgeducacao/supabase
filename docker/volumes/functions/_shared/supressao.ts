/**
 * Checagem de supressão — a trava que impede disparo para quem deu bounce duro,
 * marcou spam ou se descadastrou.
 *
 * Estava duplicada em dois lugares (`email-send`, um a um; `email-campaign-dispatcher`,
 * em lote). Duplicar ESTA regra é perigoso: se as duas cópias divergirem, um dos
 * caminhos volta a enviar para quem pediu para sair.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteSupabase = any;

export interface Suprimido {
  email: string;
  motivo: string;
}

/** Normaliza como a coluna é normalizada no banco (trigger `email_supressoes_normaliza`). */
export function normalizarEmail(email: string): string {
  return String(email ?? "").toLowerCase().trim();
}

/**
 * Decide se a supressão vale para este envio.
 *
 * Só vale para DISPARO. O e-mail 1:1 do Gmail (funil de TCC) não é bloqueado — lá a
 * Secretaria decide reenviar, e travar isso quebraria um processo que funciona.
 */
export function supressaoSeAplica(provider: string, ehCampanha: boolean): boolean {
  return provider !== "gmail" || ehCampanha;
}

/**
 * Um endereço. `eq` e não `ilike`: em ILIKE o "_" é coringa, e um e-mail como
 * joao_silva@x.com casaria com joaoXsilva@x.com — bloquearia quem nunca foi suprimido.
 */
export async function buscarSupressao(
  supabase: ClienteSupabase,
  email: string,
): Promise<Suprimido | null> {
  const { data } = await supabase
    .from("email_supressoes")
    .select("email, motivo")
    .eq("email", normalizarEmail(email))
    .maybeSingle();
  return (data as Suprimido | null) ?? null;
}

/**
 * Vários endereços de uma vez — usado ao montar o lote da campanha, para evitar uma
 * chamada de envio por destinatário que já se sabe bloqueado.
 */
export async function buscarSupressoes(
  supabase: ClienteSupabase,
  emails: string[],
): Promise<Set<string>> {
  const alvos = [...new Set(emails.map(normalizarEmail))].filter(Boolean);
  if (alvos.length === 0) return new Set();

  const { data } = await supabase
    .from("email_supressoes")
    .select("email")
    .in("email", alvos);

  return new Set(((data ?? []) as Array<{ email: string }>).map((s) => normalizarEmail(s.email)));
}
