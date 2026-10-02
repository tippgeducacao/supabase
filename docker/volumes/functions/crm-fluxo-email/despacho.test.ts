import { beforeEach, describe, expect, it, vi } from "vitest";
import { contextoDoItem, processarItemFila, statusDoLog, type DependenciasFila, type ItemFilaEmail } from "./despacho.ts";

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

describe("automações de funil (CRM V2) e do SAC 2.0 na mesma fila (02/10/2026)", () => {
  const AUTOMACAO = "88888888-8888-4888-8888-888888888888";
  const itemAutomacao = (origem: "crm_v2" | "sac_v2"): ItemFilaEmail => ({
    ...item(), id: `fila-${origem}`, origem, fluxo_id: null, execucao_id: null, no_id: null, passagem: 0,
    automacao_id: AUTOMACAO, chave: `${origem}:exec:1:${LEAD}`, acao_ref: "acao1:abc",
  });

  it("CRM V2: envia como automação do funil, com o id da automação, e não escreve no log do fluxo", async () => {
    const r = await processarItemFila(itemAutomacao("crm_v2"), deps);
    expect(r.status).toBe("enviado");
    expect(deps.nucleo.enviar).toHaveBeenCalledWith(expect.objectContaining({
      contexto_tipo: "automacao_crm", contexto_id: AUTOMACAO,
      idempotencia_key: expect.stringMatching(/^crm-v2-email\/v1\//),
    }));
    expect(deps.registrarNoFluxo).not.toHaveBeenCalled();
  });

  it("SAC 2.0: contexto próprio", async () => {
    await processarItemFila(itemAutomacao("sac_v2"), deps);
    expect(deps.nucleo.enviar).toHaveBeenCalledWith(expect.objectContaining({
      contexto_tipo: "automacao_sac", contexto_id: AUTOMACAO,
      idempotencia_key: expect.stringMatching(/^sac-v2-email\/v1\//),
    }));
  });

  it("chaves diferentes são envios diferentes; a mesma chave é a mesma reserva", async () => {
    const reservas: string[] = [];
    deps.nucleo.enviar = vi.fn(async (p: { idempotencia_key: string }) => {
      reservas.push(p.idempotencia_key);
      return { ok: true, status: 200, corpo: { ok: true, log_id: LOG } };
    });
    await processarItemFila(itemAutomacao("crm_v2"), deps);
    await processarItemFila(itemAutomacao("crm_v2"), deps);
    await processarItemFila({ ...itemAutomacao("crm_v2"), chave: "crm_v2:outra-exec:1" }, deps);
    expect(reservas[0]).toBe(reservas[1]);
    expect(new Set(reservas).size).toBe(2);
  });

  it("linha sem automação (dado torto) é descartada sem enviar", async () => {
    const r = await processarItemFila({ ...itemAutomacao("crm_v2"), automacao_id: null }, deps);
    expect(r).toMatchObject({ status: "ignorado", motivo: "contato_indisponivel" });
    expect(deps.nucleo.enviar).not.toHaveBeenCalled();
    expect(deps.descartar).toHaveBeenCalled();
  });

  it("linha antiga, sem a coluna origem, continua sendo de fluxo", () => {
    expect(contextoDoItem(item())).toEqual({
      tipo: "fluxo", id: FLUXO, namespace: "crm-fluxo-email/v1", partesChave: [FLUXO, EXEC, "2"],
    });
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
