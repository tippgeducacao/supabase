// Curso de interesse vindo do CARD quando o cadastro do agente está vazio (07/10/2026).
//
// O João lê o curso só de cliente_ppg_leads_sdr.curso_interesse_original. Formulário que não
// manda campo de curso deixava esse campo vazio, embora o card tivesse o curso no título
// ("COMPORTAMENTO E BEM ESTAR ANIMAL"): 155 de 570 leads recentes. Sem curso, o João inventou
// "Comportamento e Bem-estar de Cães e Gatos", a checagem não reconheceu e a lead pronta para
// as 9h ficou sem reunião. A RPC devolve o nome canônico do catálogo; semelhança fuzzy não conta.

type Banco = { rpc(nome: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

export async function cursoDoCardSeFaltar(
  supabase: Banco, telefone: string, lead: { curso_interesse_original?: unknown } | null | undefined,
): Promise<string | null> {
  if (String(lead?.curso_interesse_original ?? '').trim()) return null;
  try {
    const { data, error } = await supabase.rpc('crm_agente_curso_do_card', { p_telefone: telefone });
    if (error || typeof data !== 'string' || !data.trim()) return null;
    return data.trim();
  } catch {
    return null;
  }
}
