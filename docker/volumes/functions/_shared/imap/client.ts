/**
 * Cliente IMAP mínimo, escrito sobre socket cru.
 *
 * Cobre só o que a Inbox precisa: LOGIN, LIST, SELECT, UID SEARCH/FETCH/STORE,
 * APPEND, MOVE, LOGOUT. Não é um cliente IMAP completo e não pretende ser.
 *
 * O SOCKET É INJETADO. Nada de `Deno.connectTls` no topo do módulo — é a mesma lição
 * registrada em `emailProviders/ses.ts`: dependência de plataforma no corpo do módulo
 * torna o arquivo intestável no vitest. Aqui o teste passa um socket falso alimentado
 * com respostas gravadas de Dovecot, e nenhuma conexão real acontece.
 */

// ── Erros ────────────────────────────────────────────────────────────────────
// A distinção importa: `auth` é PERMANENTE (para de tentar, pede reautenticação)
// e `rede` é TRANSIENTE (tenta de novo no próximo ciclo). Confundir os dois faz o
// sync ou desistir cedo demais, ou martelar um servidor que nunca vai aceitar.

export class ErroImapAuth extends Error {
  constructor(m: string) { super(m); this.name = "ErroImapAuth"; }
}
export class ErroImapRede extends Error {
  constructor(m: string) { super(m); this.name = "ErroImapRede"; }
}
export class ErroImapProtocolo extends Error {
  constructor(m: string) { super(m); this.name = "ErroImapProtocolo"; }
}

// ── Contrato do socket ───────────────────────────────────────────────────────

