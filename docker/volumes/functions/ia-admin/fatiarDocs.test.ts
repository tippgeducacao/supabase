import { describe, expect, it } from "vitest";
// O fatiador roda no GitHub Actions (scripts/ia-admin/sincronizar-docs.mjs); o teste mora aqui
// porque o vitest só procura testes em src/ e supabase/functions/.
import { dividirEmPartes, fatiarMarkdown } from "../../../scripts/ia-admin/fatiarDocs.mjs";

describe("fatiarMarkdown", () => {
  it("corta em #, ## e ### e nomeia pela trilha de títulos", () => {
    const md = [
      "intro solta",
      "# Agendamentos",
      "texto do topo",
      "## Confirmação",
      "três toques",
      "#### detalhe (fica dentro)",
      "mais texto",
      "## Espelho",
      "### Quem herda",
      "só o comercial",
    ].join("\n");
    const s = fatiarMarkdown(md);
    expect(s.map((x: { secao: string }) => x.secao)).toEqual([
      "(início)",
      "Agendamentos",
      "Agendamentos › Confirmação",
      "Agendamentos › Espelho › Quem herda",
    ]);
    expect(s[2].conteudo).toContain("#### detalhe (fica dentro)");
    expect(s.map((x: { ordem: number }) => x.ordem)).toEqual([0, 1, 2, 3]);
  });

  it("ignora título dentro de bloco de código", () => {
    const md = ["# A", "```bash", "# comentário do shell", "```", "fim"].join("\n");
    const s = fatiarMarkdown(md);
    expect(s).toHaveLength(1);
    expect(s[0].conteudo).toContain("# comentário do shell");
  });

  it("tag do Obsidian (#ia #moc) não é título", () => {
    const s = fatiarMarkdown("# A\ntexto\n#ia #moc");
    expect(s).toHaveLength(1);
  });

  it("seção grande vira partes numeradas", () => {
    const paragrafo = "p".repeat(4000);
    const s = fatiarMarkdown(`# Grande\n${paragrafo}\n\n${paragrafo}\n\n${paragrafo}`);
    expect(s.length).toBeGreaterThan(1);
    expect(s[0].secao).toBe("Grande (parte 1)");
    for (const x of s) expect(x.conteudo.length).toBeLessThanOrEqual(6000);
  });
});

describe("dividirEmPartes", () => {
  it("parágrafo maior que o limite é cortado seco", () => {
    const partes = dividirEmPartes("x".repeat(13000), 6000);
    expect(partes.map((p: string) => p.length)).toEqual([6000, 6000, 1000]);
  });
});
