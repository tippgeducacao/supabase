import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arquivoDoEnvioPermitido, nomeDoArquivoDoEnvio } from "./arquivoDoEnvio.ts";

const EMENTAS = "https://api.ppgeducacao.site/storage/v1/object/public/ementas";

describe("arquivo do cabeçalho escolhido na ação do funil", () => {
  it("aceita só PDF do acervo público de ementas", () => {
    expect(arquivoDoEnvioPermitido(`${EMENTAS}/producao-suinos.pdf`)).toBe(`${EMENTAS}/producao-suinos.pdf`);
    expect(arquivoDoEnvioPermitido(`  ${EMENTAS}/mba-postura-comercial.pdf `)).toBe(`${EMENTAS}/mba-postura-comercial.pdf`);
  });

  it.each([
    "https://externo.example/storage/v1/object/public/ementas/x.pdf",
    "http://api.ppgeducacao.site/storage/v1/object/public/ementas/x.pdf",
    "https://api.ppgeducacao.site/storage/v1/object/sign/ementas/x.pdf?token=abc",
    "https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/x.pdf",
    "https://api.ppgeducacao.site/storage/v1/object/public/ementas/pasta/x.pdf",
    "https://api.ppgeducacao.site/storage/v1/object/public/ementas/../gt-doc-assets/x.pdf",
    "https://api.ppgeducacao.site/storage/v1/object/public/ementas/x.pdf?download=1",
    "https://api.ppgeducacao.site/storage/v1/object/public/ementas/x.exe",
    "https://api.ppgeducacao.site.golpe.example/storage/v1/object/public/ementas/x.pdf",
    "", null, undefined, 42,
  ])("recusa %s", (url) => {
    expect(arquivoDoEnvioPermitido(url)).toBeNull();
  });

  it("a base pública do ambiente também vale, mas uma base torta não abre a régua", () => {
    expect(arquivoDoEnvioPermitido("https://api.outro.example/storage/v1/object/public/ementas/x.pdf", ["https://api.outro.example/"]))
      .toBe("https://api.outro.example/storage/v1/object/public/ementas/x.pdf");
    for (const base of ["", null, undefined, "sintetico", "https://", "javascript:alert(1)", "https://a.example/caminho"]) {
      expect(arquivoDoEnvioPermitido("https://a.example/caminho/storage/v1/object/public/ementas/x.pdf", [base])).toBeNull();
    }
  });

  it("o nome do arquivo sai sem barra nem caractere de controle, com até 120 caracteres", () => {
    expect(nomeDoArquivoDoEnvio("Cronograma - Pós em Produção de Suínos.pdf")).toBe("Cronograma - Pós em Produção de Suínos.pdf");
    expect(nomeDoArquivoDoEnvio("../../etc/passwd\u0000\n.pdf")).toBe("....etcpasswd.pdf");
    expect(nomeDoArquivoDoEnvio("a".repeat(300))?.length).toBe(120);
    expect(nomeDoArquivoDoEnvio("   ")).toBeUndefined();
    expect(nomeDoArquivoDoEnvio(null)).toBeUndefined();
  });

  it("a régua do banco é a mesma (gatilho da fila)", () => {
    const pasta = join(process.cwd(), "supabase", "migrations");
    const sql = readFileSync(join(pasta, readdirSync(pasta).find((m) => m.endsWith("_cadencia_email_v2_arquivo_so_ementas.sql"))!), "utf8");
    expect(sql).toContain("'^https://api\\.ppgeducacao\\.site/storage/v1/object/public/ementas/[A-Za-z0-9._-]{1,150}\\.pdf$'");
    expect(sql).toContain("if public.crm_cadencia_email__arquivo_permitido(v_url) then");
    expect(sql).toContain("'header_media_format', 'DOCUMENT'");
    expect(sql).not.toMatch(/if v_url ~ '\^https:\/\/\[\^/);
    // rascunho de outro funil e webhook desligada não decidem o número do toque
    expect(sql).toContain("and (a.ativa or a.funil_id is not distinct from p_funil)");
    expect(sql).toContain("where w.ativa");
  });
});
