// @vitest-environment node
// ⚠️ Dados INVENTADOS: nomes dos campos vistos na chamada de teste, formatos ainda não confirmados.
import { describe, expect, it, vi } from "vitest";
import { processarReuniao, type Repo } from "./processar.ts";
import { dataDe, emailsExternos, montarRegistro, participantesDe } from "./registro.ts";

const PAYLOAD = {
  session_id: "S1",
  trigger: "meeting_end",
  title: "Reunião B2B — ZZ Teste Read",
  start_time: "2026-11-27T14:00:00-03:00",
  end_time: "2026-11-27T14:36:00-03:00",
  platform: "meet",
  platform_meeting_id: "abc-defg-hij",
  owner: { name: "Bruno", email: "bruno@wisenetix.com.br" },
  participants: [
    { name: "Bruno", email: "bruno@wisenetix.com.br" },
    { name: "Maria Cliente", email: "Maria@clienteexemplo.com.br" },
  ],
  summary: "Cliente quer treinar a equipe técnica.\nPediu proposta <urgente>.",
  action_items: [{ text: "Enviar proposta até sexta" }, "Marcar nova conversa"],
  key_questions: ["Qual o orçamento?"],
  topics: [{ text: "Treinamento" }],
  chapter_summaries: [{ title: "Abertura", description: "Apresentações" }],
  report_url: "https://app.read.ai/analytics/meetings/S1",
};

function repo(extra: Partial<Repo> = {}) {
  return {
    agendamentosPorMeet: vi.fn<Repo["agendamentosPorMeet"]>(async () => []),
    empresasPorEmail: vi.fn<Repo["empresasPorEmail"]>(async () => []),
    emailsDosContatos: vi.fn<Repo["emailsDosContatos"]>(async () => ["a@clienteexemplo.com.br"]),
    registroDaSessao: vi.fn<Repo["registroDaSessao"]>(async () => null),
    criar: vi.fn<Repo["criar"]>(async () => "atv-1"),
    atualizar: vi.fn<Repo["atualizar"]>(async () => {}),
    ...extra,
  };
}

const ag = (id: string, empresa: string, data = "2026-11-27T17:00:00Z") => ({
  id,
  empresa_id: empresa,
  data_agendamento: data,
});

describe("registro montado a partir do Read", () => {
  it("preenche assunto, data, duração, participantes, discussão e próximos passos", () => {
    const r = montarRegistro(PAYLOAD)!;
    expect(r.titulo).toBe("Reunião B2B — ZZ Teste Read");
    expect(r.metadata).toMatchObject({
      origem: "read_ai",
      quando: "2026-11-27T17:00:00.000Z",
      duracao_min: 36,
      formato: "online",
      participantes: "Bruno, Maria Cliente",
      proximos_passos: "Enviar proposta até sexta; Marcar nova conversa",
    });
    for (const trecho of ["Cliente quer treinar", "Abertura: Apresentações", "Treinamento", "Qual o orçamento?", "Ver relatório"]) {
      expect(r.corpo).toContain(trecho);
    }
  });

  it("escapa o texto vindo de fora e só aceita link do read.ai", () => {
    expect(montarRegistro(PAYLOAD)!.corpo).toContain("&lt;urgente&gt;");
    const r = montarRegistro({ ...PAYLOAD, report_url: "javascript:alert(1)" })!;
    expect(r.corpo).not.toContain("<a ");
  });

  it("aceita data em segundos ou milissegundos e participante só como texto", () => {
    const ms = Date.parse("2026-11-27T17:00:00Z");
    expect(dataDe(ms)?.getTime()).toBe(ms);
    expect(dataDe(ms / 1000)?.getTime()).toBe(ms);
    expect(dataDe("lixo")).toBeNull();
    expect(participantesDe({ participants: ["Ana", "ana", "joao@x.com"] })).toEqual([
      { nome: "Ana", email: null },
      { nome: "joao@x.com", email: "joao@x.com" },
    ]);
  });

  it("e-mail da casa não aponta empresa; sem conteúdo não há registro", () => {
    expect(emailsExternos(PAYLOAD)).toEqual(["maria@clienteexemplo.com.br"]);
    expect(montarRegistro({ session_id: "S", title: "x" })).toBeNull();
  });
});

