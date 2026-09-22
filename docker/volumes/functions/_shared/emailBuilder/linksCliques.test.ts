import { describe, expect, it, vi } from "vitest";
import { envolverCliquesNoHtml } from "./links.ts";

/** Assinador falso: o real é HMAC (envioComum.ts), que depende de Deno.env. */
const rastrear = (href: string) => Promise.resolve(`https://api.test/functions/v1/email-track-click?e=1&t=abc&u=${encodeURIComponent(href)}`);

describe("embrulhar cliques no HTML pronto", () => {
  it("embrulha link navegável e preserva o resto da tag", async () => {
    const html = `<a href="https://ppgvet.com.br/curso" target="_blank" style="color:#000">Inscrever</a>`;
    const saida = await envolverCliquesNoHtml(html, rastrear);
    expect(saida).toContain("email-track-click");
    expect(saida).toContain(encodeURIComponent("https://ppgvet.com.br/curso"));
    expect(saida).toContain(`target="_blank"`);
    expect(saida).toContain(">Inscrever</a>");
  });

  it("não toca em mailto, tel, âncora nem merge tag por resolver", async () => {
    const html = [
      `<a href="mailto:contato@ppgvet.com.br">e-mail</a>`,
      `<a href="tel:+5542999999999">telefone</a>`,
      `<a href="#topo">topo</a>`,
      `<a href="{{contato.url}}">link do contato</a>`,
    ].join("");
    expect(await envolverCliquesNoHtml(html, rastrear)).toBe(html);
  });

  it("devolve o destino com & de verdade, não com &amp;", async () => {
    // O compilador escreve `&amp;` no atributo. Sem desfazer isso, o site
    // receberia o parâmetro grudado num "amp;" e a UTM morreria na chegada.
    const visto: string[] = [];
    const html = `<a href="https://ppgvet.com.br/p?a=1&amp;utm_source=email">ver</a>`;
    const saida = await envolverCliquesNoHtml(html, (href) => { visto.push(href); return rastrear(href); });
    expect(visto).toEqual(["https://ppgvet.com.br/p?a=1&utm_source=email"]);
    // E o href reescrito volta escapado, senão o HTML fica inválido.
    expect(saida).toContain("&amp;t=abc");
    expect(saida).not.toMatch(/href="[^"]*[^m][^p]&t=abc/);
  });

  it("assina UMA vez por destino distinto, mesmo repetido em três botões", async () => {
    const assinador = vi.fn(rastrear);
    const html = Array(3).fill(`<a href="https://ppgvet.com.br/x">CTA</a>`).join("") + `<a href="https://ppgvet.com.br/y">outro</a>`;
    const saida = await envolverCliquesNoHtml(html, assinador);
    expect(assinador).toHaveBeenCalledTimes(2);
    expect(saida.match(/email-track-click/g)).toHaveLength(4);
  });

  it("respeita a lista de ignorados — o descadastro chega inteiro", async () => {
    const descadastro = "https://api.test/functions/v1/email-descadastro?e=a%40b.com&t=xyz";
    const html = `<a href="${descadastro}">Descadastrar</a><a href="https://ppgvet.com.br/">site</a>`;
    const saida = await envolverCliquesNoHtml(html, rastrear, (href) => href.includes("email-descadastro"));
    expect(saida).toContain(`href="${descadastro}"`);
    expect(saida).toContain("email-track-click");
  });

  it("HTML sem link nenhum volta idêntico, sem assinar nada", async () => {
    const assinador = vi.fn(rastrear);
    const html = "<p>Sem links por aqui.</p>";
    expect(await envolverCliquesNoHtml(html, assinador)).toBe(html);
    expect(assinador).not.toHaveBeenCalled();
  });
});
