import { ErroMaterialEmailIA, MAX_BYTES_PAGINA_EMAIL_IA, type RedeMaterialEmailIA, type RespostaPagina } from "./url.ts";
interface Socket { read(dados: Uint8Array): Promise<number | null>; write(dados: Uint8Array): Promise<number>; close(): void }
interface RedeDeno { resolveDns(host: string, tipo: "A" | "AAAA"): Promise<string[]>; connect(opcoes: { hostname: string; port: number }): Promise<Socket>; startTls(socket: Socket, opcoes: { hostname: string }): Promise<Socket> }
const MAX_CABECALHO = 32768;
const falha = () => new ErroMaterialEmailIA(422, "A página retornou uma resposta HTTP incompatível. Copie seu texto manualmente.");

/** Parser limitado de HTTP/1.1. Sem cookies, proxy, autenticação ou descompressão
 * implícita. A conexão fecha após uma resposta; não há reutilização entre hosts. */
export function lerRespostaHttpMaterialEmailIA(bytes: Uint8Array): RespostaPagina {
  const bruto = new TextDecoder("latin1").decode(bytes);
  const fim = bruto.indexOf("\r\n\r\n");
  if (fim < 0 || fim > MAX_CABECALHO) throw falha();
  const linhas = bruto.slice(0, fim).split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(linhas.shift() ?? "");
  if (!status) throw falha();
  const headers = new Headers();
  for (const linha of linhas) {
    const i = linha.indexOf(":");
    if (i < 1 || /^[ \t]/.test(linha)) throw falha();
    const nome = linha.slice(0, i).toLowerCase();
    if (headers.has(nome) && ["content-length", "transfer-encoding", "content-encoding", "location", "content-type"].includes(nome)) throw falha();
    try { headers.append(nome, linha.slice(i + 1).trim()); } catch { throw falha(); }
  }
  let corpo = bytes.slice(fim + 4);
  const codificacao = headers.get("content-encoding");
  if (codificacao && codificacao !== "identity") throw falha();
  const transferencia = headers.get("transfer-encoding");
  const tamanho = headers.get("content-length");
  if (transferencia) {
    if (transferencia.toLowerCase() !== "chunked" || tamanho) throw falha();
    const partes: Uint8Array[] = []; let inicio = 0; let total = 0;
    while (true) {
      let fimLinha = inicio;
      while (fimLinha + 1 < corpo.length && !(corpo[fimLinha] === 13 && corpo[fimLinha + 1] === 10)) fimLinha++;
      if (fimLinha - inicio > 128 || fimLinha + 1 >= corpo.length) throw falha();
      const linha = new TextDecoder().decode(corpo.slice(inicio, fimLinha));
      if (!/^[\da-f]+(?:;[^\r\n]*)?$/i.test(linha)) throw falha();
      const n = parseInt(linha, 16); inicio = fimLinha + 2;
      if (!Number.isSafeInteger(n) || total + n > MAX_BYTES_PAGINA_EMAIL_IA) throw new ErroMaterialEmailIA(413, "A página ultrapassa 2 MB.");
      if (n === 0) break;
      if (inicio + n + 2 > corpo.length || corpo[inicio + n] !== 13 || corpo[inicio + n + 1] !== 10) throw falha();
      partes.push(corpo.slice(inicio, inicio + n)); total += n; inicio += n + 2;
    }
    corpo = new Uint8Array(total); let posicao = 0;
    for (const parte of partes) { corpo.set(parte, posicao); posicao += parte.length; }
  } else if (tamanho && (!/^\d+$/.test(tamanho) || Number(tamanho) !== corpo.length)) throw falha();
  if (corpo.length > MAX_BYTES_PAGINA_EMAIL_IA) throw new ErroMaterialEmailIA(413, "A página ultrapassa 2 MB.");
  return { status: Number(status[1]), headers, corpo };
}

export function criarRedeMaterialEmailIA(deno: RedeDeno): RedeMaterialEmailIA {
  return {
    async resolver(host) {
      const respostas = await Promise.allSettled([deno.resolveDns(host, "A"), deno.resolveDns(host, "AAAA")]);
      // Só a ausência explícita de uma família é tolerada. Falha de DNS não
      // autoriza ignorar uma resposta desconhecida que poderia apontar à rede local.
      for (const resposta of respostas) if (resposta.status === "rejected" && resposta.reason?.name !== "NotFound") throw new ErroMaterialEmailIA(422, "Não foi possível verificar o endereço público da página.");
      return respostas.flatMap(r => r.status === "fulfilled" ? r.value : []);
    },
    async baixar(url, ip, signal) {
      let socket: Socket | undefined;
      const fechar = () => { try { socket?.close(); } catch { /* já fechado */ } };
      signal.addEventListener("abort", fechar, { once: true });
      try {
        if (signal.aborted) throw falha();
        socket = await deno.connect({ hostname: ip, port: 443 });
        if (signal.aborted) throw falha();
        // O DNS NÃO é consultado outra vez ao conectar. O hostname serve apenas
        // à validação do certificado e SNI: evita a janela de DNS rebinding.
        socket = await deno.startTls(socket, { hostname: url.hostname });
        if (signal.aborted) throw falha();
        const pedido = new TextEncoder().encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nUser-Agent: PPG-Educacao-Material/1.0\r\nAccept: text/html, text/plain\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
        let enviado = 0;
        while (enviado < pedido.length) { const n = await socket.write(pedido.subarray(enviado)); if (!n) throw falha(); enviado += n; }
        const partes: Uint8Array[] = []; let total = 0;
        while (true) {
          const buffer = new Uint8Array(16384); const n = await socket.read(buffer);
          if (n === null) break;
          total += n;
          // O teto também inclui framing chunked para evitar resposta de chunks
          // minúsculos sem fim. Páginas patológicas falham antes de ocupar memória.
          if (total > MAX_BYTES_PAGINA_EMAIL_IA + MAX_CABECALHO) throw new ErroMaterialEmailIA(413, "A página ultrapassa 2 MB.");
          partes.push(buffer.slice(0, n));
        }
        const bytes = new Uint8Array(total); let pos = 0;
        for (const parte of partes) { bytes.set(parte, pos); pos += parte.length; }
        return lerRespostaHttpMaterialEmailIA(bytes);
      } finally { signal.removeEventListener("abort", fechar); fechar(); }
    },
  };
}
