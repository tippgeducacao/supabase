// Regras puras da edge `gt-doc-compartilhado` — a descrição de uma tarefa do Gestor aberta por link
// (`/d/<token>`). Tudo o que decide o que entra e o que sai mora aqui (testado em
// gtDocCompartilhado.test.ts); a edge só liga isto ao banco com a service_role.
//
// Dois modos, escolhidos por quem pode editar a tarefa (RPC `gt_doc_link_definir`):
//   logado  — qualquer colaborador com login ATIVO no sistema que tenha o link
//   publico — qualquer pessoa com o link, sem login
// O token (64 hexadecimais, ~256 bits) é a credencial nos dois casos. Link inexistente, desligado,
// de tarefa sumida ou de tarefa de liderança respondem IGUAL (404 link_invalido): quem está de
// fora não distingue um caso do outro.
//
// O HTML devolvido é o da descrição com três trocas (ver `prepararHtml`):
//   1. menção de pessoa perde o `data-id` (fica só o texto "@Nome");
//   2. menção de tarefa (`#`) vira texto simples "#Título" (sem id da tarefa);
//   3. arquivos do bucket PRIVADO `gt-doc-assets` citados NESTA descrição ganham link assinado de 6 h —
//      SÓ os que o banco já VINCULOU a esta tarefa (`gt_arquivos_vinculos`, tabela gt_tasks). O vínculo
//      só nasce depois da guarda "quem salva já lê o arquivo" (Revisão R4): sem este filtro, colar o
//      caminho de um arquivo alheio na descrição e ligar o link público publicava o arquivo (achado do
//      revisor de acesso, 18/11/2026, antes do 1º push).
// O front ainda passa tudo por `sanitizarHtmlRico` antes de desenhar.

export const MAX_BYTES_DO_PEDIDO = 10_000;
export const BUCKET_PRIVADO = "gt-doc-assets";
export const VALIDADE_ASSINATURA_S = 6 * 60 * 60;
export const TOKEN_RE = /^[0-9a-f]{64}$/;

export type ModoLink = "logado" | "publico";

export interface LinkDoc {
  task_id: string;
  modo: ModoLink;
}

export interface TarefaDoLink {
  title: string | null;
  description: string | null;
  updated_at: string | null;
  leader_scope: boolean | null;
}

export interface Banco {
  linkDoToken(token: string): Promise<LinkDoc | null>;
  carregarTarefa(taskId: string): Promise<TarefaDoLink | null>;
  /** Caminhos do `gt-doc-assets` que o banco vinculou a esta tarefa (passaram pela guarda de leitura). */
  caminhosVinculados(taskId: string): Promise<Set<string>>;
  /** Caminho no bucket → URL assinada (já com o host público). Caminho que falhar fica de fora. */
  assinar(caminhos: string[]): Promise<Map<string, string>>;
}

export interface Resposta {
  status: number;
  corpo: Record<string, unknown>;
}

/** Corpo do pedido → token válido, ou null. */
export function interpretarPedido(corpo: unknown): string | null {
  if (!corpo || typeof corpo !== "object") return null;
  const token = (corpo as { token?: unknown }).token;
  if (typeof token !== "string") return null;
  const t = token.trim().toLowerCase();
  return TOKEN_RE.test(t) ? t : null;
}

// `/storage/v1/object/(public|sign|authenticated)/gt-doc-assets/<caminho>` — o caminho termina em aspas,
// espaço, `?`, `#`, `<` ou `>`.
const URL_DO_BUCKET_RE = new RegExp(
  String.raw`(?:https?:\/\/[^\s"'<>]+?)?\/storage\/v1\/object\/(?:public|sign|authenticated)\/` +
    BUCKET_PRIVADO +
    String.raw`\/([^\s"'<>?#]+)(?:\?[^\s"'<>#]*)?`,
  "g",
);

function decodificar(caminho: string): string {
  try {
    return decodeURIComponent(caminho);
  } catch {
    return caminho;
  }
}

