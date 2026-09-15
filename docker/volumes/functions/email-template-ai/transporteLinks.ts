import { criarRedeMaterialEmailIA } from "../email-importar-material/transporte.ts";
import type { RedeLinksEmailIA } from "./links.ts";

interface Socket { read(dados: Uint8Array): Promise<number | null>; write(dados: Uint8Array): Promise<number>; close(): void }
interface RedeDenoLinks { resolveDns(host: string, tipo: "A" | "AAAA"): Promise<string[]>; connect(opcoes: { hostname: string; port: number }): Promise<Socket>; startTls(socket: Socket, opcoes: { hostname: string }): Promise<Socket> }
const MAX_CABECALHO = 32768;
const falha = () => new Error("Não foi possível ler a resposta de cabeçalho do site.");

export function lerCabecalhoLinksEmailIA(bytes: Uint8Array): { status: number; headers: Headers } {
  const bruto = new TextDecoder("latin1").decode(bytes);
  const fim = bruto.indexOf("\r\n\r\n");
  if (fim < 0 || fim > MAX_CABECALHO) throw falha();
  const linhas = bruto.slice(0, fim).split("\r\n");
  const status = /^HTTP\/1\.[01] ([2-5]\d{2})(?: |$)/.exec(linhas.shift() ?? "");
  if (!status) throw falha();
  const headers = new Headers();
  for (const linha of linhas) {
    const i = linha.indexOf(":");
    if (i < 1 || /^[ \t]/.test(linha)) throw falha();
    const nome = linha.slice(0, i).toLowerCase();
    if (headers.has(nome) && ["location", "content-length", "transfer-encoding"].includes(nome)) throw falha();
    try { headers.append(nome, linha.slice(i + 1).trim()); } catch { throw falha(); }
  }
  // Content-Length descreve o GET equivalente: HEAD corretamente não tem corpo.
  // Nunca baixa o corpo para satisfazer esse valor ou seguir framing chunked.
  return { status: Number(status[1]), headers };
}

/** Mesmo resolver conservador e fixação do IP do importador. HEAD fecha assim
 * que chegam os cabeçalhos, mesmo se o servidor indevidamente mandar um corpo. */
export function criarRedeLinksEmailIA(deno: RedeDenoLinks): RedeLinksEmailIA {
  return {
    resolver: criarRedeMaterialEmailIA(deno).resolver,
    async consultar(url, ip, signal) {
      let socket: Socket | undefined;
      const fechar = () => { try { socket?.close(); } catch { /* já fechado */ } };
      signal.addEventListener("abort", fechar, { once: true });
      try {
        if (signal.aborted || !["http:", "https:"].includes(url.protocol)) throw falha();
        socket = await deno.connect({ hostname: ip, port: url.protocol === "https:" ? 443 : 80 });
        if (signal.aborted) throw falha();
        if (url.protocol === "https:") socket = await deno.startTls(socket, { hostname: url.hostname });
        if (signal.aborted) throw falha();
        const pedido = new TextEncoder().encode(`HEAD ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nUser-Agent: PPG-Educacao-Conferencia-Links/1.0\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
        let enviado = 0;
        while (enviado < pedido.length) { const n = await socket.write(pedido.subarray(enviado)); if (!n || signal.aborted) throw falha(); enviado += n; }
        let bytes = new Uint8Array(0);
        while (true) {
          const buffer = new Uint8Array(4096);
          const n = await socket.read(buffer);
          if (n === null || n === 0 || signal.aborted) throw falha();
          const atual = new Uint8Array(bytes.length + n);
          atual.set(bytes); atual.set(buffer.subarray(0, n), bytes.length); bytes = atual;
          if (new TextDecoder("latin1").decode(bytes).includes("\r\n\r\n")) return lerCabecalhoLinksEmailIA(bytes);
          if (bytes.length > MAX_CABECALHO) throw falha();
        }
      } finally { signal.removeEventListener("abort", fechar); fechar(); }
    },
  };
}
