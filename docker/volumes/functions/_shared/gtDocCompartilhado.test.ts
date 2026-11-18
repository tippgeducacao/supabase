import { describe, expect, it, vi } from "vitest";
import {
  caminhosDoBucket,
  interpretarPedido,
  prepararHtml,
  tratarPedido,
  type Banco,
  type LinkDoc,
  type TarefaDoLink,
} from "./gtDocCompartilhado.ts";

const TOKEN = "ab".repeat(32);
const TASK = "11111111-1111-4111-8111-111111111111";
const API = "https://api.ppgeducacao.site";
const FOTO = `${API}/storage/v1/object/public/gt-doc-assets/gt-task-attachments/123-foto%20a.png`;

function banco(link: LinkDoc | null, tarefa: TarefaDoLink | null, vinculados: string[] = ["gt-task-attachments/123-foto a.png"]): Banco & { assinar: ReturnType<typeof vi.fn> } {
  return {
    linkDoToken: vi.fn(async (t: string) => (t === TOKEN ? link : null)),
    carregarTarefa: vi.fn(async () => tarefa),
    caminhosVinculados: vi.fn(async () => new Set(vinculados)),
    assinar: vi.fn(async (caminhos: string[]) => new Map(caminhos.map((c) => [c, `${API}/storage/v1/object/sign/gt-doc-assets/${c}?token=x&t=1`]))),
  };
}

const tarefa = (description: string, extra: Partial<TarefaDoLink> = {}): TarefaDoLink => ({
  title: "Plano de aula",
  description,
  updated_at: "2026-11-18T13:00:00Z",
  leader_scope: false,
  ...extra,
});

describe("interpretarPedido", () => {
  it("aceita só 64 hexadecimais", () => {
    expect(interpretarPedido({ token: TOKEN })).toBe(TOKEN);
    expect(interpretarPedido({ token: TOKEN.toUpperCase() })).toBe(TOKEN);
    expect(interpretarPedido({ token: "abc" })).toBeNull();
    expect(interpretarPedido({ token: "g".repeat(64) })).toBeNull();
    expect(interpretarPedido({})).toBeNull();
    expect(interpretarPedido(null)).toBeNull();
  });
});

describe("caminhosDoBucket", () => {
  it("acha público, assinado e relativo, sem repetir, decodificado", () => {
    const html =
      `<p><img src="${FOTO}"><img src="${FOTO}"></p>` +
      `<a href="${API}/storage/v1/object/sign/gt-doc-assets/pasta/doc.pdf?token=abc&amp;x=1">doc</a>` +
      `<img src="/storage/v1/object/public/gt-doc-assets/rel/x.jpg">` +
      `<img src="${API}/storage/v1/object/public/outro-bucket/y.png">`;
    expect(caminhosDoBucket(html).sort()).toEqual(["gt-task-attachments/123-foto a.png", "pasta/doc.pdf", "rel/x.jpg"]);
  });
  it("ignora caminho com ..", () => {
    expect(caminhosDoBucket(`<img src="/storage/v1/object/public/gt-doc-assets/../segredo">`)).toEqual([]);
  });
});

describe("prepararHtml", () => {
  it("tira o id da menção de pessoa e mantém o nome", () => {
    const html = '<p><span class="gt-mention" data-type="mention" data-id="u-1" data-label="Ana">@Ana</span></p>';
    const out = prepararHtml(html, new Map());
    expect(out).not.toContain("u-1");
    expect(out).toContain("@Ana");
  });
  it("menção de tarefa vira texto, sem id", () => {
    const html = `<p>ver <span data-type="task-mention" class="gt-task-mention" data-id="${TASK}" data-label="Revisar &lt;contrato&gt;">#Revisar</span></p>`;
    const out = prepararHtml(html, new Map());
    expect(out).not.toContain(TASK);
    expect(out).not.toContain("task-mention\"");
    expect(out).toContain("#Revisar &lt;contrato&gt;");
  });
  it("troca só os arquivos que foram assinados", () => {
    const html = `<img src="${FOTO}"><img src="/storage/v1/object/public/gt-doc-assets/nao/assinado.png">`;
    const out = prepararHtml(html, new Map([["gt-task-attachments/123-foto a.png", "https://x/assinada?token=1&t=2"]]));
    expect(out).toContain('src="https://x/assinada?token=1&amp;t=2"');
    expect(out).toContain("/storage/v1/object/public/gt-doc-assets/nao/assinado.png");
  });
});

