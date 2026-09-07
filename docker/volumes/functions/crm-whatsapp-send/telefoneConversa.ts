import { classificaTelefone, digitosParaEnvio } from "../_shared/telefone.ts";

/** Variantes só brasileiras; estrangeiros nunca ganham 55 nem nono dígito. */
export function phoneVariants(raw: string): string[] {
  const destino = digitosParaEnvio(raw);
  if (!destino) return [];
  if (classificaTelefone(raw) === "internacional") return [destino];
  const d = destino.slice(2);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  const set = new Set<string>();
  const add = (x: string) => { set.add(x); set.add(`55${x}`); };
  if (rest) add(ddd + rest);
  if (rest.length === 8) add(`${ddd}9${rest}`);
  if (rest.length === 9 && rest[0] === "9") add(ddd + rest.slice(1));
  return [...set];
}

/** Chave do histórico da IA: mantém a régua BR e o DDI original do exterior. */
export function canonicalConversationPhone(raw: string): string | null {
  const destino = digitosParaEnvio(raw);
  if (!destino || classificaTelefone(raw) === "internacional") return destino;
  let d = destino.slice(2);
  if (d.length === 10 && ["6", "7", "8", "9"].includes(d[2])) {
    d = d.slice(0, 2) + "9" + d.slice(2);
  }
  return `55${d}`;
}
