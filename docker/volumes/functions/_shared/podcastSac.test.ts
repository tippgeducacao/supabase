import { describe, expect, it } from "vitest";
import { ACOES_DE_RECUSA, acaoDoBotaoPodcast, acaoDoCliquePodcast, ehBotaoDeRecusa } from "./podcastSac";

/**
 * Tabela de botões do PDF "Processo de Podcasts PPGVET" (22/10/2026): a ação depende do rótulo E
 * do modelo de onde o clique veio (a mensagem citada).
 */
describe("acaoDoBotaoPodcast", () => {
  it("interesse e 'saber mais' valem em qualquer modelo", () => {
    expect(acaoDoBotaoPodcast("Quero saber mais", "podcast_followup_2_v3")).toBe("mais_info");
    expect(acaoDoBotaoPodcast("Vamos agendar", "podcast_convite_v2")).toBe("agenda");
    expect(acaoDoBotaoPodcast("Sim, vamos agendar", "mais_info_podcast")).toBe("agenda");
    expect(acaoDoBotaoPodcast("Tenho interesse", null)).toBe("agenda");
  });

  it("'Não tenho interesse': pedido de indicação no convite e no follow-up 1; encerramento no follow-up 2 do PDF", () => {
    expect(acaoDoBotaoPodcast("Não tenho interesse", "podcast_convite_v2")).toBe("pedido_indicacao");
    expect(acaoDoBotaoPodcast("Não tenho interesse", "podcast_followup_1_v2")).toBe("pedido_indicacao");
    expect(acaoDoBotaoPodcast("Não tenho interesse", "podcast_followup_2_v3")).toBe("encerramento");
    expect(acaoDoBotaoPodcast("Não tenho interesse", null)).toBe("pedido_indicacao");
  });

  it("'Agora não': indicação no mais_info e no agenda 2; só encerra no pedido de indicação", () => {
    expect(acaoDoBotaoPodcast("Agora não", "mais_info_podcast")).toBe("pedido_indicacao");
    expect(acaoDoBotaoPodcast("Agora não", "podcast_agenda_2_v2")).toBe("pedido_indicacao");
    expect(acaoDoBotaoPodcast("Agora não", "podcast_pedido_indicacao")).toBe("recusa");
    expect(acaoDoBotaoPodcast("Agora não", "podcast_followup_2_v2")).toBe("encerramento_6m");
  });

  it("indicação, exceção da gravação e confirmação", () => {
    expect(acaoDoBotaoPodcast("Indicar alguém", "podcast_followup_2_v3")).toBe("indicacao");
    expect(acaoDoBotaoPodcast("Quero indicar alguém", "agrad_convidado_podcast")).toBe("indicacao");
    for (const r of ["Preciso reagendar", "Tive um imprevisto", "Tenho um imprevisto", "Preciso de ajuda"]) {
      expect(acaoDoBotaoPodcast(r, "lembrete_grav_1d_podcast_v2"), r).toBe("alerta");
    }
    for (const r of ["Confirmado", "Tudo certo", "Estou pronto(a)"]) {
      expect(acaoDoBotaoPodcast(r, "lembrete_host_7d_podcast"), r).toBe("confirmou");
    }
  });

  it("o resto é com o humano (nenhuma ação automática)", () => {
    for (const r of ["Tenho uma dúvida", "Não consegui acessar", "Prefiro outro horário", "Já agendei", "Vou enviar a foto",
      "Foi ótimo!", "Gostei muito!", "Tenho um feedback", "Tenho uma sugestão", "agora não posso, só em dezembro"]) {
      expect(acaoDoBotaoPodcast(r, null), r).toBeNull();
    }
  });

  it("as quatro recusas encerram o contato; o resto não", () => {
    expect([...ACOES_DE_RECUSA].sort()).toEqual(["encerramento", "encerramento_6m", "pedido_indicacao", "recusa"]);
    expect(ACOES_DE_RECUSA.has("indicacao")).toBe(false);
  });
});

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
