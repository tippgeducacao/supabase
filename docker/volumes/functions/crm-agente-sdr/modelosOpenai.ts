// Lista explícita para comparar gerações e trocar o piloto sem reiniciar todas as edges.
// A seleção nunca amplia a lista de telefones e null preserva a configuração do ambiente.
export const MODELOS_OPENAI_PILOTO = ['gpt-5.6-luna', 'gpt-6-luna'] as const;
export type ModeloOpenaiPiloto = typeof MODELOS_OPENAI_PILOTO[number];
// O modelo da conversa não amplia o piloto nem muda as chamadas de apoio.
export const MODELOS_OPENAI_CONVERSA = ['gpt-6.1-terra'] as const;
export const ESFORCOS_OPENAI_CONVERSA = ['low', 'medium', 'high'] as const;
// Ensaio por telefone (03/11/2026): modelo que só os números de `openai_ensaio_telefones` usam.
// Lista separada de propósito: o piloto acima vale para a fatia inteira do luna_percentual.
export const MODELOS_OPENAI_ENSAIO = ['gpt-6.1-terra'] as const;
export function modeloOpenaiEnsaioPermitido(valor: unknown): boolean {
  return typeof valor === 'string' && (MODELOS_OPENAI_ENSAIO as readonly string[]).includes(valor);
}
export function modeloOpenaiPermitido(valor: unknown): valor is ModeloOpenaiPiloto {
  return typeof valor === 'string' && (MODELOS_OPENAI_PILOTO as readonly string[]).includes(valor);
}
