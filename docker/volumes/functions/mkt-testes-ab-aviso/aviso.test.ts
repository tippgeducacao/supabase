import { describe, expect, it } from "vitest";
import type { DetalheAb, TesteAb } from "../_shared/testeAbDetalhe.ts";
import { avisosDoDia, linkDoTeste } from "./aviso.ts";

const teste: TesteAb = {
  chave: "form-aberto", nome: "Formulário aberto", hipotese: "", situacao: "rodando", versoes: ["a", "b"], paginas: [],
  inicio: "2026-11-18", fim: null, resultado: null, pesos: { a: 0.5, b: 0.5 },
  plano: { efeito: 0.25, base: 0.079, pessoas: 4532, semanas: 10 },
};

/** Só o que a regra do aviso lê; o resto do detalhe não importa aqui. */
function detalhe(over: Partial<DetalheAb> = {}): DetalheAb {
  return {
    situacao: "pouco-dado", certeza: null, leitura: null, avisos: [],
    checagens: { divisao: { ok: true, desde: null } },
    saude: { semVersao: { leads: 10, sem: 0 }, hoje: null, semNinguemHoje: [] },
    versoes: [{ versao: "a", pessoas: 906 }, { versao: "b", pessoas: 910 }],
    ...over,
  } as unknown as DetalheAb;
}

const rodar = (d: DetalheAb, resumo = false, t = teste) => avisosDoDia([t], new Map([[t.chave, d]]), resumo, "2026-11-23");

describe("avisosDoDia", () => {
  it("pouco dado e sem problema: nada", () => {
    expect(rodar(detalhe())).toEqual([]);
  });

  it("3 checagens ok sem resposta: já pode ser lido, com a certeza em 2 casas", () => {
    const [a, ...resto] = rodar(detalhe({ situacao: "sem-resposta", certeza: 0.4567 }));
    expect(resto).toEqual([]);
    expect(a).toMatchObject({ tipo: "leitura", assinatura: "leitura", link: linkDoTeste("form-aberto") });
    expect(a.titulo).toBe('Teste A/B "Formulário aberto" já pode ser lido');
    expect(a.corpo).toContain("Certeza agora: 45,67%");
  });

  it("B ganhou: aviso de fim (e não o de leitura), com o efeito", () => {
    const avisos = rodar(detalhe({ situacao: "b-ganha", certeza: 0.95, leitura: { rel: 0.25 } as DetalheAb["leitura"] }));
    expect(avisos.map((x) => x.tipo)).toEqual(["terminou"]);
    expect(avisos[0].titulo).toBe('Teste A/B "Formulário aberto" terminou: B ganhou');
    expect(avisos[0].corpo).toBe("Certeza 95,00%, efeito +25,00%. Abra o teste e escolha qual versão fica.");
    expect(avisos[0].assinatura).toBe("b-ganha");
  });

  it("divisão torta e lead sem versão: um aviso por problema, com chave estável", () => {
    const avisos = rodar(detalhe({
      situacao: "alerta",
      avisos: ["Divisão torta desde 20/11: 500 × 300 não bate com o sorteio. Parar e achar a causa antes de ler qualquer número."],
      checagens: { divisao: { ok: false, desde: "2026-11-20" } } as DetalheAb["checagens"],
      saude: { semVersao: { leads: 40, sem: 4 }, hoje: null, semNinguemHoje: [] },
    }));
    expect(avisos.map((x) => [x.tipo, x.assinatura])).toEqual([["problema", "divisao:2026-11-20"], ["problema", "sem-versao"]]);
    expect(avisos[1].corpo).toBe("Leads sem versão: 10,00% (4 de 40). Não leia o resultado até achar a causa.");
  });

  it("resumo: só quando pedido, com o % do plano", () => {
    const [r] = rodar(detalhe(), true);
    expect(r).toMatchObject({ tipo: "resumo", assinatura: "2026-11-23", titulo: 'Teste A/B "Formulário aberto": resumo da semana' });
    expect(r.corpo).toBe("906 × 910 pessoas por versão (19,99% do plano) · Pouco dado ainda.");
  });

  it("teste encerrado não avisa", () => {
    expect(rodar(detalhe({ situacao: "b-ganha" }), true, { ...teste, situacao: "encerrado" })).toEqual([]);
  });
});
