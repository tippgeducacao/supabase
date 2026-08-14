/**
 * Handler do webhook SES/SNS, com banco falso.
 *
 * Fecha os critérios de aceite 4 (reprocessar não duplica) e 5 (hard bounce suprime),
 * que antes só tinham a lógica pura coberta — a gravação em si ficava sem teste.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeSupabase, requisicao } from "../../../tests/helpers/fakeSupabase.ts";
import { tratarEventoSns } from "./handler.ts";
import type { MensagemSns } from "../_shared/snsVerify.ts";

const DIR = join(process.cwd(), "tests", "fixtures", "sns");
const fixture = (n: string): MensagemSns => JSON.parse(readFileSync(join(DIR, `${n}.json`), "utf-8"));

/** Banco com a mensagem já registrada, como estaria depois de um envio real. */
function bancoComEnvio(providerMessageId = "0100018f-abc-message-id") {
  return new FakeSupabase({
    emails_enviados: {
      linhas: [{
        id: "log-1",
        provider_message_id: providerMessageId,
        status: "enviado",
        aberto_count: 0,
        clicado_count: 0,
        contexto_tipo: "campanha",
        contexto_id: "camp-1",
      }],
    },
    email_webhook_eventos: { linhas: [], unicas: ["evento_id"] },
    email_supressoes: { linhas: [], unicas: ["email"] },
    email_sns_assinaturas: { linhas: [], unicas: ["topic_arn"] },
  });
}

const aceitaTudo = { verificarAssinatura: async () => true };

describe("assinatura", () => {
  it("REJEITA com 400 quando a assinatura não confere", async () => {
    const db = bancoComEnvio();
    const res = await tratarEventoSns(
      requisicao(fixture("notification-bounce-permanent")),
      { supabase: db, verificarAssinatura: async () => false },
    );

    expect(res.status).toBe(400);
    // E o mais importante: nada foi gravado.
    expect(db.linhas("email_supressoes")).toHaveLength(0);
    expect(db.linhas("email_webhook_eventos")).toHaveLength(0);
  });

  it("corpo que não é JSON devolve 400", async () => {
    const db = bancoComEnvio();
    const res = await tratarEventoSns(requisicao("nao-e-json"), { supabase: db, ...aceitaTudo });
    expect(res.status).toBe(400);
  });
});

describe("critério 5 — hard bounce suprime", () => {
  it("insere o endereço em email_supressoes com motivo bounce", async () => {
    const db = bancoComEnvio();
    const res = await tratarEventoSns(
      requisicao(fixture("notification-bounce-permanent")),
      { supabase: db, ...aceitaTudo },
    );

    expect(res.status).toBe(200);
    const sup = db.linhas("email_supressoes");
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({
      email: "inexistente@exemplo.com", motivo: "bounce", origem_tipo: "ses",
    });
  });

  it("marca a mensagem como bounce e incrementa o contador da campanha", async () => {
    const db = bancoComEnvio();
    await tratarEventoSns(requisicao(fixture("notification-bounce-permanent")), { supabase: db, ...aceitaTudo });

    expect(db.linhas("emails_enviados")[0].status).toBe("bounce");
    expect(db.rpcs).toContainEqual({
      nome: "email_campanha_incrementa",
      args: { p_campanha: "camp-1", p_bounces: 1 },
    });
  });

  it("bounce TRANSIENTE não suprime — caixa cheia não é endereço inválido", async () => {
    const db = bancoComEnvio("0100018f-transient");
    const res = await tratarEventoSns(
      requisicao(fixture("notification-bounce-transient")),
      { supabase: db, ...aceitaTudo },
    );

    expect(await res.json()).toMatchObject({ suprimidos: 0 });
    expect(db.linhas("email_supressoes")).toHaveLength(0);
    expect(db.linhas("emails_enviados")[0].status).not.toBe("bounce");
  });

  it("reclamação suprime com motivo spam", async () => {
    const db = bancoComEnvio("0100018f-complaint");
    await tratarEventoSns(requisicao(fixture("notification-complaint")), { supabase: db, ...aceitaTudo });

    expect(db.linhas("email_supressoes")[0]).toMatchObject({
      email: "reclamou@exemplo.com", motivo: "spam",
    });
  });
});

