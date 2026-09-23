/**
 * SEMANA INTENSIVA do cronograma do aluno — a semana em que a turma tem MAIS DE UMA aula
 * ao vivo.
 *
 * Por que existe: módulos intensivos (`ped_curso_aulas_blueprint.intensivo` + os dias
 * adicionais da turma em `ped_turmas.dia_semana_intensivo`) colocam duas noites de aula na
 * mesma semana. Quem só olhava o cronograma linha a linha não percebia e reclamava depois
 * (diretor, 23/09/2026). Aqui a regra é calculada pelas DATAS REAIS das aulas da turma, não
 * pela flag do curso: é o que o aluno de fato vai viver naquela semana, inclusive quando a
 * aula extra entrou por reposição.
 *
 * ⚠️ PORTE de src/services/pedagogico/semanaIntensiva.ts (Deno não importa de src/), usado
 * pelo PDF que vai ao aluno no D+1 da integração. Mudou a regra lá? Mude aqui na mesma tarefa.
 */

export interface AulaDatada {
  /** "YYYY-MM-DD" */
  data: string | null;
  tipo_aula: string | null;
}

/** Selo que o aluno lê no cronograma. Texto único: PDF e tela não podem divergir. */
export const SELO_SEMANA_INTENSIVA = "SEMANA INTENSIVA";

/**
 * Tipos que NÃO contam como "aula da semana":
 *  - `gravado`: módulo EAD, liberação MENSAL (a data é o mês, não um dia de aula);
 *  - `pratico`: presencial de dias seguidos, em seção própria do cronograma e com datas
 *    que não seguem o calendário da turma (contá-lo marcaria toda praça como intensiva);
 *  - `mentoria`: encontro avulso, que a RPC `comercial_cronograma_aluno_turma` já tira do
 *    cronograma — sem ele aqui, a TELA marcaria uma semana que o PDF não marca.
 */
const TIPOS_FORA = new Set(["gravado", "pratico", "mentoria"]);

/** Segunda-feira da semana de uma data ISO, como "YYYY-MM-DD" (UTC ao meio-dia, sem fuso). */
export function segundaDaSemana(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  // getUTCDay: 0=domingo. Domingo pertence à semana que começou na segunda anterior (ISO).
  const desloca = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - desloca);
  return d.toISOString().slice(0, 10);
}

/**
 * Datas que caem numa semana com 2 ou mais DIAS de aula ao vivo.
 *
 * Conta DIAS distintos, não linhas: aula partida em duas partes no mesmo dia continua sendo
 * uma noite só — o que incomoda o aluno é ter que assistir em dois dias da mesma semana.
 */
export function datasEmSemanaIntensiva(aulas: AulaDatada[] | null | undefined): Set<string> {
  const diasPorSemana = new Map<string, Set<string>>();
  for (const a of aulas ?? []) {
    if (!a?.data || TIPOS_FORA.has(String(a.tipo_aula ?? ""))) continue;
    const semana = segundaDaSemana(a.data);
    const dias = diasPorSemana.get(semana) ?? new Set<string>();
    dias.add(a.data);
    diasPorSemana.set(semana, dias);
  }
  const datas = new Set<string>();
  for (const dias of diasPorSemana.values()) {
    if (dias.size >= 2) for (const d of dias) datas.add(d);
  }
  return datas;
}
