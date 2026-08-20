/**
 * Cliente SMTP mínimo — o par do `client.ts`.
 *
 * Existe em vez de reusar o `emailProviders/smtp.ts` (denomailer) porque aqui o
 * envio precisa partir do MESMO byte que vai para o `APPEND` do IMAP. Bibliotecas
 * montam o MIME por dentro e não devolvem o cru.
 *
 * Mesmo contrato de socket do IMAP, então o teste usa o mesmo servidor falso.
 */
import type { ConexaoImapLike } from "./client.ts";

export class ErroSmtpAuth extends Error {
  constructor(m: string) { super(m); this.name = "ErroSmtpAuth"; }
}
export class ErroSmtp extends Error {
  constructor(m: string) { super(m); this.name = "ErroSmtp"; }
}

const CR = 13;
const LF = 10;

class LeitorSmtp {
  private buf = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  constructor(private readonly conn: ConexaoImapLike) {}

  private async encher(): Promise<void> {
    const pedaco = new Uint8Array(16 * 1024);
    const n = await this.conn.read(pedaco);
    if (n === null || n === 0) throw new ErroSmtp("Servidor SMTP fechou a conexão.");
    const novo = new Uint8Array(this.buf.length + n);
    novo.set(this.buf, 0);
    novo.set(pedaco.subarray(0, n), this.buf.length);
    this.buf = novo;
  }

  private async lerLinha(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === CR && this.buf[i + 1] === LF) {
          const linha = this.decoder.decode(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return linha;
        }
      }
      await this.encher();
    }
  }

  /**
   * Uma resposta SMTP completa. Resposta multi-linha marca a continuação com HÍFEN
   * depois do código (`250-STARTTLS`) e fecha com ESPAÇO (`250 OK`) — ler só a
   * primeira linha faria o EHLO deixar lixo no buffer e desalinhar tudo depois.
   */
  async lerResposta(): Promise<{ codigo: number; texto: string }> {
    const linhas: string[] = [];
    for (;;) {
      const linha = await this.lerLinha();
      linhas.push(linha);
      if (/^\d{3} /.test(linha)) {
        return { codigo: Number(linha.slice(0, 3)), texto: linhas.join("\n") };
      }
      if (!/^\d{3}-/.test(linha)) {
        throw new ErroSmtp(`Resposta SMTP ilegível: "${linha.slice(0, 80)}"`);
      }
    }
  }
}

/** Ponto no início da linha é o fim do DATA — tem que ser duplicado, ou a mensagem trunca. */
export function protegerPontos(bruto: Uint8Array): Uint8Array {
  const texto = new TextDecoder().decode(bruto);
  return new TextEncoder().encode(texto.replace(/\r\n\./g, "\r\n..").replace(/^\./, ".."));
}

function base64(texto: string): string {
  const bytes = new TextEncoder().encode(texto);
  let bruto = "";
  for (const b of bytes) bruto += String.fromCharCode(b);
  return btoa(bruto);
}

export class ClienteSmtp {
  private readonly leitor: LeitorSmtp;
  private readonly encoder = new TextEncoder();
  public capacidades: string[] = [];

  constructor(private readonly conn: ConexaoImapLike) {
    this.leitor = new LeitorSmtp(conn);
  }

  private async comando(linha: string, esperado: number[]): Promise<{ codigo: number; texto: string }> {
    await this.conn.write(this.encoder.encode(`${linha}\r\n`));
    const r = await this.leitor.lerResposta();
    if (!esperado.includes(r.codigo)) {
      throw new ErroSmtp(`SMTP respondeu ${r.codigo} a "${linha.split(" ")[0]}": ${r.texto}`);
    }
    return r;
  }

  async saudacao(): Promise<void> {
    const r = await this.leitor.lerResposta();
    if (r.codigo !== 220) throw new ErroSmtp(`Servidor SMTP não saudou (${r.codigo}): ${r.texto}`);
  }

  async ehlo(host: string): Promise<void> {
    const r = await this.comando(`EHLO ${host}`, [250]);
    this.capacidades = r.texto.toUpperCase().split("\n").map((l) => l.slice(4).trim());
  }

  temCapacidade(nome: string): boolean {
    return this.capacidades.some((c) => c.startsWith(nome.toUpperCase()));
  }

  async startTls(): Promise<void> {
    await this.comando("STARTTLS", [220]);
  }

  async autenticar(usuario: string, senha: string): Promise<void> {
    try {
      await this.comando("AUTH LOGIN", [334]);
      await this.comando(base64(usuario), [334]);
      await this.comando(base64(senha), [235]);
    } catch (e) {
      throw new ErroSmtpAuth(
        `Servidor SMTP recusou as credenciais: ${(e as Error).message}. Confira usuário e senha da caixa.`,
      );
    }
  }

  async enviar(de: string, destinatarios: string[], bruto: Uint8Array): Promise<void> {
    if (!destinatarios.length) throw new ErroSmtp("Envio sem destinatário.");
    await this.comando(`MAIL FROM:<${de}>`, [250]);
    for (const destino of destinatarios) {
      await this.comando(`RCPT TO:<${destino}>`, [250, 251]);
    }
    await this.comando("DATA", [354]);
    await this.conn.write(protegerPontos(bruto));
    await this.comando("\r\n.", [250]);
  }

  async sair(): Promise<void> {
    try {
      await this.comando("QUIT", [221]);
    } catch {
      // servidor que fecha sem responder o QUIT não é problema de ninguém
    }
  }
}
