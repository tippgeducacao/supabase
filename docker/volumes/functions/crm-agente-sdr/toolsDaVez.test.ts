import { describe, expect, it } from 'vitest';
import { toolsDaVez } from './toolsDaVez.ts';

describe('catálogo efetivo no fechamento de campanha', () => {
  it.each([true, false])('coleta presente na base=%s: recebe uma única função de coleta', async (jaTemColeta) => {
    const coleta = { name: 'atualizar_dados_lead', description: 'coleta', input_schema: { type: 'object' } };
    const criar = { name: 'confirmar_agendamento', description: 'agenda', input_schema: { type: 'object' } };
    const carregar = async (agente: string) => agente === 'agente_qualificador' ? [...(jaTemColeta ? [coleta] : []), criar] : [coleta];
    const tools = await toolsDaVez(carregar, 'agente_qualificador', true);
    expect(tools.filter(t => t.name === 'atualizar_dados_lead')).toHaveLength(1);
    expect(tools.filter(t => t.name === 'confirmar_agendamento')).toHaveLength(1);
  });
});
