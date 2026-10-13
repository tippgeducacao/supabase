// Inscrição nova em OUTRA pós (13/10/2026).
//
// O webhook de captação troca o curso de interesse quando o lead se inscreve numa segunda pós
// (função crm_sdr_curso_da_inscricao) e guarda na jornada de onde ele veio. Com reunião marcada no
// futuro a troca espera: a inscrição fica em jornada.inscricao_pendente e é aplicada aqui, na
// primeira rodada depois que a reunião passou. A nota entrega o FATO à IA: sem ela o histórico
// fala de uma pós, o cadastro diz outra, e a IA não sabe o porquê.

type Banco = { rpc(nome: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const objeto = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** A troca vale como novidade por 45 dias; depois é só o curso do cadastro. */
const DIAS_DE_NOVIDADE = 45;

function diaEmBrasilia(iso: unknown): string | null {
  const d = new Date(texto(iso));
  if (!texto(iso) || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** Aplica a inscrição que esperava a reunião passar. Devolve a troca, ou null se nada mudou. */
export async function aplicarInscricaoPendente(
  supabase: Banco, lead: { remotejid?: unknown; jornada?: unknown } | null | undefined,
): Promise<{ curso: string; curso_anterior: string } | null> {
  const pendente = texto(objeto(objeto(lead?.jornada).inscricao_pendente).curso);
  const remotejid = texto(lead?.remotejid);
  if (!pendente || !remotejid) return null;
  try {
    const { data, error } = await supabase.rpc('crm_sdr_curso_da_inscricao', { p_remotejid: remotejid });
    const r = objeto(data);
    if (error || r.trocou !== true || !texto(r.curso)) return null;
    return { curso: texto(r.curso), curso_anterior: texto(r.curso_anterior) };
  } catch {
    return null;
  }
}

/** A nota para o contexto; '' quando não há inscrição nova a contar. */
export function notaDaInscricao(jornada: unknown, cursoAtual: unknown, agora: Date): string {
  const j = objeto(jornada);
  const pendente = objeto(j.inscricao_pendente);
  if (texto(pendente.curso)) {
    return '\n\n[DADO DO CADASTRO — OUTRA INSCRIÇÃO DO LEAD]\n'
      + JSON.stringify({ tambem_se_inscreveu_em: texto(pendente.curso), inscrito_em: diaEmBrasilia(pendente.em) })
      + '\n[FIM DO DADO DO CADASTRO]\n'
      + 'Ele se inscreveu nessa outra pós com a reunião da pós atual já marcada. A reunião marcada continua sendo a da pós atual; '
      + 'o curso de interesse só muda depois dela.';
  }
  const anterior = objeto(j.curso_anterior);
  const trocado = new Date(texto(anterior.trocado_em));
  if (!texto(anterior.curso) || Number.isNaN(trocado.getTime())) return '';
  if (agora.getTime() - trocado.getTime() > DIAS_DE_NOVIDADE * 86_400_000) return '';
  return '\n\n[DADO DO CADASTRO — INSCRIÇÃO MAIS RECENTE DO LEAD]\n'
    + JSON.stringify({
      inscricao_mais_recente: texto(cursoAtual) || null,
      inscrito_em: diaEmBrasilia(anterior.inscrito_em) ?? diaEmBrasilia(anterior.trocado_em),
      curso_anterior: texto(anterior.curso),
    })
    + '\n[FIM DO DADO DO CADASTRO]\n'
    + 'Ele se inscreveu de novo, agora na pós da inscrição mais recente; o histórico pode falar do curso anterior. '
    + 'O que ele já contou sobre si (formação, onde atua) continua valendo; a compatibilidade é conferida para a pós nova.';
}
