import { describe, expect, it } from "vitest";
import { regraReligar } from "./religar.ts";

const C = "1da9da89-ea8c-41d5-8cad-0cf3eb3d0f8b";

describe("regraReligar", () => {
  it("troca de servidor: a chave aposentada da MESMA pasta ganha o UID novo", () => {
    const r = regraReligar(C, "inbox", [{ id: "a", gmail_message_id: `imap:${C}:inbox@1709224042-1790600000:500` }]);
    expect(r).toEqual({ religar: "a", jaLigada: false });
  });

  it("envio nosso lido de volta dos Enviados religa a chave provisória", () => {
    const r = regraReligar(C, "sent", [{ id: "p", gmail_message_id: `imap:${C}:enviada:<abc@ppg>` }]);
    expect(r.religar).toBe("p");
  });

  it("a chave provisória NÃO é religada pela cópia da INBOX (e-mail para si mesmo)", () => {
    const r = regraReligar(C, "inbox", [{ id: "p", gmail_message_id: `imap:${C}:enviada:<abc@ppg>` }]);
    expect(r).toEqual({ religar: null, jaLigada: false });
  });

  it("nunca rouba a chave da outra pasta", () => {
    const linhas = [{ id: "s", gmail_message_id: `imap:${C}:sent:12` }, { id: "x", gmail_message_id: `imap:${C}:sent@99-1:7` }];
    expect(regraReligar(C, "inbox", linhas)).toEqual({ religar: null, jaLigada: false });
  });

  it("cópia repetida na mesma pasta, já ligada à numeração atual: não religa nem duplica", () => {
    expect(regraReligar(C, "inbox", [{ id: "i", gmail_message_id: `imap:${C}:inbox:40` }])).toEqual({ religar: null, jaLigada: true });
  });

  it("chave de outra caixa não conta", () => {
    expect(regraReligar(C, "inbox", [{ id: "o", gmail_message_id: "imap:outra:inbox@1-1:5" }])).toEqual({ religar: null, jaLigada: false });
  });
});