export interface ConexaoImapLike {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

export interface LinhaResposta {
  /** Texto da linha, com cada literal trocado por `<<LITERAL0>>`, `<<LITERAL1>>`... */
  texto: string;
  /** Os bytes de cada literal, na ordem em que apareceram. */
  literais: Uint8Array[];
}

export interface Resposta {
  status: "OK" | "NO" | "BAD";
  texto: string;
  linhas: LinhaResposta[];
}

export interface Pasta {
  nome: string;
  flags: string[];
}

export interface MensagemBruta {
  uid: number;
  flags: string[];
  tamanho: number;
  bruto: Uint8Array;
}

export interface EstadoPasta {
  uidValidity: number;
  uidNext: number;
  total: number;
}

// ── Leitor bufferizado ───────────────────────────────────────────────────────

const CR = 13;
const LF = 10;

class Leitor {
  private buf = new Uint8Array(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(private readonly conn: ConexaoImapLike) {}

  private async encher(): Promise<void> {
    const pedaco = new Uint8Array(64 * 1024);
    const n = await this.conn.read(pedaco);
    if (n === null || n === 0) {
      throw new ErroImapRede("Servidor IMAP fechou a conexão antes de terminar a resposta.");
    }
    const novo = new Uint8Array(this.buf.length + n);
    novo.set(this.buf, 0);
    novo.set(pedaco.subarray(0, n), this.buf.length);
    this.buf = novo;
  }

  /** Uma linha até CRLF (o CRLF não volta). */
  async lerLinha(): Promise<string> {
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

  /** Exatamente `n` bytes — é assim que se lê um literal IMAP. */
  async lerExatos(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.encher();
    const dados = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return dados;
  }

  /**
   * Uma linha LÓGICA: a linha física mais todos os literais que ela anunciar.
   *
   * É aqui que mora a diferença entre um cliente IMAP que funciona e um que
   * embaralha corpo de e-mail. `{2345}` no fim da linha significa "os próximos
   * 2345 bytes são dados crus, podem conter CRLF, não tente parsear". E depois
   * deles a linha CONTINUA — podendo anunciar outro literal.
   */
  async lerLinhaLogica(): Promise<LinhaResposta> {
    let texto = await this.lerLinha();
    const literais: Uint8Array[] = [];
    for (;;) {
      const m = texto.match(/\{(\d+)\+?\}$/);
      if (!m) break;
      const tamanho = Number(m[1]);
      const dados = await this.lerExatos(tamanho);
      const resto = await this.lerLinha();
      texto = texto.slice(0, m.index) + `<<LITERAL${literais.length}>>` + resto;
      literais.push(dados);
    }
    return { texto, literais };
  }
}

// ── Cliente ──────────────────────────────────────────────────────────────────

export class ClienteImap {
  private readonly leitor: Leitor;
  private readonly encoder = new TextEncoder();
  private contadorTag = 0;
  private capacidades: string[] = [];

  constructor(private readonly conn: ConexaoImapLike) {
    this.leitor = new Leitor(conn);
  }

  private proximaTag(): string {
    this.contadorTag += 1;
    return `P${String(this.contadorTag).padStart(4, "0")}`;
  }

  private async enviarBruto(texto: string): Promise<void> {
    await this.conn.write(this.encoder.encode(texto));
  }

  /** Lê a saudação do servidor. Chamar uma vez, logo após conectar. */
  async saudacao(): Promise<string> {
    const linha = await this.leitor.lerLinha();
    if (!/^\* (OK|PREAUTH)/.test(linha)) {
      throw new ErroImapRede(`Servidor não respondeu como IMAP: "${linha.slice(0, 80)}"`);
    }
    return linha;
  }

  /**
   * Executa um comando e devolve tudo até a linha marcada com a tag.
   * `continuacao` é chamada quando o servidor responde `+` pedindo mais dados
   * (é o que APPEND usa para mandar a mensagem depois do cabeçalho do comando).
   */
  async executar(
    comando: string,
    continuacao?: () => Promise<void>,
  ): Promise<Resposta> {
    const tag = this.proximaTag();
    await this.enviarBruto(`${tag} ${comando}\r\n`);
    const linhas: LinhaResposta[] = [];
    for (;;) {
      const linha = await this.leitor.lerLinhaLogica();
      if (linha.texto.startsWith("+")) {
        if (!continuacao) {
          throw new ErroImapProtocolo(`Servidor pediu continuação inesperada: ${linha.texto}`);
        }
        await continuacao();
        continue;
      }
      if (linha.texto.startsWith(`${tag} `)) {
        const m = linha.texto.match(/^\S+ (OK|NO|BAD) ?(.*)$/s);
        if (!m) throw new ErroImapProtocolo(`Resposta final ilegível: ${linha.texto.slice(0, 120)}`);
        return { status: m[1] as Resposta["status"], texto: m[2] ?? "", linhas };
      }
      linhas.push(linha);
    }
  }

  private async exigirOk(comando: string, contexto: string, continuacao?: () => Promise<void>) {
    const r = await this.executar(comando, continuacao);
    if (r.status !== "OK") {
      throw new ErroImapProtocolo(`${contexto} falhou: ${r.status} ${r.texto}`.trim());
    }
    return r;
  }

  async login(usuario: string, senha: string): Promise<void> {
    const r = await this.executar(`LOGIN ${citar(usuario)} ${citar(senha)}`);
    if (r.status !== "OK") {
      // NO = credencial recusada. BAD = comando malformado (nosso erro), mas do
      // ponto de vista do usuário o efeito é o mesmo: não entra.
      throw new ErroImapAuth(
        `Login recusado pelo servidor IMAP: ${r.texto || r.status}. Confira usuário e senha da caixa.`,
      );
    }
    const cap = r.linhas.find((l) => l.texto.includes("CAPABILITY"));
    if (cap) this.capacidades = cap.texto.toUpperCase().split(/\s+/);
  }

  async carregarCapacidades(): Promise<string[]> {
    if (this.capacidades.length) return this.capacidades;
    const r = await this.exigirOk("CAPABILITY", "CAPABILITY");
    const linha = r.linhas.find((l) => l.texto.startsWith("* CAPABILITY"));
    this.capacidades = (linha?.texto ?? "").toUpperCase().split(/\s+/);
    return this.capacidades;
  }

  temCapacidade(nome: string): boolean {
    return this.capacidades.includes(nome.toUpperCase());
  }

  /** LIST com os flags de SPECIAL-USE — é assim que se acha a pasta de Enviados. */
  async listarPastas(): Promise<Pasta[]> {
    const r = await this.exigirOk(`LIST "" "*"`, "LIST");
    const pastas: Pasta[] = [];
    for (const linha of r.linhas) {
      const m = linha.texto.match(/^\* LIST \(([^)]*)\) (?:"([^"]*)"|NIL) (?:"(.*)"|(\S+))$/);
      if (!m) continue;
      const flags = (m[1] ?? "").split(/\s+/).filter(Boolean);
      const nome = m[3] ?? m[4] ?? "";
      if (nome) pastas.push({ nome, flags });
    }
    return pastas;
  }

  async selecionar(pasta: string): Promise<EstadoPasta> {
    const r = await this.executar(`SELECT ${citar(pasta)}`);
    if (r.status !== "OK") {
      throw new ErroImapProtocolo(`Não foi possível abrir a pasta "${pasta}": ${r.texto}`);
    }
    const junto = r.linhas.map((l) => l.texto).join("\n");
    const uidValidity = Number(junto.match(/\[UIDVALIDITY (\d+)\]/i)?.[1] ?? 0);
    const uidNext = Number(junto.match(/\[UIDNEXT (\d+)\]/i)?.[1] ?? 0);
    const total = Number(junto.match(/^\* (\d+) EXISTS/mi)?.[1] ?? 0);
    if (!uidValidity) {
      throw new ErroImapProtocolo(`Servidor não informou UIDVALIDITY em "${pasta}" — sync inseguro.`);
    }
    return { uidValidity, uidNext, total };
  }

  /**
   * UIDs acima de `desdeUid` (exclusivo).
   *
   * ⚠️ Armadilha clássica do IMAP: `UID SEARCH UID n:*` SEMPRE devolve pelo menos
   * uma mensagem — se nenhuma tiver UID >= n, o servidor devolve a última mesmo
   * assim, porque `*` é "o maior UID que existe" e o intervalo é reinterpretado.
   * Sem o filtro abaixo, todo sync incremental reprocessaria a última mensagem
   * para sempre. Por isso o corte é feito aqui, no cliente.
   */
  async uidsDesde(desdeUid: number): Promise<number[]> {
    const inicio = desdeUid + 1;
    const r = await this.exigirOk(`UID SEARCH UID ${inicio}:*`, "UID SEARCH");
    const linha = r.linhas.find((l) => /^\* SEARCH/i.test(l.texto));
    if (!linha) return [];
    return linha.texto
      .replace(/^\* SEARCH/i, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((uid) => Number.isFinite(uid) && uid >= inicio)
      .sort((a, b) => a - b);
  }

  /**
   * Busca as mensagens inteiras. `BODY.PEEK[]` em vez de `BODY[]` porque `BODY[]`
   * marca \Seen como efeito colateral — sincronizar não pode marcar e-mail como lido.
   */
  async buscarMensagens(uids: number[], tamanhoMaximo = 25 * 1024 * 1024): Promise<MensagemBruta[]> {
    if (!uids.length) return [];
    const r = await this.exigirOk(
      `UID FETCH ${uids.join(",")} (UID FLAGS RFC822.SIZE BODY.PEEK[])`,
      "UID FETCH",
    );
    const mensagens: MensagemBruta[] = [];
    for (const linha of r.linhas) {
      if (!/FETCH \(/i.test(linha.texto)) continue;
      const uid = Number(linha.texto.match(/\bUID (\d+)/i)?.[1] ?? 0);
      if (!uid) continue;
      const tamanho = Number(linha.texto.match(/RFC822\.SIZE (\d+)/i)?.[1] ?? 0);
      if (tamanho > tamanhoMaximo) continue;
      const indice = Number(linha.texto.match(/BODY\[\] <<LITERAL(\d+)>>/i)?.[1] ?? -1);
      if (indice < 0 || !linha.literais[indice]) continue;
      const flags = (linha.texto.match(/FLAGS \(([^)]*)\)/i)?.[1] ?? "")
        .split(/\s+/)
        .filter(Boolean);
      mensagens.push({ uid, flags, tamanho, bruto: linha.literais[indice] });
    }
    return mensagens;
  }

  async marcarLida(uid: number, lida = true): Promise<void> {
    const operacao = lida ? "+FLAGS" : "-FLAGS";
    await this.exigirOk(`UID STORE ${uid} ${operacao} (\\Seen)`, "UID STORE");
  }

  /** Grava uma mensagem numa pasta — é assim que o envio aparece nos Enviados. */
  async append(pasta: string, bruto: Uint8Array, flags: string[] = ["\\Seen"]): Promise<void> {
    const listaFlags = flags.length ? `(${flags.join(" ")}) ` : "";
    await this.exigirOk(
      `APPEND ${citar(pasta)} ${listaFlags}{${bruto.length}}`,
      "APPEND",
      async () => {
        await this.conn.write(bruto);
        await this.enviarBruto("\r\n");
      },
    );
  }

  /** MOVE quando o servidor tem a extensão; senão COPY + \Deleted + EXPUNGE. */
  async mover(uid: number, destino: string): Promise<void> {
    if (this.temCapacidade("MOVE")) {
      await this.exigirOk(`UID MOVE ${uid} ${citar(destino)}`, "UID MOVE");
      return;
    }
    await this.exigirOk(`UID COPY ${uid} ${citar(destino)}`, "UID COPY");
    await this.exigirOk(`UID STORE ${uid} +FLAGS (\\Deleted)`, "UID STORE \\Deleted");
    await this.exigirOk(`UID EXPUNGE ${uid}`, "UID EXPUNGE").catch(async () => {
      // UIDPLUS ausente: EXPUNGE sem UID limpa a pasta toda dos \Deleted, que é
      // o comportamento padrão do IMAP e o único disponível nesse caso.
      await this.exigirOk("EXPUNGE", "EXPUNGE");
    });
  }

  async sair(): Promise<void> {
    try {
      await this.executar("LOGOUT");
    } catch {
      // LOGOUT falhando não interessa a ninguém — a conexão vai fechar de qualquer jeito.
    }
  }
}

/** Aspas do IMAP: `\` e `"` são escapados; o resto vai cru. */
export function citar(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Acha a pasta pelo flag de SPECIAL-USE, com queda para nomes usuais. */
export function acharPastaEspecial(
  pastas: Pasta[],
  flag: string,
  nomesUsuais: string[],
): string | null {
  const porFlag = pastas.find((p) =>
    p.flags.some((f) => f.toLowerCase() === flag.toLowerCase())
  );
  if (porFlag) return porFlag.nome;
  for (const nome of nomesUsuais) {
    const achada = pastas.find((p) => p.nome.toLowerCase() === nome.toLowerCase());
    if (achada) return achada.nome;
  }
  return null;
}

export const PASTAS_ENVIADOS = ["INBOX.Sent", "Sent", "INBOX.Enviados", "Enviados", "Sent Items", "INBOX.Sent Items"];
export const PASTAS_ARQUIVO = ["INBOX.Archive", "Archive", "INBOX.Arquivo", "Arquivo"];
// Lixeira e Spam são pastas PRÓPRIAS. Mandar exclusão para o Arquivo deixa o e-mail
// na caixa enquanto o sistema anuncia que excluiu — ver `destinoDaAcao` em marcacao.ts.
export const PASTAS_LIXEIRA = [
  "INBOX.Trash", "Trash", "INBOX.Lixeira", "Lixeira",
  "Deleted Items", "INBOX.Deleted Items", "Deleted Messages", "INBOX.Deleted Messages",
];
export const PASTAS_SPAM = [
  "INBOX.spam", "spam", "INBOX.Junk", "Junk", "Junk E-mail", "INBOX.Junk E-mail",
  "Lixo Eletrônico", "INBOX.Lixo Eletrônico",
];
