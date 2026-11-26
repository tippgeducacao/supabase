// Tools da vez. Na campanha direta a ABERTURA usa a persona própria (que tem a
// atualizar_dados_lead); no FECHAMENTO o qualificador segue idêntico ao dos outros
// números, só ganhando a atualizar_dados_lead — o lead pode corrigir o nome lá também.
// ⚠️ Ordem estável: os extras entram sempre no fim (a ordem das tools compõe o
// prefixo do prompt cache; ordem variável = cache miss silencioso).
// Módulo próprio (25/11/2026) para a produção e o simulador usarem a MESMA regra: o
// simulador tinha uma cópia sem o filtro de nome e oferecia a coleta duas vezes.
export async function toolsDaVez<T extends { name?: unknown }>(
  carregar: (agente: string) => Promise<T[]>, agenteEfetivo: string, ehCampanha: boolean,
): Promise<T[]> {
  if (!ehCampanha) return await carregar(agenteEfetivo);
  if (agenteEfetivo === 'agente_validacao') return await carregar('agente_campanha_direta');
  const base = await carregar(agenteEfetivo);
  const extras = (await carregar('agente_campanha_direta'))
    // 13/11/2026: o qualificador já tem coleta no catálogo; não ofereça duas funções de mesmo nome.
    .filter((t) => t?.name === 'atualizar_dados_lead' && !base.some((b) => b.name === t.name));
  return [...base, ...extras];
}