/** Caminhos (decodificados, sem repetição) dos arquivos do bucket privado citados no HTML. */
export function caminhosDoBucket(html: string): string[] {
  const vistos = new Set<string>();
  for (const m of html.matchAll(URL_DO_BUCKET_RE)) {
    const c = decodificar(m[1].replace(/&amp;/g, "&"));
    if (c && !c.includes("..")) vistos.add(c);
  }
  return [...vistos];
}

const escaparTexto = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const desescapar = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function atributo(tag: string, nome: string): string | null {
  const m = tag.match(new RegExp(`\\s${nome}\\s*=\\s*"([^"]*)"`, "i")) ?? tag.match(new RegExp(`\\s${nome}\\s*=\\s*'([^']*)'`, "i"));
  return m ? m[1] : null;
}

/** As três trocas descritas no topo. `assinadas` vem de `Banco.assinar(caminhosDoBucket(html))`. */
export function prepararHtml(html: string, assinadas: Map<string, string>): string {
  let out = html;

  // 2) Menção de TAREFA → texto "#Título" (o chip salvo é `<span data-type="task-mention" data-id data-label>#Título</span>`).
  out = out.replace(
    /<span\b([^>]*\bdata-type\s*=\s*["']task-mention["'][^>]*)>([\s\S]*?)<\/span>/gi,
    (_m, attrs: string, dentro: string) => {
      const rotulo = atributo(` ${attrs}`, "data-label");
      const texto = rotulo ? `#${desescapar(rotulo)}` : desescapar(dentro.replace(/<[^>]*>/g, ""));
      return `<span class="gt-task-mention-texto">${escaparTexto(texto)}</span>`;
    },
  );

  // 1) Menção de PESSOA: tira o id do perfil de qualquer span de menção.
  out = out.replace(/<span\b[^>]*>/gi, (tag) => {
    if (!/data-type\s*=\s*["']mention["']/i.test(tag) && !/\bgt-mention\b/i.test(tag)) return tag;
    return tag.replace(/\s+data-id\s*=\s*("[^"]*"|'[^']*')/gi, "");
  });

  // 3) Arquivos do bucket privado → link assinado (só os que o banco conseguiu assinar).
  out = out.replace(URL_DO_BUCKET_RE, (inteiro, caminho: string) => {
    const assinada = assinadas.get(decodificar(caminho.replace(/&amp;/g, "&")));
    return assinada ? assinada.replace(/&/g, "&amp;") : inteiro;
  });

  return out;
}

const invalido = (): Resposta => ({ status: 404, corpo: { ok: false, erro: "link_invalido" } });

/**
 * `usuarioAtivo` só é chamado no modo `logado` — devolve true se quem chama tem sessão de colaborador
 * ativo. No modo público, quem chama não importa.
 */
export async function tratarPedido(
  corpo: unknown,
  banco: Banco,
  usuarioAtivo: () => Promise<boolean>,
): Promise<Resposta> {
  const token = interpretarPedido(corpo);
  if (!token) return invalido();

  const link = await banco.linkDoToken(token);
  if (!link || (link.modo !== "logado" && link.modo !== "publico")) return invalido();

  if (link.modo === "logado" && !(await usuarioAtivo())) {
    return { status: 401, corpo: { ok: false, erro: "precisa_login" } };
  }

  const tarefa = await banco.carregarTarefa(link.task_id);
  if (!tarefa || tarefa.leader_scope === true) return invalido();

  const original = tarefa.description ?? "";
  const citados = caminhosDoBucket(original);
  const vinculados = citados.length ? await banco.caminhosVinculados(link.task_id) : new Set<string>();
  const caminhos = citados.filter((c) => vinculados.has(c));
  const assinadas = caminhos.length ? await banco.assinar(caminhos) : new Map<string, string>();

  return {
    status: 200,
    corpo: {
      ok: true,
      titulo: tarefa.title ?? "",
      html: prepararHtml(original, assinadas),
      atualizado_em: tarefa.updated_at,
      modo: link.modo,
    },
  };
}
