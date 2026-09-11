/**
 * Dados do cronograma do aluno, lidos com a chave de serviço.
 *
 * Segue o caminho do botão "Baixar cronograma do aluno" do comercial (BlocoTurmas), que é o
 * que a apresentação de vendas manda para o lead: as MESMAS três RPCs, para que o PDF do
 * WhatsApp e o PDF baixado no CRM tragam as mesmas aulas pelas mesmas regras (sem cancelada,
 * sem prático e sem mentoria na tabela principal; prático em bloco próprio no fim).
 *   - comercial_cronograma_aluno_turma: aulas ao vivo (obrigatória; erro vira 500);
 *   - ped_turma_ead_cronograma: módulos gravados (erro vira lista vazia, como no front);
 *   - ped_turma_praticos_cronograma: sessões práticas (erro vira lista vazia, como no front).
 *
 * ⚠️ O GATE. As RPCs de aulas e de práticos filtravam `auth.uid() is not null`: com a chave de
 * serviço `auth.uid()` é NULL, e elas devolviam 0 linhas SEM ERRO (turma c9af5ece: 60 aulas e 12
 * práticos voltavam 0 e 0 em 11/09/2026). A migration 20260911223000 abre o gate para
 * `auth.role() = 'service_role'`. Sem ela aplicada, gerar PDF seria mandar ao aluno um
 * cronograma vazio; por isso, quando as aulas voltam vazias, uma sonda direta separa "turma sem
 * aula" (422) de "RPC cega" (424) em vez de gerar o PDF.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { eadComoAulas, type CronogramaAlunoAula, type CronogramaAlunoTurma, type EadCronogramaRow } from "./render.ts";
import { normalizarPraticos, type PraticoCronogramaRow, type PraticoSessao } from "./praticos.ts";

// deno-lint-ignore no-explicit-any
export type Admin = SupabaseClient<any, "public", any>;

export interface Falha {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export interface CronogramaCarregado {
  ok: true;
  turmaId: string;
  turma: CronogramaAlunoTurma;
  /** `ped_pos_graduacoes.marca`, cru (quem decide o fallback é o render). */
  marca: string | null;
  aulas: CronogramaAlunoAula[];
  praticos: PraticoSessao[];
  /** `aoVivoFuturas`: aulas ao vivo de hoje em diante (ver `contarAulasFuturas`). */
  contagem: { aoVivo: number; aoVivoFuturas: number; ead: number; praticos: number };
}

const falha = (status: number, code: string, error: string): Falha => ({ ok: false, status, code, error });

/** Hoje no calendário de Ampére (America/Sao_Paulo), "AAAA-MM-DD". */
export function hojeEmAmpere(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}

/**
 * Aulas AO VIVO de hoje em diante, no calendário de Ampére. É o número que decide se o D+1 leva
 * o PDF: turma sem aula ao vivo daqui para a frente (só prático ou mentoria futuros, ou tudo já
 * passado) não serve de cronograma para quem acabou de entrar. Conta sobre as linhas da MESMA
 * RPC do PDF (sem cancelada, prático e mentoria); pré-abertura sem data não conta. O
 * `aulas_futuras` de onb_turma_do_aluno não serve para isso: conta prático, mentoria e
 * cancelada, e pede o id da venda.
 */
export function contarAulasFuturas(aulas: { data: string | null }[], hoje: string): number {
  return aulas.filter((a) => typeof a.data === "string" && a.data.slice(0, 10) >= hoje).length;
}

/** Código do PostgREST/Postgres para função que não existe (migration não aplicada). */
function funcaoInexistente(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "PGRST202" || err.code === "42883" || /could not find the function/i.test(err.message ?? "");
}

interface TurmaRow {
  id: string;
  nome: string | null;
  data_inicio: string | null;
  data_fim: string | null;
  horario_inicio: string | null;
  horario_fim: string | null;
  pos: { nome: string | null; periodo_total_meses: number | string | null; marca: string | null } | null;
}

interface AulaAoVivoRow {
  data: string | null;
  horario: string | null;
  titulo: string | null;
  ementa: string | null;
  tipo_aula: string | null;
}

