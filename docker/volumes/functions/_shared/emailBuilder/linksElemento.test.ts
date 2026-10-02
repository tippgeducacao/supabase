import { describe, expect, it } from "vitest";
import { compilarDocumento } from "./compile.ts";
import { docVazio, type Bloco } from "./types.ts";
import { envolverCliquesNoHtml, ehElementoClique, limparRotuloClique, LIMITE_ROTULO_CLIQUE, type InfoClique } from "./links.ts";

/** Registra o que o envio perguntou ao assinador: destino + elemento + rótulo. */
function espiao() {
  const chamadas: Array<{ href: string; info: InfoClique }> = [];
  const rastrear = (href: string, info: InfoClique) => {
    chamadas.push({ href, info });
    return Promise.resolve(`https://api.test/c?k=${info.elemento}&u=${encodeURIComponent(href)}`);
  };
  return { chamadas, rastrear };
}

describe("elemento e rótulo do clique, lidos do HTML no envio", () => {
  it("usa o data-elemento que o compilador põe e o texto do botão como rótulo", async () => {
    const { chamadas, rastrear } = espiao();
    await envolverCliquesNoHtml(`<a href="https://x.com/a" data-elemento="botao" style="color:#fff">Quero saber mais</a>`, rastrear);
    expect(chamadas).toEqual([{ href: "https://x.com/a", info: { elemento: "botao", rotulo: "Quero saber mais" } }]);
  });

  it("imagem dentro de link: elemento imagem e rótulo = alt", async () => {
    const { chamadas, rastrear } = espiao();
    await envolverCliquesNoHtml(`<a href="https://x.com/a" data-elemento="imagem"><img src="https://x/i.png" alt="Banner da turma" /></a>`, rastrear);
    expect(chamadas[0].info).toEqual({ elemento: "imagem", rotulo: "Banner da turma" });
  });

  it("HTML legado sem data-elemento: com <img> é imagem, sem é link", async () => {
    const { chamadas, rastrear } = espiao();
    await envolverCliquesNoHtml(`<a href="https://x.com/1"><img src="i.png" alt="Logo" /></a> <a href="https://x.com/2">Saiba mais</a>`, rastrear);
    expect(chamadas.map((c) => c.info)).toEqual([
      { elemento: "imagem", rotulo: "Logo" },
      { elemento: "link", rotulo: "Saiba mais" },
    ]);
  });

  it("data-elemento inválido é ignorado e cai na dedução", async () => {
    const { chamadas, rastrear } = espiao();
    await envolverCliquesNoHtml(`<a href="https://x.com/1" data-elemento="hack">Texto</a>`, rastrear);
    expect(chamadas[0].info.elemento).toBe("link");
  });

  it("mesmo destino em botão E imagem gera dois links rastreados distintos", async () => {
    const { chamadas, rastrear } = espiao();
    const html = `<a href="https://x.com/c" data-elemento="imagem"><img alt="Banner" src="i.png"/></a><a href="https://x.com/c" data-elemento="botao">Matricule-se</a>`;
    const saida = await envolverCliquesNoHtml(html, rastrear);
    expect(chamadas).toHaveLength(2);
    expect(saida).toContain("k=imagem");
    expect(saida).toContain("k=botao");
  });

  it("o mesmo botão repetido (mesmo destino e texto) assina uma vez só", async () => {
    const { chamadas, rastrear } = espiao();
    const a = `<a href="https://x.com/c" data-elemento="botao">Matricule-se</a>`;
    await envolverCliquesNoHtml(a + a + a, rastrear);
    expect(chamadas).toHaveLength(1);
  });

  it("rótulo longo é cortado em 80 e sem tags nem quebras de linha", async () => {
    const { chamadas, rastrear } = espiao();
    await envolverCliquesNoHtml(`<a href="https://x.com/c"><b>${"muito ".repeat(40)}</b>\n\n fim</a>`, rastrear);
    expect(chamadas[0].info.rotulo.length).toBeLessThanOrEqual(LIMITE_ROTULO_CLIQUE);
    expect(chamadas[0].info.rotulo).not.toMatch(/[<>\n]/);
  });

  it("HTML mal fechado: o rótulo de um <a> não engole o próximo", async () => {
    const { chamadas, rastrear } = espiao();
    await envolverCliquesNoHtml(`<a href="https://x.com/1">Primeiro<a href="https://x.com/2">Segundo</a>`, rastrear);
    expect(chamadas.map((c) => c.info.rotulo)).toEqual(["Primeiro", "Segundo"]);
  });

  it("assinador antigo que ignora o segundo argumento continua funcionando", async () => {
    const saida = await envolverCliquesNoHtml(`<a href="https://x.com/c">Ir</a>`, (href) => Promise.resolve(`https://api.test/c?u=${encodeURIComponent(href)}`));
    expect(saida).toContain("api.test/c?u=");
  });

  it("descadastro ignorado e mailto intocado, como antes", async () => {
    const { chamadas, rastrear } = espiao();
    const saida = await envolverCliquesNoHtml(
      `<a href="mailto:a@b.com">Fale</a><a href="https://x/functions/v1/email-descadastro?t=1">Sair</a>`, rastrear,
      (h) => h.includes("email-descadastro"));
    expect(chamadas).toEqual([]);
    expect(saida).toContain("mailto:a@b.com");
  });
});

