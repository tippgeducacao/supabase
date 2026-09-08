/**
 * A régua do log de webhook. O teste que mais importa aqui é o do PAYLOAD: é ele que
 * decide se a tabela fica em MB ou em GB, e o erro seria silencioso — ninguém nota
 * "estamos guardando payload demais" até o disco encher.
 */
import { describe, it, expect } from "vitest";
import { classificar, guardaPayload, montarLinhaLog } from "./webhookLog.ts";

describe("classificar", () => {
  it("tipo desconhecido vence, mesmo tendo achado o e-mail", () => {
    // Senão a tela diria "sem correspondência" para um evento que nem foi entendido,
    // apontando a consequência e escondendo a causa.
    expect(classificar(false, true)).toBe("tipo_desconhecido");
    expect(classificar(false, false)).toBe("tipo_desconhecido");
  });

  it("entendeu e achou = processado", () => {
    expect(classificar(true, true)).toBe("processado");
  });

  it("entendeu e não achou = sem_correspondencia", () => {
    expect(classificar(true, false)).toBe("sem_correspondencia");
  });
});

describe("guardaPayload", () => {
  it("NÃO guarda entrega normal bem-sucedida", () => {
    for (const t of ["Delivery", "Open", "Click", "Send"]) {
      expect(guardaPayload(t, "processado"), t).toBe(false);
    }
  });

  it("guarda bounce, reclamação, reject e atraso", () => {
    for (const t of ["Bounce", "Complaint", "Reject", "DeliveryDelay"]) {
      expect(guardaPayload(t, "processado"), t).toBe(true);
    }
  });

  it("guarda QUALQUER coisa que não foi processada", () => {
    expect(guardaPayload("Delivery", "sem_correspondencia")).toBe(true);
    expect(guardaPayload("Delivery", "tipo_desconhecido")).toBe(true);
    expect(guardaPayload(null, "tipo_desconhecido")).toBe(true);
  });
});

describe("montarLinhaLog", () => {
  const base = {
    evento_id: "evt-1",
    provider: "ses",
    tipo: "Delivery",
    email_id: "msg-1",
    destinatario: "joao@exemplo.com",
    motivo: null,
    tipoConhecido: true,
    achouEmail: true,
    corpo: { notificationType: "Delivery", peso: "grande" },
  };

  it("entrega normal: linha completa, payload NULL", () => {
    const l = montarLinhaLog(base);
    expect(l).toMatchObject({
      evento_id: "evt-1", provider: "ses", tipo: "Delivery",
      email_id: "msg-1", destinatario: "joao@exemplo.com",
      resultado: "processado", payload: null,
    });
  });

  it("bounce: guarda o corpo cru, que é onde mora o diagnóstico", () => {
    const corpo = { notificationType: "Bounce", bounce: { diagnosticCode: "550 no such user" } };
    const l = montarLinhaLog({ ...base, tipo: "Bounce", motivo: "Permanent/General", corpo });
    expect(l.payload).toEqual(corpo);
    expect(l.motivo).toBe("Permanent/General");
  });

  it("evento que não casou guarda o corpo, mesmo sendo entrega", () => {
    const l = montarLinhaLog({ ...base, achouEmail: false });
    expect(l.resultado).toBe("sem_correspondencia");
    expect(l.payload).toEqual(base.corpo);
  });

  it("tipo desconhecido guarda o corpo — é o único jeito de descobrir o que chegou", () => {
    const l = montarLinhaLog({ ...base, tipo: "Coisa.Nova", tipoConhecido: false });
    expect(l.resultado).toBe("tipo_desconhecido");
    expect(l.payload).toEqual(base.corpo);
  });
});
