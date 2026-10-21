import { describe, expect, it } from "vitest";
import {
  conferirPartes,
  desfechoDoPost,
  escaparTextoLinkedIn,
  formatoPelaAssinatura,
  linkDoPost,
  mensagemDoLinkedIn,
  tipoDoPost,
} from "./linkedinPost";

describe("escaparTextoLinkedIn — o texto não pode sair cortado no primeiro parêntese", () => {
  it("escapa todos os reservados do formato little", () => {
    expect(escaparTextoLinkedIn("a(b)[c]{d}<e>|f*g_h~i\\j@k")).toBe(
      "a\\(b\\)\\[c\\]\\{d\\}\\<e\\>\\|f\\*g\\_h\\~i\\\\j\\@k",
    );
  });

  it("mantém a #hashtag clicável", () => {
    expect(escaparTextoLinkedIn("Turma nova #PPGVET #MedicinaVeterinária")).toBe("Turma nova #PPGVET #MedicinaVeterinária");
  });

  it("# que não abre palavra sai como texto", () => {
    expect(escaparTextoLinkedIn("C# e # solto e nº #3 e fim#")).toBe("C\\# e \\# solto e nº \\#3 e fim\\#");
  });

  it("texto de verdade de um post do Rafael (emoji, quebra de linha, parêntese)", () => {
    const original = "📍 Patos de Minas. Hoje é um dia histórico (de verdade) pra PPGVET. 🐂🎉\n\nE eu faço questão.";
    expect(escaparTextoLinkedIn(original)).toBe(
      "📍 Patos de Minas. Hoje é um dia histórico \\(de verdade\\) pra PPGVET. 🐂🎉\n\nE eu faço questão.",
    );
  });

  it("vazio e nulo não quebram", () => {
    expect(escaparTextoLinkedIn("")).toBe("");
    expect(escaparTextoLinkedIn(undefined as unknown as string)).toBe("");
  });
});

describe("tipoDoPost — o que o LinkedIn aceita publicar", () => {
  const img = (n: string) => `https://api.ppgeducacao.site/storage/v1/object/public/ig-media/u/${n}`;
  it("sem mídia é post de texto", () => expect(tipoDoPost([])).toEqual({ tipo: "texto" }));
  it("uma foto", () => expect(tipoDoPost([img("a.JPG")])).toEqual({ tipo: "imagem" }));
  it("várias fotos", () => expect(tipoDoPost([img("a.png"), img("b.jpeg"), img("c.gif")])).toEqual({ tipo: "multi_imagem" }));
  it("um vídeo MP4", () => expect(tipoDoPost([img("v.mp4")])).toEqual({ tipo: "video" }));
  it("não mistura foto e vídeo", () => expect(tipoDoPost([img("a.jpg"), img("v.mp4")])).toHaveProperty("erro"));
  it("WebP e MOV ficam de fora com o nome do arquivo", () => {
    expect((tipoDoPost([img("a.webp")]) as { erro: string }).erro).toContain("a.webp");
    expect(tipoDoPost([img("v.mov")])).toHaveProperty("erro");
  });
  it("até 20 fotos", () => {
    expect(tipoDoPost(Array.from({ length: 20 }, (_, i) => img(`${i}.jpg`)))).toEqual({ tipo: "multi_imagem" });
    expect(tipoDoPost(Array.from({ length: 21 }, (_, i) => img(`${i}.jpg`)))).toHaveProperty("erro");
  });
  it("query string não engana a extensão", () => expect(tipoDoPost([img("a.jpg?token=x.mp4")])).toEqual({ tipo: "imagem" }));
});

