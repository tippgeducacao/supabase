import { describe, expect, it } from "vitest";
import { FONTES_KIT_EMAIL_IA, kitMarcaEmailIAVazio, validarKitMarcaEmailIA, validarLogoKitEmailIA } from "./aiMarca";

const URL = "https://api.exemplo.test";
describe("kit de marca do e-mail", () => {
  it("valida e normaliza um kit reutilizável com fonte compatível e logo institucional", () => {
    const kit = validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(" Marca "), logoId: "ppgvet", email: "contato@exemplo.test", ctaUrl: "https://exemplo.test/inscricao", cores: { fundoPagina: "#eee", fundo: "#fff", texto: "#123", destaque: "#ABCDEF" }, fonte: "Georgia" }, URL);
    expect(kit.nome).toBe("Marca");
    expect(kit.cores).toEqual({ fundoPagina: "#eeeeee", fundo: "#ffffff", texto: "#112233", destaque: "#abcdef" });
    expect(kit.fonte).toBe(FONTES_KIT_EMAIL_IA.find(f => f.nome === "Georgia")?.valor);
    expect(kit.logoId).toBe("ppgvet");
  });
  it("aceita logo raster publicado no bucket correto e recusa escolha ambígua", () => {
    const logoUrl = `${URL}/storage/v1/object/public/email-imagens/ia-logo.webp`;
    expect(validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), logoUrl }, URL).logoUrl).toBe(logoUrl);
    expect(() => validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), logoId: "ppgvet", logoUrl }, URL)).toThrow("somente um");
  });
  it.each([
    "https://externo.test/storage/v1/object/public/email-imagens/logo.png",
    `${URL}/storage/v1/object/public/outro-bucket/logo.png`,
    `${URL}/storage/v1/object/public/email-imagens/logo.svg`,
    `${URL}/storage/v1/object/public/email-imagens/logo.png?token=privado`,
    `${URL}/storage/v1/object/public/email-imagens/logo.png#fragmento`,
    "data:image/png;base64,AA==",
    `${URL}/storage/v1/object/public/email-imagens/%2e%2e/outro/logo.png`,
  ])("não autoriza URL arbitrária como logo: %s", valor => expect(() => validarLogoKitEmailIA(valor, URL)).toThrow());
  it.each(["javascript:alert(1)", "https://usuario:senha@exemplo.test", "https://exemplo.test/%0aSegredo", 'https://exemplo.test/"x"', "https://exemplo.test/{dado}", "tel:+551199999999999999999999999999", "mailto:contato@exemplo.test?body=mensagem"])("recusa destino incompatível com e-mail: %s", ctaUrl => {
    expect(() => validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), ctaUrl }, URL)).toThrow();
  });
  it.each(["https://exemplo.test/contato", "http://exemplo.test", "mailto:contato@exemplo.test", "tel:+5511999999999"])("aceita destino suportado pelo compilador: %s", ctaUrl => {
    expect(validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), ctaUrl }, URL).ctaUrl).toBeTruthy();
  });
  it("recusa fonte desconhecida, campos ocultos e email incompatível com mailto", () => {
    expect(() => validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), fonte: "Fonte remota" }, URL)).toThrow("compatível");
    expect(() => validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), segredo: "campo extra" }, URL)).toThrow("campos");
    expect(() => validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), email: '"contato"@exemplo.test' }, URL)).toThrow("e-mail");
    expect(() => validarKitMarcaEmailIA({ ...kitMarcaEmailIAVazio(), cores: { ...kitMarcaEmailIAVazio().cores, css: "arbitrario" } }, URL)).toThrow("cores");
  });
});
