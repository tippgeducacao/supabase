import { describe, expect, it } from "vitest";
import { assinaturaCompativel, etapaPorCampo, validarManifesto, validarProfessor } from "./arquivosValidacao";

const areas = ["Direito Animal", "Anestesiologia Veterinária", "Medicina Felina", "Clínica Geral de Cães e Gatos", "Medicina Integrativa Veterinária", "Diagnóstico por Imagem Veterinário", "Comportamento de Animais de Companhia, Silvestres e Pets Não Convencionais", "Piscicultura", "Direito Agrário", "Gestão e Cooperativas", "Nutrição de monogástricos", "Terapia intensiva veterinária", "Nutrição de cães e gatos", "Adestramento de cães"];
const etapas = Object.fromEntries(areas.map((a,i) => [a, `etapa-${i}`]));
const params = { etapaId: "NUNCA-USAR", etapaPorCampo: { campo: "Area", etapas } };
const dados = (area = areas[0]) => ({ Nome: "Candidato Sintético QA", WhatsApp: "+55 (46) 99999-1234", E_mail: "SINTETICO@example.invalid", Area: area, Subarea: "Vendas", Tema_aula: "Aula sintética", Lattes: "lattes.cnpq.br/0000000000000000", Link_aula: "https://example.invalid/aula", Ciente: true });

describe("roteamento do seletivo", () => {
  it.each(areas)("encaminha %s à etapa exata", area => {
    const d = dados(area);
    expect(validarProfessor(d, false)).toBeNull();
    expect(etapaPorCampo(params,d)).toBe(etapas[area]);
  });
  it("rejeita área desconhecida sem usar a primeira etapa", () => {
    expect(etapaPorCampo(params,{ Area: "Outra" })).toBeNull();
    expect(validarProfessor(dados("Outra"),false)?.campo).toBe("area");
    expect(etapaPorCampo(params,{})).toBeNull();
    expect(etapaPorCampo(params,{ Area: "__proto__" })).toBeNull();
  });
  it("preserva ações antigas sem mapa", () => expect(etapaPorCampo({etapaId:"antiga"},{})).toBe("antiga"));
});

describe("dados e documentos", () => {
  const regras = [{ campo: "identidade", rotulo: "Identidade", tipos: ["application/pdf"], maxBytes: 100, obrigatorio: true }];
  it("exige obrigatório, formato, tamanho finito e campo único", () => {
    const a = {campo:"identidade",tipo:"application/pdf",tamanho:10};
    expect(validarManifesto(regras,[a])).toBeNull();
    for (const entrada of [null, [], [a,a], [{...a,campo:"outro"}], [{...a,tipo:"text/html"}], [{...a,tamanho:0}], [{...a,tamanho:NaN}], [{...a,tamanho:101}]]) expect(validarManifesto(regras,entrada)).not.toBeNull();
  });
  it("confere assinatura dos bytes, não só o nome/MIME", () => {
    expect(assinaturaCompativel("application/pdf",new TextEncoder().encode("%PDF-1.7 sintético"))).toBe(true);
    expect(assinaturaCompativel("application/pdf",new TextEncoder().encode("<html>falso.pdf"))).toBe(false);
    expect(assinaturaCompativel("image/png",new Uint8Array([137,80,78,71,13,10,26,10]))).toBe(true);
    expect(assinaturaCompativel("video/mp4",new Uint8Array([0,0,0,20,102,116,121,112]))).toBe(true);
    expect(assinaturaCompativel("image/webp",new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe(true);
    expect(assinaturaCompativel("image/webp",new TextEncoder().encode("RIFF0000WAVEfmt "))).toBe(false);
  });
  it("preserva DDD 55 e normaliza DDI, espaços e e-mail", () => {
    const d = {...dados(), WhatsApp:"(55) 99999-1234"};
    expect(validarProfessor(d,false)).toBeNull();
    expect(d.WhatsApp).toBe("5555999991234");
    expect(d.E_mail).toBe("sintetico@example.invalid");
  });
  it("exige subárea apenas para Gestão", () => {
    expect(validarProfessor({...dados("Gestão e Cooperativas"), Subarea:""},false)?.campo).toBe("subarea");
    const d = dados(); validarProfessor(d,false); expect(d.Subarea).toBe("");
  });
  it("exige link ou vídeo e recusa Lattes em domínio falso", () => {
    expect(validarProfessor({...dados(), Link_aula:""},false)?.campo).toBe("link_aula");
    expect(validarProfessor({...dados(), Link_aula:""},true)).toBeNull();
    expect(validarProfessor({...dados(), Lattes:"falsolattes.cnpq.br/123"},false)?.campo).toBe("lattes");
    expect(validarProfessor({...dados(), Link_aula:"javascript:alert(1)"},false)?.campo).toBe("link_aula");
  });
});
