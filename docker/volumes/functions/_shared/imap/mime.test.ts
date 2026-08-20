/**
 * Parser MIME e cifra — com o postal-mime MOCKADO.
 *
 * O que se testa aqui é o MAPEAMENTO (postal-mime → formato do Gmail) e as regras de
 * encadeamento, que são o código próprio. O postal-mime em si é biblioteca testada;
 * como ele é injetado, o `import("npm:...")` nunca roda e o vitest não precisa
 * resolver o especificador.
 */
import { describe, expect, it } from "vitest";
import { chaveDaThread, parsearMensagem, resumo, textoParaHtml } from "./mime.ts";
import { cifrar, decifrar, ErroCripto, importarChave } from "./cripto.ts";

const parserFalso = (retorno: Record<string, unknown>) => async () => retorno;

describe("parsearMensagem", () => {
  it("mapeia o essencial e normaliza endereço para minúsculas", async () => {
    const m = await parsearMensagem(
      new Uint8Array(),
      parserFalso({
        headers: [{ key: "Message-ID", value: "<a@x>" }, { key: "X-Coisa", value: "1" }],
        messageId: "<a@x>",
        subject: "Matrícula 2026",
        from: { address: "Secretaria@PPGEducacao.com.BR", name: "Secretaria" },
        to: [{ address: "Aluno@Exemplo.com", name: "Aluno" }],
        cc: [],
        date: "2026-08-20T12:00:00.000Z",
        html: "<p>Oi</p>",
        text: "Oi",
        attachments: [],
      }),
    );
    expect(m.de).toEqual({ email: "secretaria@ppgeducacao.com.br", name: "Secretaria" });
    expect(m.para[0].email).toBe("aluno@exemplo.com");
    expect(m.assunto).toBe("Matrícula 2026");
    expect(m.data).toBe("2026-08-20T12:00:00.000Z");
    expect(m.headers["x-coisa"]).toBe("1"); // header vira chave minúscula, igual ao Gmail
  });

  it("e-mail só-texto ganha o MESMO <pre> que o motor do Gmail produz", async () => {
    const m = await parsearMensagem(
      new Uint8Array(),
      parserFalso({ text: "linha 1\nlinha 2", html: "", attachments: [] }),
    );
    expect(m.html).toBe(textoParaHtml("linha 1\nlinha 2"));
    expect(m.html).toContain("white-space:pre-wrap");
  });

  it("escapa < > & do texto puro — senão o corpo injeta markup na tela", async () => {
    const m = await parsearMensagem(
      new Uint8Array(),
      parserFalso({ text: "<script>alert(1)</script> & cia", html: "", attachments: [] }),
    );
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).not.toContain("<script>");
  });

  it("mensagem sem corpo nenhum não inventa <pre> vazio", async () => {
    const m = await parsearMensagem(new Uint8Array(), parserFalso({ attachments: [] }));
    expect(m.html).toBe("");
    expect(m.text).toBe("");
  });

  it("converte anexo para bytes e calcula o tamanho real", async () => {
    const conteudo = new TextEncoder().encode("PDF falso");
    const m = await parsearMensagem(
      new Uint8Array(),
      parserFalso({
        attachments: [{ filename: "boleto.pdf", mimeType: "application/pdf", content: conteudo.buffer }],
      }),
    );
    expect(m.anexos[0]).toMatchObject({ filename: "boleto.pdf", mimeType: "application/pdf", size: 9 });
    expect(new TextDecoder().decode(m.anexos[0].conteudo)).toBe("PDF falso");
  });

  it("cai nos headers quando o parser não expõe o campo direto", async () => {
    const m = await parsearMensagem(
      new Uint8Array(),
      parserFalso({
        headers: [{ key: "In-Reply-To", value: "<raiz@x>" }],
        attachments: [],
      }),
    );
    expect(m.inReplyTo).toBe("<raiz@x>");
  });
});

describe("chaveDaThread — IMAP não tem thread id, quem encadeia é References", () => {
  it("usa a PRIMEIRA entrada de References, que é a raiz da conversa", () => {
    expect(chaveDaThread({ references: "<raiz@x> <meio@x> <ultima@x>", messageId: "<nova@x>" }))
      .toBe("<raiz@x>");
  });

  it("cai no In-Reply-To quando o cliente não mandou References", () => {
    expect(chaveDaThread({ inReplyTo: "<pai@x>", messageId: "<nova@x>" })).toBe("<pai@x>");
  });

  it("mensagem que inicia a conversa é a própria raiz", () => {
    expect(chaveDaThread({ messageId: "<nova@x>" })).toBe("<nova@x>");
  });

  it("References com lixo em volta ainda entrega o id", () => {
    expect(chaveDaThread({ references: "\r\n\t<raiz@x>\r\n <b@x>" })).toBe("<raiz@x>");
  });
});

describe("resumo", () => {
  it("prefere o texto e colapsa espaço", () => {
    expect(resumo("  Olá\n\n  tudo   bem?  ", "<p>x</p>")).toBe("Olá tudo bem?");
  });

  it("tira as tags quando só há HTML", () => {
    expect(resumo("", "<p>Olá <b>aluno</b></p>")).toBe("Olá aluno");
  });

  it("corta no limite pedido", () => {
    expect(resumo("a".repeat(500), "", 10)).toHaveLength(10);
  });
});

describe("cifra da senha", () => {
  const CHAVE = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

  it("ida e volta devolve a senha original", async () => {
    const k = await importarChave(CHAVE);
    const blob = await cifrar("s3nh@ do cPanel", k);
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("s3nh@");
    expect(await decifrar(blob, k)).toBe("s3nh@ do cPanel");
  });

  it("dois cifrados da MESMA senha são diferentes (IV aleatório)", async () => {
    const k = await importarChave(CHAVE);
    expect(await cifrar("igual", k)).not.toBe(await cifrar("igual", k));
  });

  it("aguenta acento e unicode", async () => {
    const k = await importarChave(CHAVE);
    const senha = "açúcar-Ω-🔐";
    expect(await decifrar(await cifrar(senha, k), k)).toBe(senha);
  });

  it("chave trocada não decifra — e diz isso em português", async () => {
    const k1 = await importarChave(CHAVE);
    const k2 = await importarChave(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))));
    const blob = await cifrar("segredo", k1);
    await expect(decifrar(blob, k2)).rejects.toThrow(/IMAP_ENC_KEY mudou/);
  });

  it("recusa chave que não tem 32 bytes em vez de cifrar mal", async () => {
    await expect(importarChave(btoa("curta"))).rejects.toBeInstanceOf(ErroCripto);
  });

  it("recusa blob com formato estranho", async () => {
    const k = await importarChave(CHAVE);
    await expect(decifrar("naoehcifrado", k)).rejects.toThrow(/Formato/);
    await expect(decifrar("v9:aa:bb", k)).rejects.toThrow(/Versão de cifra desconhecida/);
  });
});
