import { describe, expect, it } from "vitest";
import { agradHostPula, dataBR, diaBR, emBR, horaBR, planoDeLembretes } from "./podcastLembretes";
import { parametrosDoModelo, resolverVarPodcast, telefoneLegivel } from "./podcastEnvio";

/**
 * Congela a régua do guia da equipe (22/10/2026), no horário de Brasília:
 *  · nada sai antes da validação; validado ⇒ confirmação ao convidado E ao host;
 *  · lembretes só depois dos dados confirmados — convidado 7d/3d (9h), véspera (10h), dia (8h);
 *    host 15d/7d/3d (9h), véspera (10h), dia (8h);
 *  · o que já passou quando os dados foram confirmados é pulado, e cada lembrete só sai na janela dele;
 *  · o agradecimento antigo do host ("o episódio de hoje") só sai se marcado no mesmo dia.
 */
const BR = (s: string) => new Date(`${s}-03:00`); // "2026-11-05T14:00:00" em Brasília
const enviar = (p: ReturnType<typeof planoDeLembretes>) => p.filter((x) => x.acao === "enviar").map((x) => x.chave).sort();
const pular = (p: ReturnType<typeof planoDeLembretes>) => p.filter((x) => x.acao === "pular").map((x) => x.chave).sort();
const feito = (...chaves: string[]) => Object.fromEntries(chaves.map((k) => [k, { status: "enviado" }]));

// gravação quinta 05/11/2026 às 14h; o aviso do Calendly chegou na quarta 15/10 e foi validado e
// confirmado no mesmo dia
const base = {
  status: "agendado",
  inicio: BR("2026-11-05T14:00:00").toISOString(),
  agendado_em: BR("2026-10-15T15:00:00").toISOString(),
  validado_em: BR("2026-10-15T16:00:00").toISOString(),
  dados_confirmados_em: BR("2026-10-15T17:00:00").toISOString(),
  lembretes: {} as Record<string, any>,
};

describe("horário de Brasília", () => {
  it("dia, instante e formatação", () => {
    expect(diaBR(BR("2026-10-21T23:30:00"))).toBe("2026-10-21");
    expect(emBR("2026-11-05", 9, 15).toISOString()).toBe(BR("2026-10-21T09:00:00").toISOString());
    expect(emBR("2026-11-01", 10, 1).toISOString()).toBe(BR("2026-10-31T10:00:00").toISOString());
    expect(dataBR(BR("2026-10-21T14:00:00"))).toBe("quarta-feira, 21 de outubro");
    expect(horaBR(BR("2026-10-21T14:00:00"))).toBe("14h");
    expect(horaBR(BR("2026-10-21T09:30:00"))).toBe("9h30");
  });
});

describe("planoDeLembretes — validação e confirmação", () => {
  it("aviso do Calendly ainda não validado: nada sai", () => {
    const aguardando = { ...base, validado_em: null, dados_confirmados_em: null };
    expect(planoDeLembretes(aguardando, BR("2026-10-15T15:05:00"))).toEqual([]);
  });

  it("validado: confirmação ao convidado e ao host, e só elas enquanto os dados não forem confirmados", () => {
    const validado = { ...base, dados_confirmados_em: null };
    expect(enviar(planoDeLembretes(validado, BR("2026-10-15T16:01:00")))).toEqual(["grav_recebido", "host_recebido"]);
    // nem quando chega o horário de um lembrete
    const p = planoDeLembretes({ ...validado, lembretes: feito("grav_recebido", "host_recebido") }, BR("2026-10-21T09:00:00"));
    expect(p).toEqual([]);
  });
});

