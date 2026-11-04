// Regras da página PÚBLICA da agenda do cliente (edge `agenda-cliente-publica`, 03/11/2026).
//
// A empresa-cliente abre a agenda por um link com token aleatório (256 bits, revogável) e pode LER e COMENTAR.
// Nada aqui toca o banco: o `index.ts` entrega um `Banco` (service_role) e este arquivo decide o que sai e o que
// entra. Fica separado para o vitest poder rodar sem Deno e sem rede.
//
// O que a empresa NUNCA recebe: ids de pessoas, quem criou/alterou, links que apontam para o sistema interno
// (a tarefa do Gestor, que ela não consegue abrir) e nada de outra agenda.

export const TOKEN_RE = /^[0-9a-f]{64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NOME_MIN = 2;
export const NOME_MAX = 80;
export const TEXTO_MAX = 2000;
/** Freio contra enxurrada: por agenda, só olhando comentários de CLIENTE. */
export const LIMITE_POR_MINUTO = 5;
export const LIMITE_POR_DIA = 100;
export const MAX_COMENTARIOS_NA_TELA = 500;
export const MAX_BYTES_DO_PEDIDO = 10_000;

export interface LinkAgenda {
  label: string;
  url: string;
}

/** Endereços do sistema interno: a empresa não abre, e mostrá-los só entrega o endereço e os ids de tarefa. */
const HOSTS_INTERNOS = new Set(["sistemappgvet.ppgeducacao.site", "api.ppgeducacao.site"]);

export function linkDaEmpresa(l: unknown): LinkAgenda | null {
  if (!l || typeof l !== "object") return null;
  const { label, url } = l as { label?: unknown; url?: unknown };
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u) || u.length > 2000) return null;
  try {
    const p = new URL(u);
    if (HOSTS_INTERNOS.has(p.hostname.toLowerCase())) return null;
    if (p.searchParams.has("gtTask") || p.pathname.includes("gestao-de-tarefas")) return null;
  } catch {
    return null;
  }
  const rotulo = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : "Acesso";
  return { label: rotulo, url: u };
}

export function filtrarLinks(links: unknown): LinkAgenda[] {
  if (!Array.isArray(links)) return [];
  return links.map(linkDaEmpresa).filter((l): l is LinkAgenda => l !== null);
}

/** Tira caracteres de controle e junta espaços; vazio vira null. */
function higienizar(s: unknown, multilinha: boolean): string | null {
  if (typeof s !== "string") return null;
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r\n?/g, "\n");
  t = multilinha ? t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : t.replace(/\s+/g, " ");
  t = t.trim();
  return t === "" ? null : t;
}

export function limparNome(s: unknown): string | null {
  const t = higienizar(s, false);
  return t && t.length >= NOME_MIN && t.length <= NOME_MAX ? t : null;
}

export function limparTexto(s: unknown): string | null {
  const t = higienizar(s, true);
  return t && t.length <= TEXTO_MAX ? t : null;
}

export type Pedido =
  | { acao: "ler"; token: string }
  | { acao: "comentar"; token: string; nome: string; texto: string; itemId: string | null }
  | { erro: "pedido_invalido" | "nome_invalido" | "texto_invalido" };

export function interpretarPedido(corpo: unknown): Pedido {
  if (!corpo || typeof corpo !== "object") return { erro: "pedido_invalido" };
  const c = corpo as Record<string, unknown>;
  const token = typeof c.token === "string" ? c.token.trim().toLowerCase() : "";
  if (!TOKEN_RE.test(token)) return { erro: "pedido_invalido" };
  if (c.acao === "ler") return { acao: "ler", token };
  if (c.acao === "comentar") {
    const nome = limparNome(c.nome);
    if (!nome) return { erro: "nome_invalido" };
    const texto = limparTexto(c.texto);
    if (!texto) return { erro: "texto_invalido" };
    let itemId: string | null = null;
    if (c.item_id != null && c.item_id !== "") {
      if (typeof c.item_id !== "string" || !UUID_RE.test(c.item_id)) return { erro: "pedido_invalido" };
      itemId = c.item_id.toLowerCase();
    }
    return { acao: "comentar", token, nome, texto, itemId };
  }
  return { erro: "pedido_invalido" };
}

