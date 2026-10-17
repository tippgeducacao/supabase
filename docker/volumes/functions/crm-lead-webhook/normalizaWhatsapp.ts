import { classificaTelefone } from "../_shared/telefone.ts";

/**
 * WhatsApp do intake: só dígitos, com DDI.
 *
 * ⚠️ DDI estrangeiro explícito ("+351 935 624 417") fica como veio. Até 17/10/2026 todo
 * número sem "55" na frente ganhava "55" — o celular português virava `55351935624417`,
 * a régua de `_shared/telefone.ts` o julgava impossível e a ação de template era pulada
 * sem aviso (lead Aracely Machado, Form Meta do MBA Liderança). O sinal é o MESMO da
 * régua (regra 0 de `classificaTelefone`): "+" seguido de DDI ≠ 55. Sem o "+" o número
 * continua sendo lido como brasileiro — "16997722712" é DDD 16, não DDI 1.
 */
export function normalizeWhatsapp(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits || digits.length < 8) return null;
  if (typeof raw === "string" && /^\s*\+/.test(raw) && classificaTelefone(raw) === "internacional") {
    return digits;
  }
  return digits.startsWith("55") ? digits : `55${digits}`;
}
