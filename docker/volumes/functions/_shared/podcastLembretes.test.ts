import { describe, expect, it } from "vitest";
import { dataBR, diaBR, emBR, horaBR, planoDeLembretes } from "./podcastLembretes";
import { parametrosDoModelo, resolverVarPodcast, telefoneLegivel } from "./podcastEnvio";

/**
 * Congela a régua dos lembretes de gravação (decisão de 14/10/2026) — 5 dias antes às 9h,
 * véspera às 10h, no dia às 8h, no horário de Brasília. O que se protege:
 *  · cada lembrete sai na janela dele, e só nela (cron parado não manda "bom dia" à noite);
 *  · gravação marcada em cima da hora não recebe lembrete "atrasado";
 *  · o agradecimento do host ("o episódio de hoje") só sai se marcado no mesmo dia.
 */
const BR = (s: string) => new Date(`${s}-03:00`); // "2026-10-21T14:00:00" em Brasília
const enviar = (p: ReturnType<typeof planoDeLembretes>) => p.filter((x) => x.acao === "enviar").map((x) => x.chave).sort();
const pular = (p: ReturnType<typeof planoDeLembretes>) => p.filter((x) => x.acao === "pular").map((x) => x.chave).sort();

// gravação quarta 21/10/2026 às 14h, marcada na terça 13/10
const ag = { status: "agendado", inicio: BR("2026-10-21T14:00:00").toISOString(), agendado_em: BR("2026-10-13T15:00:00").toISOString(), lembretes: {} };

describe("horário de Brasília", () => {
  it("dia, instante e formatação", () => {
    expect(diaBR(BR("2026-10-21T23:30:00"))).toBe("2026-10-21");
    expect(emBR("2026-10-21", 9, 5).toISOString()).toBe(BR("2026-10-16T09:00:00").toISOString());
    expect(emBR("2026-11-01", 10, 1).toISOString()).toBe(BR("2026-10-31T10:00:00").toISOString());
    expect(dataBR(BR("2026-10-21T14:00:00"))).toBe("quarta-feira, 21 de outubro");
    expect(horaBR(BR("2026-10-21T14:00:00"))).toBe("14h");
    expect(horaBR(BR("2026-10-21T09:30:00"))).toBe("9h30");
  });
});

describe("planoDeLembretes — gravação agendada", () => {
  it("logo depois de agendar: só a confirmação", () => {
    expect(enviar(planoDeLembretes(ag, BR("2026-10-13T15:05:00")))).toEqual(["grav_recebido"]);
  });

  it("5 dias antes, a partir das 9h", () => {
    const feitos = { ...ag, lembretes: { grav_recebido: { status: "enviado" } } };
    expect(enviar(planoDeLembretes(feitos, BR("2026-10-16T08:59:00")))).toEqual([]);
    expect(enviar(planoDeLembretes(feitos, BR("2026-10-16T09:00:00")))).toEqual(["grav_5d"]);
  });

  it("véspera às 10h: convidado e host", () => {
    const feitos = { ...ag, lembretes: { grav_recebido: { status: "enviado" }, grav_5d: { status: "enviado" } } };
    expect(enviar(planoDeLembretes(feitos, BR("2026-10-20T10:00:00")))).toEqual(["grav_1d", "host_1d"]);
  });

  it("no dia às 8h: convidado e host; depois que começou, nada", () => {
    const feitos = { ...ag, lembretes: Object.fromEntries(["grav_recebido", "grav_5d", "grav_1d", "host_1d"].map((k) => [k, { status: "enviado" }])) };
    expect(enviar(planoDeLembretes(feitos, BR("2026-10-21T08:00:00")))).toEqual(["grav_dia", "host_dia"]);
    expect(planoDeLembretes(feitos, BR("2026-10-21T14:00:00"))).toEqual([]);
  });

  it("cron parado: o lembrete das 9h não sai fora da janela, é pulado", () => {
    const feitos = { ...ag, lembretes: { grav_recebido: { status: "enviado" } } };
    const p = planoDeLembretes(feitos, BR("2026-10-20T11:00:00"));
    expect(pular(p)).toContain("grav_5d");
    expect(enviar(p)).toEqual(["grav_1d", "host_1d"]);
  });

  it("marcada com 3 dias de antecedência: sem o de 5 dias", () => {
    const perto = { ...ag, agendado_em: BR("2026-10-18T16:00:00").toISOString() };
    const p = planoDeLembretes(perto, BR("2026-10-18T16:01:00"));
    expect(enviar(p)).toEqual(["grav_recebido"]);
    expect(pular(p)).toEqual(["grav_5d"]);
  });

  it("gravação às 8h30: sem o lembrete do dia (o texto diz 'Bom dia' às 8h)", () => {
    const cedo = { ...ag, inicio: BR("2026-10-21T08:30:00").toISOString() };
    expect(pular(planoDeLembretes(cedo, BR("2026-10-14T10:00:00")))).toEqual(["grav_dia", "host_dia"]);
  });

  it("o que já foi enviado ou pulado não volta; falha volta até a 3ª tentativa", () => {
    const l = {
      grav_recebido: { status: "enviado" },
      grav_5d: { status: "falhou", tentativas: 1 },
    };
    expect(enviar(planoDeLembretes({ ...ag, lembretes: l }, BR("2026-10-16T09:20:00")))).toEqual(["grav_5d"]);
    const l3 = { ...l, grav_5d: { status: "falhou", tentativas: 3 } };
    expect(planoDeLembretes({ ...ag, lembretes: l3 }, BR("2026-10-16T09:20:00"))).toEqual([]);
  });

  it("cancelada: nada", () => {
    expect(planoDeLembretes({ ...ag, status: "cancelado" }, BR("2026-10-20T10:00:00"))).toEqual([]);
  });
});

