// Leitura da consulta 7 do EDUQ ("Alunos bloqueados por inadimplência"). Puro, sem Deno nem
// rede: é o que o vitest testa (mapear.test.ts).

export interface ItemBloqueado {
  id_aluno: number;
  nome: string | null;
  cpf: string | null;
  contato_bruto: string | null;
  telefone: string | null;
  email: string | null;
  curso: string | null;
  turma: string | null;
  dias_em_atraso: number | null;
  parcelas_em_atraso: number | null;
  valor_em_aberto: number | null;
  motivo_bloqueio: string | null;
  bruto: Record<string, unknown>;
}

const txt = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // "1.234,56" (pt-BR) ou "1234.56"
  const s = String(v).trim();
  const n = /,\d{1,2}$/.test(s) ? parseFloat(s.replace(/\./g, "").replace(",", ".")) : parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** Primeiro campo presente entre os apelidos: a EDUQ já mandou snake_case e PascalCase. */
function campo(t: Record<string, unknown>, ...nomes: string[]): unknown {
  for (const n of nomes) if (t[n] != null && t[n] !== "") return t[n];
  return null;
}

export function cpfDigitos(v: unknown): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length === 11 ? d : null;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Separa telefone e e-mail do campo `contato`, que pode trazer os dois juntos
 * ("(85) 99999-1234 / ana@x.com"), só um, ou vir MASCARADO como na consulta 4
 * ("(85)*****-***4", "r********t@gmail.com"). Parte mascarada nunca vira contato:
 * gravada, ela viraria o "telefone do aluno" no Vincular.
 */
export function separarContato(contato: unknown): { telefone: string | null; email: string | null; mascarado: boolean } {
  const s = txt(contato);
  if (!s) return { telefone: null, email: null, mascarado: false };
  let telefone: string | null = null;
  let email: string | null = null;
  let mascarado = false;
  for (const parte of s.split(/\s*[/;|,]\s*|\s+e\s+/)) {
    const p = parte.trim();
    if (!p) continue;
    if (p.includes("*")) { mascarado = true; continue; }
    const e = p.match(EMAIL)?.[0];
    if (e) { email ??= e.toLowerCase(); continue; }
    const d = p.replace(/\D/g, "");
    // 10–13 dígitos: fixo/celular com DDD, com ou sem 55.
    if (d.length >= 10 && d.length <= 13) telefone ??= p;
  }
  return { telefone, email, mascarado };
}

export function paraItem(t: Record<string, unknown>): ItemBloqueado | null {
  const id = Number(campo(t, "id_aluno", "IdAluno", "AlunoId", "idAluno"));
  if (!Number.isInteger(id) || id <= 0) return null;
  const contato = txt(campo(t, "contato", "Contato", "telefone", "celular"));
  const { telefone, email } = separarContato(contato);
  const emailSolto = txt(campo(t, "email", "Email", "e_mail"));
  return {
    id_aluno: id,
    nome: txt(campo(t, "nome_aluno", "NomeAluno", "nome", "Nome")),
    cpf: cpfDigitos(campo(t, "cpf", "Cpf", "CPF")),
    contato_bruto: contato,
    telefone,
    email: email ?? (emailSolto && !emailSolto.includes("*") ? emailSolto.toLowerCase() : null),
    curso: txt(campo(t, "curso", "Curso")),
    turma: txt(campo(t, "turma", "Turma")),
    dias_em_atraso: num(campo(t, "dias_em_atraso", "DiasEmAtraso")),
    parcelas_em_atraso: num(campo(t, "quantidade_parcelas_atraso", "QuantidadeParcelasAtraso")),
    valor_em_aberto: num(campo(t, "valor_em_aberto", "ValorEmAberto")),
    motivo_bloqueio: txt(campo(t, "motivo_bloqueio", "MotivoBloqueio")),
    bruto: t,
  };
}