describe("critério 4 — reprocessar não duplica", () => {
  it("o MESMO payload duas vezes grava um evento só", async () => {
    const db = bancoComEnvio();
    const payload = fixture("notification-bounce-permanent");

    const r1 = await tratarEventoSns(requisicao(payload), { supabase: db, ...aceitaTudo });
    const r2 = await tratarEventoSns(requisicao(payload), { supabase: db, ...aceitaTudo });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ repetido: true });

    expect(db.linhas("email_webhook_eventos")).toHaveLength(1);
    // E não suprime duas vezes nem conta o bounce em dobro.
    expect(db.linhas("email_supressoes")).toHaveLength(1);
    expect(db.rpcs.filter((r) => r.args.p_bounces)).toHaveLength(1);
  });

  it("eventos DIFERENTES do mesmo e-mail são processados normalmente", async () => {
    const db = bancoComEnvio("0100018f-delivery");
    await tratarEventoSns(requisicao(fixture("notification-delivery")), { supabase: db, ...aceitaTudo });
    await tratarEventoSns(requisicao(fixture("notification-complaint")), { supabase: db, ...aceitaTudo });

    expect(db.linhas("email_webhook_eventos")).toHaveLength(2);
  });

  it("abertura repetida do mesmo evento não infla aberto_count", async () => {
    const db = bancoComEnvio("0100018f-open");
    const abertura = {
      ...fixture("notification-delivery"),
      MessageId: "evento-open-1",
      Message: JSON.stringify({
        notificationType: "Open",
        mail: { messageId: "0100018f-open", destination: ["ok@exemplo.com"] },
      }),
    };

    await tratarEventoSns(requisicao(abertura), { supabase: db, ...aceitaTudo });
    await tratarEventoSns(requisicao(abertura), { supabase: db, ...aceitaTudo });

    expect(db.linhas("emails_enviados")[0].aberto_count).toBe(1);
  });
});

describe("entrega e status", () => {
  it("Delivery marca entregue e registra a data", async () => {
    const db = bancoComEnvio("0100018f-delivery");
    await tratarEventoSns(requisicao(fixture("notification-delivery")), { supabase: db, ...aceitaTudo });

    const log = db.linhas("emails_enviados")[0];
    expect(log.status).toBe("entregue");
    expect(log.entregue_em).toBeTruthy();
  });

  it("status não REGRIDE: entrega atrasada não desfaz um clique", async () => {
    const db = bancoComEnvio("0100018f-delivery");
    db.linhas("emails_enviados")[0].status = "clicado";

    await tratarEventoSns(requisicao(fixture("notification-delivery")), { supabase: db, ...aceitaTudo });

    expect(db.linhas("emails_enviados")[0].status).toBe("clicado");
  });

  it("evento de mensagem desconhecida não quebra — só não atualiza nada", async () => {
    const db = bancoComEnvio("outro-id-qualquer");
    const res = await tratarEventoSns(
      requisicao(fixture("notification-delivery")), { supabase: db, ...aceitaTudo },
    );

    expect(res.status).toBe(200);
    expect(db.linhas("emails_enviados")[0].status).toBe("enviado");
  });
});

describe("inscrição SNS", () => {
  it("confirma a inscrição batendo na SubscribeURL e registra o tópico", async () => {
    const db = bancoComEnvio();
    const buscar = vi.fn(async () => ({ ok: true }));

    const res = await tratarEventoSns(
      requisicao(fixture("subscription-confirmation")),
      { supabase: db, ...aceitaTudo, buscar },
    );

    expect(await res.json()).toMatchObject({ confirmada: true });
    expect(buscar).toHaveBeenCalledWith(expect.stringContaining("ConfirmSubscription"));
    expect(db.linhas("email_sns_assinaturas")[0]).toMatchObject({
      topic_arn: "arn:aws:sns:us-east-1:123456789012:crm-ses-events",
      subscription_arn: "confirmada",
    });
  });

  it("se a confirmação falhar, registra sem marcar como confirmada", async () => {
    const db = bancoComEnvio();
    const res = await tratarEventoSns(
      requisicao(fixture("subscription-confirmation")),
      { supabase: db, ...aceitaTudo, buscar: async () => ({ ok: false }) },
    );

    expect(await res.json()).toMatchObject({ confirmada: false });
    expect(db.linhas("email_sns_assinaturas")[0].subscription_arn).toBeNull();
  });
});