describe("planoDeLembretes — gravado", () => {
  it("marcado no dia: agradece convidado e host", () => {
    const g = { ...ag, status: "gravado", gravado_em: BR("2026-10-21T15:10:00").toISOString() };
    expect(enviar(planoDeLembretes(g, BR("2026-10-21T15:11:00")))).toEqual(["agrad_convidado", "agrad_host"]);
  });

  it("marcado no dia seguinte: só o convidado (o do host diz 'hoje')", () => {
    const g = { ...ag, status: "gravado", gravado_em: BR("2026-10-22T09:00:00").toISOString() };
    const p = planoDeLembretes(g, BR("2026-10-22T09:01:00"));
    expect(enviar(p)).toEqual(["agrad_convidado"]);
    expect(pular(p)).toEqual(["agrad_host"]);
  });
});

describe("variáveis da gravação", () => {
  const ctx = {
    nome: "Maria", podcast: "Suinocast", youtube: "",
    dataGravacao: "quarta-feira, 21 de outubro", horarioGravacao: "14h",
    host: "Carlos Souza", nomeHost: "Carlos", convidado: "Maria Lima",
    telefoneConvidado: "(46) 99927-0638", linkAcesso: "https://zencastr.com/x",
    linkBriefing: "https://docs.google.com/d/1", usuarioAcesso: "podcast@ppgvet.com",
  };

  it("nome exato ganha da heurística: telefone e host não viram o nome do convidado", () => {
    expect(resolverVarPodcast("telefone_convidado", ctx)).toBe("(46) 99927-0638");
    expect(resolverVarPodcast("nome_host", ctx)).toBe("Carlos");
    expect(resolverVarPodcast("convidado_episodio", ctx)).toBe("Maria Lima");
    expect(resolverVarPodcast("login_acesso", ctx)).toBe("podcast@ppgvet.com");
  });

  it("lembrete_host_1d_podcast monta os 8 parâmetros na ordem", () => {
    const r = parametrosDoModelo({
      "1": "nome_host", "2": "data_gravacao", "3": "horario_gravacao", "4": "convidado_episodio",
      "5": "telefone_convidado", "6": "link_briefing", "7": "link_acesso", "8": "login_acesso",
    }, ctx);
    expect(r.vazios).toEqual([]);
    expect(r.params.map((p) => p.text)).toEqual([
      "Carlos", "quarta-feira, 21 de outubro", "14h", "Maria Lima", "(46) 99927-0638",
      "https://docs.google.com/d/1", "https://zencastr.com/x", "podcast@ppgvet.com",
    ]);
  });

  it("sem briefing: o lembrete do host denuncia a falta", () => {
    expect(parametrosDoModelo({ "1": "nome_host", "2": "link_briefing" }, { ...ctx, linkBriefing: null }).vazios).toEqual(["link_briefing"]);
  });

  it("telefone legível", () => {
    expect(telefoneLegivel("46 9 9927-0638")).toBe("(46) 99927-0638");
    expect(telefoneLegivel("+5546999270638")).toBe("(46) 99927-0638");
    expect(telefoneLegivel(null)).toBe("");
  });
});
