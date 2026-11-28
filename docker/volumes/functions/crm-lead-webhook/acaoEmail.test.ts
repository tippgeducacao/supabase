import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { executarAcaoEmail, executarEnvioModeloEmail, linkPessoalBemUsado, normalizarDestinatarioEmail, VARIAVEL_DO_TOQUE, variavelDoSistema, type DependenciasAcaoEmail, type LeadEmail, type RemetenteEmail, type ReservaEmail, type TemplateEmail } from "./acaoEmail.ts";

const INTEGRACAO = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const REMETENTE = "44444444-4444-4444-8444-444444444444";
const LOG = "55555555-5555-4555-8555-555555555555";
const entrada = () => ({
  integrationId: INTEGRACAO, leadId: LEAD, dados: { nome: "Invasor do payload", email: "outro@example.com", titulo: "Aula de amanhã" },
  acao: { id: "acao-email-1", params: { template_id: TEMPLATE, remetente_id: REMETENTE, variaveis: {} as Record<string, string> } },
});
let lead: LeadEmail;
let template: TemplateEmail;
let remetente: RemetenteEmail;
let deps: DependenciasAcaoEmail;
let reservas: Set<string>;

beforeEach(() => {
  lead = { id: LEAD, nome: "Maria Silva", email: "  MARIA@Example.COM ", whatsapp: "5546999999999", curso_interesse: "Medicina Veterinária" };
  template = { id: TEMPLATE, ativo: true, assunto: "Olá {{primeiro_nome}}", corpo_html: "<html><body><h1>Olá {{nome}}</h1><p>Curso: {{curso}}.</p></body></html>", corpo_texto: "Olá {{nome}}", uso: "marketing" };
  remetente = { id: REMETENTE, ativo: true, provider: "resend", dominio_verificado: true };
  reservas = new Set();
  deps = {
    carregarLead: vi.fn(async () => lead), carregarTemplate: vi.fn(async () => template), carregarRemetente: vi.fn(async () => remetente),
    reservar: vi.fn(async (r: ReservaEmail) => { if (reservas.has(r.chave)) return false; reservas.add(r.chave); return true; }),
    finalizar: vi.fn(async () => {}),
    enviadoNas24h: vi.fn(async () => false),
    enviar: vi.fn(async () => ({ ok: true, status: 200, corpo: { ok: true, log_id: LOG } })),
    resolverVariavel: (modelo, dados) => modelo.replace(/\{webhook=([^}]+)\}/g, (_m, k: string) => String((dados as Record<string, string>)[k] ?? "")),
  };
});

