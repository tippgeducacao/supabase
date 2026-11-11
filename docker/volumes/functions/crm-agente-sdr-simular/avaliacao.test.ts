import { describe, expect, it, vi } from 'vitest';
import { avaliarChamadaCongelada } from './avaliacao';

describe('avaliação isolada de conversa real', () => {
  it('preserva o ponto da conversa e devolve solicitações de ferramentas sem executá-las', async () => {
    const pedido = { system: [{ type: 'text' as const, text: 'regras históricas' }], messages: [{ role: 'user' as const, content: 'mensagem original' }], tools: [] };
    const chamar = vi.fn(async (p) => {
      expect(p).toEqual(pedido);
      p.messages.push({ role: 'assistant', content: 'mutação isolada' });
      return { content: [
        { type: 'thinking', thinking: 'privado' },
        { type: 'tool_use', name: 'confirmar_agendamento', input: { horario: 'amanhã' } },
      ] };
    });
    const resultado = await avaliarChamadaCongelada(pedido, chamar);
    expect(chamar).toHaveBeenCalledOnce();
    expect(pedido.messages).toHaveLength(1);
    expect(resultado).toMatchObject({ ok: true, ferramentas_executadas: false,
      resposta: { content: [{ type: 'tool_use', name: 'confirmar_agendamento', input: { horario: 'amanhã' } }] } });
  });
});
