/**
 * Cliente IMAP contra um servidor FALSO — nenhuma conexão real sai daqui.
 *
 * O que torna isto possível é o socket ser injetado: o `ClienteImap` recebe qualquer
 * coisa que saiba `read`/`write`/`close`, então o teste alimenta respostas gravadas no
 * formato do Dovecot e verifica o parser byte a byte.
 *
 * Os casos foram escolhidos onde parser de IMAP costuma quebrar de verdade:
 * literal no meio da linha, vários literais na mesma linha, corpo com CRLF dentro,
 * acento (byte ≠ caractere) e a armadilha do `UID SEARCH n:*`.
 */
import { describe, expect, it } from "vitest";
import {
  acharPastaEspecial,
  citar,
  ClienteImap,
  type ConexaoImapLike,
  ErroImapAuth,
  ErroImapProtocolo,
  PASTAS_ENVIADOS,
} from "./client.ts";

/** Servidor de mentira: cada `write` do cliente destrava a próxima resposta do roteiro. */
class ServidorFalso implements ConexaoImapLike {
  public enviados: string[] = [];
  public fechado = false;
  private pendente: Uint8Array = new Uint8Array(0);
  private indice = 0;
  private readonly encoder = new TextEncoder();

  constructor(saudacao: string, private readonly roteiro: (string | Uint8Array)[] = []) {
    this.empurrar(saudacao);
  }

  private empurrar(dado: string | Uint8Array): void {
    const bytes = typeof dado === "string" ? this.encoder.encode(dado) : dado;
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

  close(): void {
    this.fechado = true;
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);

/** Monta um `* n FETCH (... BODY[] {tam}\r\n<corpo>\r\n)` com o tamanho REAL em bytes. */
function fetchComCorpo(uid: number, corpo: string, extras = "FLAGS (\\Seen) RFC822.SIZE 100"): Uint8Array {
  const corpoBytes = bytes(corpo);
  const cabeca = bytes(`* 1 FETCH (UID ${uid} ${extras} BODY[] {${corpoBytes.length}}\r\n`);
  const cauda = bytes(`)\r\nP0001 OK FETCH completed\r\n`);
  const saida = new Uint8Array(cabeca.length + corpoBytes.length + cauda.length);
  saida.set(cabeca, 0);
  saida.set(corpoBytes, cabeca.length);
  saida.set(cauda, cabeca.length + corpoBytes.length);
  return saida;
}

describe("saudação e login", () => {
  it("aceita a saudação OK do servidor", async () => {
    const s = new ServidorFalso("* OK [CAPABILITY IMAP4rev1] Dovecot ready.\r\n");
    const c = new ClienteImap(s);
    await expect(c.saudacao()).resolves.toContain("Dovecot");
  });

  it("recusa quem não fala IMAP (porta errada é o caso real)", async () => {
    const s = new ServidorFalso("220 mail.exemplo.com ESMTP Postfix\r\n");
    const c = new ClienteImap(s);
    await expect(c.saudacao()).rejects.toThrow(/não respondeu como IMAP/);
  });

  it("login recusado vira ErroImapAuth — o erro PERMANENTE, que para o retry", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["P0001 NO [AUTHENTICATIONFAILED] Authentication failed.\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    await expect(c.login("joao@exemplo.com", "errada")).rejects.toBeInstanceOf(ErroImapAuth);
  });

  it("escapa aspas e barras na senha em vez de quebrar o comando", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["P0001 OK Logged in\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    await c.login("joao@exemplo.com", 'se"nha\\louca');
    expect(s.enviados[0]).toBe('P0001 LOGIN "joao@exemplo.com" "se\\"nha\\\\louca"\r\n');
  });
});

describe("literais — onde parser de IMAP quebra", () => {
  it("lê um corpo que contém CRLF sem se perder na linha", async () => {
    const corpo = "Subject: Teste\r\nMessage-ID: <a@b>\r\n\r\nLinha 1\r\nLinha 2\r\n";
    const s = new ServidorFalso("* OK ready\r\n", [fetchComCorpo(42, corpo)]);
    const c = new ClienteImap(s);
    await c.saudacao();
    const msgs = await c.buscarMensagens([42]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].uid).toBe(42);
    expect(new TextDecoder().decode(msgs[0].bruto)).toBe(corpo);
    expect(msgs[0].flags).toEqual(["\\Seen"]);
  });

  it("conta o literal em BYTES, não em caracteres (acento é o teste)", async () => {
    const corpo = "Subject: Matrícula\r\n\r\nParabéns pela inscrição — até já!\r\n";
    expect(bytes(corpo).length).toBeGreaterThan(corpo.length); // o acento ocupa 2 bytes
    const s = new ServidorFalso("* OK ready\r\n", [fetchComCorpo(7, corpo)]);
    const c = new ClienteImap(s);
    await c.saudacao();
    const msgs = await c.buscarMensagens([7]);
    expect(new TextDecoder().decode(msgs[0].bruto)).toBe(corpo);
  });

  it("aguenta dois literais na MESMA linha lógica", async () => {
    const a = "corpo A";
    const b = "corpo B";
    const resposta = new Uint8Array([
      ...bytes(`* 1 FETCH (UID 5 RFC822.SIZE 10 BODY[HEADER] {${a.length}}\r\n`),
      ...bytes(a),
      ...bytes(` BODY[] {${b.length}}\r\n`),
      ...bytes(b),
      ...bytes(`)\r\nP0001 OK FETCH completed\r\n`),
    ]);
    const s = new ServidorFalso("* OK ready\r\n", [resposta]);
    const c = new ClienteImap(s);
    await c.saudacao();
    const msgs = await c.buscarMensagens([5]);
    expect(new TextDecoder().decode(msgs[0].bruto)).toBe(b); // pega o BODY[], não o HEADER
  });

  it("pula mensagem acima do teto de tamanho", async () => {
    const s = new ServidorFalso("* OK ready\r\n", [
      fetchComCorpo(9, "gigante", "FLAGS () RFC822.SIZE 99999999"),
    ]);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.buscarMensagens([9], 1024)).toHaveLength(0);
  });

  it("usa BODY.PEEK[] — sincronizar não pode marcar e-mail como lido", async () => {
    const s = new ServidorFalso("* OK ready\r\n", [fetchComCorpo(1, "x")]);
    const c = new ClienteImap(s);
    await c.saudacao();
    await c.buscarMensagens([1]);
    expect(s.enviados[0]).toContain("BODY.PEEK[]");
    expect(s.enviados[0]).not.toMatch(/[^.]BODY\[\]/);
  });
});

