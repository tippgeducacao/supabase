// Lista explícita para comparar gerações e trocar o piloto sem reiniciar todas as edges.
// A seleção nunca amplia a lista de telefones e null preserva a configuração do ambiente.
export const MODELOS_OPENAI_PILOTO = ['gpt-5.6-luna', 'gpt-6-luna'] as const;
export type ModeloOpenaiPiloto = typeof MODELOS_OPENAI_PILOTO[number];
export function modeloOpenaiPermitido(valor: unknown): valor is ModeloOpenaiPiloto {
  return typeof valor === 'string' && (MODELOS_OPENAI_PILOTO as readonly string[]).includes(valor);
}
