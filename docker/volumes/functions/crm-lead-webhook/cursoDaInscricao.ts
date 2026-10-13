// Inscrição nova em OUTRA pós troca o curso de interesse da IA (13/10/2026).
//
// O seed do agente era só "preenche se vazio": quem se inscrevia numa segunda pós ganhava o card
// novo, mas a IA seguia falando da primeira (caso Eliel Dias: Sanidade Avícola em 11/06, Qualidade
// e Segurança de Alimentos em 28/08, e a IA retomou por Sanidade em 12/10). A regra inteira mora na
// função crm_sdr_curso_da_inscricao: pós reconhecida sem fuzzy, aula não troca, e reunião marcada
// no futuro adia a troca. Aqui só se escolhe o que mandar para ela.

type Banco = { rpc(nome: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

export type TrocaDeCurso = {
  trocou: boolean;
  motivo?: string;
  curso?: string;
  curso_anterior?: string;
  reuniao_em?: string;
};

/**
 * Tenta o curso do formulário e, se ele não for reconhecido, os títulos dos cards desta captação.
 * Para no primeiro que o catálogo reconhece, troque ou não. Devolve null se nada foi tentado.
 */
export async function aplicarCursoDaInscricao(
  admin: Banco,
  entrada: { remotejid: string; candidatos: readonly unknown[]; funilIds: readonly unknown[] },
): Promise<TrocaDeCurso | null> {
  const funis = [...new Set(entrada.funilIds.map((f) => String(f ?? '').trim()).filter(Boolean))];
  const vistos = new Set<string>();
  let ultimo: TrocaDeCurso | null = null;
  for (const bruto of entrada.candidatos) {
    const curso = String(bruto ?? '').trim();
    const chave = curso.toLowerCase();
    if (!curso || vistos.has(chave)) continue;
    vistos.add(chave);
    const { data, error } = await admin.rpc('crm_sdr_curso_da_inscricao', {
      p_remotejid: entrada.remotejid, p_curso: curso, p_funil_ids: funis,
    });
    if (error) throw new Error(String((error as { message?: unknown })?.message ?? error));
    if (!data || typeof data !== 'object') continue;
    ultimo = data as TrocaDeCurso;
    if (ultimo.motivo !== 'curso_nao_reconhecido') return ultimo;
  }
  return ultimo;
}
