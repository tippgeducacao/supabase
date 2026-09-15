import { describe, expect, it } from "vitest";
import { camposFonteOfertaEmailIA, exigirOfertaVigenteEmailIA, lerDecimalOfertaEmailIA, situacaoOfertaEmailIA, validarDadosOfertaEmailIA, validarOfertaEmailIA } from "./aiOferta";

const DADOS = { id: "11111111-1111-4111-8111-111111111111", curso_id: "22222222-2222-4222-8222-222222222222", nome: "Condição de setembro",
  preco_centavos: 150099, parcelas: 3, valor_parcela_centavos: 51000, desconto_pontos_base: 1000, vagas_informadas: 10,
  inicio_em: "2026-09-15T10:00:00-03:00", fim_em: "2026-09-16T10:00:00-03:00", url_destino: "https://ppgeducacao.com.br/curso", condicoes: "Condições sujeitas ao público aprovado desta campanha.", disponivel: true };
const OFERTA = { ...DADOS, revisao: 1, aprovada_por: "33333333-3333-4333-8333-333333333333", aprovada_em: "2026-09-15T12:00:00Z", revogada_em: null };

describe("oferta aprovada com valores explícitos", () => {
  it("conserva preço e parcelas diferentes, sem calcular ou arredondar condições", () => {
    const oferta = validarOfertaEmailIA(OFERTA), campos = camposFonteOfertaEmailIA(oferta);
    expect(oferta.preco_centavos).toBe(150099);
    expect(campos["Preço aprovado"]).toBe("R$ 1500,99");
    expect(campos["Parcelamento aprovado"]).toBe("3 parcelas de R$ 510,00");
    expect(campos["Desconto aprovado"]).toBe("10,00%");
    expect(JSON.stringify(campos)).not.toContain("1530");
    expect(campos["Vagas informadas pelo responsável"]).toContain("sem consulta de estoque");
  });
  it("não completa campos opcionais nem transforma validade em prazo geral", () => {
    const campos = camposFonteOfertaEmailIA(validarOfertaEmailIA({ ...OFERTA, preco_centavos: null, parcelas: null, valor_parcela_centavos: null, desconto_pontos_base: null, vagas_informadas: null }));
    expect(campos["Preço aprovado"]).toContain("Não informado");
    expect(campos["Parcelamento aprovado"]).toContain("não calcular");
    expect(campos["Limite da confirmação"]).toContain("não prazo geral de matrícula");
  });
  it.each([
    { preco_centavos: 10.5 }, { preco_centavos: -1 }, { desconto_pontos_base: 10001 }, { vagas_informadas: -2 },
    { parcelas: 2, valor_parcela_centavos: null }, { parcelas: null, valor_parcela_centavos: 900 },
    { fim_em: DADOS.inicio_em }, { inicio_em: "2026-02-30T10:00:00Z" }, { inicio_em: "2026-09-15T24:00:00Z" },
    { inicio_em: "2026-09-15T10:00" }, { url_destino: "javascript:alert(1)" }, { url_destino: "https://usuario:senha@site.test" },
    { url_destino: "https://site.test/{{preco}}" }, { curso_id: "livre" }, { aprovada_por: OFERTA.aprovada_por },
  ])("recusa entrada inconsistente ou campos de auditoria: %j", alteracao => {
    expect(() => validarDadosOfertaEmailIA({ ...DADOS, ...alteracao })).toThrow();
  });
  it("normaliza fuso preservando o instante", () => expect(validarOfertaEmailIA(OFERTA).inicio_em).toBe("2026-09-15T13:00:00.000Z"));
  it("considera início inclusivo e fim exclusivo no relógio do servidor", () => {
    const oferta = validarOfertaEmailIA(OFERTA);
    expect(situacaoOfertaEmailIA(oferta, new Date("2026-09-15T12:59:59Z"))).toBe("programada");
    expect(situacaoOfertaEmailIA(oferta, new Date("2026-09-15T13:00:00Z"))).toBe("vigente");
    expect(situacaoOfertaEmailIA(oferta, new Date("2026-09-16T13:00:00Z"))).toBe("expirada");
  });
  it("recusa revogação, indisponibilidade, zero vagas e curso divergente", () => {
    const agora = new Date("2026-09-15T14:00:00Z");
    for (const alteracao of [{ revogada_em: "2026-09-15T13:30:00Z" }, { disponivel: false }, { vagas_informadas: 0 }]) {
      expect(() => exigirOfertaVigenteEmailIA(validarOfertaEmailIA({ ...OFERTA, ...alteracao }), DADOS.curso_id, agora)).toThrow();
    }
    expect(() => exigirOfertaVigenteEmailIA(validarOfertaEmailIA(OFERTA), OFERTA.aprovada_por, agora)).toThrow("outro curso");
  });
  it("converte casas decimais sem aceitar arredondamento ou separador ambíguo", () => {
    expect(lerDecimalOfertaEmailIA("1500,99")).toBe(150099);
    expect(lerDecimalOfertaEmailIA("0.01")).toBe(1);
    expect(lerDecimalOfertaEmailIA("")).toBe(null);
    for (const valor of ["10,005", "1.500,99", "-2", "1e3", "Infinity"]) expect(() => lerDecimalOfertaEmailIA(valor)).toThrow();
  });
});