/**
 * Conta, lendo as tabelas direto (a chave de serviço passa por cima da RLS), as aulas que a RPC
 * comercial_cronograma_aluno_turma DEVERIA devolver: mesmas regras de cancelada, prático e
 * mentoria. Só roda quando a RPC voltou vazia; o teto de 67 aulas por turma cabe numa página.
 */
async function aulasElegiveisDiretas(admin: Admin, turmaId: string): Promise<number | null> {
  const { data, error } = await admin
    .from("ped_aula_turmas")
    .select("aula:ped_aulas(cancelada, tipo_aula)")
    .eq("turma_id", turmaId)
    .limit(1000);
  if (error) {
    console.error("[generate-cronograma-aluno-pdf] sonda de aulas falhou:", error.message);
    return null;
  }
  // deno-lint-ignore no-explicit-any
  return (data ?? []).filter((r: any) => {
    const a = Array.isArray(r.aula) ? r.aula[0] : r.aula;
    if (!a || a.cancelada === true) return false;
    const tipo = String(a.tipo_aula ?? "");
    return tipo !== "pratico" && tipo !== "mentoria";
  }).length;
}

export async function carregarCronograma(admin: Admin, turmaId: string): Promise<CronogramaCarregado | Falha> {
  // (1) Cabeçalho da turma. A marca do curso só existe aqui: a RPC comercial não a devolve.
  const { data: turmaRow, error: turmaErr } = await admin
    .from("ped_turmas")
    .select("id, nome, data_inicio, data_fim, horario_inicio, horario_fim, pos:ped_pos_graduacoes(nome, periodo_total_meses, marca)")
    .eq("id", turmaId)
    .maybeSingle();
  if (turmaErr) {
    console.error("[generate-cronograma-aluno-pdf] leitura da turma falhou:", turmaErr.message);
    return falha(500, "erro_interno", "não foi possível ler a turma");
  }
  if (!turmaRow) return falha(404, "turma_nao_encontrada", "turma não encontrada");
  const t = turmaRow as unknown as TurmaRow;
  const pos = Array.isArray(t.pos) ? t.pos[0] ?? null : t.pos;

  // (2) As três RPCs do comercial, em paralelo.
  const [aoVivoRes, eadRes, praticosRes] = await Promise.all([
    admin.rpc("comercial_cronograma_aluno_turma", { p_turma_id: turmaId }),
    admin.rpc("ped_turma_ead_cronograma", { p_turma_id: turmaId }),
    admin.rpc("ped_turma_praticos_cronograma", { p_turma_id: turmaId }),
  ]);
  if (aoVivoRes.error) {
    console.error("[generate-cronograma-aluno-pdf] comercial_cronograma_aluno_turma falhou:", aoVivoRes.error.message);
    return falha(500, "erro_interno", "não foi possível ler as aulas da turma");
  }
  if (eadRes.error) console.warn("[generate-cronograma-aluno-pdf] EAD ignorado:", eadRes.error.message);
  if (praticosRes.error) console.warn("[generate-cronograma-aluno-pdf] práticos ignorados:", praticosRes.error.message);

  const aoVivo: CronogramaAlunoAula[] = ((aoVivoRes.data ?? []) as AulaAoVivoRow[]).map((a) => ({
    data: a.data,
    horario: a.horario,
    titulo: a.titulo,
    ementa: a.ementa,
    tipo_aula: a.tipo_aula,
  }));

  // (3) Sem aula ao vivo: turma sem cronograma, ou a RPC cega para a chave de serviço?
  if (aoVivo.length === 0) {
    const elegiveis = await aulasElegiveisDiretas(admin, turmaId);
    if (elegiveis === null) return falha(500, "erro_interno", "não foi possível conferir as aulas da turma");
    if (elegiveis > 0) {
      console.error(
        `[generate-cronograma-aluno-pdf] turma ${turmaId} tem ${elegiveis} aulas e a RPC devolveu 0: ` +
          "a migration 20260911223000_cronograma_aluno_pdf_service_role não está aplicada (gate auth.uid()).",
      );
      return falha(424, "rpc_sem_acesso", "as aulas existem mas a leitura com a chave de serviço voltou vazia (migration pendente)");
    }
    return falha(422, "sem_cronograma", "esta turma ainda não tem cronograma publicado no Pedagógico");
  }

  const ead = eadComoAulas(eadRes.error ? [] : ((eadRes.data ?? []) as EadCronogramaRow[]));
  // Superfície do ALUNO: sessão anterior ao início da turma fica fora (ele não alcança).
  const praticos = normalizarPraticos(
    praticosRes.error ? [] : ((praticosRes.data ?? []) as PraticoCronogramaRow[]),
    { somenteAPartirDoInicioDaTurma: true },
  );

  return {
    ok: true,
    turmaId,
    turma: {
      nome: t.nome,
      data_inicio: t.data_inicio,
      data_fim: t.data_fim,
      horario_inicio: t.horario_inicio,
      horario_fim: t.horario_fim,
      pos: pos ? { nome: pos.nome, periodo_total_meses: pos.periodo_total_meses } : null,
    },
    marca: pos?.marca ?? null,
    // O render ordena; aqui só junta ao vivo + gravados, como os dois chamadores do front.
    aulas: [...aoVivo, ...ead],
    praticos,
    contagem: {
      aoVivo: aoVivo.length,
      aoVivoFuturas: contarAulasFuturas(aoVivo, hojeEmAmpere()),
      ead: ead.length,
      praticos: praticos.length,
    },
  };
}

