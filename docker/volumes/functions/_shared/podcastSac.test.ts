import { describe, expect, it } from "vitest";
import { acaoDoCliquePodcast, ehBotaoDeRecusa } from "./podcastSac";

/**
 * O clique em "Agora não" encerra o convite de podcast (candidato 'recusou', convidado em
 * espera de 6 meses). Até 14/10/2026 todo clique virava "Interessado". O que se protege:
 *  · os rótulos reais dos modelos aprovados são reconhecidos, com ou sem acento;
 *  · nenhum botão de interesse/agendamento é lido como recusa — isso tiraria da régua
 *    quem quer gravar.
 */
describe("ehBotaoDeRecusa", () => {
  it("reconhece os botões de recusa dos modelos", () => {
    expect(ehBotaoDeRecusa("Agora não")).toBe(true);
    expect(ehBotaoDeRecusa("Não tenho interesse")).toBe(true);
    expect(ehBotaoDeRecusa("agora nao")).toBe(true);
    expect(ehBotaoDeRecusa("  AGORA NÃO! ")).toBe(true);
  });

  it("não confunde interesse, agendamento nem lembrete com recusa", () => {
    for (const rotulo of [
      "Tenho interesse", "Quero saber mais", "Vamos agendar", "Sim, vamos agendar", "Indicar alguém",
      "Já agendei", "Não consegui acessar", "Prefiro outro horário", "Tenho uma dúvida",
      "Confirmado", "Preciso reagendar", "Tive um imprevisto", "Escolher horário", "Falar depois",
    ]) {
      expect(ehBotaoDeRecusa(rotulo), rotulo).toBe(false);
    }
  });

  it("frase digitada não é botão", () => {
    expect(ehBotaoDeRecusa("agora não posso, mas semana que vem sim")).toBe(false);
    expect(ehBotaoDeRecusa("")).toBe(false);
    expect(ehBotaoDeRecusa(null)).toBe(false);
  });
});

/**
 * Clique que pede resposta na hora. O que se protege: cada botão dos modelos aprovados cai
 * na ação certa, e recusa/lembrete NUNCA disparam mensagem automática.
 */
describe("acaoDoCliquePodcast", () => {
  it("'Quero saber mais' pede o mais_info; interesse e agendar pedem o link", () => {
    expect(acaoDoCliquePodcast("Quero saber mais")).toBe("mais_info");
    expect(acaoDoCliquePodcast("Tenho interesse")).toBe("agenda");
    expect(acaoDoCliquePodcast("Vamos agendar")).toBe("agenda");
    expect(acaoDoCliquePodcast("Sim, vamos agendar")).toBe("agenda");
  });

  it("recusa, lembrete e agendamento já feito não respondem nada", () => {
    for (const rotulo of [
      "Agora não", "Não tenho interesse", "Indicar alguém", "Já agendei", "Não consegui acessar",
      "Prefiro outro horário", "Tenho uma dúvida", "Confirmado", "Preciso reagendar", "Tudo certo",
      "Tive um imprevisto", "Escolher horário", "Falar depois", "tenho interesse sim, mas só em dezembro",
    ]) {
      expect(acaoDoCliquePodcast(rotulo), rotulo).toBeNull();
    }
  });
});