describe("UID SEARCH — a armadilha do n:*", () => {
  it("descarta o UID abaixo do pedido que o servidor devolve por definição do protocolo", async () => {
    // Pedimos acima de 10; a caixa só tem até 7. O RFC manda o servidor devolver 7
    // mesmo assim. Sem o filtro, o sync reprocessaria essa mensagem para sempre.
    const s = new ServidorFalso("* OK ready\r\n", ["* SEARCH 7\r\nP0001 OK SEARCH completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.uidsDesde(10)).toEqual([]);
    expect(s.enviados[0]).toBe("P0001 UID SEARCH UID 11:*\r\n");
  });

  it("devolve ordenado o que está de fato acima do ponteiro", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["* SEARCH 14 12 99\r\nP0001 OK SEARCH completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.uidsDesde(10)).toEqual([12, 14, 99]);
  });

  it("caixa sem novidade devolve lista vazia", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["* SEARCH\r\nP0001 OK SEARCH completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.uidsDesde(10)).toEqual([]);
  });
});

describe("UID SEARCH para trás — o histórico", () => {
  it("pede o intervalo fechado, sem o `*` que traria a mensagem errada", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["* SEARCH 3 7 5\r\nP0001 OK SEARCH completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    // Abaixo de 10 = intervalo 1:9. Fechado dos dois lados, então aqui não existe
    // a armadilha do `n:*` que obriga o corte no cliente.
    expect(await c.uidsAte(10)).toEqual([7, 5, 3]);
    expect(s.enviados[0]).toBe("P0001 UID SEARCH UID 1:9\r\n");
  });

  it("devolve do MAIOR para o menor — o histórico desce do recente para o antigo", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["* SEARCH 1 50 20\r\nP0001 OK SEARCH completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.uidsAte(100)).toEqual([50, 20, 1]);
  });

  it("não fala com o servidor quando já chegou no fundo", async () => {
    const s = new ServidorFalso("* OK ready\r\n", []);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.uidsAte(1)).toEqual([]);
    expect(await c.uidsAte(0)).toEqual([]);
    expect(s.enviados).toHaveLength(0);
  });

  it("descarta UID acima do teto, se o servidor mandar", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["* SEARCH 5 999\r\nP0001 OK SEARCH completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.uidsAte(10)).toEqual([5]);
  });
});

describe("SELECT", () => {
  it("extrai UIDVALIDITY, UIDNEXT e total", async () => {
    const s = new ServidorFalso("* OK ready\r\n", [
      [
        "* FLAGS (\\Answered \\Seen)",
        "* 231 EXISTS",
        "* OK [UIDVALIDITY 1755600000] UIDs valid",
        "* OK [UIDNEXT 4321] Predicted next UID",
        "P0001 OK [READ-WRITE] Select completed",
        "",
      ].join("\r\n"),
    ]);
    const c = new ClienteImap(s);
    await c.saudacao();
    expect(await c.selecionar("INBOX")).toEqual({
      uidValidity: 1755600000,
      uidNext: 4321,
      total: 231,
    });
  });

  it("servidor sem UIDVALIDITY é recusado — sync sem essa trava grava mensagem errada", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["* 3 EXISTS\r\nP0001 OK Select completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    await expect(c.selecionar("INBOX")).rejects.toThrow(/UIDVALIDITY/);
  });

  it("pasta inexistente estoura com o nome dela na mensagem", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["P0001 NO Mailbox doesn't exist: Lixo\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    await expect(c.selecionar("Lixo")).rejects.toBeInstanceOf(ErroImapProtocolo);
  });
});

describe("pastas", () => {
  it("lê LIST e acha os Enviados pelo flag de SPECIAL-USE", async () => {
    const s = new ServidorFalso("* OK ready\r\n", [
      [
        `* LIST (\\HasNoChildren) "." INBOX`,
        `* LIST (\\HasNoChildren \\Sent) "." "INBOX.Sent"`,
        `* LIST (\\HasNoChildren \\Trash) "." "INBOX.Trash"`,
        `P0001 OK List completed`,
        "",
      ].join("\r\n"),
    ]);
    const c = new ClienteImap(s);
    await c.saudacao();
    const pastas = await c.listarPastas();
    expect(pastas.map((p) => p.nome)).toEqual(["INBOX", "INBOX.Sent", "INBOX.Trash"]);
    expect(acharPastaEspecial(pastas, "\\Sent", PASTAS_ENVIADOS)).toBe("INBOX.Sent");
  });

  it("cai no nome usual quando o servidor não declara SPECIAL-USE", async () => {
    const pastas = [
      { nome: "INBOX", flags: ["\\HasNoChildren"] },
      { nome: "INBOX.Sent", flags: ["\\HasNoChildren"] },
    ];
    expect(acharPastaEspecial(pastas, "\\Sent", PASTAS_ENVIADOS)).toBe("INBOX.Sent");
  });

  it("devolve null quando não há candidata — quem chama decide o que fazer", async () => {
    expect(acharPastaEspecial([{ nome: "INBOX", flags: [] }], "\\Sent", PASTAS_ENVIADOS)).toBeNull();
  });
});

describe("APPEND — é o que faz o envio aparecer nos Enviados do servidor", () => {
  it("manda o tamanho, espera o + e só então despeja a mensagem", async () => {
    const s = new ServidorFalso("* OK ready\r\n", [
      "+ OK\r\n",
      "",
      "P0001 OK [APPENDUID 1755600000 88] Append completed\r\n",
    ]);
    const c = new ClienteImap(s);
    await c.saudacao();
    const bruto = bytes("Subject: Oi\r\n\r\nCorpo");
    await c.append("INBOX.Sent", bruto);
    expect(s.enviados[0]).toBe(`P0001 APPEND "INBOX.Sent" (\\Seen) {${bruto.length}}\r\n`);
    expect(s.enviados[1]).toBe("Subject: Oi\r\n\r\nCorpo");
    expect(s.enviados[2]).toBe("\r\n");
  });
});

describe("flags", () => {
  it("marca como lida com UID STORE", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["P0001 OK Store completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    await c.marcarLida(33);
    expect(s.enviados[0]).toBe("P0001 UID STORE 33 +FLAGS (\\Seen)\r\n");
  });

  it("desmarca com -FLAGS", async () => {
    const s = new ServidorFalso("* OK ready\r\n", ["P0001 OK Store completed\r\n"]);
    const c = new ClienteImap(s);
    await c.saudacao();
    await c.marcarLida(33, false);
    expect(s.enviados[0]).toBe("P0001 UID STORE 33 -FLAGS (\\Seen)\r\n");
  });
});

describe("citar", () => {
  it("escapa o que o IMAP exige e deixa o resto em paz", () => {
    expect(citar("INBOX.Sent")).toBe('"INBOX.Sent"');
    expect(citar('pasta "x"')).toBe('"pasta \\"x\\""');
    expect(citar("c:\\temp")).toBe('"c:\\\\temp"');
    expect(citar("Ação")).toBe('"Ação"');
  });
});
