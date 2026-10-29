// Regra única de senha (29/10/2026, decisão do Gustavo após o pentest de 27/10: o sistema aceitava
// 6 caracteres, e create-user aceitava qualquer coisa). Vale no front (cadastro e redefinição pelo
// admin) e nas edges create-user / reset-user-password — o front é conveniência, quem barra é a edge.
// Senhas antigas continuam valendo até a próxima troca. Sem import por URL: carrega no vitest.

export const SENHA_MINIMO = 10;
export const REGRA_SENHA_TEXTO = `Mínimo de ${SENHA_MINIMO} caracteres, com letra maiúscula, letra minúscula e número.`;

/** Mensagem do que falta, ou null se a senha cumpre a regra. */
export function problemaDaSenha(senha: string | null | undefined): string | null {
  const s = senha ?? "";
  const falta: string[] = [];
  if (s.length < SENHA_MINIMO) falta.push(`${SENHA_MINIMO} caracteres`);
  if (!/[a-z]/.test(s)) falta.push("uma letra minúscula");
  if (!/[A-Z]/.test(s)) falta.push("uma letra maiúscula");
  if (!/[0-9]/.test(s)) falta.push("um número");
  return falta.length ? `A senha precisa ter ${falta.join(", ")}.` : null;
}

/** Senha aleatória de 14 caracteres que sempre cumpre a regra (gerador do admin). */
export function gerarSenhaForte(tamanho = 14): string {
  const grupos = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%&*"];
  const todos = grupos.join("");
  const sorteio = (n: number) => {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return b[0] % n;
  };
  const chars = grupos.map((g) => g[sorteio(g.length)]);
  while (chars.length < Math.max(tamanho, SENHA_MINIMO)) chars.push(todos[sorteio(todos.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = sorteio(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
