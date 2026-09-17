import { describe, expect, it } from "vitest";
import { AGENTE_AULA, comporAgenteAula, estadoDaAula, montarVarsAula, quandoOcorre, type AulaParaPrompt } from "./prompts-aula.ts";
import { AGENTE_VALIDACAO } from "./prompts.ts";
import { fichaDaPos } from "./fichasPos.ts";

const aula: AulaParaPrompt = {
  titulo: "Medicina Endocanabinoide Veterinária",
  tema: "canabinoides no tratamento da dor em animais",
  inicio_em: "2026-09-22T19:00:00-03:00",
  link: "https://youtu.be/aula",
  certificado_instrucoes: null,
  monitor_nome: "Erika Costa",
  curso_nome: "PÓS | CANNABIS MEDICINAL VETERINÁRIA",
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
  });
  it("'amanhã' é pelo dia de Brasília, não por 24 h corridas", () => {
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

describe("ficha da pós e vars", () => {
  it("casa a pós pelo nome do catálogo (com prefixo e acento) e carrega o tom obrigatório", () => {
    const ficha = fichaDaPos("PÓS | CANNABIS MEDICINAL VETERINÁRIA");
    expect(ficha).toContain("TERAPIA ADJUVANTE");
    expect(ficha).toContain("RDC 936");
    expect(fichaDaPos("PÓS | PRODUÇÃO DE SUÍNOS")).toBe("");
    expect(fichaDaPos(null)).toBe("");
  });
  it("vars: um link só, ficha quando existe e aviso quando não existe; aula sem pós deixa o curso vazio", () => {
    const vars = montarVarsAula(aula, em("2026-09-25T10:00:00-03:00"));
    expect(vars.aula_link).toBe("https://youtu.be/aula");
    expect(vars.aula_quando).toContain("já acabou");
    expect(vars.aula_ficha_pos).toContain("GANCHOS DE CONEXÃO");
    expect(Object.keys(vars)).not.toContain("aula_gravacao");
    const semPos = montarVarsAula({ ...aula, curso_nome: null });
    expect(semPos.curso_interesse_original).toBe("");
    expect(semPos.aula_ficha_pos).toContain("ainda não tem ficha");
  });
});

describe("AGENTE_AULA composto a partir do João de vendas", () => {
  it("encontra todas as seções esperadas do prompt de vendas (extração do n8n não renomeou nada)", () => {
    const { ausentes, trocadas } = comporAgenteAula(AGENTE_VALIDACAO);
    expect(ausentes).toEqual([]);
    expect(trocadas).toEqual(["Papel", "O que você pode e não pode", "Fluxo da conversa", "Oferta de cronograma aceita", "Exemplos de condução"]);
  });

  it("herda as regras de vendas ao vivo e troca só o que é da aula", () => {
    // herdado (não copiado): regras de ouro, horários, objeções, desinteresse, regras finais
    for (const titulo of ["Regra de ouro nº 2: horário só vem da ferramenta", "## Regras de horário", "## Como ler o retorno de consulta_objecoes",
      "## Quando o lead pede tempo pra analisar o material", "## Quando o lead não quer, pede humano ou pede ligação", "## Regras finais"]) {
      expect(AGENTE_AULA).toContain(titulo);
    }
    // próprio da aula
    for (const titulo of ["## A aula deste convite", "## Ficha da pós", "## ⛔ Regra de ouro nº 5", "## Sempre responder e voltar ao fluxo",
      "## AULA SEM PÓS", "## Formação: leia a profissão antes de perguntar", "## CRONOGRAMA (ou portfólio)", "## Lead que só quer a aula"]) {
      expect(AGENTE_AULA).toContain(titulo);
    }
    // o fluxo de vendas ("abra pela condição") não sobrevive; o da aula entra uma vez só
    expect(AGENTE_AULA).not.toContain("Abra pela condição");
    expect(AGENTE_AULA.split("## Fluxo da conversa").length).toBe(2);
    expect(AGENTE_AULA.split("## Papel").length).toBe(2);
  });

  it("gancho novo em todo o prompt, inclusive nas seções herdadas", () => {
    expect(AGENTE_AULA).toContain("estamos em fechamento do primeiro lote promocional");
    expect(AGENTE_AULA).toContain("eu gostaria de te apresentar essa condição");
    // As expressões antigas só podem aparecer na linha que as PROÍBE.
    const semAProibicao = AGENTE_AULA.split("\n").filter((l) => !l.startsWith("⛔ **O nome da oferta")).join("\n");
    expect(semAProibicao).not.toMatch(/secretaria liberou/i);
    expect(semAProibicao).not.toMatch(/condição especial/i);
    expect(AGENTE_AULA).toContain("NÃO existem nesta conversa");
    expect(AGENTE_AULA).toContain("Preço NÃO tem troca");
    expect(AGENTE_AULA).toContain("encaixe pra ainda hoje");
  });

  it("carrega as regras decididas pelo TI", () => {
    expect(AGENTE_AULA).toContain("claro, já te envio. mas antes só me confirma: sua graduação está completa? e qual o curso?");
    expect(AGENTE_AULA).toContain("Profissão que exige diploma + nome da graduação = graduação CONCLUÍDA");
    expect(AGENTE_AULA).toContain("Não repita a mesma pergunta com as mesmas palavras");
    expect(AGENTE_AULA).toContain("prefere que eu te chame quando abrir a próxima turma");
    expect(AGENTE_AULA).toContain("{{ $json.aula_ficha_pos }}");
    expect(AGENTE_AULA).toContain("Quando ocorre: **{{ $json.aula_quando }}**");
    expect(AGENTE_AULA).not.toContain("aula_gravacao");
  });
});
