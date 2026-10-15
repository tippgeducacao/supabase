import { describe, expect, it } from "vitest";
import { ehExecutavel, extensaoDoArquivo, extensaoDoMime, extensaoDoNome, nomeParaDownload } from "./extensaoArquivo.ts";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("extensão do caminho no storage", () => {
  it("o caso da Monique: o pptx do professor não vira mais .bin", () => {
    expect(extensaoDoArquivo(PPTX, "AFECÇÕES RESPIRATÓRIAS VIRAIS - PÓS 2024.pptx")).toBe("pptx");
    expect(extensaoDoArquivo(PPTX, undefined)).toBe("pptx");
  });

  it("todos os tipos que estavam em .bin no SAC ganham extensão", () => {
    expect(extensaoDoArquivo(DOCX)).toBe("docx");
    expect(extensaoDoArquivo(XLSX)).toBe("xlsx");
    expect(extensaoDoArquivo("application/vnd.ms-excel.sheet.macroEnabled.12")).toBe("xlsm");
    expect(extensaoDoArquivo("application/x-zip-compressed")).toBe("zip");
    expect(extensaoDoArquivo("text/xml")).toBe("xml");
    expect(extensaoDoArquivo("application/xml")).toBe("xml");
    expect(extensaoDoArquivo("text/vcard")).toBe("vcf");
    expect(extensaoDoArquivo("text/plain")).toBe("txt");
    expect(extensaoDoArquivo("text/html")).toBe("html");
  });

  it("áudio, vídeo, imagem e PDF saem iguais ao mapa antigo do webhook", () => {
    expect(extensaoDoArquivo("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensaoDoArquivo("audio/mpeg")).toBe("mp3");
    expect(extensaoDoArquivo("audio/mp4")).toBe("m4a");
    expect(extensaoDoArquivo("audio/aac")).toBe("m4a");
    expect(extensaoDoArquivo("video/mp4")).toBe("mp4");
    expect(extensaoDoArquivo("image/jpeg")).toBe("jpg");
    expect(extensaoDoArquivo("image/png")).toBe("png");
    expect(extensaoDoArquivo("image/webp")).toBe("webp");
    expect(extensaoDoArquivo("application/pdf")).toBe("pdf");
  });

  it("o nome original manda; o mime só desempata", () => {
    expect(extensaoDoArquivo("application/octet-stream", "planilha.XLSX")).toBe("xlsx");
    expect(extensaoDoArquivo(DOCX, "Contrato")).toBe("docx");
  });

  it("sem nome útil e sem mime conhecido, sobra .bin", () => {
    expect(extensaoDoArquivo("application/octet-stream")).toBe("bin");
    expect(extensaoDoArquivo(undefined, undefined)).toBe("bin");
    expect(extensaoDoArquivo("", "")).toBe("bin");
  });

  it("os nomes sem extensão do banco caem no mime: vCard e página salva (Lattes)", () => {
    expect(extensaoDoArquivo("text/vcard", "Avivar Gerente Matrizes Dr. João Caciano e outros 64 contatos")).toBe("vcf");
    expect(extensaoDoArquivo("multipart/related", "Currículo do Sistema de Currículos Lattes (Andressa Silva Santos)")).toBe("mht");
    expect(extensaoDoArquivo("application/x-zip-compressed", "EXPORTACAO_NFSE_1790189779_XML.zip")).toBe("zip");
  });

  it("executável nunca vira extensão no bucket público", () => {
    expect(extensaoDoArquivo("application/x-msdownload", "Handy_0.9.0_x64-setup.exe")).toBe("bin");
    expect(extensaoDoArquivo("application/octet-stream", "fatura.pdf.bat")).toBe("bin");
    expect(extensaoDoArquivo("application/vnd.android.package-archive", "app.apk")).toBe("bin");
    expect(extensaoDoArquivo("application/x-msdownload", "fatura.exe.")).toBe("bin");
  });
});

describe("executável", () => {
  it("reconhece pela extensão do nome, inclusive escondida por caractere de direção", () => {
    expect(ehExecutavel("Handy_0.9.0_x64-setup.exe")).toBe(true);
    expect(ehExecutavel("script.JS")).toBe(true);
    // RLO: na tela aparece "Contratoexe.pdf"
    expect(ehExecutavel("Contrato\u202Efdp.exe")).toBe(true);
    expect(ehExecutavel("fatura.exe ")).toBe(true);
  });

  it("documento comum não é executável", () => {
    expect(ehExecutavel("AFECÇÕES RESPIRATÓRIAS VIRAIS - PÓS 2024.pptx")).toBe(false);
    expect(ehExecutavel("nota.xml")).toBe(false);
    expect(ehExecutavel(undefined)).toBe(false);
    expect(ehExecutavel("Instalador")).toBe(false);
  });
});

describe("extensão tirada do nome", () => {
  it("nome sem ponto não tem extensão (o helper antigo transformava 'Aula1' em .aula1)", () => {
    expect(extensaoDoNome("Aula1")).toBeNull();
    expect(extensaoDoNome("Slides")).toBeNull();
  });

  it("ignora ponto no começo, ponto no fim, número puro, texto longo e o .bin que nós gravávamos", () => {
    expect(extensaoDoNome(".bashrc")).toBeNull();
    expect(extensaoDoNome("relatorio.")).toBeNull();
    expect(extensaoDoNome("Relatório v1.2")).toBeNull();
    expect(extensaoDoNome("Prova 2024.2024")).toBeNull();
    expect(extensaoDoNome("arquivo.verylongext")).toBeNull();
    expect(extensaoDoNome("document.bin")).toBeNull();
    expect(extensaoDoNome("foto (1).jpg ")).toBe("jpg");
  });

  it("mime com parâmetros e em maiúsculas", () => {
    expect(extensaoDoMime("Application/PDF")).toBe("pdf");
    expect(extensaoDoMime("text/plain; charset=utf-8")).toBe("txt");
    expect(extensaoDoMime("application/octet-stream")).toBeNull();
  });
});

describe("nome para baixar", () => {
  it("mantém o nome original quando ele já tem extensão", () => {
    expect(nomeParaDownload("AFECÇÕES RESPIRATÓRIAS VIRAIS - PÓS 2024.pptx", PPTX, "document"))
      .toBe("AFECÇÕES RESPIRATÓRIAS VIRAIS - PÓS 2024.pptx");
  });

  it("completa a extensão pelo mime quando o nome não tem", () => {
    expect(nomeParaDownload("Contrato", DOCX)).toBe("Contrato.docx");
    expect(nomeParaDownload("document.bin", DOCX, "document")).toBe("document.docx");
  });

  it("sem nome, usa o tipo do anexo; sem nada, 'arquivo'", () => {
    expect(nomeParaDownload(undefined, XLSX, "document")).toBe("document.xlsx");
    expect(nomeParaDownload(null, XLSX)).toBe("arquivo.xlsx");
    expect(nomeParaDownload(null, "application/octet-stream")).toBe("arquivo");
    expect(nomeParaDownload("firmware.bin", "application/octet-stream")).toBe("firmware.bin");
  });

  it("tira barra e caractere de controle (não vira pasta nem quebra o cabeçalho)", () => {
    expect(nomeParaDownload("notas/2026\\out.pdf", "application/pdf")).toBe("notas_2026_out.pdf");
    expect(nomeParaDownload("nota\u0000fiscal\n.xml", "text/xml")).toBe("notafiscal.xml");
  });

  it("tira os invisíveis (o vCard do WhatsApp chega com U+200E) e completa pelo mime", () => {
    expect(nomeParaDownload("\u200EDr. Fulano e mais 3 contatos", "text/vcard")).toBe("Dr. Fulano e mais 3 contatos.vcf");
    expect(nomeParaDownload("Contrato\u202Efdp.exe", "application/x-msdownload")).toBe("Contratofdp.exe");
  });

  it("ponto ou espaço no fim não esconde a extensão", () => {
    expect(nomeParaDownload("Relatório. ", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("Relatório.docx");
  });
});
