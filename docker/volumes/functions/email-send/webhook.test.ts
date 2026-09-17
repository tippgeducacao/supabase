import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { expandirVariaveis, renderizarTags } from "../_shared/emailBuilder/mergeTags.ts";

const teste = vi.hoisted(() => ({
  handler: null as ((req: Request) => Promise<Response>) | null,
  enviar: vi.fn(),
  suprimido: false,
  modelo: {} as Record<string, unknown>,
  remetente: {} as Record<string, unknown>,
  logs: [] as Record<string, unknown>[],
}));

vi.mock("https://esm.sh/@supabase/supabase-js@2.45.0", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
    from(tabela: string) {
      let insercao: Record<string, unknown> | null = null;
      const resposta = () => {
        if (tabela === "email_templates") return { data: teste.modelo, error: null };
        if (tabela === "email_remetentes") return { data: teste.remetente, error: null };
        if (insercao) return { data: { id: "log-webhook" }, error: null };
        return { data: null, error: null };
      };
      const consulta = {
        select: () => consulta, eq: () => consulta, order: () => consulta, limit: () => consulta,
        insert: (valor: Record<string, unknown>) => { insercao = valor; teste.logs.push(valor); return consulta; },
        update: () => consulta, single: async () => resposta(), maybeSingle: async () => resposta(),
        then: (resolve: (r: ReturnType<typeof resposta>) => unknown) => Promise.resolve(resposta()).then(resolve),
      };
      return consulta;
    },
  }),
}));
vi.mock("../_shared/emailProviders/index.ts", () => ({
  ErroEnvio: class extends Error {}, provedorEfetivo: () => "resend",
  obterProvedor: () => ({ send: teste.enviar }),
}));
vi.mock("../_shared/supressao.ts", () => ({
  supressaoSeAplica: () => true,
  buscarSupressao: async () => teste.suprimido ? { motivo: "descadastro" } : null,
}));
vi.mock("../_shared/envioComum.ts", () => ({
  formatarFrom: (nome: string, email: string) => `${nome} <${email}>`,
  linkDescadastro: async () => "https://email.example/descadastro-assinado",
  tagSegura: (valor: string) => valor,
}));

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: (nome: string) => ({
      SUPABASE_URL: "https://api.example", RESEND_API_KEY: "chave-ficticia",
      SUPABASE_SERVICE_ROLE_KEY: "servico-ficticio",
      RESEND_WEBHOOK_SECRET: "segredo-ficticio",
    })[nome] },
    serve: (handler: (req: Request) => Promise<Response>) => { teste.handler = handler; },
  });
  await import("./index.ts");
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  teste.modelo = {
    id: "modelo", ativo: true, uso: "marketing", assunto: "Olá, {{nome}}",
    corpo_html: '<html><body><p>Olá, {{nome}}</p></body></html>', corpo_texto: "Olá, {{nome}}",
  };
  teste.remetente = {
    id: "remetente", ativo: true, provider: "resend", dominio_verificado: true,
    nome_remetente: "PPG Educação", email_completo: "comercial@email.example",
    reply_to_email: "comercial@example.com",
  };
  teste.logs = [];
  teste.suprimido = false;
  teste.enviar.mockReset().mockResolvedValue({ providerMessageId: "provedor-id" });
});

async function enviar(contexto = "webhook", nome = "Ana & João") {
  return teste.handler!(new Request("https://api.example/functions/v1/email-send", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer servico-ficticio" },
    body: JSON.stringify({ template_id: "modelo", remetente_id: "remetente",
      destinatario_email: "destino@example.com", contexto_tipo: contexto,
      contexto_id: "integracao", variaveis: { nome }, idempotencia_key: "teste" }),
  }));
}

