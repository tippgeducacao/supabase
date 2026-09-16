import { describe, expect, it } from "vitest";
import { AGENTE_AULA, estadoDaAula, montarVarsAula, quandoOcorre, type AulaParaPrompt } from "./prompts-aula.ts";
import { INSTRUCAO_ELEGIBILIDADE } from "./instrucaoElegibilidade.ts";

const aula: AulaParaPrompt = {
  titulo: "Mercado da Piscicultura no Brasil e no Mundo",
  tema: "panorama do mercado e sistemas de produção",
  inicio_em: "2026-09-22T19:00:00-03:00",
  link: "https://youtu.be/aula",
  certificado_instrucoes: null,
  monitor_nome: "Erika Costa",
  curso_nome: "Qualidade e Segurança de Alimentos de Origem Animal",
};

const em = (iso: string) => new Date(iso);

describe("estadoDaAula (regra do TI de 16/09/2026)", () => {
  it("data → amanhã → hoje → acontecendo agora → já acabou (2 h depois)", () => {
    expect(estadoDaAula(aula, em("2026-09-16T12:00:00-03:00"))).toBe("data");
    expect(estadoDaAula(aula, em("2026-09-21T23:30:00-03:00"))).toBe("amanha");
    expect(estadoDaAula(aula, em("2026-09-22T08:00:00-03:00"))).toBe("hoje");
    expect(estadoDaAula(aula, em("2026-09-22T18:59:00-03:00"))).toBe("hoje");
    expect(estadoDaAula(aula, em("2026-09-22T19:00:00-03:00"))).toBe("agora");
    expect(estadoDaAula(aula, em("2026-09-22T20:59:00-03:00"))).toBe("agora");
    expect(estadoDaAula(aula, em("2026-09-22T21:00:00-03:00"))).toBe("encerrada");
    expect(estadoDaAula(aula, em("2026-10-01T10:00:00-03:00"))).toBe("encerrada");
  });

  it("'amanhã' é pelo dia de Brasília, não por 24 h corridas", () => {
    // 21/09 às 00h10 BRT: a aula é no dia seguinte, mesmo faltando mais de 24 h.
    expect(estadoDaAula(aula, em("2026-09-21T00:10:00-03:00"))).toBe("amanha");
  });
});

describe("quandoOcorre", () => {
  it("produz o texto de cada estado com a hora da aula", () => {
    expect(quandoOcorre(aula, em("2026-09-16T12:00:00-03:00"))).toBe("22/09 às 19h00 (horário de brasília)");
    expect(quandoOcorre(aula, em("2026-09-21T12:00:00-03:00"))).toBe("amanhã, às 19h00 (horário de brasília)");
    expect(quandoOcorre(aula, em("2026-09-22T12:00:00-03:00"))).toBe("hoje, às 19h00 (horário de brasília)");
    expect(quandoOcorre(aula, em("2026-09-22T19:30:00-03:00"))).toBe("acontecendo agora (começou às 19h00)");
    expect(quandoOcorre(aula, em("2026-09-23T09:00:00-03:00"))).toBe("já acabou, mas está no youtube, no mesmo link");
  });
});

describe("montarVarsAula", () => {
  it("um link só, sem gravação separada; certificado vazio quando não cadastrado", () => {
    const vars = montarVarsAula(aula, em("2026-09-25T10:00:00-03:00"));
    expect(vars.aula_link).toBe("https://youtu.be/aula");
    expect(vars.aula_quando).toContain("já acabou");
    expect(vars.aula_certificado).toBe("");
    expect(vars.curso_interesse_original).toBe(aula.curso_nome);
    expect(Object.keys(vars)).not.toContain("aula_gravacao");
  });

  it("aula sem pós deixa o curso vazio (cai na seção AULA SEM PÓS)", () => {
    expect(montarVarsAula({ ...aula, curso_nome: null }).curso_interesse_original).toBe("");
  });
});

describe("AGENTE_AULA", () => {
  it("carrega as regras decididas em 16/09 e as instruções compartilhadas", () => {
    expect(AGENTE_AULA).toContain("claro, já te envio. mas antes só me confirma: sua graduação está completa? e qual o curso?");
    expect(AGENTE_AULA).toContain("Sempre responder e voltar ao fluxo");
    expect(AGENTE_AULA).toContain("AULA SEM PÓS");
    expect(AGENTE_AULA).toContain("prefere que eu te chame quando abrir a próxima turma");
    expect(AGENTE_AULA).toContain("Quando ocorre: **{{ $json.aula_quando }}**");
    expect(AGENTE_AULA).toContain("fica gravada");
    expect(AGENTE_AULA).not.toContain("aula_gravacao");
    expect(AGENTE_AULA).toContain("{{ $json.curso_interesse_original }}");
    // O fechamento é do qualificador: o texto PRÓPRIO da persona não cria reunião
    // (a instrução compartilhada de elegibilidade, anexada no fim, cita a tool de propósito).
    const textoProprio = AGENTE_AULA.split(INSTRUCAO_ELEGIBILIDADE)[0];
    expect(textoProprio).not.toContain("confirmar_agendamento");
    expect(AGENTE_AULA.length).toBeGreaterThan(20_000);
  });
});
