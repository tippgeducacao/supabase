import { describe, expect, it, vi } from "vitest";
import { tratarVerificacaoLinksEmailIA, verificarDestinoEmailIA, type RedeLinksEmailIA } from "./links";
import { criarRedeLinksEmailIA, lerCabecalhoLinksEmailIA } from "./transporteLinks";

const resposta = (status = 200, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });
const rede = (): RedeLinksEmailIA => ({ resolver: vi.fn(async () => ["93.184.216.34"]), consultar: vi.fn(async () => resposta()) });
const enc = (valor: string) => new TextEncoder().encode(valor);

describe("conferência real com rede controlada", () => {
  it("não resolve DNS nem conecta a URLs de ações ou variáveis", async () => {
    const r = rede();
    for (const url of ["https://curso.com/unsubscribe", "https://curso.com/confirm", "{{descadastro_url}}", "https://curso.com/?token=abc", "https://click.curso.com/a", "https://curso.com/functions/v1/email-send"]) expect((await verificarDestinoEmailIA(url, r)).estado).toBe("nao_verificado");
    expect(r.resolver).not.toHaveBeenCalled(); expect(r.consultar).not.toHaveBeenCalled();
  });
  it("remove parâmetros UTM da requisição e preserva o destino original", async () => {
    const r = rede(); const url = "http://curso.com/cardio?utm_source=email#ementa";
    expect(await verificarDestinoEmailIA(url, r)).toMatchObject({ url, urlConsultada: "http://curso.com/cardio", urlFinal: "http://curso.com/cardio", estado: "acessivel", statusHttp: 200 });
    expect((vi.mocked(r.consultar).mock.calls[0][0] as URL).search).toBe("");
  });
  it("confere cada redirect e mostra a página final", async () => {
    const r = rede(); r.consultar = vi.fn().mockResolvedValueOnce(resposta(301, { location: "https://novo.com/curso" })).mockResolvedValueOnce(resposta(200));
    expect(await verificarDestinoEmailIA("http://curso.com/", r)).toMatchObject({ estado: "redirecionado", urlFinal: "https://novo.com/curso", statusHttp: 200 });
    expect(r.resolver).toHaveBeenNthCalledWith(1, "curso.com"); expect(r.resolver).toHaveBeenNthCalledWith(2, "novo.com");
  });
  it.each(["https://curso.com/confirm", "https://curso.com/click", "https://curso.com/?token=abc", "http://127.0.0.1/", "https://site.internal/", "http://curso.com/sem-tls"])("não segue redirect para %s", async local => {
    const r = rede(); r.consultar = vi.fn(async () => resposta(302, { location: local }));
    expect((await verificarDestinoEmailIA("https://curso.com/", r)).estado).toBe("nao_verificado"); expect(r.consultar).toHaveBeenCalledTimes(1); expect(r.resolver).toHaveBeenCalledTimes(1);
  });
  it.each([["8.8.8.8", "::1"], ["127.0.0.1"], ["10.0.0.1"], ["169.254.169.254"], ["2001:db8::1"], []])("falha fechada com DNS não exclusivamente público %j", async (...ips) => {
    const r = rede(); r.resolver = vi.fn(async () => ips as string[]);
    expect((await verificarDestinoEmailIA("https://curso.com/", r)).estado).toBe("nao_verificado"); expect(r.consultar).not.toHaveBeenCalled();
  });
  it("bloqueia rede privada em redirect antes da conexão", async () => {
    const r = rede(); r.consultar = vi.fn(async () => resposta(302, { location: "https://novo.com/" })); r.resolver = vi.fn().mockResolvedValueOnce(["8.8.8.8"]).mockResolvedValueOnce(["192.168.1.1"]);
    expect((await verificarDestinoEmailIA("https://curso.com/", r)).estado).toBe("nao_verificado"); expect(r.consultar).toHaveBeenCalledTimes(1);
  });
  it("limita redirects e detecta ciclo", async () => {
    const r = rede(); let i = 0; r.consultar = vi.fn(async () => resposta(302, { location: `https://curso.com/pagina${++i}` }));
    expect((await verificarDestinoEmailIA("https://curso.com/", r)).mensagem).toContain("três"); expect(r.consultar).toHaveBeenCalledTimes(4);
    r.consultar = vi.fn(async () => resposta(302, { location: "https://curso.com/" }));
    expect((await verificarDestinoEmailIA("https://curso.com/", r)).mensagem).toContain("ciclo"); expect(r.consultar).toHaveBeenCalledTimes(1);
  });
  it.each([[404, "falha"], [410, "falha"], [503, "falha"], [403, "nao_verificado"], [401, "nao_verificado"], [429, "nao_verificado"], [405, "nao_verificado"], [501, "nao_verificado"]])("classifica HTTP %i sem fallback para GET", async (status, estado) => {
    const r = rede(); r.consultar = vi.fn(async () => resposta(status as number)); expect(await verificarDestinoEmailIA("https://curso.com/", r)).toMatchObject({ estado, statusHttp: status }); expect(r.consultar).toHaveBeenCalledTimes(1);
  });
  it("limita DNS lento e não conecta depois do cancelamento", async () => {
    const r = rede(); let resolver!: (ips: string[]) => void; r.resolver = vi.fn(() => new Promise(res => { resolver = res; }));
    const resultado = await verificarDestinoEmailIA("https://curso.com/", r, 5);
    expect(resultado.estado).toBe("nao_verificado"); expect(resultado.mensagem).toContain("demorou"); resolver(["8.8.8.8"]); await Promise.resolve(); expect(r.consultar).not.toHaveBeenCalled();
  });
  it("não expõe erro de DNS ou TLS", async () => {
    const r = rede(); r.consultar = vi.fn(async () => { throw new Error("TLS segredo interno 10.0.0.1"); });
    const resultado = await verificarDestinoEmailIA("https://curso.com/", r); expect(resultado.estado).toBe("nao_verificado"); expect(resultado.mensagem).not.toContain("10.0.0.1");
  });
  it("valida conta, tamanho e serviço antes da rede", async () => {
    const r = rede();
    await expect(tratarVerificacaoLinksEmailIA({ usuario_esperado: "outra", urls: ["https://curso.com/"] }, { usuarioId: "atual", rede: r })).rejects.toMatchObject({ status: 409 });
    await expect(tratarVerificacaoLinksEmailIA({ usuario_esperado: "atual", urls: [] }, { usuarioId: "atual", rede: r })).rejects.toMatchObject({ status: 400 });
    await expect(tratarVerificacaoLinksEmailIA({ usuario_esperado: "atual", urls: ["https://curso.com/"] }, { usuarioId: "atual" })).rejects.toMatchObject({ status: 503 });
    expect(r.resolver).not.toHaveBeenCalled();
  });
  it("preserva a ordem dos selecionados e limita a três conexões simultâneas", async () => {
    const r = rede(); let ativas = 0; let maximo = 0;
    r.consultar = vi.fn(async () => { ativas++; maximo = Math.max(maximo, ativas); await new Promise(resolve => setTimeout(resolve, 2)); ativas--; return resposta(); });
    const urls = Array.from({ length: 12 }, (_, i) => `https://curso.com/pagina${i}`);
    const resultado = await tratarVerificacaoLinksEmailIA({ usuario_esperado: "atual", urls }, { usuarioId: "atual", rede: r });
    expect(resultado.resultados.map(r => r.url)).toEqual(urls); expect(maximo).toBe(3); expect(resultado.versao).toBe(1);
  });
});