/**
 * Turma de uma oportunidade da integração, pelos DOIS jeitos de o aluno estar no funil ONBORDING
 * (card próprio OU posição do card fixo ALUNOS <ano>): a RPC onb_turma_da_oportunidade usa o
 * turma_id do próprio card e, sem ele, a venda aprovada do lead (onb_turma_do_aluno); etapa sem
 * curso com mais de uma venda recente é ambígua e não resolve. Sem turma, 404
 * turma_nao_identificada: é o caminho B da régua (D+1 sem anexo), e quem chama não deve chutar.
 * Oportunidade que não existe sai em 404 PRÓPRIO (oportunidade_nao_encontrada): é erro de quem
 * chamou, e não pode se misturar com "aluno sem turma".
 */
export async function turmaDaOportunidade(
  admin: Admin,
  oportunidadeId: string,
): Promise<{ ok: true; turmaId: string; origem: string } | Falha> {
  const { data, error } = await admin.rpc("onb_turma_da_oportunidade", { p_oportunidade_id: oportunidadeId });
  if (error) {
    if (funcaoInexistente(error)) {
      console.error("[generate-cronograma-aluno-pdf] onb_turma_da_oportunidade não existe: migration 20260911222900 pendente.");
      return falha(424, "rpc_sem_acesso", "a resolução da turma pela oportunidade ainda não está no banco (migration pendente)");
    }
    console.error("[generate-cronograma-aluno-pdf] onb_turma_da_oportunidade falhou:", error.message);
    return falha(500, "erro_interno", "não foi possível identificar a turma da oportunidade");
  }
  const linha = (Array.isArray(data) ? data[0] : data) as { turma_id?: string | null; origem?: string | null } | null;
  if (!linha?.turma_id) {
    // A RPC não devolve linha nos dois casos; só aqui dá para separar. Erro típico do chamador:
    // mandar o id da crm_oportunidade_posicoes no lugar do oportunidade_id.
    const { data: op, error: opErr } = await admin
      .from("crm_oportunidades")
      .select("id")
      .eq("id", oportunidadeId)
      .maybeSingle();
    if (opErr) {
      console.error("[generate-cronograma-aluno-pdf] leitura da oportunidade falhou:", opErr.message);
      return falha(500, "erro_interno", "não foi possível conferir a oportunidade");
    }
    if (!op) {
      console.error(
        `[generate-cronograma-aluno-pdf] oportunidade ${oportunidadeId} não existe: erro de quem chamou ` +
          "(id da posição no lugar do oportunidade_id?).",
      );
      return falha(404, "oportunidade_nao_encontrada", "oportunidade não encontrada");
    }
    console.warn(`[generate-cronograma-aluno-pdf] oportunidade ${oportunidadeId} sem turma identificada (caminho B).`);
    return falha(404, "turma_nao_identificada", "não foi possível identificar a turma desta oportunidade");
  }
  return { ok: true, turmaId: String(linha.turma_id), origem: String(linha.origem ?? "oportunidade") };
}
