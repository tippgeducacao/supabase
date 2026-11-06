import { describe, expect, it, vi } from 'vitest';
import { executarEnsaio, validarPedidoLaboratorio } from './laboratorio';
import { validarEntradaSimulacao, type DependenciasSimulacao } from './simulacao';

const tool = (name: string) => ({ name, description: 'regra', input_schema: { type: 'object' } });
const pedido = () => ({ system: [{ type: 'text', text: 'rascunho' }], messages: [{ role: 'user', content: 'Me mande os horários.' }], tools: [tool('consulta_disponibilidade'), tool('pausa_ia'), tool('responder_ao_cliente')] });
const entrada = () => validarEntradaSimulacao({ persona: 'validacao', mensagens: ['entrada externa'], ficha: true });
const dependencias = (): DependenciasSimulacao => ({
  prepararRodada: async () => ({ promptAgente: 'original', contextoTemporal: 'agora', tools: [], agente: 'agente_validacao', comFicha: true }),
  chamarPrincipal: vi.fn(), mockTool: vi.fn(async () => 'retorno completo'), humanizar: (t) => t,
});
describe('ensaio do pedido editável', () => {
  it('ignora modelo, URLs e orçamento do JSON; exige canal e histórico válido', () => {
    const p = pedido();
    expect(validarPedidoLaboratorio({ ...p, model: 'outro', max_tokens: 1000000, base: 'http://db' })).toEqual(p);
    expect(() => validarPedidoLaboratorio({ ...p, tools: [] })).toThrow('responder_ao_cliente');
    expect(() => validarPedidoLaboratorio({ ...p, messages: [{ role: 'system', content: 'x' }] })).toThrow();
    expect(() => validarPedidoLaboratorio({ ...p, messages: [{ role: 'assistant', content: 'x' }] })).toThrow('terminar');
    expect(() => validarPedidoLaboratorio({ ...p, messages: [{ role: 'user', content: [{ type: 'reasoning' }] }] })).toThrow();
  });
  it('preserva o pedido editado, registra I/O e compartilha deduplicação do simulador', async () => {
    const deps = dependencias();
    let chamada = 0;
    const chamar = vi.fn(async () => ++chamada <= 2 ? { content: [{ type: 'tool_use', id: `t${chamada}`, name: 'consulta_disponibilidade', input: { data: 'amanhã' } }] }
      : { content: [{ type: 'text', text: 'Você prefere às 14h?' }] });
    const p = pedido(); const antes = structuredClone(p);
    const resultado = await executarEnsaio(p, entrada(), deps, chamar);
    expect(deps.mockTool).toHaveBeenCalledTimes(1);
    expect(resultado.tools_chamadas).toEqual(['consulta_disponibilidade', 'consulta_disponibilidade']);
    expect(resultado.transcript.some((t) => String(t.resultado).includes('já'))).toBe(true);
    expect(chamar.mock.calls[0][0].system).toEqual(p.system);
    expect(chamar.mock.calls[0][0].messages).toEqual(p.messages);
    expect(resultado.transcript[0].texto).toBe('Me mande os horários.');
    expect(p).toEqual(antes);
  });
  it('mantém a guarda de formação antes de executar pausa_ia', async () => {
    const deps = dependencias(); let n = 0;
    const r = await executarEnsaio(pedido(), entrada(), deps, async () => ++n === 1 ? {
      content: [{ type: 'tool_use', id: 'pausa', name: 'pausa_ia', input: { tipo: 'sem_graduacao' } }],
    } : { content: [{ type: 'text', text: 'Você tem alguma graduação?' }] });
    expect(deps.mockTool).not.toHaveBeenCalled();
    expect(r.transcript.find((t) => t.quem === 'tool')?.bloqueado).toBe(true);
    expect(r.limite_atingido).toBe(false);
  });
});
