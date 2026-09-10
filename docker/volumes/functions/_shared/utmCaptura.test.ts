import { describe, expect, it } from "vitest";
import { complementarPrimeiraAtribuicao, extrairRastreamento, podeComplementarAtribuicao } from "./utmCaptura";

describe("captura de rastreamento da chegada", () => {
  it.each(["tiktok_aviario", "linkedin_ppgvet", "whatsapp_aves", "ig_petfood"])("recupera %s com campanha e conteúdo enviados somente na URL", fonte => {
    expect(extrairRastreamento({ urls: [`https://sanidade.ppgvet.com.br/?utm_source=${fonte}&utm_medium=bio&utm_campaign=Sanidade%20Av%C3%ADcola&utm_content=video_1`] })).toEqual({
      utm_source: fonte, utm_medium: "bio", utm_campaign: "Sanidade Avícola", utm_content: "video_1",
    });
  });

  it("preserva prioridade do mapeamento/corpo sobre query/URL, preenchendo só faltantes", () => {
    expect(extrairRastreamento({
      campos: [{ utm_source: "tiktok", ttclid: "clique-no-corpo" }, { utm_source: "ignorar", utm_id: 12345 }],
      urls: ["https://ppgvet.com.br/?utm_source=linkedin&utm_content=video_2&ttclid=ignorar"],
    })).toEqual({ utm_source: "tiktok", ttclid: "clique-no-corpo", utm_id: "12345", utm_content: "video_2" });
  });

  it("ignora placeholders e aceita as grafias legadas também na URL", () => {
    expect(extrairRastreamento({
      campos: [{ utm_source: "{utm_source}", utm_campaign: "{{campaign.name}}", fbclid: "undefined" }],
      urls: ["ppgvet.com.br/?utm_source=tiktok&utm_campaing=campanha&utm_contet=video&ttclid=clique"],
    })).toEqual({ utm_source: "tiktok", utm_campaign: "campanha", utm_content: "video", ttclid: "clique" });
  });

  it("source GreatPages do corpo não bloqueia TikTok da URL e preserva nomes de campanha/conteúdo", () => {
    expect(extrairRastreamento({
      campos: [{ utm_source: "  GREATpages  ", utm_campaign: "GreatPages", utm_content: "GreatPages" }],
      urls: ["https://ppgvet.com.br/?utm_source=tiktok_aviario"],
    })).toEqual({ utm_source: "tiktok_aviario", utm_campaign: "GreatPages", utm_content: "GreatPages" });
  });

  it("source GreatPages isolado não conta como rastreamento recebido", () => {
    expect(extrairRastreamento({ campos: [{ utm_source: "GreatPages" }], urls: ["https://ppgvet.com.br/?utm_source=greatpages"] })).toEqual({});
  });

  it("URL inválida e estruturas inesperadas não derrubam a captação nem criam rastreio", () => {
    expect(extrairRastreamento({ campos: [{ utm_source: { nome: "tiktok" }, ttclid: ["clique"] }], urls: [null, {}, "https://", "sem utm"] })).toEqual({});
  });

  it("captura clique TikTok sem exigir UTM de origem", () => {
    expect(extrairRastreamento({ urls: ["https://campanha.ppgvet.com.br/?ttclid=clique123456&UTM_ID=identificador"] })).toEqual({ ttclid: "clique123456", utm_id: "identificador" });
  });

  it("preserva click ID longo e diferencia cliques com prefixo igual", () => {
    const prefixo = "x".repeat(600);
    expect(extrairRastreamento({ urls: [`https://ppgvet.com.br/?ttclid=${prefixo}1`] }).ttclid).toBe(`${prefixo}1`);
    expect(podeComplementarAtribuicao({ ttclid: `${prefixo}1` }, { ttclid: `${prefixo}2` })).toBe(false);
  });
});

describe("primeira atribuição do contato", () => {
  const primeira = { utm_source: "tiktok_aviario", utm_campaign: "sanidade", utm_content: null };

  it("preenche informação ausente compatível sem trocar o valor já gravado", () => {
    expect(complementarPrimeiraAtribuicao(primeira, { utm_source: "tiktok_aviario", utm_campaign: "sanidade", utm_content: "video_1", utm_id: "campanha_1", ttclid: "clique_1" })).toEqual({ utm_content: "video_1", utm_id: "campanha_1", ttclid: "clique_1" });
  });

  it.each([
    { utm_source: "linkedin_aviario", utm_campaign: "sanidade", utm_content: "video_2" },
    { utm_source: "tiktok_aviario", utm_campaign: "outra-campanha", utm_content: "video_2" },
    { utm_source: "tiktok_suinocast", utm_campaign: "sanidade", utm_content: "video_2" },
    { utm_content: "video_sem_identidade" },
  ])("recadastro de outra origem/campanha não completa primeiro toque (%j)", entrada => {
    expect(complementarPrimeiraAtribuicao(primeira, entrada)).toEqual({});
  });

  it("um segundo clique da mesma campanha não completa campos do primeiro", () => {
    expect(complementarPrimeiraAtribuicao({ ...primeira, ttclid: "primeiro" }, { ...primeira, ttclid: "segundo", utm_term: "grupo-novo" })).toEqual({});
  });

  it("identificadores opacos são comparados preservando maiúsculas", () => {
    expect(complementarPrimeiraAtribuicao({ ...primeira, ttclid: "ABC" }, { ...primeira, ttclid: "abc", utm_content: "video" })).toEqual({});
  });

  it("campanhas Meta de mesmo nome com IDs diferentes não misturam seus dados", () => {
    expect(podeComplementarAtribuicao({ meta_campaign_id: "123", meta_campaign_name: "Campanha" }, { meta_campaign_id: "456", meta_campaign_name: "Campanha" })).toBe(false);
  });

  it("Meta legado sem UTM não é enriquecido com atribuição TikTok", () => {
    expect(podeComplementarAtribuicao({ fonte: "METAADS" }, { utm_source: "tiktok", utm_content: "video" })).toBe(false);
  });

  it("campanha Meta antiga também protege contato sem source explícito", () => {
    expect(complementarPrimeiraAtribuicao({ fonte: "METAADS", meta_campaign_name: "primeira" }, { utm_source: "facebook", utm_campaign: "nova", utm_content: "video" })).toEqual({});
  });

  it("origem declarada de indicação não é substituída ao receber uma URL de campanha", () => {
    expect(podeComplementarAtribuicao({ fonte_referencia: "Indicação" }, { utm_source: "tiktok" })).toBe(false);
  });

  it("contato ainda sem origem aceita os sinais recebidos", () => {
    expect(complementarPrimeiraAtribuicao({ fonte: "UTM COM ERRO" }, { utm_source: "linkedin_ppgvet", utm_campaign: "sanidade" })).toEqual({ utm_source: "linkedin_ppgvet", utm_campaign: "sanidade" });
  });
});
