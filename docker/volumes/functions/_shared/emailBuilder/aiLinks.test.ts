import { describe, expect, it } from "vitest";
import { analisarDestinoLinkEmailIA, coletarDestinosEmailIA, validarRespostaLinksEmailIA, validarUrlsVerificacaoEmailIA } from "./aiLinks";
import { docVazio } from "./types";

describe("destinos que podem receber consulta de cabeçalho", () => {
  it.each([
    "", "#", "https://", "{{descadastro_url}}", "https://curso.com/{{id}}", "https://curso.com/%7B%7Bid%7D%7D", "mailto:contato@curso.com", "tel:11999999999",
    "https://curso.com/unsubscribe", "https://curso.com/descadastrar/abc", "https://curso.com/confirmar", "https://curso.com/%63onfirmar", "https://curso.com/%2563onfirmar", "https://curso.com/reset-password/abc",
    "https://curso.com/checkout", "https://track.curso.com/a", "https://curso.com/click/a", "https://curso.com/api/enroll", "https://curso.com/functions/v1/email-campaign-dispatcher", "https://bit.ly/curso",
    "https://curso.com/a?email=pessoa@exemplo.com", "https://curso.com/a?token=abc", "https://curso.com/a?url=https://outro.com", "https://curso.com/a?utm_source=email&acao=excluir", "https://curso.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://curso.com/login", "https://curso.com:444", "https://user:pass@curso.com", "https://127.0.0.1", "https://0x7f000001", "https://2130706433", "https://[::1]", "https://site.internal/", "https://localhost", "https://curso.com\\@outro.com",
  ])("não permite sondar %s", valor => expect(analisarDestinoLinkEmailIA(valor).verificavel).toBe(false));

  it.each(["https://ppgeducacao.com.br/cursos/cardio", "http://curso.com/cursos", "https://curso.com:443/oferta", "http://curso.com:80/oferta"])("aceita candidato estático %s", url => expect(analisarDestinoLinkEmailIA(url).verificavel).toBe(true));
  it("remove UTM e fragmento sem modificar o destino do documento", () => {
    const url = "https://curso.com/cardio?utm_source=email&utm_campaign=setembro#ementa";
    expect(analisarDestinoLinkEmailIA(url)).toMatchObject({ verificavel: true, urlConsulta: "https://curso.com/cardio", motivo: expect.stringContaining("UTM") });
    const doc = docVazio();
    doc.linhas = [{ id: "l1", colunas: [{ id: "c1", larguraPct: 100, blocos: [
      { id: "b1", tipo: "botao", props: { href: url, texto: "Conhecer curso" } },
      { id: "b2", tipo: "imagem-link", props: { href: url } },
      { id: "b3", tipo: "link", props: { href: "{{descadastro_url}}" } },
      { id: "b4", tipo: "html", props: { html: '<a href="https://curso.com/confirm">Confirmar</a>' } },
    ] }] }];
    const antes = JSON.stringify(doc);
    const destinos = coletarDestinosEmailIA(doc);
    expect(destinos).toHaveLength(2);
    expect(destinos[0].blocos.map(b => b.id)).toEqual(["b1", "b2"]);
    expect(destinos[1].verificavel).toBe(false);
    expect(JSON.stringify(doc)).toBe(antes);
  });
  it("limita requisição a 12 URLs diferentes", () => {
    expect(() => validarUrlsVerificacaoEmailIA([])).toThrow();
    expect(() => validarUrlsVerificacaoEmailIA(["a", "a"])).toThrow();
    expect(() => validarUrlsVerificacaoEmailIA(Array.from({ length: 13 }, (_, i) => `https://curso.com/${i}`))).toThrow();
    expect(() => validarUrlsVerificacaoEmailIA(["a".repeat(2049)])).toThrow();
  });
  it("recusa contrato antigo, resultado faltante/trocado ou sucesso sem resposta HTTP", () => {
    const url = "https://curso.com/";
    const resposta = { versao: 1, verificadoEm: "2026-09-15T12:00:00.000Z", resultados: [{ url, estado: "acessivel", mensagem: "A página respondeu.", statusHttp: 200, urlConsultada: url, urlFinal: url }] };
    expect(validarRespostaLinksEmailIA(resposta, [url])).toEqual(resposta);
    for (const invalida of [{}, { ...resposta, versao: 0 }, { ...resposta, resultados: [] }, { ...resposta, resultados: [{ ...resposta.resultados[0], url: "https://outro.com/" }] }, { ...resposta, resultados: [{ ...resposta.resultados[0], statusHttp: 404 }] }, { ...resposta, resultados: [{ ...resposta.resultados[0], urlFinal: "http://localhost/" }] }]) expect(() => validarRespostaLinksEmailIA(invalida, [url])).toThrow();
  });
});