describe("em qual empresa a reunião entra", () => {
  it("pelo link do Meet, pendurada no agendamento do dia", async () => {
    const r = repo({
      agendamentosPorMeet: vi.fn(async () => [ag("ag-velho", "E1", "2026-10-01T12:00:00Z"), ag("ag-hoje", "E1")]),
    });
    expect(await processarReuniao(PAYLOAD, r)).toEqual({ situacao: "criada", empresa_id: "E1", atividade_id: "atv-1" });
    expect(r.criar.mock.calls[0][0].metadata).toMatchObject({ agendamento_id: "ag-hoje", empresa_achada_por: "meet" });
    expect(r.empresasPorEmail).not.toHaveBeenCalled();
  });

  it("sem Meet conhecido, pelo e-mail do participante de fora", async () => {
    const r = repo({ empresasPorEmail: vi.fn(async () => ["E2"]) });
    expect((await processarReuniao(PAYLOAD, r)).empresa_id).toBe("E2");
    expect(r.criar.mock.calls[0][0].metadata).toMatchObject({ agendamento_id: null, empresa_achada_por: "email" });
  });

  it("não chuta: nenhuma empresa ou mais de uma não grava na ficha", async () => {
    const casos: Array<[Partial<Repo>, string]> = [
      [{}, "sem_empresa"],
      [{ empresasPorEmail: vi.fn(async () => ["E1", "E2"]) }, "empresa_ambigua"],
      [{ agendamentosPorMeet: vi.fn(async () => [ag("a", "E1"), ag("b", "E2")]) }, "empresa_ambigua"],
    ];
    for (const [extra, situacao] of casos) {
      const r = repo(extra);
      expect((await processarReuniao(PAYLOAD, r)).situacao).toBe(situacao);
      expect(r.criar).not.toHaveBeenCalled();
    }
  });

  it("e-mail pessoal e cadastro que é lista geral não apontam empresa", async () => {
    const pessoal = repo({ empresasPorEmail: vi.fn(async () => ["E1"]) });
    const entrevista = { ...PAYLOAD, participants: [{ name: "Candidata", email: "candidata@gmail.com" }] };
    expect((await processarReuniao(entrevista, pessoal)).situacao).toBe("sem_empresa");
    expect(pessoal.empresasPorEmail).not.toHaveBeenCalled();

    const muitos = Array.from({ length: 31 }, (_, i) => `x@dominio${i}.com`);
    const geral = repo({
      empresasPorEmail: vi.fn(async () => ["LISTA", "E2"]),
      emailsDosContatos: vi.fn(async (id: string) => (id === "LISTA" ? muitos : ["a@clienteexemplo.com.br"])),
    });
    expect((await processarReuniao(PAYLOAD, geral)).empresa_id).toBe("E2");
  });

  it("reenvio atualiza o mesmo registro e respeita o que foi editado à mão", async () => {
    const existente = { id: "atv-9", empresa_id: "E1", metadata: { agendamento_id: "ag-1" } };
    const r = repo({ registroDaSessao: vi.fn(async () => existente) });
    expect((await processarReuniao(PAYLOAD, r)).situacao).toBe("atualizada");
    expect(r.atualizar.mock.calls[0][1].metadata).toMatchObject({ agendamento_id: "ag-1", duracao_min: 36 });
    expect(r.criar).not.toHaveBeenCalled();

    const editado = repo({
      registroDaSessao: vi.fn(async () => ({ ...existente, metadata: { editado_por_nome: "Eduarda" } })),
    });
    expect((await processarReuniao(PAYLOAD, editado)).situacao).toBe("mantida_editada");
    expect(editado.atualizar).not.toHaveBeenCalled();
  });

  it("início de reunião não registra", async () => {
    const r = repo();
    expect((await processarReuniao({ ...PAYLOAD, trigger: "meeting_start" }, r)).situacao).toBe("sem_conteudo");
    expect(r.registroDaSessao).not.toHaveBeenCalled();
  });
});
