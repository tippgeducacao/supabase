import { beforeEach, describe, expect, it, vi } from "vitest";
import { processarItemFila, statusDoLog, type DependenciasFila, type ItemFilaEmail } from "./despacho.ts";

const FLUXO = "66666666-6666-4666-8666-666666666666";
const EXEC = "77777777-7777-4777-8777-777777777777";
const LEAD = "22222222-2222-4222-8222-222222222222";
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const REMETENTE = "44444444-4444-4444-8444-444444444444";
const LOG = "55555555-5555-4555-8555-555555555555";

const item = (): ItemFilaEmail => ({
  id: "fila-1", fluxo_id: FLUXO, execucao_id: EXEC, passagem: 2, no_id: "bloco-1", acao_ref: "bloco-acao-1", lead_id: LEAD,
  params: { template_id: TEMPLATE, remetente_id: REMETENTE, variaveis: { titulo: "Aula de amanhã" } },
});

let deps: DependenciasFila;
let email: string | null;

beforeEach(() => {
  email = "maria@example.com";
  deps = {
    nucleo: {
      carregarLead: vi.fn(async () => ({ id: LEAD, nome: "Maria Silva", email, whatsapp: null, curso_interesse: "Nutrição" })),
      carregarTemplate: vi.fn(async () => ({ id: TEMPLATE, ativo: true, assunto: "Oi {{primeiro_nome}}", corpo_html: "<p>{{titulo}}</p>", corpo_texto: null, uso: "transacional" })),
      carregarRemetente: vi.fn(async () => ({ id: REMETENTE, ativo: true, provider: "ses", dominio_verificado: true })),
      enviar: vi.fn(async () => ({ ok: true, status: 200, corpo: { ok: true, log_id: LOG } })),
      resolverVariavel: (modelo: string) => modelo,
    },
    assumir: vi.fn(async () => true),
    concluir: vi.fn(async () => {}),
    descartar: vi.fn(async () => {}),
    registrarNoFluxo: vi.fn(async () => {}),
  };
});

describe("despachante da fila de e-mail dos fluxos", () => {
  it("assume, envia com contexto do fluxo e conclui a linha", async () => {
    const r = await processarItemFila(item(), deps);
    expect(r).toEqual({ acao_id: "bloco-acao-1", status: "enviado", log_id: LOG });
    expect(deps.assumir).toHaveBeenCalledWith("fila-1");
    expect(deps.nucleo.enviar).toHaveBeenCalledWith(expect.objectContaining({
      contexto_tipo: "fluxo", contexto_id: FLUXO, destinatario_email: "maria@example.com",
      variaveis: expect.objectContaining({ primeiro_nome: "Maria", titulo: "Aula de amanhã" }),
    }));
    expect(deps.concluir).toHaveBeenCalledWith("fila-1", r);
    expect(deps.descartar).not.toHaveBeenCalled();
    expect((deps.assumir as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((deps.nucleo.enviar as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });

  it("lead sem e-mail: sai da fila como ignorado, sem assumir nem enviar (não volta a cada minuto)", async () => {
    email = null;
    const r = await processarItemFila(item(), deps);
    expect(r).toMatchObject({ status: "ignorado", motivo: "contato_sem_email_valido" });
    expect(deps.assumir).not.toHaveBeenCalled();
    expect(deps.nucleo.enviar).not.toHaveBeenCalled();
    expect(deps.descartar).toHaveBeenCalledWith("fila-1", r);
  });

  it("outra rodada assumiu primeiro: não envia e não mexe na linha", async () => {
    deps.assumir = vi.fn(async () => false);
    const r = await processarItemFila(item(), deps);
    expect(r.status).toBe("duplicado");
    expect(deps.nucleo.enviar).not.toHaveBeenCalled();
    expect(deps.descartar).not.toHaveBeenCalled();
    expect(deps.concluir).not.toHaveBeenCalled();
  });

  it("resposta incerta do envio: conclui como erro, sem nova tentativa", async () => {
    deps.nucleo.enviar = vi.fn(async () => { throw new Error("timeout"); });
    const r = await processarItemFila(item(), deps);
    expect(r).toMatchObject({ status: "erro", motivo: "resultado_desconhecido" });
    expect(deps.concluir).toHaveBeenCalledWith("fila-1", r);
  });

  it("falha no log do fluxo não derruba o envio", async () => {
    deps.registrarNoFluxo = vi.fn(async () => { throw new Error("log fora"); });
    expect((await processarItemFila(item(), deps)).status).toBe("enviado");
  });

  it("a passagem entra na chave: o mesmo bloco na volta seguinte do fluxo é outro envio", async () => {
    const reservas: string[] = [];
    deps.nucleo.enviar = vi.fn(async (p: { idempotencia_key: string }) => {
      reservas.push(p.idempotencia_key);
      return { ok: true, status: 200, corpo: { ok: true, log_id: LOG } };
    });
    await processarItemFila(item(), deps);
    await processarItemFila({ ...item(), id: "fila-2", passagem: 3 }, deps);
    expect(new Set(reservas).size).toBe(2);
  });
});

describe("statusDoLog", () => {
  it("fala a língua da aba de execuções", () => {
    expect(statusDoLog({ acao_id: "a", status: "enviado", log_id: LOG })).toBe("executada");
    expect(statusDoLog({ acao_id: "a", status: "erro", motivo: "envio_recusado" })).toBe("erro");
    expect(statusDoLog({ acao_id: "a", status: "ignorado", motivo: "contato_sem_email_valido" })).toBe("pulada_contato_sem_email_valido");
    expect(statusDoLog({ acao_id: "a", status: "suprimido" })).toBe("pulada_email_suprimido");
  });
});
