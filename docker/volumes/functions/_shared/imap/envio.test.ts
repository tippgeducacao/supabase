/**
 * Montagem da mensagem e cliente SMTP — sem rede.
 *
 * A montagem é pura, então dá para afirmar o BYTE exato injetando data e limites
 * fixos. O SMTP usa o mesmo servidor falso do IMAP, já que o contrato de socket é
 * o mesmo.
 */
import { describe, expect, it } from "vitest";
import type { ConexaoImapLike } from "./client.ts";
import {
  base64EmLinhas,
  codificarCabecalho,
  dataRfc,
  destinatariosDoEnvelope,
  formatarRemetente,
  montarMensagem,
} from "./mensagem.ts";
import { ClienteSmtp, ErroSmtp, ErroSmtpAuth, protegerPontos } from "./smtp.ts";

class ServidorFalso implements ConexaoImapLike {
  public enviados: string[] = [];
  private pendente = new Uint8Array(0);
  private indice = 0;
  private readonly encoder = new TextEncoder();

  constructor(saudacao: string, private readonly roteiro: string[] = []) {
    this.empurrar(saudacao);
  }

  private empurrar(dado: string): void {
    const bytes = this.encoder.encode(dado);
    if (!bytes.length) return;
    const novo = new Uint8Array(this.pendente.length + bytes.length);
    novo.set(this.pendente, 0);
    novo.set(bytes, this.pendente.length);
    this.pendente = novo;
  }

  read(p: Uint8Array): Promise<number | null> {
    if (!this.pendente.length) return Promise.resolve(null);
    const n = Math.min(p.length, this.pendente.length);
    p.set(this.pendente.subarray(0, n));
    this.pendente = this.pendente.slice(n);
    return Promise.resolve(n);
  }

  write(p: Uint8Array): Promise<number> {
    this.enviados.push(new TextDecoder().decode(p));
    if (this.indice < this.roteiro.length) this.empurrar(this.roteiro[this.indice++]);
    return Promise.resolve(p.length);
  }

  close(): void {}
}

const OPCOES = {
  agora: new Date("2026-08-20T15:04:05.000Z"),
  idMensagem: "<fixo@ppgeducacao.com.br>",
  limite: (() => {
    let n = 0;
    return () => `LIMITE${++n}`;
  })(),
};

const BASE = {
  de: { email: "secretaria@ppgeducacao.com.br", nome: "Secretaria" },
  para: ["aluno@exemplo.com"],
  assunto: "Oi",
  html: "<p>Olá</p>",
};

function montarTexto(msg: Parameters<typeof montarMensagem>[0], opcoes = OPCOES) {
  return new TextDecoder().decode(montarMensagem(msg, opcoes).bruto);
}

describe("cabeçalhos", () => {
  it("deixa ASCII em paz", () => {
    expect(codificarCabecalho("Matricula 2026")).toBe("Matricula 2026");
  });

  it("codifica acento em RFC 2047 — sem isso o assunto chega como lixo", () => {
    const saida = codificarCabecalho("Matrícula");
    expect(saida).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(atob(saida.slice(10, -2))).toBe("MatrÃ­cula"); // UTF-8 em bytes
  });

  it("formata o remetente com nome codificado", () => {
    expect(formatarRemetente("a@b.com", "José")).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b\.com>$/);
    expect(formatarRemetente("a@b.com")).toBe("a@b.com");
  });

  it("data no formato do RFC 5322", () => {
    expect(dataRfc(new Date("2026-08-20T15:04:05.000Z"))).toBe("Thu, 20 Aug 2026 15:04:05 +0000");
  });
});

describe("montarMensagem", () => {
  it("põe os cabeçalhos essenciais", () => {
    const t = montarTexto(BASE);
    expect(t).toContain("From: Secretaria <secretaria@ppgeducacao.com.br>");
    expect(t).toContain("To: aluno@exemplo.com");
    expect(t).toContain("Subject: Oi");
    expect(t).toContain("Message-ID: <fixo@ppgeducacao.com.br>");
    expect(t).toContain("Date: Thu, 20 Aug 2026 15:04:05 +0000");
    expect(t).toContain("MIME-Version: 1.0");
  });

  it("manda texto E html — cliente sem html ainda lê a mensagem", () => {
    const t = montarTexto({ ...BASE, html: "<p>Olá</p>", texto: "Olá" });
    expect(t).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(t).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(t).toContain("multipart/alternative");
  });

  it("deriva o texto do html quando não recebe um", () => {
    const { bruto } = montarMensagem({ ...BASE, html: "<p>Olá <b>aluno</b></p>" }, OPCOES);
    const t = new TextDecoder().decode(bruto);
    // partes[1] é o que vem logo após o cabeçalho da parte text/plain: o base64 dela.
    const partes = t.split("Content-Transfer-Encoding: base64");
    const textoDerivado = atob(partes[1].trim().split("\r\n")[0]);
    expect(textoDerivado).toContain("Ol"); // "Olá" em bytes UTF-8
    expect(textoDerivado).toContain("aluno");
    expect(textoDerivado).not.toContain("<b>");
  });

  it("encadeia a resposta com In-Reply-To e References", () => {
    const t = montarTexto({ ...BASE, emRespostaA: "<pai@x>", referencias: "<raiz@x> <pai@x>" });
    expect(t).toContain("In-Reply-To: <pai@x>");
    expect(t).toContain("References: <raiz@x> <pai@x>");
  });

  it("com anexo vira multipart/mixed e declara o disposition", () => {
    const t = montarTexto({
      ...BASE,
      anexos: [{ filename: "boleto.pdf", mimeType: "application/pdf", conteudoBase64: btoa("x") }],
    });
    expect(t).toContain("multipart/mixed");
    expect(t).toContain('Content-Type: application/pdf; name="boleto.pdf"');
    expect(t).toContain('Content-Disposition: attachment; filename="boleto.pdf"');
  });

  it("BCC entra no envelope e NUNCA no cabeçalho — senão vaza para todo mundo", () => {
    const msg = { ...BASE, cc: ["chefe@exemplo.com"], bcc: ["oculto@exemplo.com"] };
    expect(destinatariosDoEnvelope(msg)).toEqual([
      "aluno@exemplo.com",
      "chefe@exemplo.com",
      "oculto@exemplo.com",
    ]);
    const t = montarTexto(msg);
    expect(t).toContain("Cc: chefe@exemplo.com");
    expect(t).not.toContain("oculto@exemplo.com");
  });

  it("quebra base64 em 76 colunas como o RFC manda", () => {
    const linhas = base64EmLinhas("A".repeat(200)).split("\r\n");
    expect(linhas[0]).toHaveLength(76);
    expect(linhas.every((l) => l.length <= 76)).toBe(true);
  });

  it("termina com CRLF", () => {
    expect(montarTexto(BASE).endsWith("\r\n")).toBe(true);
  });
});

