import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A assinatura do link rastreado é a trava contra OPEN REDIRECT: o redirecionador
 * recebe o destino na URL e só pode obedecer ao que ele mesmo assinou no envio.
 * Por isso o teste não confere só o caminho feliz — confere o que um atacante faria:
 * trocar o destino, trocar o envio, e mandar token vazio.
 *
 * `envioComum.ts` roda em Deno; aqui só o `Deno.env.get` precisa existir.
 */
const SEGREDO = "segredo-de-teste";

beforeEach(() => {
  vi.stubGlobal("Deno", { env: { get: (k: string) => (k === "EMAIL_CLICK_SECRET" ? SEGREDO : undefined) } });
});
afterEach(() => vi.unstubAllGlobals());

async function carregar() {
  return await import("./envioComum.ts");
}

describe("assinatura do link rastreado", () => {
  it("assina e confere o par (envio, destino)", async () => {
    const { assinarCliqueEmail, conferirCliqueEmail } = await carregar();
    const token = await assinarCliqueEmail("envio-1", "https://ppgvet.com.br/curso");
    expect(token).toHaveLength(32);
    expect(await conferirCliqueEmail("envio-1", "https://ppgvet.com.br/curso", token)).toBe(true);
  });

  it("é o HMAC-SHA256 de `envio\\ndestino`, não de uma concatenação qualquer", async () => {
    // Independente da nossa implementação: o vetor sai do node:crypto.
    const { assinarCliqueEmail } = await carregar();
    const esperado = createHmac("sha256", SEGREDO).update("envio-1\nhttps://ppgvet.com.br/").digest("hex").slice(0, 32);
    expect(await assinarCliqueEmail("envio-1", "https://ppgvet.com.br/")).toBe(esperado);
  });

  it("token de outro destino NÃO abre o redirecionador", async () => {
    const { assinarCliqueEmail, conferirCliqueEmail } = await carregar();
    const token = await assinarCliqueEmail("envio-1", "https://ppgvet.com.br/curso");
    expect(await conferirCliqueEmail("envio-1", "https://site-de-golpe.test", token)).toBe(false);
  });

  it("token de outro envio não credita clique no envio alheio", async () => {
    const { assinarCliqueEmail, conferirCliqueEmail } = await carregar();
    const token = await assinarCliqueEmail("envio-1", "https://ppgvet.com.br/curso");
    expect(await conferirCliqueEmail("envio-2", "https://ppgvet.com.br/curso", token)).toBe(false);
  });

  it("token vazio ou truncado é recusado", async () => {
    const { assinarCliqueEmail, conferirCliqueEmail } = await carregar();
    const token = await assinarCliqueEmail("envio-1", "https://ppgvet.com.br/curso");
    expect(await conferirCliqueEmail("envio-1", "https://ppgvet.com.br/curso", "")).toBe(false);
    expect(await conferirCliqueEmail("envio-1", "https://ppgvet.com.br/curso", token.slice(0, 16))).toBe(false);
  });

  it("id encodado: (envio, quebra+url) nao colide com (envio+quebra, url)", async () => {
    // Sem encodar o id, as duas mensagens seriam a MESMA string e a mesma
    // assinatura — um token serviria para os dois pares.
    const { assinarCliqueEmail } = await carregar();
    const quebra = String.fromCharCode(10);
    const a = await assinarCliqueEmail("envio", `1${quebra}https://x.test`);
    const b = await assinarCliqueEmail(`envio${quebra}1`, "https://x.test");
    expect(a).not.toBe(b);
  });

  it("o link montado leva envio, token e destino escapado", async () => {
    const { linkCliqueEmail, assinarCliqueEmail } = await carregar();
    const destino = "https://ppgvet.com.br/p?a=1&b=2";
    const link = await linkCliqueEmail("https://api.test", "envio-1", destino);
    const url = new URL(link);
    expect(url.pathname).toBe("/functions/v1/email-track-click");
    expect(url.searchParams.get("e")).toBe("envio-1");
    expect(url.searchParams.get("u")).toBe(destino);
    expect(url.searchParams.get("t")).toBe(await assinarCliqueEmail("envio-1", destino));
  });
});
