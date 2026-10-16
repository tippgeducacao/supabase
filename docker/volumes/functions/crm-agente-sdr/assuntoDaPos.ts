// Assunto em que o lead quer se especializar ≠ nome de pós (16/10/2026, caso Dinah).
//
// A lead, cadastrada em Nutrição e Gestão de Bovinos, escreveu "sou zootecnista e trabalho na área de
// bovinocultura leiteira… gostaria de saber informações sobre pós graduação nessa área". A IA procurou no
// catálogo uma pós chamada "bovinocultura leiteira", não achou e respondeu "não temos uma pós específica…
// qual delas vc quer conhecer?". A pós do cadastro trata desse assunto. Em 7 dias, 82 leads com curso no
// cadastro receberam "curso não encontrado" assim (Sanidade Avícola → "nutrição de aves", Saúde Única →
// "Saúde Pública").
//
// Quando a busca não acha e o lead tem pós no cadastro, o retorno lembra qual é ela e que um assunto não é
// pedido de outra pós. Quem pede outra pós pelo nome ("vcs têm de equinos?") segue recebendo o "não temos".
// deno-lint-ignore-file no-explicit-any

export function notaDoAssunto(consulta: string, posDoCadastro: string): string {
  return `"${consulta}" não é o nome de uma pós do catálogo. Antes de dizer que não temos: se o lead falou de um ASSUNTO, área ou tema em que quer se especializar (e não pediu outra pós pelo nome), isso é interesse na pós do cadastro dele, ${posDoCadastro}, que trata desse assunto. Fale dela, sem "não temos" e sem listar outras pós; se ele pediu informações, siga a FICHA e mande o cronograma dela. Só se ele perguntou por outra pós pelo nome, ou disse que não quer a do cadastro, vale o que vem a seguir:`;
}

/** A leitura do assunto vale para este telefone? (catalogo_assunto_cadastro / _telefones). Falha = desligada. */
export async function assuntoDoCadastroLigado(supabase: { from: (tabela: string) => any }, telefone: string | null | undefined): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('catalogo_assunto_cadastro, catalogo_assunto_cadastro_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.catalogo_assunto_cadastro === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.catalogo_assunto_cadastro_telefones) ? data.catalogo_assunto_cadastro_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}