// ── O que o banco entrega ────────────────────────────────────────────────────────────────

export interface ItemBruto {
  id: string;
  titulo: string;
  detalhe: string;
  status: string;
  prazo: string;
  entregue_em: string;
  links: unknown;
  ordem: number;
}
export interface SecaoBruta {
  id: string;
  titulo: string;
  ordem: number;
  itens: ItemBruto[];
}
export interface DadosDaAgenda {
  cliente: string;
  agenda: {
    projeto: string;
    inicio: string | null;
    termino: string | null;
    ultima_reuniao: string | null;
    proxima_reuniao: string | null;
    logo: string | null;
  };
  secoes: SecaoBruta[];
}
export interface ComentarioPublico {
  id: string;
  item_id: string | null;
  autor_tipo: "equipe" | "cliente";
  autor_nome: string;
  texto: string;
  created_at: string;
}

export interface Banco {
  /** O `agenda_id` do token, ou null (não existe OU foi revogado: a empresa não distingue). */
  agendaDoToken(token: string): Promise<string | null>;
  carregarAgenda(agendaId: string): Promise<DadosDaAgenda | null>;
  listarComentarios(agendaId: string): Promise<ComentarioPublico[]>;
  contarComentariosDeClientes(agendaId: string, desdeIso: string): Promise<number>;
  inserirComentario(c: { agendaId: string; itemId: string | null; nome: string; texto: string }): Promise<ComentarioPublico | "item_invalido">;
}

export interface Resposta {
  status: number;
  corpo: Record<string, unknown>;
}

const porOrdem = <T extends { ordem: number; id: string }>(a: T, b: T) => a.ordem - b.ordem || a.id.localeCompare(b.id);

export function montarLeitura(d: DadosDaAgenda, comentarios: ComentarioPublico[]): Record<string, unknown> {
  return {
    ok: true,
    cliente: d.cliente,
    agenda: d.agenda,
    secoes: [...d.secoes].sort(porOrdem).map((s) => ({
      id: s.id,
      titulo: s.titulo,
      itens: [...s.itens].sort(porOrdem).map((i) => ({
        id: i.id,
        titulo: i.titulo,
        detalhe: i.detalhe,
        status: i.status,
        prazo: i.prazo,
        entregue_em: i.entregue_em,
        links: filtrarLinks(i.links),
      })),
    })),
    comentarios,
  };
}

export async function tratarPedido(corpo: unknown, banco: Banco, agora: Date = new Date()): Promise<Resposta> {
  const pedido = interpretarPedido(corpo);
  if ("erro" in pedido) return { status: 400, corpo: { ok: false, motivo: pedido.erro } };

  const agendaId = await banco.agendaDoToken(pedido.token);
  if (!agendaId) return { status: 404, corpo: { ok: false, motivo: "link_invalido" } };

  if (pedido.acao === "ler") {
    const [dados, comentarios] = await Promise.all([banco.carregarAgenda(agendaId), banco.listarComentarios(agendaId)]);
    if (!dados) return { status: 404, corpo: { ok: false, motivo: "link_invalido" } };
    return { status: 200, corpo: montarLeitura(dados, comentarios.slice(-MAX_COMENTARIOS_NA_TELA)) };
  }

  const umMinuto = new Date(agora.getTime() - 60_000).toISOString();
  const umDia = new Date(agora.getTime() - 86_400_000).toISOString();
  const [noMinuto, noDia] = await Promise.all([
    banco.contarComentariosDeClientes(agendaId, umMinuto),
    banco.contarComentariosDeClientes(agendaId, umDia),
  ]);
  if (noMinuto >= LIMITE_POR_MINUTO || noDia >= LIMITE_POR_DIA) {
    return { status: 429, corpo: { ok: false, motivo: "muitos_comentarios" } };
  }
  const gravado = await banco.inserirComentario({ agendaId, itemId: pedido.itemId, nome: pedido.nome, texto: pedido.texto });
  if (gravado === "item_invalido") return { status: 400, corpo: { ok: false, motivo: "pedido_invalido" } };
  return { status: 200, corpo: { ok: true, comentario: gravado } };
}
