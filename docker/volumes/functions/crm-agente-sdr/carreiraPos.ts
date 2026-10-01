// Bloco CARREIRA (01/10/2026, agentes SDR V2 — ideia do Wellinton). O conhecimento da pós vem da tabela
// sdr_carreira_pos (pós × perfil de atuação → pergunta de dor, ponte do convite, moeda) e
// sdr_carreira_pos_objecoes, e chega à IA como DADO, no contexto. O prompt não muda por pós.
// Enquanto o perfil do lead não vem do formulário nem de um classificador, vão TODAS as linhas da pós,
// cada uma com os sinais do perfil, e a IA escolhe a que combina com o que o lead disse.

type Banco = { from: (t: string) => any };

export type LinhaCarreira = {
  perfil: string; moeda: string | null; pergunta_dor: string | null; ponte_convite: string | null; observacao: string | null;
};
export type ObjecaoCarreira = { objecao: string; resposta: string };

/** Como reconhecer cada perfil na fala do lead (vale para todas as pós). */
export const SINAIS_DO_PERFIL: Record<string, string> = {
  clinica_propria: 'tem clínica, atende por conta, autônomo, consultório',
  plantonista: 'faz plantão',
  contratado: 'trabalha numa clínica, hospital, integradora, cooperativa ou fazenda como funcionário',
  industria_rt: 'frigorífico, laticínio, indústria, RT, controle de qualidade',
  setor_publico: 'prefeitura, vigilância, servidor, concurso',
  quer_entrar: 'formado que ainda não atua com o tema da pós',
  ja_atua_no_tema: 'já faz o que a pós ensina',
  estudante: 'ainda está na graduação',
  outra_area: 'formação fora das aceitas pela pós',
};

/** A aula traz o NOME da pós (cursos.nome); o id sai daqui. */
export async function carregarCarreiraPorNome(banco: Banco, cursoNome: string | null | undefined) {
  if (!cursoNome?.trim()) return null;
  try {
    const { data, error } = await banco.from('cursos').select('id').eq('nome', cursoNome.trim()).limit(1);
    if (error || !data?.[0]?.id) return null;
    return await carregarCarreira(banco, String(data[0].id));
  } catch { return null; }
}

export async function carregarCarreira(banco: Banco, cursoId: string): Promise<{ linhas: LinhaCarreira[]; objecoes: ObjecaoCarreira[] } | null> {
  try {
    const [l, o] = await Promise.all([
      banco.from('sdr_carreira_pos').select('perfil, moeda, pergunta_dor, ponte_convite, observacao').eq('curso_id', cursoId).eq('ativo', true),
      banco.from('sdr_carreira_pos_objecoes').select('objecao, resposta').eq('curso_id', cursoId).eq('ativo', true).order('ordem'),
    ]);
    if (l.error || o.error) throw new Error((l.error ?? o.error).message);
    if (!l.data?.length) return null;
    return { linhas: l.data as LinhaCarreira[], objecoes: (o.data ?? []) as ObjecaoCarreira[] };
  } catch (e) {
    console.error('[crm-agente-sdr] carreira da pós (segue sem o bloco):', (e as Error)?.message ?? e);
    return null;
  }
}

/** O bloco que a IA lê. '' sem dados (a conversa segue sem ele). */
export function blocoCarreira(c: { linhas: LinhaCarreira[]; objecoes: ObjecaoCarreira[] } | null, nomePos: string): string {
  if (!c?.linhas.length) return '';
  const linhas = c.linhas.map((l) => {
    const partes = [`- ${l.perfil} (${SINAIS_DO_PERFIL[l.perfil] ?? l.perfil})`];
    if (l.pergunta_dor) partes.push(`PERGUNTA DE DOR: "${l.pergunta_dor}"`);
    if (l.ponte_convite) partes.push(`PONTE: ${l.ponte_convite}`);
    if (l.observacao) partes.push(l.observacao);
    return partes.join(' · ');
  });
  const objecoes = c.objecoes.map((o) => `- "${o.objecao}": ${o.resposta}`);
  return `\n\nCARREIRA — ${nomePos} (dados; escolha o perfil que combina com o que ele disse)\n${linhas.join('\n')}`
    + (objecoes.length ? `\nOBJEÇÕES DESTA PÓS:\n${objecoes.join('\n')}` : '');
}
