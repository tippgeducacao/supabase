import { describe, expect, it } from "vitest";
import {
  chaveDoCliente,
  classificarVisita,
  criarLimitador,
  ehRobo,
  hostDaPpg,
  normalizarPagina,
} from "./visitaChatgpt";

const visita = (u: string, r?: string) => classificarVisita({ u, r });

describe("classificarVisita — o que é visita vinda do ChatGPT", () => {
  it("resposta do ChatGPT: o utm_source=chatgpt.com que o próprio ChatGPT acrescenta", () => {
    expect(visita("https://www.ppgvet.com.br/poa?utm_source=chatgpt.com")).toEqual({
      host: "ppgvet.com.br",
      pagina: "/poa",
      tipo: "resposta",
      via: "utm",
    });
  });

  it("anúncio do ChatGPT Ads: utm_source=openai (com ou sem o medium)", () => {
    expect(visita("https://www.ppgvet.com.br/sanidade-avicola?utm_source=openai&utm_medium=chatgpt_ads")?.tipo).toBe("anuncio");
    expect(visita("https://www.ppgvet.com.br/sanidade-avicola?utm_source=openai")?.tipo).toBe("anuncio");
  });

  it('o medium de mídia paga vira anúncio, mas "leads" NÃO é "ads"', () => {
    expect(visita("https://ppgvet.com.br/poa?utm_source=chatgpt.com&utm_medium=cpc")?.tipo).toBe("anuncio");
    expect(visita("https://ppgvet.com.br/poa?utm_source=chatgpt.com&utm_medium=paid_social")?.tipo).toBe("anuncio");
    expect(visita("https://ppgvet.com.br/poa?utm_source=chatgpt.com&utm_medium=chatgpt_ads")?.tipo).toBe("anuncio");
    expect(visita("https://ppgvet.com.br/poa?utm_source=chatgpt.com&utm_medium=leads")?.tipo).toBe("resposta");
    // o GreatPages grava "form" nas respostas
    expect(visita("https://ppgvet.com.br/poa?utm_source=chatgpt.com&utm_medium=form")?.tipo).toBe("resposta");
  });

  it("maiúscula, espaço e + no valor não escapam da marca", () => {
    expect(visita("https://ppgvet.com.br/poa?utm_source=ChatGPT.com")?.tipo).toBe("resposta");
    expect(visita("https://ppgvet.com.br/poa?utm_source=%20OpenAI")?.tipo).toBe("anuncio");
  });

  it("sem marca na URL, vir de chatgpt.com conta como resposta (via referrer)", () => {
    for (const r of ["https://chatgpt.com/", "https://chat.openai.com/c/abc", "https://sub.chatgpt.com/x"]) {
      expect(visita("https://ppgvet.com.br/poa", r)).toEqual({
        host: "ppgvet.com.br",
        pagina: "/poa",
        tipo: "resposta",
        via: "referrer",
      });
    }
  });

  it("a marca da URL vence o referrer (via = utm)", () => {
    expect(visita("https://ppgvet.com.br/poa?utm_source=chatgpt.com", "https://chatgpt.com/")?.via).toBe("utm");
  });

  it("navegação dentro do site não é visita nova (o caso real de 07/11: LP → página de obrigado)", () => {
    // a LP conta (veio do ChatGPT, ou sem referrer — o app do ChatGPT às vezes não manda)
    expect(visita("https://www.ppgvet.com.br/pos-saude-unica?utm_source=chatgpt.com", "https://chatgpt.com/")).not.toBeNull();
    expect(visita("https://www.ppgvet.com.br/pos-saude-unica?utm_source=chatgpt.com")).not.toBeNull();
    // o obrigado herda a marca na URL, mas veio da própria LP: não soma
    expect(visita("https://www.ppgvet.com.br/saude-unica-obg?utm_source=chatgpt.com", "https://www.ppgvet.com.br/pos-saude-unica?utm_source=chatgpt.com")).toBeNull();
    // referrer só com a origem (política do navegador), sem www., ou de outro site da PPG: idem
    expect(visita("https://www.ppgvet.com.br/cronograma-poa?utm_source=chatgpt.com", "https://ppgvet.com.br/")).toBeNull();
    expect(visita("https://www.ppgvet.com.br/poa?utm_source=openai", "https://escoladeespecializacao.ppgvet.com.br/x")).toBeNull();
    // referrer de outro site que não é da PPG não é navegação interna
    expect(visita("https://www.ppgvet.com.br/poa?utm_source=chatgpt.com", "https://www.bing.com/")).not.toBeNull();
  });

  it("referrer que só PARECE ChatGPT não conta", () => {
    for (const r of ["https://notchatgpt.com/", "https://evil.com/chatgpt.com", "https://chatgpt.com.evil.com/", "http://chatgpt.com/"]) {
      expect(visita("https://ppgvet.com.br/poa", r), r).toBeNull();
    }
  });

  it("outras origens e visita sem origem não contam", () => {
    expect(visita("https://ppgvet.com.br/poa?utm_source=google")).toBeNull();
    expect(visita("https://ppgvet.com.br/poa?utm_source=meta&utm_medium=cpc")).toBeNull();
    expect(visita("https://ppgvet.com.br/poa")).toBeNull();
    expect(visita("https://ppgvet.com.br/poa", "https://www.google.com/")).toBeNull();
    // o nome só no meio do valor não é marca (o banco também exige o COMEÇO)
    expect(visita("https://ppgvet.com.br/poa?utm_source=meu_chatgpt")).toBeNull();
  });

  it("só páginas da PPG: host de fora, host parecido e URL torta são ignorados", () => {
    expect(visita("https://evil.example/poa?utm_source=chatgpt.com")).toBeNull();
    expect(visita("https://ppgvet.com.br.evil.com/poa?utm_source=chatgpt.com")).toBeNull();
    expect(visita("https://notppgvet.com.br/poa?utm_source=chatgpt.com")).toBeNull();
    expect(visita("http://ppgvet.com.br/poa?utm_source=chatgpt.com")).toBeNull();
    expect(visita("javascript:alert(1)")).toBeNull();
    expect(visita("não é uma url")).toBeNull();
    expect(classificarVisita(null)).toBeNull();
    expect(classificarVisita({})).toBeNull();
    expect(classificarVisita({ u: 42 })).toBeNull();
    expect(visita(`https://ppgvet.com.br/${"a".repeat(3000)}?utm_source=chatgpt.com`)).toBeNull();
  });

  it("subdomínios da PPG contam e o www. some do host", () => {
    expect(visita("https://site.ppgvet.com.br/?utm_source=chatgpt.com")).toEqual({
      host: "site.ppgvet.com.br",
      pagina: "/",
      tipo: "resposta",
      via: "utm",
    });
    expect(visita("https://www.ppgagro.com.br/cooperativismo?utm_source=chatgpt.com")?.host).toBe("ppgagro.com.br");
    expect(visita("https://www.produtivaassessoriavet.com.br/cattle-clinic?utm_source=chatgpt.com")?.host).toBe(
      "produtivaassessoriavet.com.br",
    );
    expect(hostDaPpg("ppgvet.com.br")).toBe(true);
    expect(hostDaPpg("x.ppgeducacao.com.br")).toBe(true);
    expect(hostDaPpg("ppgvet.com")).toBe(false);
  });
});

