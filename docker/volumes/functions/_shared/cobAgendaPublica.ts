// Regras PURAS da agenda de renegociação da Cobrança — a página `/renegociar/<token>` que o
// aluno da Fase 03 abre pelo botão do modelo `cob_reuniao_convite` (número 7693).
//
// Aqui só mora o que dá para testar sem banco nem rede: o formato do pedido, o que a página
// pode ver da resposta (nada de telefone, card ou id interno), o evento do Google e o freio
// de abuso. Quem decide horário livre, trava e lembretes é o banco
// (`cob_reuniao_publico_carregar` / `_marcar`, migration 20261112120000).
//
// ⚠️ Sem dependência de Deno/Node: este arquivo é importado pela edge e pelo vitest.

/** 32 hex minúsculos: o token do convite (128 bits). É a única credencial da página. */
export const TOKEN_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** O pedido da página é pequeno; mais que isto é lixo ou ataque. */
export const MAX_BYTES_DO_PEDIDO = 2_000;

export type Motivo =
  | "link_invalido"
  | "horario_indisponivel"
  | "muitas_tentativas"
  | "pedido_invalido"
  | "falhou";

const MOTIVOS: ReadonlySet<string> = new Set<Motivo>([
  "link_invalido",
  "horario_indisponivel",
  "muitas_tentativas",
  "pedido_invalido",
  "falhou",
]);

/** Motivo que a página sabe explicar; qualquer outro vira "falhou" (sem vazar detalhe). */
export function motivoConhecido(m: unknown): Motivo {
  return typeof m === "string" && MOTIVOS.has(m) ? (m as Motivo) : "falhou";
}

export type Pedido =
  | { acao: "carregar"; token: string }
  | { acao: "marcar"; token: string; horarioId: string };

export function interpretarPedido(corpo: unknown): Pedido | { erro: "link_invalido" | "pedido_invalido" } {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return { erro: "pedido_invalido" };
  const c = corpo as Record<string, unknown>;
  const token = typeof c.token === "string" ? c.token.trim() : "";
  if (!TOKEN_RE.test(token)) return { erro: "link_invalido" };
  const acao = c.acao ?? "carregar";
  if (acao === "carregar") return { acao: "carregar", token };
  if (acao === "marcar") {
    const horarioId = typeof c.horario_id === "string" ? c.horario_id.trim() : "";
    if (!UUID_RE.test(horarioId)) return { erro: "pedido_invalido" };
    return { acao: "marcar", token, horarioId };
  }
  return { erro: "pedido_invalido" };
}

/** Link da sala: só https, sem espaço, de tamanho sensato. O resto vira null. */
export function linkDeSala(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^https:\/\/[^\s]+$/.test(s) && s.length <= 300 ? s : null;
}

function iso(v: unknown): string | null {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
}

export interface ReuniaoPublica {
  inicio: string;
  fim: string;
  status: "marcada" | "realizada";
  link: string | null;
  passou: boolean;
}

export interface HorarioPublico {
  id: string;
  inicio: string;
  fim: string;
}

export function reuniaoPublica(r: unknown): ReuniaoPublica | null {
  if (!r || typeof r !== "object") return null;
  const x = r as Record<string, unknown>;
  const inicio = iso(x.inicio);
  const fim = iso(x.fim);
  if (!inicio || !fim) return null;
  const status = x.status === "realizada" ? "realizada" : "marcada";
  return { inicio, fim, status, link: linkDeSala(x.link), passou: x.passou === true };
}

export type RespostaCarregar =
  | { ok: false; motivo: Motivo }
  | { ok: true; primeiro_nome: string; reuniao: ReuniaoPublica | null; horarios: HorarioPublico[] };

/** O que vai para a página: primeiro nome, a reunião (se houver) e os horários livres. */
export function respostaCarregar(data: unknown): RespostaCarregar {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (d.ok !== true) return { ok: false, motivo: motivoConhecido(d.motivo) };
  const horarios = Array.isArray(d.horarios)
    ? d.horarios
        .map((h) => {
          const x = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
          const id = typeof x.id === "string" && UUID_RE.test(x.id) ? x.id : null;
          const inicio = iso(x.inicio);
          const fim = iso(x.fim);
          return id && inicio && fim ? { id, inicio, fim } : null;
        })
        .filter((h): h is HorarioPublico => h !== null)
    : [];
  return {
    ok: true,
    primeiro_nome: typeof d.primeiro_nome === "string" ? d.primeiro_nome.slice(0, 60) : "",
    reuniao: reuniaoPublica(d.reuniao),
    horarios,
  };
}

export interface EventoDoBanco {
  reuniao_id?: unknown;
  integration_id?: unknown;
  convidados?: unknown;
  nome?: unknown;
  telefone?: unknown;
}

function texto(v: unknown, max: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Corpo para a `google-calendar-create-event`: evento de 30 min com Meet na agenda
 * "Cobrança - Renegociação" (conta programappgvet). `null` = sem agenda configurada.
 *
 * O organizador é o programappgvet: em conta Google pessoal, quem não foi convidado no
 * evento PEDE para entrar e o anfitrião admite. Por isso a descrição diz para quem conduz
 * entrar logado nessa conta.
 */
export function montarEvento(ev: EventoDoBanco | null | undefined, reuniao: { inicio: string; fim: string }) {
  const integrationId = typeof ev?.integration_id === "string" && UUID_RE.test(ev.integration_id) ? ev.integration_id : null;
  if (!integrationId || !iso(reuniao?.inicio) || !iso(reuniao?.fim)) return null;
  const nome = texto(ev?.nome, 120) || "Aluno";
  const telefone = texto(ev?.telefone, 25);
  const convidados = Array.isArray(ev?.convidados)
    ? (ev!.convidados as unknown[]).filter((e): e is string => typeof e === "string" && EMAIL_RE.test(e)).slice(0, 10)
    : [];
  return {
    integration_id: integrationId,
    title: `Renegociação com ${nome}`,
    description: [
      `Aluno(a): ${nome}`,
      telefone ? `WhatsApp: ${telefone}` : "",
      "",
      "Horário escolhido pelo próprio aluno na agenda de renegociação (convite do Rafael pelo 7693, Fase 03).",
      "Quem conduz: entre na sala logado no programappgvet@gmail.com para conseguir admitir o aluno.",
    ].filter((l, i, arr) => l !== "" || (arr[i - 1] ?? "") !== "").join("\n"),
    starts_at: reuniao.inicio,
    ends_at: reuniao.fim,
    attendees: convidados,
    create_meet: true,
    reminders: [{ method: "popup" as const, minutes: 10 }],
  };
}

/**
 * Freio de abuso do MARCAR, por IP e em memória (por instância da edge). Carregar não
 * conta: abrir a página várias vezes não é abuso.
 */
export function criarFreio(max: number, janelaMs: number, agora: () => number = () => Date.now()) {
  const tentativas = new Map<string, { n: number; ate: number }>();
  return function podeMarcar(chave: string): boolean {
    const t0 = agora();
    if (tentativas.size > 5_000) {
      for (const [k, v] of tentativas) if (t0 > v.ate) tentativas.delete(k);
    }
    const t = tentativas.get(chave);
    if (!t || t0 > t.ate) {
      tentativas.set(chave, { n: 1, ate: t0 + janelaMs });
      return true;
    }
    t.n += 1;
    return t.n <= max;
  };
}
