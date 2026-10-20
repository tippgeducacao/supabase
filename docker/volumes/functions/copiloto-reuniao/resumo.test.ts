import { describe, expect, it } from "vitest";
import { linhaDaMensagem, montarConversa, montarEntradaResumo, PROMPT_RESUMO } from "./resumo";

const em = (iso: string) => ({ created_at: iso });

describe("linhaDaMensagem", () => {
  it("texto do lead e da PPGVET, com data e hora de Brasília", () => {
    expect(linhaDaMensagem({ ...em("2026-10-10T13:05:00Z"), direcao: "inbound", tipo: "text", conteudo: "Tenho interesse na pós" }))
      .toBe("[10/10 10:05] Lead: Tenho interesse na pós");
    expect(linhaDaMensagem({ ...em("2026-10-10T13:06:00Z"), direcao: "outbound", tipo: "text", conteudo: "Oi! Você trabalha com o quê?" }))
      .toBe("[10/10 10:06] PPGVET: Oi! Você trabalha com o quê?");
  });

  it("áudio usa a transcrição guardada (da mensagem ou a do SDR)", () => {
    expect(linhaDaMensagem({ ...em("2026-10-10T13:07:00Z"), direcao: "inbound", tipo: "audio", conteudo: "[Áudio]", audio: "trabalho numa cooperativa" }))
      .toBe("[10/10 10:07] Lead (áudio): trabalho numa cooperativa");
    expect(linhaDaMensagem({ ...em("2026-10-10T13:08:00Z"), direcao: "outbound", tipo: "audio", conteudo: "", audio_sdr: "te mando o cronograma" }))
      .toBe("[10/10 10:08] PPGVET (áudio): te mando o cronograma");
  });

  it("áudio sem transcrição some; figurinha e documento só registram que aconteceram", () => {
    expect(linhaDaMensagem({ ...em("2026-10-10T13:09:00Z"), direcao: "inbound", tipo: "audio", conteudo: "[Áudio]" })).toBeNull();
    expect(linhaDaMensagem({ ...em("2026-10-10T13:10:00Z"), direcao: "outbound", tipo: "document", conteudo: "cronograma.pdf" }))
      .toBe("[10/10 10:10] PPGVET enviou document");
  });

  it("mensagem automática aparece marcada e encurtada", () => {
    const l = linhaDaMensagem({ ...em("2026-10-10T13:11:00Z"), direcao: "outbound", tipo: "template", template_name: "novo_lead", conteudo: "x".repeat(500) });
    expect(l).toMatch(/^\[10\/10 10:11\] PPGVET \(mensagem automática "novo_lead"\): x{200}…$/);
  });
});

describe("montarConversa", () => {
  it("ordem cronológica, mesmo que o banco devolva da mais nova para a mais antiga", () => {
    const c = montarConversa([
      { ...em("2026-10-10T13:02:00Z"), direcao: "outbound", tipo: "text", conteudo: "segunda" },
      { ...em("2026-10-10T13:01:00Z"), direcao: "inbound", tipo: "text", conteudo: "primeira" },
    ]);
    expect(c.indexOf("primeira")).toBeLessThan(c.indexOf("segunda"));
  });

  it("conversa enorme: corta o começo e avisa, o fim fica", () => {
    const muitas = Array.from({ length: 200 }, (_, i) => ({
      ...em(new Date(Date.UTC(2026, 9, 1, 12, i)).toISOString()), direcao: "inbound", tipo: "text", conteudo: `${i} ${"y".repeat(400)}`,
    }));
    const c = montarConversa(muitas);
    expect(c.length).toBeLessThanOrEqual(40_100);
    expect(c.startsWith("(mensagens mais antigas omitidas)")).toBe(true);
    expect(c).toContain("Lead: 199 ");
  });
});

describe("montarEntradaResumo", () => {
  it("junta as informações da reunião, a análise da Mimosa e a conversa", () => {
    const e = montarEntradaResumo({
      contexto: "# Informações desta reunião\n## Lead\n- Nome: Ana",
      analisePreReuniao: "ICP: veterinária de clínica",
      mensagens: [{ ...em("2026-10-10T13:01:00Z"), direcao: "inbound", tipo: "text", conteudo: "quero crescer na cooperativa" }],
    });
    expect(e).toContain("- Nome: Ana");
    expect(e).toContain("## Análise pré-reunião já feita pela Mimosa\nICP: veterinária de clínica");
    expect(e).toContain("Lead: quero crescer na cooperativa");
  });

  it("sem conversa, diz que não há mensagem (o modelo não inventa uma)", () => {
    expect(montarEntradaResumo({ contexto: "x", mensagens: [] })).toContain("(nenhuma mensagem registrada)");
  });
});

describe("O que ainda não sabemos (20/10/2026)", () => {
  // Gustavo: "por que pediu para não ser notificada" não é coisa de perguntar na reunião
  it("só lacunas de carreira; logística e pagamento ficam de fora", () => {
    expect(PROMPT_RESUMO).toContain("lacunas sobre a CARREIRA");
    expect(PROMPT_RESUMO).toMatch(/notificações, aparelho, horário, pagamento\) não é lacuna de carreira/);
  });
});
