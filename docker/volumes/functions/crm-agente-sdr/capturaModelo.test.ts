import { describe, expect, it, vi } from 'vitest';
import { observarSemInterromper, observadorDaRodada, semDadosPrivados } from './capturaModelo';

describe('histórico automático do João', () => {
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
  it('uma gravação que não responde não segura o atendimento indefinidamente', async () => {
    vi.useFakeTimers();
    try {
      const observar = vi.fn(() => new Promise<void>(() => {}));
      const captura = observarSemInterromper(observar, { pedido: {}, enviado: {}, provedor: 'teste' });
      await vi.advanceTimersByTimeAsync(1501);
      await expect(captura).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
  it('salva cada chamada e ferramenta sem opt-in, sem guardar etapas extras nem renovar a configuração', async () => {
    const inserir = vi.fn(async (_dados: Record<string, unknown>) => ({}));
    const banco = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { capturar_ate: '2020-01-01' } }) }) }), insert: inserir }) };
    const observar = await observadorDaRodada(banco, 'jid', 'rodada', 'abertura', ['mensagem']);
    await observarSemInterromper(observar, { pedido: { messages: ['primeira'] }, enviado: {}, provedor: 'teste' });
    await observarSemInterromper(observar, { tipo: 'ferramenta', pedido: { tool: 'consulta' }, enviado: {}, resposta: { resultado: 'curso' }, provedor: 'teste' });
    await observarSemInterromper(observar, { pedido: { messages: ['primeira', 'retorno da ferramenta'] }, enviado: {}, provedor: 'teste' });
    await observarSemInterromper(observar, { tipo: 'etapa', pedido: {}, enviado: {}, provedor: 'teste' });
    expect(inserir).toHaveBeenCalledTimes(3);
    expect(inserir.mock.calls[2][0]).toMatchObject({ tipo: 'modelo', rodada_id: 'rodada', origens: { mensagens_entrada: ['mensagem'] } });
    expect(semDadosPrivados(null)).toBeNull();
  });
  it('mantém o histórico quando a configuração está ausente ou falha', async () => {
    for (const config of [{ data: null }, { data: null, error: 'indisponível' }]) {
      const inserir = vi.fn(async () => ({}));
      const banco = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => config }) }), insert: inserir }) };
      await observarSemInterromper(await observadorDaRodada(banco, 'jid', 'rodada', 'router'), { pedido: {}, enviado: {}, provedor: 'teste' });
      expect(inserir).toHaveBeenCalledOnce();
    }
  });
});
