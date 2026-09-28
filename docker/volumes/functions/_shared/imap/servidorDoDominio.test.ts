import { describe, expect, it } from "vitest";
import { compararServidores, verificarServidorDoDominio, type Resolvedor } from "./servidorDoDominio.ts";

/** O cenário real de 28/09/2026: MX no servidor novo, caixa lendo o antigo. */
const migrado: Resolvedor = {
  mx: async () => [{ exchange: "mail.ppgeducacao.com.br.", preference: 0 }],
  ipv4: async (host) => (host === "mail.ppgeducacao.com.br" ? ["143.95.219.78"] : ["50.116.87.190"]),
};

describe("compararServidores", () => {
  it("alerta quando a caixa lê um servidor sem nenhum IP em comum com o do domínio", () => {
    expect(compararServidores("br804.hostgator.com.br", ["50.116.87.190"], "mail.ppgeducacao.com.br.", ["143.95.219.78"]))
      .toEqual({
        tipo: "servidor_mudou",
        host_atual: "br804.hostgator.com.br",
        host_do_dominio: "mail.ppgeducacao.com.br",
        ips_atual: ["50.116.87.190"],
        ips_do_dominio: ["143.95.219.78"],
      });
  });

  it("mesmo servidor com nome diferente (um IP em comum) não é alerta", () => {
    expect(compararServidores("br804.hostgator.com.br", ["50.116.87.190"], "mail.x.com.br", ["50.116.87.190", "1.2.3.4"])).toBeNull();
  });

  it("mesmo nome não é alerta, nem precisa de IP", () => {
    expect(compararServidores("Mail.X.com.br", [], "mail.x.com.br.", [])).toBeNull();
  });

  it("sem IP de um dos lados é inconclusivo, nunca alerta", () => {
    expect(compararServidores("a.com", [], "b.com", ["1.1.1.1"])).toBeNull();
    expect(compararServidores("a.com", ["1.1.1.1"], "b.com", [])).toBeNull();
  });
});

describe("verificarServidorDoDominio", () => {
  it("acha o caso da migração do cPanel", async () => {
    const alerta = await verificarServidorDoDominio("marketing@ppgeducacao.com.br", "br804.hostgator.com.br", migrado);
    expect(alerta?.host_do_dominio).toBe("mail.ppgeducacao.com.br");
  });

  it("depois de editar para o host do domínio, o alerta some", async () => {
    expect(await verificarServidorDoDominio("marketing@ppgeducacao.com.br", "mail.ppgeducacao.com.br", migrado)).toBeNull();
  });

  it("usa o MX de MENOR preferência", async () => {
    const r: Resolvedor = {
      mx: async () => [{ exchange: "backup.x.com", preference: 20 }, { exchange: "mx.x.com", preference: 10 }],
      ipv4: async (h) => (h === "mx.x.com" ? ["9.9.9.9"] : h === "backup.x.com" ? ["8.8.8.8"] : ["7.7.7.7"]),
    };
    expect((await verificarServidorDoDominio("a@x.com", "imap.x.com", r))?.host_do_dominio).toBe("mx.x.com");
  });

  it("DNS fora do ar, domínio sem MX ou demora = inconclusivo (null)", async () => {
    const quebrado: Resolvedor = { mx: async () => { throw new Error("SERVFAIL"); }, ipv4: async () => [] };
    const semMx: Resolvedor = { mx: async () => [], ipv4: async () => ["1.1.1.1"] };
    const lento: Resolvedor = { mx: () => new Promise(() => {}), ipv4: async () => [] };
    expect(await verificarServidorDoDominio("a@x.com", "imap.x.com", quebrado)).toBeNull();
    expect(await verificarServidorDoDominio("a@x.com", "imap.x.com", semMx)).toBeNull();
    expect(await verificarServidorDoDominio("a@x.com", "imap.x.com", lento, 20)).toBeNull();
  });

  it("e-mail sem domínio não consulta nada", async () => {
    expect(await verificarServidorDoDominio("sem-arroba", "imap.x.com", migrado)).toBeNull();
  });
});
