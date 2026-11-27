// Descobre a empresa da reunião e cria (ou atualiza) a "reunião registrada". Nunca chuta: com zero
// ou mais de uma empresa possível, não grava nada na ficha e a entrega fica na caixa de chegada.
import { codigoDoMeet, dataDe, emailPessoal, emailsExternos, montarRegistro, type DadosRegistro, type Payload } from "./registro.ts";

export interface Agendamento {
  id: string;
  empresa_id: string;
  data_agendamento: string | null;
}

export interface Repo {
  /** Agendamentos com empresa cujo link do Meet tem este código. */
  agendamentosPorMeet: (codigo: string) => Promise<Agendamento[]>;
  /** Empresas não arquivadas que têm este e-mail (na própria empresa ou num contato dela). */
  empresasPorEmail: (email: string) => Promise<string[]>;
  /** E-mails dos contatos da empresa (amostra de até 1.000). */
  emailsDosContatos: (empresaId: string) => Promise<string[]>;
  registroDaSessao: (sessionId: string) => Promise<{ id: string; empresa_id: string; metadata: Record<string, unknown> } | null>;
  criar: (linha: DadosRegistro & { empresa_id: string }) => Promise<string>;
  atualizar: (id: string, dados: DadosRegistro) => Promise<void>;
}

export interface ResultadoProcesso {
  situacao: "criada" | "atualizada" | "mantida_editada" | "sem_empresa" | "empresa_ambigua" | "sem_conteudo";
  empresa_id: string | null;
  atividade_id: string | null;
}

const DIA_MS = 24 * 60 * 60 * 1000;

// Cadastro com contatos de domínios demais é lista geral (evento, importação), não um cliente:
// em 27/11/2026 um tinha 1.616 domínios e o seguinte, 10.
const MAX_DOMINIOS = 30;

async function ehListaGeral(empresaId: string, repo: Repo): Promise<boolean> {
  const emails = await repo.emailsDosContatos(empresaId);
  return new Set(emails.map((e) => e.split("@")[1]?.toLowerCase()).filter(Boolean)).size > MAX_DOMINIOS;
}

async function acharEmpresa(
  payload: Payload,
  repo: Repo,
): Promise<{ empresa: string; agendamento: string | null; por: "meet" | "email" } | "sem_empresa" | "empresa_ambigua"> {
  const codigo = codigoDoMeet(payload.platform_meeting_id);
  if (codigo) {
    const ags = await repo.agendamentosPorMeet(codigo);
    const empresas = new Set(ags.map((a) => a.empresa_id));
    if (empresas.size > 1) return "empresa_ambigua";
    if (empresas.size === 1) {
      const inicio = dataDe(payload.start_time)?.getTime();
      const distancia = (a: Agendamento) =>
        inicio && a.data_agendamento ? Math.abs(new Date(a.data_agendamento).getTime() - inicio) : Infinity;
      const perto = [...ags].sort((a, b) => distancia(a) - distancia(b))[0];
      // sala reaproveitada: a empresa vale, mas só pendura no agendamento do mesmo dia
      return { empresa: perto.empresa_id, agendamento: distancia(perto) <= DIA_MS ? perto.id : null, por: "meet" };
    }
  }

  const empresas = new Set<string>();
  // E-mail pessoal não aponta empresa: candidato em entrevista ou aluno não pode cair na ficha de alguém.
  for (const email of emailsExternos(payload).filter((e) => !emailPessoal(e)).slice(0, 30)) {
    for (const id of await repo.empresasPorEmail(email)) empresas.add(id);
  }
  for (const id of [...empresas]) {
    if (await ehListaGeral(id, repo)) empresas.delete(id);
  }
  if (empresas.size === 0) return "sem_empresa";
  if (empresas.size > 1) return "empresa_ambigua";
  return { empresa: [...empresas][0], agendamento: null, por: "email" };
}

export async function processarReuniao(payload: Payload, repo: Repo): Promise<ResultadoProcesso> {
  const nada = (situacao: ResultadoProcesso["situacao"]): ResultadoProcesso => ({
    situacao,
    empresa_id: null,
    atividade_id: null,
  });

  const registro = montarRegistro(payload);
  const sessao = registro?.metadata.read_ai_session_id as string | null | undefined;
  if (!registro || !sessao || (payload.trigger && payload.trigger !== "meeting_end")) return nada("sem_conteudo");

  // Reenvio da mesma reunião (ex.: depois de aplicar um modelo): atualiza, sem duplicar.
  const existente = await repo.registroDaSessao(sessao);
  if (existente) {
    const resultado = { empresa_id: existente.empresa_id, atividade_id: existente.id };
    // Alguém corrigiu na tela: o que a pessoa escreveu vale mais que o reenvio.
    if (existente.metadata.editado_por_nome) return { situacao: "mantida_editada", ...resultado };
    await repo.atualizar(existente.id, { ...registro, metadata: { ...existente.metadata, ...registro.metadata } });
    return { situacao: "atualizada", ...resultado };
  }

  const achada = await acharEmpresa(payload, repo);
  if (typeof achada === "string") return nada(achada);

  const id = await repo.criar({
    ...registro,
    empresa_id: achada.empresa,
    metadata: { ...registro.metadata, agendamento_id: achada.agendamento, empresa_achada_por: achada.por },
  });
  return { situacao: "criada", empresa_id: achada.empresa, atividade_id: id };
}