function denoSimulado(partes: string[]) {
  let posicao = 0;
  const pedidos: string[] = [];
  const socket = { close: vi.fn(), write: vi.fn(async (b: Uint8Array) => { pedidos.push(new TextDecoder().decode(b)); return b.length; }), read: vi.fn(async (b: Uint8Array) => { const texto = partes[posicao++]; if (texto === undefined) return null; const bytes = enc(texto); b.set(bytes); return bytes.length; }) };
  return { socket, pedidos, deno: { resolveDns: vi.fn(async () => ["8.8.8.8"]), connect: vi.fn(async () => socket), startTls: vi.fn(async () => socket) } };
}

describe("transporte HEAD com IP fixado", () => {
  it("conecta ao IP público, valida TLS pelo hostname e termina no cabeçalho", async () => {
    const { deno, socket, pedidos } = denoSimulado(["HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n", "CORPO QUE NÃO DEVE SER LIDO"]);
    const resposta = await criarRedeLinksEmailIA(deno).consultar(new URL("https://curso.com/cardio"), "93.184.216.34", new AbortController().signal);
    expect(resposta.status).toBe(200); expect(deno.connect).toHaveBeenCalledWith({ hostname: "93.184.216.34", port: 443 }); expect(deno.startTls).toHaveBeenCalledWith(socket, { hostname: "curso.com" }); expect(deno.resolveDns).not.toHaveBeenCalled();
    expect(pedidos.join("")).toContain("HEAD /cardio HTTP/1.1"); expect(pedidos.join("")).not.toMatch(/Authorization|Cookie|GET /); expect(socket.read).toHaveBeenCalledTimes(1); expect(socket.close).toHaveBeenCalled();
  });
  it("suporta HTTP e cabeçalho dividido sem TLS nem corpo", async () => {
    const { deno, socket } = denoSimulado(["HTTP/1.1 301 Moved\r\nLoca", "tion: https://curso.com/\r\n\r\n"]);
    const resposta = await criarRedeLinksEmailIA(deno).consultar(new URL("http://curso.com/"), "8.8.8.8", new AbortController().signal);
    expect(resposta.headers.get("location")).toBe("https://curso.com/"); expect(deno.connect).toHaveBeenCalledWith({ hostname: "8.8.8.8", port: 80 }); expect(deno.startTls).not.toHaveBeenCalled(); expect(socket.close).toHaveBeenCalled();
  });
  it.each(["HTTP/1.1 200 OK\r\nLocation: /a\r\nLocation: /b\r\n\r\n", "HTTP/1.1 200 OK\r\nContinua\r\n\r\n", "HTTP/1.1 100 Continue\r\n\r\n", "HTTP/1.1 200 OK\r\nX: " + "a".repeat(32768) + "\r\n\r\n"])("recusa cabeçalho ambíguo ou excessivo", texto => expect(() => lerCabecalhoLinksEmailIA(enc(texto))).toThrow());
  it("falha fechada se uma família DNS não pôde ser consultada", async () => {
    const { deno } = denoSimulado([]); deno.resolveDns = vi.fn(async (_host: string, tipo?: string) => { if (tipo === "AAAA") throw new Error("Timeout"); return ["8.8.8.8"]; });
    await expect(criarRedeLinksEmailIA(deno).resolver("curso.com")).rejects.toThrow(); expect(deno.connect).not.toHaveBeenCalled();
  });
  it("não conecta se o sinal já está cancelado", async () => {
    const { deno } = denoSimulado([]); const controle = new AbortController(); controle.abort();
    await expect(criarRedeLinksEmailIA(deno).consultar(new URL("https://curso.com/"), "8.8.8.8", controle.signal)).rejects.toThrow(); expect(deno.connect).not.toHaveBeenCalled();
  });
});
