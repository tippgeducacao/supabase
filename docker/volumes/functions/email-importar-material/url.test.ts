import { describe, expect, it, vi } from "vitest";
import { extrairTextoHtmlEmailIA, importarUrlMaterialEmailIA, ipPublicoMaterialEmailIA, validarUrlMaterialEmailIA, type RedeMaterialEmailIA } from "./url";
import { criarRedeMaterialEmailIA, lerRespostaHttpMaterialEmailIA } from "./transporte";
const enc = (s: string) => new TextEncoder().encode(s);
const pagina = (texto = "Conteúdo público com informações do curso.") => ({ status: 200, headers: new Headers({ "content-type": "text/html; charset=utf-8" }), corpo: enc(`<main><h1>Curso</h1><p>${texto}</p></main>`) });
const rede = (): RedeMaterialEmailIA => ({ resolver: vi.fn(async () => ["93.184.216.34"]), baixar: vi.fn(async () => pagina()) });

describe("importação de página pública", () => {
  it.each(["http://curso.com", "https://localhost", "https://site.local/", "https://metadata.internal/", "https://127.0.0.1", "https://0x7f000001", "https://2130706433", "https://[::1]", "https://user:pass@curso.com", "https://curso.com:444", "https://curso.com/#fragmento", "https://curso.com\\@privado.local"])("recusa endereço não permitido %s", url => expect(() => validarUrlMaterialEmailIA(url)).toThrow());
  it.each(["0.0.0.0", "10.2.3.4", "100.64.0.1", "127.1.2.3", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "fc00::1", "fe80::1", "::ffff:7f00:1", "2001:db8::1", "2002:7f00:1::", "2001::1", "3fff::1", "2001:0db8:0000:0000::1"])("recusa IP especial %s", ip => expect(ipPublicoMaterialEmailIA(ip)).toBe(false));
  it.each(["8.8.8.8", "93.184.216.34", "172.32.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("aceita IP global %s", ip => expect(ipPublicoMaterialEmailIA(ip)).toBe(true));
  it("não acessa nenhum IP se uma família DNS aponta para rede privada", async () => {
    const r = rede(); r.resolver = vi.fn(async () => ["93.184.216.34", "::1"]);
    await expect(importarUrlMaterialEmailIA("https://curso.com", r)).rejects.toThrow("públicos"); expect(r.baixar).not.toHaveBeenCalled();
  });
  it("valida novamente o destino de cada redirect antes de conectar", async () => {
    const r = rede(); r.baixar = vi.fn(async () => ({ status: 302, headers: new Headers({ location: "https://interno.exemplo.com/" }), corpo: enc("") }));
    r.resolver = vi.fn(async host => host.startsWith("interno") ? ["10.0.0.1"] : ["8.8.8.8"]);
    await expect(importarUrlMaterialEmailIA("https://curso.com", r)).rejects.toThrow(); expect(r.baixar).toHaveBeenCalledTimes(1);
  });
  it("entrega texto e origem final revisáveis, excluindo script/style/HTML", async () => {
    expect(extrairTextoHtmlEmailIA('<script>alert("segredo")</script><style>body{}</style><main><h1>A &amp; B</h1><p>Curso &#231; &#xE3;</p></main>')).toBe("A & B\nCurso ç ã");
    const resultado = await importarUrlMaterialEmailIA("https://curso.com/oferta", rede());
    expect(resultado).toMatchObject({ tipo: "url", origem: "https://curso.com/oferta", truncado: false }); expect(resultado.texto).toContain("Conteúdo público");
  });
  it("sinaliza truncamento e limita conteúdo a 12000 caracteres", async () => {
    const r = rede(); r.baixar = vi.fn(async () => pagina("A".repeat(15000)));
    const resultado = await importarUrlMaterialEmailIA("https://curso.com", r); expect(resultado.texto).toHaveLength(12000); expect(resultado.truncado).toBe(true);
  });
  it("aborta DNS lento e nunca inicia transporte depois do timeout", async () => {
    const r = rede(); let resolver!: (ips: string[]) => void; r.resolver = vi.fn(() => new Promise(res => { resolver = res; }));
    await expect(importarUrlMaterialEmailIA("https://curso.com", r, 5)).rejects.toThrow("15 segundos"); resolver(["8.8.8.8"]); await Promise.resolve(); expect(r.baixar).not.toHaveBeenCalled();
  });
  it("recusa PDF/JSON/login e páginas além de 2 MB", async () => {
    for (const resposta of [{ ...pagina(), status: 401 }, { ...pagina(), headers: new Headers({ "content-type": "application/pdf" }) }, { ...pagina(), corpo: new Uint8Array(2 * 1024 * 1024 + 1) }]) {
      const r = rede(); r.baixar = vi.fn(async () => resposta); await expect(importarUrlMaterialEmailIA("https://curso.com", r)).rejects.toThrow();
    }
  });
});
describe("transporte HTTPS com DNS fixado", () => {
  it("conecta ao IP aprovado e usa o hostname só no TLS/Host", async () => {
    const recebido: string[] = []; let lido = false;
    const socket = { close: vi.fn(), write: vi.fn(async (b: Uint8Array) => { recebido.push(new TextDecoder().decode(b)); return b.length; }), read: vi.fn(async (b: Uint8Array) => { if (lido) return null; lido = true; const bytes = enc("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nOi!!"); b.set(bytes); return bytes.length; }) };
    const deno = { resolveDns: vi.fn(async () => ["8.8.8.8"]), connect: vi.fn(async () => socket), startTls: vi.fn(async () => socket) };
    await criarRedeMaterialEmailIA(deno).baixar(new URL("https://curso.com/a?q=1"), "93.184.216.34", new AbortController().signal);
    expect(deno.connect).toHaveBeenCalledWith({ hostname: "93.184.216.34", port: 443 }); expect(deno.startTls).toHaveBeenCalledWith(socket, { hostname: "curso.com" }); expect(deno.resolveDns).not.toHaveBeenCalled();
    expect(recebido.join("")).toContain("Host: curso.com"); expect(recebido.join("")).not.toContain("Authorization"); expect(socket.close).toHaveBeenCalled();
  });
  it("lê framing chunked e recusa ambiguidade, truncamento e compressão", () => {
    expect(new TextDecoder().decode(lerRespostaHttpMaterialEmailIA(enc("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nOi!!\r\n0\r\n\r\n")).corpo)).toBe("Oi!!");
    for (const cabecalho of ["Content-Length: 2", "Content-Length: 4\r\nContent-Length: 4", "Content-Encoding: gzip", "Transfer-Encoding: chunked\r\nContent-Length: 4"]) expect(() => lerRespostaHttpMaterialEmailIA(enc(`HTTP/1.1 200 OK\r\n${cabecalho}\r\n\r\nOi!!`))).toThrow();
  });
  it("falha fechada quando uma família DNS não pôde ser verificada", async () => {
    const deno = { resolveDns: vi.fn(async (_h: string, t: "A" | "AAAA") => { if (t === "AAAA") throw new Error("DNS timeout"); return ["8.8.8.8"]; }), connect: vi.fn(), startTls: vi.fn() };
    await expect(criarRedeMaterialEmailIA(deno).resolver("curso.com")).rejects.toThrow("verificar");
  });
});
