import { describe, expect, it } from "vitest";

import { origemDoArquivo } from "./bibliotecaArquivo";
import { MidiaInvalida, objetoDoStorage } from "./midiaRecebida";

const publico = (caminho: string, bucket = "gt-doc-assets") =>
  `https://api.ppgeducacao.site/storage/v1/object/public/${bucket}/${caminho}`;

describe("origemDoArquivo", () => {
  it("carga do Drive sai sem conferir anexo", () => {
    expect(origemDoArquivo("gt-doc-assets", "pedagogico-biblioteca/cmmv/modulo-1/aula.pdf")).toBe("carga");
  });

  it("anexo de aula precisa conferir a tag", () => {
    expect(origemDoArquivo("gt-doc-assets", "pedagogico-aulas/9b96/1794263613312-slides.pdf")).toBe("anexo");
  });

  it("o resto do bucket fica fechado", () => {
    expect(origemDoArquivo("gt-doc-assets", "tcc/aluno/termo.pdf")).toBeNull();
    expect(origemDoArquivo("gt-doc-assets", "pedagogico-bibliotecaX/arquivo.pdf")).toBeNull();
    expect(origemDoArquivo("gt-doc-assets", "pedagogico-aulas/")).toBeNull();
    expect(origemDoArquivo("gt-doc-assets", "pedagogico-biblioteca/")).toBeNull();
  });

  it("outro bucket nunca sai, mesmo com o mesmo caminho", () => {
    expect(origemDoArquivo("gt-chat-media", "pedagogico-aulas/x.pdf")).toBeNull();
    expect(origemDoArquivo("whatsapp-anexos", "pedagogico-biblioteca/x.pdf")).toBeNull();
  });
});

describe("caminho vindo do link público da biblioteca", () => {
  it("decodifica o nome e mantém o bucket", () => {
    const o = objetoDoStorage(publico("pedagogico-biblioteca/livros-didaticos/Sa%C3%BAde%20%C3%9Anica.pdf"));
    expect(o).toEqual({ bucket: "gt-doc-assets", caminho: "pedagogico-biblioteca/livros-didaticos/Saúde Única.pdf" });
    expect(origemDoArquivo(o!.bucket, o!.caminho)).toBe("carga");
  });

  it("subir de pasta para sair da área da biblioteca é recusado", () => {
    expect(() => objetoDoStorage(publico("pedagogico-biblioteca/../tcc/termo.pdf"))).toThrow(MidiaInvalida);
    expect(() => objetoDoStorage(publico("pedagogico-biblioteca/%2e%2e/tcc/termo.pdf"))).toThrow(MidiaInvalida);
  });

  it("link de fora do nosso storage não vira objeto", () => {
    expect(objetoDoStorage("https://exemplo.com/storage/v1/object/public/gt-doc-assets/pedagogico-aulas/x.pdf")).toBeNull();
  });
});
