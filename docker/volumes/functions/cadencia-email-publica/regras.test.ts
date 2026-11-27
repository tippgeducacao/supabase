import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acaoValida, deveAcordarDespachante, FILA_CURTA_ATE, respostaDaPagina, tipoDoToken, TOKEN_OK } from "./regras.ts";

const token = (opcao: string) => "a".repeat(96) + opcao + "b".repeat(24);

describe("token do link pessoal", () => {
  it("só 122 hex minúsculos passam", () => {
    expect(TOKEN_OK.test(token("00"))).toBe(true);
    expect(TOKEN_OK.test(token("00").toUpperCase())).toBe(false);
    expect(TOKEN_OK.test(token("00").slice(1))).toBe(false);
    expect(TOKEN_OK.test(token("00") + "a")).toBe(false);
    expect(TOKEN_OK.test("' or 1=1 --")).toBe(false);
  });

  it("a opção 00 é o cronograma; qualquer outra é resposta", () => {
    expect(tipoDoToken(token("00"))).toBe("cronograma");
    expect(tipoDoToken(token("01"))).toBe("resposta");
    expect(tipoDoToken(token("0a"))).toBe("resposta");
    expect(tipoDoToken("x")).toBeNull();
  });

  it("só existem duas ações", () => {
    expect(acaoValida("abrir")).toBe(true);
    expect(acaoValida("registrar")).toBe(true);
    expect(acaoValida("enviar")).toBe(false);
    expect(acaoValida(undefined)).toBe(false);
  });
});

describe("acordar o despachante do WhatsApp", () => {
  it("só quando o clique pôs mensagem na fila e a fila está curta", () => {
    expect(deveAcordarDespachante({ ok: true, enviou: true }, 1)).toBe(true);
    expect(deveAcordarDespachante({ ok: true, enviou: true }, FILA_CURTA_ATE)).toBe(true);
    expect(deveAcordarDespachante({ ok: true, enviou: true }, FILA_CURTA_ATE + 1)).toBe(false);
    expect(deveAcordarDespachante({ ok: true, enviou: true }, 0)).toBe(false);
    expect(deveAcordarDespachante({ ok: true, enviou: true }, null)).toBe(false);
  });

  it("clique repetido, sem envio ou recusado não acorda ninguém", () => {
    expect(deveAcordarDespachante({ ok: true, enviou: true, repetido: true }, 1)).toBe(false);
    expect(deveAcordarDespachante({ ok: true, enviou: false }, 1)).toBe(false);
    expect(deveAcordarDespachante({ ok: false }, 1)).toBe(false);
  });
});

describe("o que sai para a página", () => {
  const doBanco = {
    ok: true, tipo: "cronograma", primeiro_nome: "Ana", telefone_final: "1082",
    pos_nome: "Pós em Cannabis Medicinal na Veterinária", assina_nome: "João", assina_whatsapp: "554699222253",
    cronograma: { url: "https://api.ppgeducacao.site/storage/v1/object/public/ementas/cannabis-medicinal.pdf", capa: "https://x.site/capa.jpg", paginas: 21 },
    resposta: null,
    // nada disto pode vazar, mesmo que um dia o banco devolva
    lead_id: "792f5f4e-0000-0000-0000-000000000000", email: "ana@x.com", whatsapp: "5546999991082", nome: "Ana Paula Souza",
  };

  it("só primeiro nome e 4 últimos dígitos; nenhum outro dado pessoal atravessa", () => {
    const r = respostaDaPagina(doBanco);
    expect(Object.keys(r).sort()).toEqual(["assina_nome", "assina_whatsapp", "cronograma", "ok", "pos_nome", "primeiro_nome", "resposta", "telefone_final", "tipo"]);
    expect(JSON.stringify(r)).not.toMatch(/ana@x\.com|5546999991082|Paula|792f5f4e/);
  });

  it("endereço que não é https e número torto são descartados", () => {
    const r = respostaDaPagina({ ...doBanco, telefone_final: "99991082", assina_whatsapp: "46999222253",
      cronograma: { url: "javascript:alert(1)", capa: "http://sem-s.site/x.jpg", paginas: -1 } });
    expect(r.telefone_final).toBe("");
    expect(r.assina_whatsapp).toBe("");
    expect(r.cronograma).toEqual({ url: null, capa: null, paginas: null });
  });

  it("resposta: só rótulo e tom conhecido", () => {
    const r = respostaDaPagina({ ...doBanco, tipo: "resposta", resposta: { rotulo: "Não tenho interesse", tom: "encerrar", n: 3 } });
    expect(r.resposta).toEqual({ rotulo: "Não tenho interesse", tom: "encerrar" });
    expect(respostaDaPagina({ ...doBanco, tipo: "resposta", resposta: { rotulo: "x", tom: "outro" } }).resposta).toEqual({ rotulo: "x", tom: "interesse" });
  });

  it("link inválido devolve só o motivo", () => {
    expect(respostaDaPagina({ ok: false, motivo: "link_invalido", primeiro_nome: "Ana" })).toEqual({ ok: false, motivo: "link_invalido" });
    expect(respostaDaPagina(null)).toEqual({ ok: false, motivo: "link_invalido" });
  });
});

describe("a edge (lida como texto: é a porta pública)", () => {
  const fonte = readFileSync(join(process.cwd(), "supabase", "functions", "cadencia-email-publica", "index.ts"), "utf8");

  it("declara o acesso público na 1ª linha, com o que confere a origem", () => {
    expect(fonte.split("\n")[0]).toMatch(/^\/\/ acesso: publico — .{15,}/);
  });

  it("confere o formato do token ANTES de criar o cliente do banco", () => {
    expect(fonte.indexOf("TOKEN_OK.test(token)")).toBeGreaterThan(0);
    expect(fonte.indexOf("TOKEN_OK.test(token)")).toBeLessThan(fonte.indexOf("createClient(SUPABASE_URL"));
  });

  it("não envia WhatsApp: só registra e, no máximo, acorda o despachante da fila", () => {
    expect(fonte).not.toContain("crm-whatsapp-send");
    expect(fonte).not.toContain("template_name");
    expect(fonte).toContain("crm_cadencia_email_publica_registrar");
    expect(fonte).toContain("crm-agendadas-dispatch");
  });

  it("só aceita POST e nunca guarda a resposta em cache", () => {
    expect(fonte).toContain("req.method !== 'POST'");
    expect(fonte).toContain("'Cache-Control': 'no-store'");
  });
});
