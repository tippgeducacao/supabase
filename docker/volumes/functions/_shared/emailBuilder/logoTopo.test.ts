import { describe, expect, it } from "vitest";
import { compilarDocumento } from "./compile";
import { docVazio, type DocumentoEmail, type Linha } from "./types";
import { CAMINHO_LOGO_TOPO_EMAIL, DESTINO_LOGO_TOPO_EMAIL, ID_LINHA_LOGO_TOPO_EMAIL, blocoLogoTopoEmail, emailTemLogoTopo, garantirLogoTopoEmail, linhaLogoTopoEmail, urlLogoTopoEmail } from "./logoTopo";

const URL_PUBLICA = "https://api.exemplo.test";
const LOGO = urlLogoTopoEmail(URL_PUBLICA);
const cabecalho = (): Linha => ({
  id: "lin_cabecalho",
  colunas: [{ id: "col_cabecalho", larguraPct: 100, blocos: [{ id: "b_titulo", tipo: "texto", props: { texto: "Pós-Graduação em Avicultura" } }] }],
  corFundoExterna: "#15803d",
});
const comCabecalho = (): DocumentoEmail => ({ ...docVazio("Campanha"), linhas: [cabecalho()] });

describe("faixa do logo institucional no topo do e-mail", () => {
  it("monta a URL pública a partir da instância, sem barra dobrada", () => {
    expect(LOGO).toBe(`${URL_PUBLICA}/storage/v1/object/public/email-imagens/${CAMINHO_LOGO_TOPO_EMAIL}`);
    expect(urlLogoTopoEmail(`${URL_PUBLICA}/`)).toBe(LOGO);
  });

  it("insere a faixa ANTES do cabeçalho que a IA criou", () => {
    const doc = garantirLogoTopoEmail(comCabecalho(), LOGO);
    expect(doc.linhas.map(l => l.id)).toEqual([ID_LINHA_LOGO_TOPO_EMAIL, "lin_cabecalho"]);
    expect(doc.linhas[1]).toEqual(cabecalho());
  });

  it("não duplica quando o logo já está no e-mail", () => {
    const uma = garantirLogoTopoEmail(comCabecalho(), LOGO);
    expect(garantirLogoTopoEmail(uma, LOGO)).toBe(uma);
    // A IA pode ter colocado o mesmo arquivo em outro ponto do e-mail.
    const noRodape: DocumentoEmail = { ...comCabecalho(), linhas: [cabecalho(), {
      id: "lin_rodape", colunas: [{ id: "col_rodape", larguraPct: 100, blocos: [{ id: "b_logo_rodape", tipo: "imagem", props: { src: LOGO, alt: "PPGVET" } }] }],
    }] };
    expect(emailTemLogoTopo(noRodape, LOGO)).toBe(true);
    expect(garantirLogoTopoEmail(noRodape, LOGO)).toBe(noRodape);
  });

  it("sem URL do logo o documento segue intacto", () => {
    const doc = comCabecalho();
    expect(garantirLogoTopoEmail(doc, "")).toBe(doc);
  });

  it("uma VERSÃO ANTERIOR do arquivo conta como logo — não duplica a faixa", () => {
    // E-mail montado antes de o arquivo mudar de tamanho continua com o caminho
    // antigo. É o mesmo logo na tela de quem recebe; uma segunda faixa seria erro.
    const antigo = `${URL_PUBLICA}/storage/v1/object/public/email-imagens/institucional/logo-ppgvet.png`;
    const doc: DocumentoEmail = { ...comCabecalho(), linhas: [{
      id: "lin_topo_antigo", colunas: [{ id: "col", larguraPct: 100, blocos: [{ id: "b_antigo", tipo: "imagem", props: { src: antigo, alt: "PPGVET" } }] }],
    }, cabecalho()] };
    expect(emailTemLogoTopo(doc, LOGO)).toBe(true);
    expect(garantirLogoTopoEmail(doc, LOGO)).toBe(doc);
  });

  it("o logo leva ao site, em aba nova e sem UTM escrito à mão", () => {
    const bloco = blocoLogoTopoEmail(LOGO);
    expect(bloco.tipo).toBe("imagem-link");
    expect(bloco.props.href).toBe(DESTINO_LOGO_TOPO_EMAIL);
    expect(bloco.props.alvo).toBe("_blank");
    // UTM fixo aqui apagaria o utm_content que a campanha usa no teste A/B.
    expect(DESTINO_LOGO_TOPO_EMAIL).not.toContain("utm_");
  });

  it("compila a 180px, centralizado e com fundo branco mesmo em e-mail de fundo escuro", () => {
    const doc = garantirLogoTopoEmail({ ...comCabecalho(), globais: { ...docVazio().globais, corFundo: "#0f2e1f" } }, LOGO);
    const html = compilarDocumento(doc).html;
    const img = html.slice(html.indexOf("<img"), html.indexOf(">", html.indexOf("<img")) + 1);
    expect(img).toContain(`src="${LOGO}"`);
    expect(img).toContain('width="180"');
    expect(img).toContain('alt="PPGVET Educação"');
    expect(img).toContain("margin:0 auto");
    expect(html).toContain("background-color:#ffffff");
    expect(html).toContain(`href="${DESTINO_LOGO_TOPO_EMAIL}"`);
    // A faixa fica dentro do container: nada de sangrar na largura total da página.
    expect(linhaLogoTopoEmail(LOGO).corFundoExterna).toBeUndefined();
  });
});