describe("helpers", () => {
  it("ehElementoClique aceita só os quatro", () => {
    for (const v of ["botao", "link", "imagem", "video"]) expect(ehElementoClique(v)).toBe(true);
    for (const v of ["", "BOTAO", "logo", null, undefined, 3]) expect(ehElementoClique(v)).toBe(false);
  });
  it("limparRotuloClique tira tag, entidade e controle", () => {
    expect(limparRotuloClique("<b>Ol&aacute;</b>&amp; mundo\u0000\t")).toBe("Ol&aacute; & mundo");
  });
});

describe("o compilador marca cada <a> com o tipo do elemento", () => {
  const doc = (blocos: Bloco[]) => ({ ...docVazio("T"), linhas: [{ id: "l", colunas: [{ id: "c", larguraPct: 100, blocos }] }] });
  const marcas = (blocos: Bloco[]) => [...compilarDocumento(doc(blocos)).html.matchAll(/<a\b[^>]*data-elemento="([a-z]+)"/g)].map((m) => m[1]);

  it("botão, link, imagem com link e vídeo", () => {
    expect(marcas([{ id: "b1", tipo: "botao", props: { texto: "Ir", href: "https://x.com" } }])).toEqual(["botao"]);
    expect(marcas([{ id: "b2", tipo: "link", props: { texto: "Ver", href: "https://x.com" } }])).toEqual(["link"]);
    expect(marcas([{ id: "b3", tipo: "imagem-link", props: { src: "https://x/i.png", alt: "A", href: "https://x.com" } }])).toEqual(["imagem"]);
    expect(marcas([{ id: "b4", tipo: "video", props: { thumbnail: "https://x/t.jpg", href: "https://y.be/v", alt: "V" } }])).toEqual(["video", "video"]);
  });

  it("imagem sem href não vira link, logo não tem marca", () => {
    expect(marcas([{ id: "b5", tipo: "imagem", props: { src: "https://x/i.png", alt: "A" } }])).toEqual([]);
  });

  it("ponta a ponta: o HTML compilado, ao ser embrulhado, devolve o tipo certo", async () => {
    const { html } = compilarDocumento(doc([
      { id: "i", tipo: "imagem-link", props: { src: "https://x/i.png", alt: "Banner", href: "https://x.com/c" } },
      { id: "b", tipo: "botao", props: { texto: "Matricule-se", href: "https://x.com/c" } },
      { id: "l", tipo: "link", props: { texto: "Regulamento", href: "https://x.com/r" } },
    ]));
    const { chamadas, rastrear } = espiao();
    await envolverCliquesNoHtml(html, rastrear);
    expect(chamadas.map((c) => `${c.info.elemento}:${c.info.rotulo}`).sort()).toEqual(
      ["botao:Matricule-se", "imagem:Banner", "link:Regulamento"]);
  });
});