describe("formatoPelaAssinatura", () => {
  const bytes = (...xs: number[]) => {
    const b = new Uint8Array(16);
    b.set(xs);
    return b;
  };
  it("reconhece JPEG, PNG, GIF e MP4", () => {
    expect(formatoPelaAssinatura(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(formatoPelaAssinatura(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
    expect(formatoPelaAssinatura(bytes(0x47, 0x49, 0x46, 0x38))).toBe("image/gif");
    expect(formatoPelaAssinatura(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d))).toBe("video/mp4");
  });
  it("denuncia o WebP disfarçado de .jpg e recusa o QuickTime", () => {
    expect(formatoPelaAssinatura(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
    expect(formatoPelaAssinatura(bytes(0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20))).toBeNull();
  });
});

describe("desfechoDoPost — recusado × incerto decide se pode tentar de novo", () => {
  it("201 com URN é publicado", () => {
    expect(desfechoDoPost(201, "urn:li:share:123", null)).toEqual({ situacao: "publicado", urn: "urn:li:share:123" });
  });
  it("2xx sem URN ainda é publicado (reenviar duplicaria)", () => {
    expect(desfechoDoPost(201, null, null)).toEqual({ situacao: "publicado", urn: "" });
  });
  it("sem resposta e 5xx são incertos — o post pode ter saído", () => {
    expect(desfechoDoPost(null, null, "timeout").situacao).toBe("incerto");
    expect(desfechoDoPost(503, null, { message: "down" }).situacao).toBe("incerto");
  });
  it("401 e 403 são definitivos e mandam reconectar", () => {
    const r401 = desfechoDoPost(401, null, { message: "Expired token" });
    expect(r401).toMatchObject({ situacao: "recusado", definitivo: true });
    expect((r401 as { mensagem: string }).mensagem).toMatch(/reconecte/i);
    expect(desfechoDoPost(403, null, null)).toMatchObject({ situacao: "recusado", definitivo: true });
  });
  it("429, 409 e mídia processando valem nova tentativa", () => {
    expect(desfechoDoPost(429, null, null)).toMatchObject({ definitivo: false });
    expect(desfechoDoPost(409, null, null)).toMatchObject({ definitivo: false });
    expect(desfechoDoPost(400, null, { message: "Media asset is still PROCESSING" })).toMatchObject({ definitivo: false });
    expect(desfechoDoPost(400, null, { code: "MEDIA_ASSET_WAITING_UPLOAD" })).toMatchObject({ definitivo: false });
  });
  it("vídeo que o LinkedIn não processou é definitivo — esperar não conserta o arquivo", () => {
    const r = desfechoDoPost(400, null, { code: "MEDIA_ASSET_PROCESSING_FAILED", message: "Media asset failed processing" });
    expect(r).toMatchObject({ situacao: "recusado", definitivo: true });
    expect((r as { mensagem: string }).mensagem).toMatch(/Exporte de novo/);
  });
  it("texto longo demais é definitivo, com a mensagem do LinkedIn", () => {
    const r = desfechoDoPost(422, null, { message: "commentary length exceeds", code: "FIELD_LENGTH_TOO_LONG" });
    expect(r).toMatchObject({ situacao: "recusado", definitivo: true });
    expect((r as { mensagem: string }).mensagem).toContain("FIELD_LENGTH_TOO_LONG");
  });
});

describe("conferirPartes — vídeo truncado não pode subir", () => {
  const p = (a: number, b: number) => ({ firstByte: a, lastByte: b, uploadUrl: "https://x" });
  it("aceita partes contíguas que cobrem o arquivo", () => {
    expect(conferirPartes([p(0, 4194303), p(4194304, 5000000)], 5000001)).toBeNull();
  });
  it("recusa buraco, ordem trocada, falta de partes e tamanho errado", () => {
    expect(conferirPartes([p(0, 9), p(11, 19)], 20)).toMatch(/fora de ordem/);
    expect(conferirPartes([], 20)).toMatch(/não devolveu/);
    expect(conferirPartes([p(0, 9)], 20)).toMatch(/cobrem 10 bytes/);
  });
});

describe("mensagemDoLinkedIn e linkDoPost", () => {
  it("junta message e code sem repetir", () => {
    expect(mensagemDoLinkedIn({ message: "Bad", code: "X", status: 400 })).toBe("Bad · X");
    expect(mensagemDoLinkedIn(null)).toBe("");
  });
  it("monta o link do post só para URN de post", () => {
    expect(linkDoPost("urn:li:share:1")).toBe("https://www.linkedin.com/feed/update/urn:li:share:1/");
    expect(linkDoPost("urn:li:image:1")).toBeNull();
    expect(linkDoPost(null)).toBeNull();
  });
});
