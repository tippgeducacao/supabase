// Transforma o payload do Read AI nos dados da "reunião registrada" da empresa. Puro, sem rede.
// ⚠️ Os NOMES dos campos vieram da chamada de teste (27/11/2026); os FORMATOS ainda não foram vistos
// numa reunião real, por isso a leitura aceita as variações comuns.
import { escaparHtml } from "../_shared/escaparHtml.ts";

export type Payload = Record<string, unknown>;

export interface Participante {
  nome: string;
  email: string | null;
}

export interface DadosRegistro {
  titulo: string;
  corpo: string;
  metadata: Record<string, unknown>;
}

const obj = (v: unknown): Payload => (v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : {});

function texto(v: unknown): string {
  if (typeof v === "string") return v.trim();
  const o = obj(v);
  for (const campo of ["text", "title", "name", "description", "summary"]) {
    if (typeof o[campo] === "string" && (o[campo] as string).trim()) return (o[campo] as string).trim();
  }
  return "";
}

const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(texto).filter(Boolean) : []);

/** ISO, epoch em segundos ou em milissegundos. */
export function dataDe(v: unknown): Date | null {
  let d: Date | null = null;
  if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else if (typeof v === "string" && v) {
    d = new Date(v);
  }
  return d && !Number.isNaN(d.getTime()) && d.getFullYear() > 2000 ? d : null;
}

export function codigoDoMeet(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.toLowerCase().match(/(?:^|[^a-z])([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[^a-z]|$)/);
  return m ? m[1] : null;
}

export function participantesDe(payload: Payload): Participante[] {
  const vistos = new Set<string>();
  const saida: Participante[] = [];
  const brutos = [...(Array.isArray(payload.participants) ? payload.participants : []), payload.owner];
  for (const p of brutos) {
    const o = obj(p);
    const cru = typeof p === "string" ? p.trim() : "";
    const email = (typeof o.email === "string" ? o.email : cru).trim().toLowerCase();
    const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    const nome = (typeof o.name === "string" && o.name.trim()) || cru || emailValido || "";
    const chaves = [emailValido, nome.toLowerCase()].filter(Boolean) as string[];
    if (!nome || chaves.some((c) => vistos.has(c))) continue;
    chaves.forEach((c) => vistos.add(c));
    saida.push({ nome, email: emailValido });
  }
  return saida;
}

const DOMINIOS_DA_CASA = ["ppgvet.com", "popgvet.com", "wisenetix.com.br", "ppgeducacao.com.br", "ppgeducacao.site"];
const PROVEDORES_PUBLICOS = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.com.br", "icloud.com", "live.com"];

/** E-mails de quem NÃO é da casa: são os únicos que podem apontar para a empresa cliente. */
export function emailsExternos(payload: Payload): string[] {
  const dono = String(obj(payload.owner).email ?? "").toLowerCase().split("@")[1] ?? "";
  const internos = new Set(DOMINIOS_DA_CASA);
  if (dono && !PROVEDORES_PUBLICOS.includes(dono)) internos.add(dono);
  return participantesDe(payload)
    .map((p) => p.email)
    .filter((e): e is string => !!e && !internos.has(e.split("@")[1]));
}

const secao = (nome: string, itens: string[]) =>
  itens.length ? `<p><strong>${nome}</strong></p><ul>${itens.map((i) => `<li>${escaparHtml(i)}</li>`).join("")}</ul>` : "";

function linkDoRelatorio(v: unknown): string | null {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" && /(^|\.)read\.ai$/.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** `null` quando não há nada de "o que foi discutido" para registrar. */
export function montarRegistro(payload: Payload): DadosRegistro | null {
  const resumo = texto(payload.summary);
  const capitulos = (Array.isArray(payload.chapter_summaries) ? payload.chapter_summaries : [])
    .map((c) => {
      const o = obj(c);
      const nome = texto(o.title);
      const desc = texto(o.description) || texto(o.summary);
      return [nome, desc !== nome ? desc : ""].filter(Boolean).join(": ") || texto(c);
    })
    .filter(Boolean);
  const topicos = lista(payload.topics);
  const perguntas = lista(payload.key_questions);
  if (!resumo && !capitulos.length && !topicos.length && !perguntas.length) return null;

  const relatorio = linkDoRelatorio(payload.report_url);
  const paragrafos = resumo
    .split(/\n+/)
    .filter((l) => l.trim())
    .map((l) => `<p>${escaparHtml(l.trim())}</p>`)
    .join("");
  const corpo = [
    paragrafos ? `<p><strong>Resumo</strong></p>${paragrafos}` : "",
    secao("Capítulos", capitulos),
    secao("Tópicos", topicos),
    secao("Perguntas principais", perguntas),
    relatorio
      ? `<p><a href="${escaparHtml(relatorio)}" target="_blank" rel="noopener noreferrer">Ver relatório completo no Read AI</a></p>`
      : "",
  ].join("");

  const assunto = texto(payload.title).slice(0, 200);
  const inicio = dataDe(payload.start_time);
  const fim = dataDe(payload.end_time);
  const minutos = inicio && fim ? Math.round((fim.getTime() - inicio.getTime()) / 60000) : 0;
  const dia = inicio ? inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";

  return {
    titulo: !assunto ? `Reunião — ${dia || "Read AI"}` : /^reuni[aã]o/i.test(assunto) ? assunto : `Reunião — ${assunto}`,
    corpo,
    metadata: {
      origem: "read_ai",
      realizada: true,
      assunto: assunto || null,
      quando: inicio ? inicio.toISOString() : null,
      duracao_min: minutos > 0 && minutos < 24 * 60 ? minutos : null,
      formato: "online",
      participantes: participantesDe(payload).map((p) => p.nome).join(", ") || null,
      proximos_passos: lista(payload.action_items).join("; ") || null,
      read_ai_session_id: typeof payload.session_id === "string" ? payload.session_id : null,
      read_ai_relatorio: relatorio,
    },
  };
}

const PROVEDORES_PESSOAIS = new Set(
  ("gmail.com googlemail.com hotmail.com hotmail.com.br outlook.com outlook.com.br live.com msn.com yahoo.com " +
    "yahoo.com.br icloud.com me.com bol.com.br uol.com.br terra.com.br ig.com.br globo.com protonmail.com proton.me").split(" "),
);

export const emailPessoal = (email: string) => PROVEDORES_PESSOAIS.has(email.split("@")[1]?.toLowerCase() ?? "");