describe("ação de e-mail da integração", () => {
  it("mesmo modelo já enviado ao endereço em 24h sai como duplicado, sem reservar nem enviar", async () => {
    deps.enviadoNas24h = vi.fn(async () => true);
    const r = await executarAcaoEmail(entrada(), deps);
    expect(r).toEqual({ acao_id: "acao-email-1", status: "duplicado", motivo: "mesmo_modelo_24h" });
    expect(deps.enviadoNas24h).toHaveBeenCalledWith(TEMPLATE, "maria@example.com");
    expect(deps.reservar).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it("envia ao contato persistido, com os IDs da configuração e variáveis padrão", async () => {
    const pedido = entrada();
    pedido.dados = { ...pedido.dados, template_id: "invasor", remetente_id: "invasor" } as typeof pedido.dados;
    const r = await executarAcaoEmail(pedido, deps);
    expect(r).toEqual({ acao_id: "acao-email-1", status: "enviado", log_id: LOG });
    expect(deps.enviar).toHaveBeenCalledWith(expect.objectContaining({
      template_id: TEMPLATE, remetente_id: REMETENTE, destinatario_email: "maria@example.com", destinatario_nome: "Maria Silva",
      variaveis: {
        nome: "Maria Silva", primeiro_nome: "Maria", email: "maria@example.com", telefone: "5546999999999", curso: "Medicina Veterinária",
        "contato.nome": "Maria Silva", "contato.primeiro_nome": "Maria", "contato.email": "maria@example.com",
        "contato.telefone": "5546999999999", "curso.nome": "Medicina Veterinária",
      },
      contexto_tipo: "webhook", contexto_id: INTEGRACAO,
      idempotencia_key: expect.stringMatching(/^crm-webhook-email\/v1\/[a-f0-9]{64}$/),
    }));
    expect(deps.finalizar).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), r);
    expect((deps.reservar as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan((deps.enviar as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(JSON.stringify((deps.reservar as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("maria@example.com");
  });

  it("usa o resolvedor existente para valores fixos e tokens mapeados, sem pré-escapar HTML", async () => {
    const pedido = entrada();
    pedido.acao.params.variaveis = { nome: "Equipe & <PPG>", titulo: "Confira {webhook=titulo}" };
    template.corpo_html = "<html><body><p>{{nome}}: {{titulo}}</p></body></html>";
    await executarAcaoEmail(pedido, deps);
    expect(deps.enviar).toHaveBeenCalledWith(expect.objectContaining({ variaveis: expect.objectContaining({ nome: "Equipe & <PPG>", titulo: "Confira Aula de amanhã" }) }));
  });

  it("preenche sozinho o catálogo aninhado do editor ({{contato.primeiro_nome}}) — e valor mapeado ganha", async () => {
    template.assunto = "Olá {{contato.primeiro_nome}}";
    template.corpo_html = "<html><body><p>{{contato.nome}} · {{contato.email}} · {{curso.nome}}</p></body></html>";
    template.corpo_texto = "Olá {{contato.primeiro_nome}}";
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    const pedido = entrada();
    pedido.acao.params.variaveis = { "contato.primeiro_nome": "Dra. Maria" };
    await executarAcaoEmail(pedido, { ...deps, reservar: vi.fn(async () => true) });
    expect(deps.enviar).toHaveBeenLastCalledWith(expect.objectContaining({ variaveis: expect.objectContaining({ "contato.primeiro_nome": "Dra. Maria" }) }));
  });

  it("modelo com {{contato.primeiro_nome | fallback:\"Olá\"}} envia (era 'variavel_ausente' para todos — 02/10/2026)", async () => {
    template.assunto = "Seu acesso à Escola";
    template.corpo_html = '<html><body><p>{{contato.primeiro_nome | fallback:&quot;Olá&quot;}}, chegou!</p></body></html>';
    template.corpo_texto = '{{contato.primeiro_nome | fallback:"Olá"}}, chegou!';
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    // Contato sem nome e valor mapeado que resolve vazio: o fallback assume, sem barrar.
    lead.nome = "";
    const pedido = entrada();
    pedido.acao.params.variaveis = { "contato.primeiro_nome": "{webhook=nao_veio}" };
    const r = await executarAcaoEmail(pedido, { ...deps, reservar: vi.fn(async () => true) });
    expect(r.status).toBe("enviado");
  });

  it.each(["resend", "ses"])("aceita provedor %s verificado", async provider => {
    remetente.provider = provider;
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
  });

  it.each([
    ["sem ID da ação", () => { const p = entrada(); p.acao.id = " "; return p; }],
    ["sem template", () => { const p = entrada(); p.acao.params.template_id = ""; return p; }],
    ["template vindo de token", () => { const p = entrada(); p.acao.params.template_id = "{webhook=template_id}"; return p; }],
    ["sem remetente", () => { const p = entrada(); p.acao.params.remetente_id = ""; return p; }],
    ["variável inexistente dentro de texto", () => { const p = entrada(); p.acao.params.variaveis = { nome: "Olá {webhook=ausente}, tudo bem?" }; return p; }],
    ["token malformado", () => { const p = entrada(); p.acao.params.variaveis = { nome: "{webhook=nome" }; return p; }],
    ["descadastro sobrescrito", () => { const p = entrada(); p.acao.params.variaveis = { descadastro_url: "https://destino.invalid" }; return p; }],
  ])("recusa %s antes de reservar/enviar", async (_nome, criar) => {
    expect((await executarAcaoEmail(criar(), deps)).status).toBe("ignorado");
    expect(deps.reservar).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it.each([
    ["e-mail ausente", () => { lead.email = null; }],
    ["e-mail inválido", () => { lead.email = "maria@example.com\r\nBcc: outro@example.com"; }],
    ["template inativo", () => { template.ativo = false; }],
    ["remetente inativo", () => { remetente.ativo = false; }],
    ["Gmail", () => { remetente.provider = "gmail"; }],
    ["domínio não verificado", () => { remetente.dominio_verificado = false; }],
    ["sem assunto", () => { template.assunto = " "; }],
    ["HTML vazio", () => { template.corpo_html = "<html><body><style>p{color:red}</style>&nbsp;</body></html>"; }],
    ["variável ausente no HTML", () => { template.corpo_html = "<html><body>{{nao_existe}}</body></html>"; }],
    ["variável ausente no texto", () => { template.corpo_texto = "Olá {{nao_existe}}"; }],
    ["variável padrão vazia utilizada", () => { lead.curso_interesse = null; }],
    ["sintaxe de variável desconhecida", () => { template.assunto = "Olá {{nome | desconhecido}}"; }],
    ["CRLF no assunto", () => { template.assunto = "Olá\r\nBcc: outro@example.com"; }],
    ["CRLF interpolado", () => { lead.nome = "Maria\r\nBcc: outro@example.com"; template.assunto = "Olá {{nome}}"; }],
    ["descadastro no assunto", () => { template.assunto = "Olá {{descadastro_url}}"; }],
    ["token injetado pelo contato", () => { lead.nome = "{{email}}"; }],
  ])("recusa %s sem consumir tentativa", async (_nome, configurar) => {
    configurar();
    const r = await executarAcaoEmail(entrada(), deps);
    expect(r.status).toBe("ignorado");
    expect(deps.reservar).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it("mantém placeholder de descadastro no corpo para o email-send resolver", async () => {
    template.corpo_html = '<html><body><p>Olá {{nome}}</p><a href="{{descadastro_url}}">Sair</a></body></html>';
    template.corpo_texto = "Olá {{nome}}. Sair: {{descadastro_url}}";
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
  });

  it("preserva modelos antigos em fragmentos HTML legíveis", async () => {
    template.corpo_html = "<p>Olá {{nome}}, sua inscrição chegou.</p>";
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
  });

  // 06/11/2026 (Tortuga): e-mail só de imagens NÃO pode ser barrado, tenha ou não `alt`.
  it.each([
    ["só imagens com alt vazio (o caso do Tortuga)", '<html><head><title>Mais Rúmen</title><style>body{margin:0}</style></head><body><a href="https://exemplo.com/p"><img src="https://x/a.jpg" alt="" width="552"></a><img src="https://x/b.png" alt=""></body></html>'],
    ["imagem sem o atributo alt", '<html><body><img src="https://x/a.jpg"></body></html>'],
    ["imagem com alt só de espaço", "<html><body><img src='https://x/a.jpg' alt='   '></body></html>"],
    ["imagem com src sem aspas", "<html><body><img src=https://x/a.jpg></body></html>"],
  ])("envia e-mail %s", async (_nome, html) => {
    template.corpo_html = html;
    const r = await executarAcaoEmail(entrada(), deps);
    expect(r.status).toBe("enviado");
    expect(deps.enviar).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["imagem com src vazio", '<html><body><img src="" alt="Banner"></body></html>'],
    ["só CSS, comentário e nbsp", "<html><head><style>p{color:red}</style></head><body><!-- nada -->&nbsp;</body></html>"],
  ])("continua recusando e-mail vazio: %s", async (_nome, html) => {
    template.corpo_html = html;
    const r = await executarAcaoEmail(entrada(), deps);
    expect(r).toMatchObject({ status: "ignorado", motivo: "template_incompleto" });
    expect(deps.reservar).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it("não consome a reserva quando um link dinâmico usa protocolo inseguro", async () => {
    template.corpo_html = '<p>Olá {{nome}}.</p><a href="{{link}}">Abrir</a>';
    const pedido = entrada();
    pedido.acao.params.variaveis = { link: "javascript:alert(1)" };
    expect(await executarAcaoEmail(pedido, deps)).toMatchObject({ status: "ignorado", motivo: "template_invalido" });
    expect(deps.reservar).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it("duas captações concorrentes reservam uma única tentativa", async () => {
    const resultados = await Promise.all([executarAcaoEmail(entrada(), deps), executarAcaoEmail(entrada(), deps)]);
    expect(resultados.map(r => r.status).sort()).toEqual(["duplicado", "enviado"]);
    expect(deps.enviar).toHaveBeenCalledTimes(1);
  });

  it("o mesmo e-mail não reenvia após mudar lead ou template, mas outra ação tem sua própria reserva", async () => {
    await executarAcaoEmail(entrada(), deps);
    const pedido = entrada();
    pedido.leadId = "77777777-7777-4777-8777-777777777777";
    pedido.acao.params.template_id = "88888888-8888-4888-8888-888888888888";
    lead.id = pedido.leadId;
    expect((await executarAcaoEmail(pedido, deps)).status).toBe("duplicado");
    pedido.acao.id = "outra-acao";
    expect((await executarAcaoEmail(pedido, deps)).status).toBe("enviado");
    expect(deps.enviar).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ok: true, status: 200, corpo: { suprimido: true, motivo: "segredo" } }, "suprimido"],
    [{ ok: true, status: 200, corpo: { ok: true, duplicado: true, id: LOG } }, "duplicado"],
    [{ ok: false, status: 409, corpo: { ok: false, duplicado: true, id: LOG } }, "duplicado"],
    [{ ok: false, status: 400, corpo: { error: "segredo" } }, "erro"],
    [{ ok: true, status: 200, corpo: { ok: true } }, "erro"],
    [{ ok: true, status: 200, corpo: "resposta desconhecida segredo" }, "erro"],
  ])("classifica resposta sem confundir HTTP 200 com enviado", async (resposta, status) => {
    deps.enviar = vi.fn(async () => resposta);
    const r = await executarAcaoEmail(entrada(), deps);
    expect(r.status).toBe(status);
    expect(JSON.stringify(r)).not.toContain("segredo");
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("duplicado");
    expect(deps.enviar).toHaveBeenCalledTimes(1);
  });

  it("timeout mantém reserva e não repete envio de resultado desconhecido", async () => {
    deps.enviar = vi.fn(async () => { throw new Error("timeout com segredo"); });
    expect(await executarAcaoEmail(entrada(), deps)).toMatchObject({ status: "erro", motivo: "resultado_desconhecido" });
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("duplicado");
    expect(deps.enviar).toHaveBeenCalledTimes(1);
  });

  it("falha da reserva impede a chamada ao provedor", async () => {
    deps.reservar = vi.fn(async () => { throw new Error("banco indisponível"); });
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("erro");
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it("resultado não persistido preserva a aceitação conhecida e a reserva", async () => {
    deps.finalizar = vi.fn(async () => { throw new Error("banco indisponível"); });
    expect(await executarAcaoEmail(entrada(), deps)).toMatchObject({ status: "enviado", log_id: LOG, motivo: "registro_resultado_pendente" });
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("duplicado");
    expect(deps.enviar).toHaveBeenCalledTimes(1);
  });
});

describe("links pessoais do contato (27/11/2026, cadência por pós v2)", () => {
  const AGENDA = "https://sistemappgvet.ppgeducacao.site/agendar-reuniao/abc";
  const CRONO = "https://sistemappgvet.ppgeducacao.site/meu-atendimento/" + "a".repeat(122);
  const corpoComLinks = '<p><a href="{{link_agenda_reuniao | fallback:&quot;https://agenda.geral/x&quot;}}">Agendar comigo</a>'
    + '<a href="{{link_cronograma | fallback:&quot;https://pdf.site/c.pdf&quot;}}">Ver o cronograma completo</a>'
    + '<a href="{{link_resposta_1 | fallback:&quot;https://wa.me/554699222253&quot;}}">Sim</a></p>';

  it("modelo com link pessoal pede os links ao banco e manda o que veio; o resto fica no fallback", async () => {
    template.corpo_html = corpoComLinks;
    deps.linksPessoais = vi.fn(async () => ({ link_agenda_reuniao: AGENDA, link_cronograma: CRONO }));
    const r = await executarAcaoEmail(entrada(), deps);
    expect(r.status).toBe("enviado");
    expect(deps.linksPessoais).toHaveBeenCalledWith(LEAD, TEMPLATE);
    const variaveis = (deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis;
    expect(variaveis.link_agenda_reuniao).toBe(AGENDA);
    expect(variaveis.link_cronograma).toBe(CRONO);
    expect(variaveis.link_resposta_1).toBeUndefined();
  });

  it("modelo sem link pessoal nem consulta o banco", async () => {
    deps.linksPessoais = vi.fn(async () => ({ link_cronograma: CRONO }));
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    expect(deps.linksPessoais).not.toHaveBeenCalled();
  });

  it("falha ao montar o link não segura o e-mail: sai com o fallback do modelo", async () => {
    template.corpo_html = corpoComLinks;
    deps.linksPessoais = vi.fn(async () => { throw new Error("banco fora"); });
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    expect((deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis.link_cronograma).toBeUndefined();
  });

  it("só entra endereço https e só nas variáveis de link — nada de javascript: nem de sobrescrever o nome", async () => {
    template.corpo_html = corpoComLinks;
    deps.linksPessoais = vi.fn(async () => ({
      link_cronograma: "javascript:alert(1)", link_resposta_1: "http://sem-s.site/x", link_agenda_reuniao: 42, nome: "Invasor",
    }));
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    const variaveis = (deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis;
    expect(variaveis.link_cronograma).toBeUndefined();
    expect(variaveis.link_resposta_1).toBeUndefined();
    expect(variaveis.link_agenda_reuniao).toBeUndefined();
    expect(variaveis.nome).toBe("Maria Silva");
  });

  it("valor MAPEADO para um link pessoal é ignorado — nem payload de página, nem vazio, nem texto fixo passam por cima", async () => {
    template.corpo_html = corpoComLinks;
    deps.linksPessoais = vi.fn(async () => ({ link_agenda_reuniao: AGENDA, link_cronograma: CRONO }));
    const pedido = entrada();
    pedido.dados = { ...pedido.dados, destino: "https://site-de-terceiro.example/golpe" } as typeof pedido.dados;
    pedido.acao.params.variaveis = { link_cronograma: "{webhook=destino}", link_agenda_reuniao: "", link_resposta_1: "https://fixo.example/x" };
    expect((await executarAcaoEmail(pedido, deps)).status).toBe("enviado");
    const variaveis = (deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis;
    expect(variaveis.link_cronograma).toBe(CRONO);
    expect(variaveis.link_agenda_reuniao).toBe(AGENDA);
    expect(variaveis.link_resposta_1).toBeUndefined();
  });

  it("link pessoal fora de um href inteiro não é entregue (imagem, pedaço de outro endereço, assunto)", async () => {
    deps.linksPessoais = vi.fn(async () => ({ link_cronograma: CRONO, link_resposta_1: CRONO, link_agenda_reuniao: AGENDA }));
    template.corpo_html = '<p><img src="https://fora.example/p.gif?x={{link_resposta_1 | fallback:&quot;x&quot;}}">'
      + '<a href="https://fora.example/r?u={{link_cronograma | fallback:&quot;x&quot;}}">Ver</a>'
      + '<a href="{{link_agenda_reuniao | fallback:&quot;https://agenda.geral/x&quot;}}">Agendar comigo</a></p>';
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    const variaveis = (deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis;
    expect(variaveis.link_resposta_1).toBeUndefined();
    expect(variaveis.link_cronograma).toBeUndefined();
    expect(variaveis.link_agenda_reuniao).toBe(AGENDA);
    expect(linkPessoalBemUsado("link_cronograma", { assunto: "Veja {{link_cronograma}}", corpo_html: '<a href="{{link_cronograma}}">x</a>' })).toBe(false);
    // as duas formas de escrever o fallback valem (aspas retas do gerador do Rafael e &quot;)
    expect(linkPessoalBemUsado("link_cronograma", { assunto: "Oi", corpo_html: '<a href="{{link_cronograma | fallback:"https://x.site/a.pdf"}}" target="_blank">x</a>' })).toBe(true);
    expect(linkPessoalBemUsado("link_resposta_2", { assunto: "Oi", corpo_html: "<a class='b' href='{{link_resposta_2}}'>x</a><a href=\"{{link_resposta_2 | fallback:&quot;https://wa.me/55&quot;}}\">y</a>" })).toBe(true);
    expect(linkPessoalBemUsado("contato.nome", { assunto: "Oi", corpo_html: '<a href="{{contato.nome}}">x</a>' })).toBe(false);
  });

  it("webhook: link de resposta SEM fallback e sem link pessoal continua barrando o envio", async () => {
    template.corpo_html = '<p><a href="{{link_resposta_1}}">Sim</a></p>';
    deps.linksPessoais = vi.fn(async () => ({}));
    expect(await executarAcaoEmail(entrada(), deps)).toMatchObject({ status: "ignorado", motivo: "variavel_ausente" });
  });
});

describe("o WhatsApp do toque no e-mail (28/11/2026: o número segue o toque, lido do fluxo)", () => {
  const corpo = '<p><a href="{{link_whatsapp | fallback:&quot;https://wa.me/554699222253&quot;}}">Falar no WhatsApp</a> '
    + 'ou chame no {{whatsapp_numero | fallback:"(46) 99922-2253"}}.</p>';

  it("o número vem do banco e entra no link e no texto; só ele já basta para consultar", async () => {
    template.corpo_html = corpo;
    deps.linksPessoais = vi.fn(async () => ({ link_whatsapp: "https://wa.me/5546999159811", whatsapp_numero: "(46) 99915-9811" }));
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    expect(deps.linksPessoais).toHaveBeenCalledWith(LEAD, TEMPLATE);
    const variaveis = (deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis;
    expect(variaveis.link_whatsapp).toBe("https://wa.me/5546999159811");
    expect(variaveis.whatsapp_numero).toBe("(46) 99915-9811");
  });

  it("fora do formato exato não entra: vale o fallback do modelo", async () => {
    template.corpo_html = corpo;
    deps.linksPessoais = vi.fn(async () => ({
      link_whatsapp: "https://wa.me/5546999159811?text=golpe", whatsapp_numero: "<b>46</b> 99915-9811",
    }));
    expect((await executarAcaoEmail(entrada(), deps)).status).toBe("enviado");
    const variaveis = (deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis;
    expect(variaveis.link_whatsapp).toBeUndefined();
    expect(variaveis.whatsapp_numero).toBeUndefined();
    for (const ruim of ["https://wa.me.golpe.site/5546999159811", "http://wa.me/5546999159811", "https://wa.me/46999159811", "https://wa.me/5546999159811/"]) {
      expect(VARIAVEL_DO_TOQUE.link_whatsapp.test(ruim)).toBe(false);
    }
    expect(VARIAVEL_DO_TOQUE.link_whatsapp.test("https://wa.me/554699222253")).toBe(true);
    expect(VARIAVEL_DO_TOQUE.whatsapp_numero.test("(46) 9922-2253")).toBe(true);
  });

  it("valor mapeado na tela ou vindo do payload não passa por cima do número do toque", async () => {
    template.corpo_html = corpo;
    deps.linksPessoais = vi.fn(async () => ({ link_whatsapp: "https://wa.me/5546999159811", whatsapp_numero: "(46) 99915-9811" }));
    const pedido = entrada();
    pedido.dados = { ...pedido.dados, zap: "https://wa.me/5511900000000" } as typeof pedido.dados;
    pedido.acao.params.variaveis = { link_whatsapp: "{webhook=zap}", whatsapp_numero: "" };
    expect((await executarAcaoEmail(pedido, deps)).status).toBe("enviado");
    const variaveis = (deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis;
    expect(variaveis.link_whatsapp).toBe("https://wa.me/5546999159811");
    expect(variaveis.whatsapp_numero).toBe("(46) 99915-9811");
    expect(variavelDoSistema("link_whatsapp") && variavelDoSistema("whatsapp_numero") && variavelDoSistema("link_resposta_3")).toBe(true);
    expect(variavelDoSistema("nome") || variavelDoSistema("constructor") || variavelDoSistema("toString")).toBe(false);
  });
});

describe("nome que resolve vazio usa o fallback do modelo (27/11/2026)", () => {
  it("valor mapeado vazio + fallback no modelo: sai o fallback, não a 1ª palavra crua do cadastro", async () => {
    lead.nome = "MV 123";
    template.assunto = '{{contato.primeiro_nome | fallback:"Oi"}}, uma pergunta';
    template.corpo_html = '<p>{{contato.primeiro_nome | fallback:"Olá"}}, tudo bem?</p>';
    template.corpo_texto = null;
    const pedido = entrada();
    // É assim que a automação manda quando o {primeiro_nome_limpo} recusa o nome.
    pedido.acao.params.variaveis = { "contato.primeiro_nome": "" };
    const r = await executarEnvioModeloEmail({
      contexto: { tipo: "automacao_crm", id: INTEGRACAO, namespace: "crm-v2-email/v1", partesChave: ["k"] },
      acao: pedido.acao, leadId: LEAD, dados: null,
    }, { ...deps, reservar: vi.fn(async () => true) });
    expect(r.status).toBe("enviado");
    expect((deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis["contato.primeiro_nome"]).toBe("");
  });

  it("sem fallback no modelo, a automação segue com o valor automático do contato (como antes)", async () => {
    template.assunto = "Olá";
    template.corpo_html = "<p>{{contato.primeiro_nome}}, tudo bem?</p>";
    template.corpo_texto = null;
    const pedido = entrada();
    pedido.acao.params.variaveis = { "contato.primeiro_nome": "" };
    await executarEnvioModeloEmail({
      contexto: { tipo: "automacao_crm", id: INTEGRACAO, namespace: "crm-v2-email/v1", partesChave: ["k"] },
      acao: pedido.acao, leadId: LEAD, dados: null,
    }, { ...deps, reservar: vi.fn(async () => true) });
    expect((deps.enviar as ReturnType<typeof vi.fn>).mock.calls[0][0].variaveis["contato.primeiro_nome"]).toBe("Maria");
  });
});

describe("destinatário de e-mail", () => {
  it.each(["pessoa", "pessoa@", "a@-example.com", "a@ex..com", "a..b@example.com", ".a@example.com", "a b@example.com", "a@ex.com,b@ex.com", "a@example.com\u0000", "a".repeat(65) + "@example.com"])("recusa endereço impossível %s", valor => {
    expect(normalizarDestinatarioEmail(valor)).toBeNull();
  });
  it("preserva alias + e normaliza espaços/maiúsculas", () => {
    expect(normalizarDestinatarioEmail(" Pessoa+Teste@Example.COM ")).toBe("pessoa+teste@example.com");
  });
});

describe("núcleo compartilhado com os Fluxos (28/09/2026)", () => {
  it("a chave do webhook é a MESMA de antes da generalização (senão quem já recebeu receberia de novo)", async () => {
    await executarAcaoEmail(entrada(), deps);
    const esperado = createHash("sha256")
      .update(JSON.stringify(["crm-webhook-email/v1", INTEGRACAO, "acao-email-1", "maria@example.com"])).digest("hex");
    expect(deps.reservar).toHaveBeenCalledWith(expect.objectContaining({ chave: esperado, integration_id: INTEGRACAO, acao_id: "acao-email-1" }));
    expect(deps.enviar).toHaveBeenCalledWith(expect.objectContaining({ idempotencia_key: `crm-webhook-email/v1/${esperado}` }));
  });

  it("origem fluxo: contexto, chave e reserva do fluxo, com as mesmas validações", async () => {
    const FLUXO = "66666666-6666-4666-8666-666666666666";
    const EXEC = "77777777-7777-4777-8777-777777777777";
    const reservar = vi.fn(async () => true);
    const r = await executarEnvioModeloEmail({
      contexto: { tipo: "fluxo", id: FLUXO, namespace: "crm-fluxo-email/v1", partesChave: [FLUXO, EXEC, "0"] },
      acao: { id: "no-acao-1", params: { template_id: TEMPLATE, remetente_id: REMETENTE, variaveis: {} } },
      leadId: LEAD, dados: null,
    }, { ...deps, reservar });
    expect(r).toEqual({ acao_id: "no-acao-1", status: "enviado", log_id: LOG });
    const esperado = createHash("sha256")
      .update(JSON.stringify(["crm-fluxo-email/v1", FLUXO, EXEC, "0", "no-acao-1", "maria@example.com"])).digest("hex");
    expect(reservar).toHaveBeenCalledWith(expect.objectContaining({ chave: esperado, contexto_id: FLUXO, acao_id: "no-acao-1", lead_id: LEAD }));
    expect(deps.enviar).toHaveBeenCalledWith(expect.objectContaining({
      contexto_tipo: "fluxo", contexto_id: FLUXO, idempotencia_key: `crm-fluxo-email/v1/${esperado}`,
    }));
  });

  it.each([
    ["fluxo", "crm-fluxo-email/v1"],
    ["automacao_crm", "crm-v2-email/v1"],
    ["automacao_sac", "sac-v2-email/v1"],
  ] as const)("origem %s: variável sem valor sai em branco, não barra (05/10/2026)", async (tipo, namespace) => {
    // Cadência de teste: o 1º e-mail ("…pós em {{curso.nome}}") não saiu porque o contato não
    // tinha curso, e o 3º pedia {{link_oferta}} que ninguém preencheu. No fluxo, sai em branco.
    lead.curso_interesse = null;
    template.assunto = "Recebemos seu cadastro na pós em {{curso.nome}}";
    template.corpo_html = '<html><body><p>{{contato.primeiro_nome}}: {{curso.nome}}</p><a href="{{link_oferta}}">Ver</a></body></html>';
    template.corpo_texto = "{{contato.primeiro_nome}} {{data_limite}}";
    const r = await executarEnvioModeloEmail({
      contexto: { tipo, id: "66666666-6666-4666-8666-666666666666", namespace, partesChave: ["x"] },
      acao: { id: "no-acao-1", params: { template_id: TEMPLATE, remetente_id: REMETENTE, variaveis: { "contato.primeiro_nome": "", data_limite: " " } } },
      leadId: LEAD, dados: null,
    }, { ...deps, resolverVariavel: (modelo) => modelo, reservar: vi.fn(async () => true) });
    expect(r.status).toBe("enviado");
    expect(deps.enviar).toHaveBeenCalledWith(expect.objectContaining({
      contexto_tipo: tipo, variaveis: expect.objectContaining({ "curso.nome": "", "contato.primeiro_nome": "Maria" }),
    }));
  });

  it("origem webhook: a mesma falta de dado continua barrando", async () => {
    lead.curso_interesse = null;
    template.assunto = "Recebemos seu cadastro na pós em {{curso.nome}}";
    const r = await executarAcaoEmail(entrada(), deps);
    expect(r).toMatchObject({ status: "ignorado", motivo: "variavel_ausente" });
  });

  it("origem fluxo: token de webhook não existe ali e barra o envio", async () => {
    const r = await executarEnvioModeloEmail({
      contexto: { tipo: "fluxo", id: "66666666-6666-4666-8666-666666666666", namespace: "crm-fluxo-email/v1", partesChave: ["x"] },
      acao: { id: "no-acao-1", params: { template_id: TEMPLATE, remetente_id: REMETENTE, variaveis: { nome: "{webhook=nome}" } } },
      leadId: LEAD, dados: null,
    }, { ...deps, resolverVariavel: (modelo) => modelo, reservar: vi.fn(async () => true) });
    expect(r.status).toBe("ignorado");
    expect(deps.enviar).not.toHaveBeenCalled();
  });
});
