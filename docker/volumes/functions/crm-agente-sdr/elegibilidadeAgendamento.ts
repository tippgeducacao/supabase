// 05/09/2026: formação preenchida não comprova aprovação. A avaliação tem seu
// próprio estado e só o backend produz a autorização usada ao criar a reunião.
export const VERSAO_REGRA_ELEGIBILIDADE = '2026-08-28:v1';
export type DecisaoElegibilidade = 'pendente' | 'aprovado' | 'reprovado';
export type EstadoElegibilidade = {
  curso: string;
  decisao: DecisaoElegibilidade;
  motivo: string;
  regra_versao: string;
};
export type ContextoElegibilidade = {
  telefone: string;
  modoTeste?: boolean;
  ultimaElegibilidade?: EstadoElegibilidade;
};
type ClienteElegibilidade = {
  rpc: (nome: string, params: Record<string, unknown>) => PromiseLike<{
    data: unknown; error: { message: string } | null;
  }>;
};
type AvaliacaoIniciada = { avaliacaoId: string | null; cursoId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function objeto(valor: unknown): Record<string, unknown> {
  return valor !== null && typeof valor === 'object' ? valor as Record<string, unknown> : {};
}
export function normalizarCursoTeste(curso: unknown): string {
  return String(curso ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^(pos|mba)\s*\|\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function iniciarAvaliacao(
  supabase: ClienteElegibilidade, ctx: ContextoElegibilidade, input: Record<string, unknown>,
): Promise<AvaliacaoIniciada> {
  // Também bloqueia nesta execução se a PRIMEIRA escrita falhar. Uma falha de
  // conexão não pode transformar aprovação antiga em autorização para a rodada.
  ctx.ultimaElegibilidade = {
    curso: String(input.curso_interesse ?? ''), decisao: 'pendente',
    motivo: 'avaliacao_em_andamento', regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
  };
  if (ctx.modoTeste) return { avaliacaoId: null, cursoId: null };
  const { data, error } = await supabase.rpc('crm_agente_elegibilidade_iniciar', {
    p_telefone: ctx.telefone,
    p_curso: input.curso_interesse ?? '',
    p_dados: {
      formacao_academica: input.formacao_academica ?? '',
      contexto_qualificacao: input.contexto_qualificacao ?? 'normal',
      conclusao_graduacao_bruta: input.conclusao_graduacao_bruta ?? null,
      conclusao_graduacao: input.conclusao_graduacao ?? null,
    },
    p_regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
  });
  const r = objeto(data);
  if (error || r.success !== true || !UUID.test(String(r.avaliacao_id ?? '')) || !UUID.test(String(r.curso_id ?? ''))) {
    throw new Error(error?.message ?? String(r.error ?? r.code ?? 'Não foi possível iniciar a avaliação'));
  }
  return { avaliacaoId: String(r.avaliacao_id), cursoId: String(r.curso_id) };
}

export async function finalizarAvaliacao(
  supabase: ClienteElegibilidade, ctx: ContextoElegibilidade, avaliacao: AvaliacaoIniciada,
  resultado: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const aprovada = resultado.output === 'APROVADO'
    && resultado.pode_cursar === true && resultado.compativel === true;
  const decisao: DecisaoElegibilidade = aprovada ? 'aprovado'
    : resultado.pode_cursar === false || resultado.compativel === false ? 'reprovado' : 'pendente';
  const motivo = String(resultado.output ?? 'PENDENTE').slice(0, 100);
  if (ctx.modoTeste) {
    if (aprovada && normalizarCursoTeste(resultado.curso_solicitado) !== normalizarCursoTeste(ctx.ultimaElegibilidade?.curso)) {
      throw new Error('A matriz respondeu sobre outro curso');
    }
  } else {
    const { data, error } = await supabase.rpc('crm_agente_elegibilidade_finalizar', {
      p_avaliacao_id: avaliacao.avaliacaoId,
      p_decisao: decisao, p_motivo: motivo,
      p_curso_avaliado: aprovada ? resultado.curso_solicitado ?? null : null,
    });
    const r = objeto(data);
    if (error || r.success !== true || r.decisao !== decisao) {
      throw new Error(error?.message ?? String(r.error ?? r.code ?? 'Não foi possível registrar o resultado'));
    }
  }
  ctx.ultimaElegibilidade = {
    curso: ctx.ultimaElegibilidade?.curso ?? '', decisao, motivo,
    regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
  };
  return {
    ...resultado,
    elegibilidade_status: decisao,
    elegibilidade_registrada: !ctx.modoTeste,
    ...(ctx.modoTeste ? { elegibilidade_simulada: true } : {}),
  };
}

export async function consultarAprovacao(
  supabase: ClienteElegibilidade, ctx: ContextoElegibilidade, curso: unknown,
): Promise<{ aprovada: boolean; avaliacaoId?: string; motivo: string }> {
  const local = ctx.ultimaElegibilidade;
  if (local && local.decisao !== 'aprovado') {
    return { aprovada: false, motivo: local.motivo };
  }
  if (ctx.modoTeste) {
    return {
      aprovada: local?.decisao === 'aprovado'
        && local.regra_versao === VERSAO_REGRA_ELEGIBILIDADE
        && normalizarCursoTeste(local.curso) === normalizarCursoTeste(curso),
      motivo: local?.motivo ?? 'elegibilidade_ausente',
    };
  }
  const { data, error } = await supabase.rpc('crm_agente_elegibilidade_consultar', {
    p_telefone: ctx.telefone, p_curso: curso ?? '', p_regra_versao: VERSAO_REGRA_ELEGIBILIDADE,
  });
  if (error) return { aprovada: false, motivo: 'falha_ao_consultar_elegibilidade' };
  const r = objeto(data);
  const aprovada = r.success === true && r.decisao === 'aprovado'
    && r.regra_versao === VERSAO_REGRA_ELEGIBILIDADE && UUID.test(String(r.avaliacao_id ?? ''));
  return {
    aprovada, ...(aprovada ? { avaliacaoId: String(r.avaliacao_id) } : {}),
    motivo: String(r.code ?? 'elegibilidade_ausente'),
  };
}

export function recusaElegibilidade(id: string, motivo: string) {
  return {
    id, agendamento_id: null, output: 'ELEGIBILIDADE_NAO_APROVADA',
    resultado: 'RECUSADO: não há aprovação válida de elegibilidade para este curso.',
    motivo,
    instrucao: 'NÃO diga que a reunião está marcada. Se houve reprovação, siga a orientação dessa análise; '
      + 'se faltou data de conclusão, pergunte só o dado ausente. Se falta registro, o curso mudou ou houve falha técnica, '
      + 'rode verificar_compatibilidade_curso com as respostas já dadas, sem reperguntar o que está no histórico. '
      + 'Só confirme depois da aprovação da nova análise. Não exponha identificadores ou erros internos ao lead.',
  };
}