describe("normalizarPagina — o que vai para a coluna `pagina`", () => {
  it("minúscula, sem barra no fim, sem barra dupla; a home é /", () => {
    expect(normalizarPagina("/POA/")).toBe("/poa");
    expect(normalizarPagina("//pos-3em1//")).toBe("/pos-3em1");
    expect(normalizarPagina("/")).toBe("/");
    expect(normalizarPagina("")).toBe("/");
    expect(normalizarPagina("/cronograma-poa/")).toBe("/cronograma-poa");
  });

  it("caractere fora do permitido, escape inválido e caminho enorme viram (outras)", () => {
    expect(normalizarPagina("/p%C3%A1gina")).toBe("(outras)"); // "página" tem acento: o banco não aceita
    expect(normalizarPagina("/a b")).toBe("(outras)");
    expect(normalizarPagina("/%E0%A4%A")).toBe("(outras)");
    expect(normalizarPagina(`/${"a".repeat(130)}`)).toBe("(outras)");
    expect(normalizarPagina("/<script>")).toBe("(outras)");
  });

  it("o resultado sempre passa na CHECK da tabela (`^(/[a-z0-9._/-]{0,119}|\\(outras\\))$`)", () => {
    const check = /^(\/[a-z0-9._/-]{0,119}|\(outras\))$/;
    for (const p of ["/POA/", "//x//y", "/", "", "/a.b_c-d/e", "/ç", "/a b", `/${"z".repeat(500)}`, "/%zz"]) {
      expect(normalizarPagina(p), p).toMatch(check);
    }
  });
});

describe("ehRobo", () => {
  it("robôs e ferramentas não contam", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36",
      "curl/8.4.0",
      "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0",
      "ChatGPT-User/1.0",
      "python-requests/2.31",
      "",
      null,
      undefined,
    ]) {
      expect(ehRobo(ua as string | null | undefined), String(ua)).toBe(true);
    }
  });

  it("navegador de gente passa (inclusive o do app do ChatGPT, que usa o navegador do sistema)", () => {
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    ]) {
      expect(ehRobo(ua)).toBe(false);
    }
  });
});

describe("criarLimitador", () => {
  it("deixa passar até o máximo na janela e bloqueia o excedente", () => {
    let t = 0;
    const passa = criarLimitador({ max: 3, janelaMs: 1000, agora: () => t });
    expect([passa("a"), passa("a"), passa("a"), passa("a")]).toEqual([true, true, true, false]);
    // outra chave não é afetada
    expect(passa("b")).toBe(true);
  });

  it("a janela anda: passado o tempo, volta a passar", () => {
    let t = 0;
    const passa = criarLimitador({ max: 2, janelaMs: 1000, agora: () => t });
    passa("a");
    passa("a");
    expect(passa("a")).toBe(false);
    t = 1001;
    expect(passa("a")).toBe(true);
  });
});

describe("chaveDoCliente", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  it("prefere o IP que a Cloudflare entrega, depois o x-real-ip e o primeiro do x-forwarded-for", () => {
    expect(chaveDoCliente(h({ "cf-connecting-ip": "1.1.1.1", "x-real-ip": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(chaveDoCliente(h({ "x-real-ip": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(chaveDoCliente(h({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" }))).toBe("3.3.3.3");
    expect(chaveDoCliente(h({}))).toBe("desconhecido");
  });
});