describe("protegerPontos", () => {
  it("dobra o ponto no começo da linha — senão a mensagem trunca ali", () => {
    const bruto = new TextEncoder().encode("linha 1\r\n.\r\nlinha 2\r\n");
    expect(new TextDecoder().decode(protegerPontos(bruto))).toBe("linha 1\r\n..\r\nlinha 2\r\n");
  });

  it("dobra também quando a mensagem COMEÇA com ponto", () => {
    const bruto = new TextEncoder().encode(".oi\r\n");
    expect(new TextDecoder().decode(protegerPontos(bruto))).toBe("..oi\r\n");
  });

  it("não mexe em ponto no meio da linha", () => {
    const bruto = new TextEncoder().encode("valor de R$ 1.200,00\r\n");
    expect(new TextDecoder().decode(protegerPontos(bruto))).toContain("1.200,00");
  });
});

describe("ClienteSmtp", () => {
  it("lê resposta MULTI-LINHA do EHLO inteira antes de seguir", async () => {
    const s = new ServidorFalso("220 mail.exemplo.com ESMTP\r\n", [
      "250-mail.exemplo.com\r\n250-STARTTLS\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 52428800\r\n",
      "250 OK\r\n",
    ]);
    const c = new ClienteSmtp(s);
    await c.saudacao();
    await c.ehlo("ppgvet");
    expect(c.temCapacidade("AUTH")).toBe(true);
    expect(c.temCapacidade("STARTTLS")).toBe(true);
    expect(c.temCapacidade("XCOISA")).toBe(false);
    // Se a multi-linha tivesse sobrado no buffer, este comando leria o resto dela.
    await expect(c["comando"]("NOOP", [250])).resolves.toMatchObject({ codigo: 250 });
  });

  it("AUTH LOGIN manda usuário e senha em base64, nessa ordem", async () => {
    const s = new ServidorFalso("220 ok\r\n", ["334 VXNlcm5hbWU6\r\n", "334 UGFzc3dvcmQ6\r\n", "235 aceito\r\n"]);
    const c = new ClienteSmtp(s);
    await c.saudacao();
    await c.autenticar("caixa@exemplo.com", "senha");
    expect(s.enviados[0]).toBe("AUTH LOGIN\r\n");
    expect(atob(s.enviados[1].trim())).toBe("caixa@exemplo.com");
    expect(atob(s.enviados[2].trim())).toBe("senha");
  });

  it("credencial recusada vira ErroSmtpAuth com recado em português", async () => {
    const s = new ServidorFalso("220 ok\r\n", ["334 x\r\n", "334 y\r\n", "535 Authentication failed\r\n"]);
    const c = new ClienteSmtp(s);
    await c.saudacao();
    await expect(c.autenticar("a@b.com", "errada")).rejects.toBeInstanceOf(ErroSmtpAuth);
  });

  it("envia na ordem MAIL FROM → RCPT TO → DATA → corpo → ponto final", async () => {
    const s = new ServidorFalso("220 ok\r\n", [
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "250 recipient ok\r\n",
      "354 go ahead\r\n",
      "",
      "250 queued as ABC\r\n",
    ]);
    const c = new ClienteSmtp(s);
    await c.saudacao();
    await c.enviar("de@x.com", ["a@y.com", "b@y.com"], new TextEncoder().encode("Subject: Oi\r\n\r\nCorpo\r\n"));
    expect(s.enviados[0]).toBe("MAIL FROM:<de@x.com>\r\n");
    expect(s.enviados[1]).toBe("RCPT TO:<a@y.com>\r\n");
    expect(s.enviados[2]).toBe("RCPT TO:<b@y.com>\r\n");
    expect(s.enviados[3]).toBe("DATA\r\n");
    expect(s.enviados[4]).toContain("Subject: Oi");
    expect(s.enviados[5]).toBe("\r\n.\r\n");
  });

  it("recusa envio sem destinatário em vez de falar com o servidor à toa", async () => {
    const c = new ClienteSmtp(new ServidorFalso("220 ok\r\n"));
    await expect(c.enviar("de@x.com", [], new Uint8Array())).rejects.toBeInstanceOf(ErroSmtp);
  });

  it("caixa cheia do destinatário estoura com o código do servidor à mostra", async () => {
    const s = new ServidorFalso("220 ok\r\n", ["250 ok\r\n", "552 Mailbox full\r\n"]);
    const c = new ClienteSmtp(s);
    await c.saudacao();
    await expect(c.enviar("de@x.com", ["cheio@y.com"], new Uint8Array())).rejects.toThrow(/552/);
  });
});