describe("planoDeLembretes — lembretes do guia", () => {
  const confirmados = { ...base, lembretes: feito("grav_recebido", "host_recebido") };

  it("15 dias antes, às 9h: só o host", () => {
    expect(enviar(planoDeLembretes(confirmados, BR("2026-10-21T08:59:00")))).toEqual([]);
    expect(enviar(planoDeLembretes(confirmados, BR("2026-10-21T09:00:00")))).toEqual(["host_15d"]);
  });

  it("7 dias antes, às 9h: convidado e host", () => {
    const l = { ...confirmados, lembretes: { ...confirmados.lembretes, ...feito("host_15d") } };
    expect(enviar(planoDeLembretes(l, BR("2026-10-29T09:00:00")))).toEqual(["grav_7d", "host_7d"]);
  });

  it("3 dias antes, às 9h: convidado e host (o do host leva o briefing)", () => {
    const l = { ...confirmados, lembretes: { ...confirmados.lembretes, ...feito("host_15d", "grav_7d", "host_7d") } };
    expect(enviar(planoDeLembretes(l, BR("2026-11-02T09:00:00")))).toEqual(["grav_3d", "host_3d"]);
  });

  it("véspera às 10h e no dia às 8h; depois que começou, nada", () => {
    const antes = feito("host_15d", "grav_7d", "host_7d", "grav_3d", "host_3d");
    const v = { ...confirmados, lembretes: { ...confirmados.lembretes, ...antes } };
    expect(enviar(planoDeLembretes(v, BR("2026-11-04T10:00:00")))).toEqual(["grav_1d", "host_1d"]);
    const d = { ...v, lembretes: { ...v.lembretes, ...feito("grav_1d", "host_1d") } };
    expect(enviar(planoDeLembretes(d, BR("2026-11-05T08:00:00")))).toEqual(["grav_dia", "host_dia"]);
    expect(planoDeLembretes(d, BR("2026-11-05T14:00:00"))).toEqual([]);
  });

  it("dados confirmados com 5 dias de antecedência: o de 15 e os de 7 dias são pulados", () => {
    const perto = { ...confirmados, dados_confirmados_em: BR("2026-10-31T11:00:00").toISOString() };
    const p = planoDeLembretes(perto, BR("2026-10-31T11:01:00"));
    expect(pular(p)).toEqual(["grav_7d", "host_15d", "host_7d"]);
    expect(enviar(p)).toEqual([]);
    // e o de 3 dias sai no horário dele
    const p3 = planoDeLembretes({ ...perto, lembretes: { ...perto.lembretes, ...feito("grav_7d", "host_15d", "host_7d") } }, BR("2026-11-02T09:00:00"));
    expect(enviar(p3)).toEqual(["grav_3d", "host_3d"]);
  });

  it("cron parado: o lembrete das 9h não sai fora da janela, é pulado", () => {
    const l = { ...confirmados, lembretes: { ...confirmados.lembretes, ...feito("host_15d", "grav_7d", "host_7d") } };
    const p = planoDeLembretes(l, BR("2026-11-04T11:00:00"));
    expect(pular(p)).toEqual(["grav_3d", "host_3d"]);
    expect(enviar(p)).toEqual(["grav_1d", "host_1d"]);
  });

  it("gravação às 8h30: sem o lembrete do dia (o texto diz 'Bom dia' às 8h)", () => {
    const cedo = { ...confirmados, inicio: BR("2026-11-05T08:30:00").toISOString() };
    expect(pular(planoDeLembretes(cedo, BR("2026-10-16T10:00:00")))).toEqual(["grav_dia", "host_dia"]);
  });

  it("o que já foi enviado ou pulado não volta; falha volta até a 3ª tentativa", () => {
    const l = { ...confirmados.lembretes, host_15d: { status: "falhou", tentativas: 1 } };
    expect(enviar(planoDeLembretes({ ...confirmados, lembretes: l }, BR("2026-10-21T09:20:00")))).toEqual(["host_15d"]);
    const l3 = { ...l, host_15d: { status: "falhou", tentativas: 3 } };
    expect(planoDeLembretes({ ...confirmados, lembretes: l3 }, BR("2026-10-21T09:20:00"))).toEqual([]);
  });

  it("cancelada, aguardando validação ou não compareceu: nada", () => {
    for (const status of ["cancelado", "aguardando_validacao", "nao_compareceu"]) {
      expect(planoDeLembretes({ ...confirmados, status }, BR("2026-11-04T10:00:00"))).toEqual([]);
    }
  });
});

describe("planoDeLembretes — gravado", () => {
  it("agradece convidado e host", () => {
    const g = { ...base, status: "gravado", gravado_em: BR("2026-11-05T15:10:00").toISOString() };
    expect(enviar(planoDeLembretes(g, BR("2026-11-05T15:11:00")))).toEqual(["agrad_convidado", "agrad_host"]);
  });

  it("o agradecimento ANTIGO do host ('de hoje') pula em outro dia; o do guia, não", () => {
    const inicio = BR("2026-11-05T14:00:00").toISOString();
    expect(agradHostPula("agrad_host_podcast", inicio, BR("2026-11-05T15:00:00").toISOString())).toBe(false);
    expect(agradHostPula("agrad_host_podcast", inicio, BR("2026-11-06T09:00:00").toISOString())).toBe(true);
    expect(agradHostPula("agrad_host_podcast_v2", inicio, BR("2026-11-06T09:00:00").toISOString())).toBe(false);
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

  it("lembrete_host_1d_podcast_v2 (padrão do host + sala) monta os 7 parâmetros na ordem", () => {
    const r = parametrosDoModelo({
      "1": "nome_host", "2": "nome_podcast", "3": "data_gravacao", "4": "horario_gravacao",
      "5": "convidado_episodio", "6": "telefone_convidado", "7": "link_acesso",
    }, ctx);
    expect(r.vazios).toEqual([]);
    expect(r.params.map((p) => p.text)).toEqual([
      "Carlos", "Suinocast", "quarta-feira, 21 de outubro", "14h", "Maria Lima", "(46) 99927-0638", "https://zencastr.com/x",
    ]);
  });

  it("padrão do convidado (7d/3d/véspera/dia) leva o host com o nome inteiro", () => {
    const r = parametrosDoModelo({
      "1": "nome_convidado", "2": "nome_podcast", "3": "data_gravacao", "4": "horario_gravacao", "5": "host_episodio", "6": "link_acesso",
    }, ctx);
    expect(r.params.map((p) => p.text)).toEqual(["Maria", "Suinocast", "quarta-feira, 21 de outubro", "14h", "Carlos Souza", "https://zencastr.com/x"]);
  });

  it("sem briefing: o lembrete de 3 dias do host denuncia a falta", () => {
    expect(parametrosDoModelo({ "1": "nome_host", "2": "link_briefing" }, { ...ctx, linkBriefing: null }).vazios).toEqual(["link_briefing"]);
  });

  it("telefone legível", () => {
    expect(telefoneLegivel("46 9 9927-0638")).toBe("(46) 99927-0638");
    expect(telefoneLegivel("+5546999270638")).toBe("(46) 99927-0638");
    expect(telefoneLegivel(null)).toBe("");
  });
});