describe("tratarPedido", () => {
  it("token ruim ou inexistente = 404 link_invalido, sem consultar tarefa", async () => {
    const b = banco(null, tarefa("x"));
    expect((await tratarPedido({ token: "x" }, b, async () => true)).status).toBe(404);
    const r = await tratarPedido({ token: TOKEN }, b, async () => true);
    expect(r).toEqual({ status: 404, corpo: { ok: false, erro: "link_invalido" } });
    expect(b.carregarTarefa).not.toHaveBeenCalled();
  });

  it("modo logado sem login = 401 precisa_login, sem ler a tarefa", async () => {
    const b = banco({ task_id: TASK, modo: "logado" }, tarefa("<p>oi</p>"));
    const r = await tratarPedido({ token: TOKEN }, b, async () => false);
    expect(r.status).toBe(401);
    expect(r.corpo.erro).toBe("precisa_login");
    expect(b.carregarTarefa).not.toHaveBeenCalled();
  });

  it("modo logado com login ativo devolve o documento", async () => {
    const b = banco({ task_id: TASK, modo: "logado" }, tarefa("<p>oi</p>"));
    const r = await tratarPedido({ token: TOKEN }, b, async () => true);
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ ok: true, titulo: "Plano de aula", html: "<p>oi</p>", modo: "logado" });
  });

  it("modo público não pergunta quem chama e assina as fotos", async () => {
    const quem = vi.fn(async () => false);
    const b = banco({ task_id: TASK, modo: "publico" }, tarefa(`<p><img src="${FOTO}"></p>`));
    const r = await tratarPedido({ token: TOKEN }, b, quem);
    expect(r.status).toBe(200);
    expect(quem).not.toHaveBeenCalled();
    expect(b.assinar).toHaveBeenCalledWith(["gt-task-attachments/123-foto a.png"]);
    expect(String(r.corpo.html)).toContain("/object/sign/gt-doc-assets/");
  });

  it("arquivo citado mas NÃO vinculado à tarefa não é assinado (caminho alheio colado na descrição)", async () => {
    const alheio = `${API}/storage/v1/object/public/gt-doc-assets/tcc/outra-pessoa.pdf`;
    const b = banco({ task_id: TASK, modo: "publico" }, tarefa(`<p><img src="${FOTO}"><a href="${alheio}">x</a><a href="/storage/v1/object/public/gt-doc-assets/rel/y.pdf">y</a></p>`));
    const r = await tratarPedido({ token: TOKEN }, b, async () => true);
    expect(b.assinar).toHaveBeenCalledWith(["gt-task-attachments/123-foto a.png"]);
    expect(String(r.corpo.html)).toContain(alheio);
    expect(String(r.corpo.html)).not.toContain("/object/sign/gt-doc-assets/tcc/");
  });

  it("nada vinculado = nada assinado", async () => {
    const b = banco({ task_id: TASK, modo: "publico" }, tarefa(`<p><img src="${FOTO}"></p>`), []);
    await tratarPedido({ token: TOKEN }, b, async () => true);
    expect(b.assinar).not.toHaveBeenCalled();
  });

  it("tarefa de liderança ou sumida responde igual a link inválido", async () => {
    const lider = await tratarPedido({ token: TOKEN }, banco({ task_id: TASK, modo: "publico" }, tarefa("x", { leader_scope: true })), async () => true);
    expect(lider).toEqual({ status: 404, corpo: { ok: false, erro: "link_invalido" } });
    const sumida = await tratarPedido({ token: TOKEN }, banco({ task_id: TASK, modo: "publico" }, null), async () => true);
    expect(sumida.status).toBe(404);
  });

  it("descrição vazia não chama a assinatura", async () => {
    const b = banco({ task_id: TASK, modo: "publico" }, tarefa("", { description: null }));
    const r = await tratarPedido({ token: TOKEN }, b, async () => true);
    expect(r.corpo.html).toBe("");
    expect(b.assinar).not.toHaveBeenCalled();
  });
});