describe("email-send acionado pelo webhook", () => {
  it("mantém modelo, remetente e contexto no histórico, com Reply-To e descadastro de marketing", async () => {
    expect((await enviar()).status).toBe(200);
    expect(teste.logs[0]).toMatchObject({ template_id: "modelo", remetente_id: "remetente", contexto_tipo: "webhook", contexto_id: "integracao" });
    const mensagem = teste.enviar.mock.calls[0][0];
    expect(mensagem.replyTo).toBe("comercial@example.com");
    expect(mensagem.html).toContain("Ana &amp; João");
    expect(mensagem.text).toContain("Ana & João");
    expect(mensagem.html).toContain("Descadastrar deste tipo de e-mail");
    expect(mensagem.text).toContain("https://email.example/descadastro-assinado");
    expect(mensagem.headers["List-Unsubscribe"]).toContain("descadastro-assinado");
  });

  it("resolve a variável reservada sem acrescentar um segundo rodapé", async () => {
    teste.modelo.corpo_html = '<p>Mensagem</p><a href="{{descadastro_url}}">Sair</a>';
    teste.modelo.corpo_texto = "Sair: {{descadastro_url}}";
    await enviar();
    const mensagem = teste.enviar.mock.calls[0][0];
    expect(mensagem.html).toContain('href="https://email.example/descadastro-assinado"');
    expect(mensagem.html).not.toContain("Descadastrar deste tipo");
    expect(mensagem.text).not.toContain("{{");
  });

  it("não adiciona rodapé de marketing a modelo transacional", async () => {
    teste.modelo.uso = "transacional";
    await enviar();
    expect(teste.enviar.mock.calls[0][0].html).not.toContain("Descadastrar deste tipo");
    expect(teste.enviar.mock.calls[0][0].text).toBe("Olá, Ana & João");
  });

  it("respeita supressão sem criar envio ou chamar o provedor", async () => {
    teste.suprimido = true;
    expect(await (await enviar()).json()).toMatchObject({ suprimido: true });
    expect(teste.logs).toHaveLength(0);
    expect(teste.enviar).not.toHaveBeenCalled();
  });

  it.each(["modelo inativo", "remetente inativo", "domínio não verificado", "Gmail"])(
    "recusa alteração de configuração depois da validação externa: %s", async (caso) => {
      if (caso === "modelo inativo") teste.modelo.ativo = false;
      if (caso === "remetente inativo") teste.remetente.ativo = false;
      if (caso === "domínio não verificado") teste.remetente.dominio_verificado = false;
      if (caso === "Gmail") teste.remetente.provider = "gmail";
      expect((await enviar()).status).toBe(422);
      expect(teste.enviar).not.toHaveBeenCalled();
    },
  );

  it("recusa variável ausente e cabeçalho injetado antes de registrar envio", async () => {
    expect((await enviar("webhook", "")).status).toBe(422);
    expect((await enviar("webhook", "Ana\r\nBcc: outro@example.com")).status).toBe(422);
    expect(teste.logs).toHaveLength(0);
    expect(teste.enviar).not.toHaveBeenCalled();
  });

  it("preserva a renderização dos testes de e-mail já existentes", async () => {
    // Mudou de propósito em 17/09/2026: o valor da variável passa a ser ESCAPADO no
    // corpo HTML, como o caminho de webhook já fazia em `renderizacaoWebhook.ts` e como
    // a prévia do construtor sempre fez. `Ana &amp; João` renderiza "Ana & João" no
    // cliente — o que muda é que um contato chamado `<b>` deixa de injetar markup.
    // Conferido no banco antes de mexer: dos 774 envios com modelo, nenhum corpo
    // renderizado trazia tag HTML vinda de variável.
    await enviar("teste");
    expect(teste.enviar.mock.calls[0][0].html).toContain("Ana &amp; João");
    expect(teste.enviar.mock.calls[0][0].html).not.toContain("Descadastrar deste tipo");
  });

  it("tag com filtro chega resolvida ao destinatário, não crua", async () => {
    // O defeito que motivou a troca do motor: o prompt do sistema ENSINA a IA a escrever
    // `{{contato.primeiro_nome | fallback:"Olá"}}`, o regex antigo (`[\w.]+`) não casava
    // filtro nenhum, e a campanha entregava a chave literal. Já havia modelo de
    // marketing salvo assim, pronto para disparo.
    const corpo = '<p>Olá {{contato.primeiro_nome | fallback:&quot;pessoa&quot;}}</p>';
    expect(renderizarTags(corpo, expandirVariaveis({ nome: "Ana Paula" }), { escapar: true }))
      .toBe("<p>Olá Ana</p>");
    expect(renderizarTags(corpo, expandirVariaveis({}), { escapar: true }))
      .toBe("<p>Olá pessoa</p>");
  });

  it("modelo legado sem filtro continua idêntico", async () => {
    // Os 29 modelos do funil de TCC usam `{{nome}}` raso e esperam tag não resolvida
    // saindo LITERAL. Quebrar isso estragaria e-mail que a Secretaria manda todo dia.
    expect(renderizarTags("Olá {{nome_aluno}}, TCC {{titulo_tcc}}", expandirVariaveis({ nome_aluno: "João" })))
      .toBe("Olá João, TCC {{titulo_tcc}}");
  });
});
