import { describe, expect, it } from "vitest";
import {
  destinoDeEnvio, normalizarChat, normalizarChats, normalizarMensagem, normalizarMensagens, paraMs, tipoDaMensagem,
} from "./waEspelho.ts";

describe("paraMs", () => {
  it("aceita ms e segundos", () => {
    expect(paraMs(1794490094000)).toBe(1794490094000);
    expect(paraMs(1794490094)).toBe(1794490094000);
    expect(paraMs("")).toBe(0);
  });
});

describe("normalizarMensagem", () => {
  const base = { messageid: "A1", fromMe: false, messageTimestamp: 1794490094000, senderName: "Ana", sender_pn: "554699413956@s.whatsapp.net" };

  it("texto simples", () => {
    const m = normalizarMensagem({ ...base, messageType: "Conversation", type: "text", text: "Bom dia", content: "Bom dia" })!;
    expect(m.tipo).toBe("texto");
    expect(m.texto).toBe("Bom dia");
    expect(m.autorTelefone).toBe("554699413956");
    expect(m.temArquivo).toBe(false);
  });

  it("voz (ptt) tem arquivo e duração", () => {
    const m = normalizarMensagem({
      ...base, messageType: "AudioMessage", type: "media", mediaType: "ptt",
      content: { PTT: true, seconds: 12, mimetype: "audio/ogg; codecs=opus", URL: "https://mmg.whatsapp.net/x.enc" },
    })!;
    expect(m.tipo).toBe("voz");
    expect(m.temArquivo).toBe(true);
    expect(m.segundos).toBe(12);
  });

  it("imagem com miniatura em base64 vira data URL; miniatura gigante é descartada", () => {
    const pequena = "/9j/" + "A".repeat(100);
    const a = normalizarMensagem({ ...base, messageType: "ImageMessage", mediaType: "image", content: { JPEGThumbnail: pequena, mimetype: "image/jpeg" } })!;
    expect(a.tipo).toBe("imagem");
    expect(a.miniatura?.startsWith("data:image/jpeg;base64,/9j/")).toBe(true);
    const b = normalizarMensagem({ ...base, messageType: "ImageMessage", mediaType: "image", content: { JPEGThumbnail: "/9j/" + "A".repeat(70_000) } })!;
    expect(b.miniatura).toBeNull();
  });

  it("documento traz o nome do arquivo", () => {
    const m = normalizarMensagem({ ...base, messageType: "DocumentMessage", mediaType: "document", content: { fileName: "contrato.pdf", mimetype: "application/pdf" } })!;
    expect(m.tipo).toBe("documento");
    expect(m.nomeArquivo).toBe("contrato.pdf");
  });

  it("reação guarda o emoji no texto e o alvo em reacaoDeId", () => {
    const m = normalizarMensagem({ ...base, messageType: "ReactionMessage", type: "reaction", reaction: "ZZ9", text: "👍", content: { text: "👍", key: { ID: "ZZ9" } } })!;
    expect(m.tipo).toBe("reacao");
    expect(m.texto).toBe("👍");
    expect(m.reacaoDeId).toBe("ZZ9");
  });

  it("resposta traz o trecho citado", () => {
    const m = normalizarMensagem({
      ...base, messageType: "ExtendedTextMessage", type: "text", quoted: "Q1",
      content: { text: "ok", contextInfo: { quotedMessage: { conversation: "Você vem hoje?" } } },
    })!;
    expect(m.citadaId).toBe("Q1");
    expect(m.citadaTexto).toBe("Você vem hoje?");
    expect(m.texto).toBe("ok");
  });

  it("contato compartilhado e figurinha", () => {
    expect(normalizarMensagem({ ...base, messageType: "ContactMessage", mediaType: "vcard", content: { displayName: "Maria", vcard: "BEGIN" } })!.contatoNome).toBe("Maria");
    expect(tipoDaMensagem({ messageType: "StickerMessage", mediaType: "sticker" })).toBe("figurinha");
  });

  it("sem id não vira mensagem", () => {
    expect(normalizarMensagem({ text: "x" })).toBeNull();
    expect(normalizarMensagem(null)).toBeNull();
  });
});

describe("normalizarMensagens", () => {
  it("ordena do mais antigo ao mais novo e lê a paginação", () => {
    const r = normalizarMensagens({
      messages: [
        { messageid: "n", messageTimestamp: 2000000000000, text: "novo" },
        { messageid: "a", messageTimestamp: 1000000000000, text: "antigo" },
      ],
      pagination: { hasMore: true, nextOffset: 2 },
    });
    expect(r.mensagens.map((m) => m.id)).toEqual(["a", "n"]);
    expect(r.temMais).toBe(true);
    expect(r.proximoOffset).toBe(2);
  });
});

describe("normalizarChat", () => {
  it("conversa individual: telefone e nome", () => {
    const c = normalizarChat({ wa_chatid: "554699413956@s.whatsapp.net", wa_name: "Ana", wa_unreadCount: 3, wa_lastMsgTimestamp: 1794490094, image: "https://pps.whatsapp.net/a.jpg" })!;
    expect(c.grupo).toBe(false);
    expect(c.telefone).toBe("554699413956");
    expect(c.nome).toBe("Ana");
    expect(c.naoLidas).toBe(3);
    expect(c.ultimaEm).toBe(1794490094000);
    expect(c.foto).toBe("https://pps.whatsapp.net/a.jpg");
  });

  it("grupo não tem telefone", () => {
    const c = normalizarChat({ wa_chatid: "1203630@g.us", wa_name: "Equipe", wa_isGroup: true })!;
    expect(c.grupo).toBe(true);
    expect(c.telefone).toBeNull();
  });

  it("sem nome cai no telefone; status e canal ficam de fora", () => {
    expect(normalizarChat({ wa_chatid: "5511999999999@s.whatsapp.net" })!.nome).toBe("5511999999999");
    expect(normalizarChat({ wa_chatid: "status@broadcast" })).toBeNull();
    expect(normalizarChat({ wa_chatid: "123@newsletter" })).toBeNull();
  });

  it("foto que não é http é descartada (nada de data:/javascript:)", () => {
    expect(normalizarChat({ wa_chatid: "5511@s.whatsapp.net", image: "javascript:alert(1)" })!.foto).toBeNull();
  });

  it("lista com paginação", () => {
    const r = normalizarChats({ chats: [{ wa_chatid: "5511@s.whatsapp.net" }], pagination: { totalRecords: 40, hasMore: true, nextOffset: 1 } });
    expect(r.total).toBe(40);
    expect(r.temMais).toBe(true);
  });
});

describe("destinoDeEnvio", () => {
  it("pessoa vai por dígitos, grupo por JID", () => {
    expect(destinoDeEnvio("554699413956@s.whatsapp.net")).toBe("554699413956");
    expect(destinoDeEnvio("120363025-1234@g.us")).toBe("120363025-1234@g.us");
  });
  it("recusa status, canal, lista de transmissão e lixo", () => {
    expect(destinoDeEnvio("status@broadcast")).toBeNull();
    expect(destinoDeEnvio("123@newsletter")).toBeNull();
    expect(destinoDeEnvio("abc@s.whatsapp.net")).toBeNull();
    expect(destinoDeEnvio("")).toBeNull();
  });
});
