import { describe, expect, it, vi } from 'vitest';
import { observarSemInterromper, observadorDaRodada, semDadosPrivados } from './capturaModelo';

describe('captura opt-in do João', () => {
  it('mantém instruções e resultados grandes sem cortar e remove pensamento/segredos', async () => {
    const grande = 'retorno da ferramenta '.repeat(1500);
    const original = { pedido: { system: [{ type: 'text', text: 'regra' }], thinking: { type: 'adaptive' }, messages: [{ content: [
      { type: 'thinking', thinking: 'privado', signature: 'assinatura' }, { type: 'reasoning', encrypted_content: 'cifrado' },
      { type: 'tool_result', content: grande },
    ] }] }, enviado: { api_key: 'segredo', tools: [{ name: 'consulta', description: 'quando usar' }] }, provedor: 'teste' };
    const observar = vi.fn();
    await observarSemInterromper(observar, original);
    const salvo = observar.mock.calls[0][0];
    expect(salvo.pedido.messages[0].content).toEqual([{ type: 'tool_result', content: grande }]);
    expect(salvo.pedido.thinking).toEqual({ type: 'adaptive' });
    expect(JSON.stringify(salvo)).not.toMatch(/privado|assinatura|cifrado|segredo/);
    expect(original.pedido.messages[0].content).toHaveLength(3);
  });
  it('uma falha na gravação nunca muda a resposta do atendimento', async () => {
    await expect(observarSemInterromper(() => { throw new Error('banco fora'); }, { pedido: {}, enviado: {}, provedor: 'teste' })).resolves.toBeUndefined();
  });
  it('não grava sem captura ativa; captura expirada não é renovada por uma mensagem', async () => {
    const inserir = vi.fn();
    const banco = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { capturar_ate: '2020-01-01' } }) }) }), insert: inserir }) };
    expect(await observadorDaRodada(banco, 'jid', 'rodada', 'abertura')).toBeUndefined();
    expect(inserir).not.toHaveBeenCalled();
    expect(semDadosPrivados(null)).toBeNull();
  });
});
