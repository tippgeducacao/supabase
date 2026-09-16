import { describe, expect, it } from 'vitest';
import { descreverToolsSdr } from './descricoesTools';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from './prompts';

// 16/09/2026 (caso Letícia #184143): "De onde vc fala?" virou "falamos aqui de São Paulo"
// sem consultar a base, que já tinha a resposta (pergunta_instituicao: sede em Cascavel/PR).
describe('dados institucionais só pela base', () => {
  it('a tool de objeções anuncia o tipo pergunta_instituicao e proíbe sede de cabeça', () => {
    const [tool] = descreverToolsSdr([{
      name: 'consulta_objecoes', description: '', input_schema: { type: 'object', properties: {} },
    } as never]);
    expect(tool.description).toContain('pergunta_instituicao');
    expect(tool.description).toContain('de onde falam');
    expect(tool.description).toContain('nunca saem de cabeça');
  });
  it('as duas personas do WhatsApp trazem a regra', () => {
    for (const prompt of [AGENTE_VALIDACAO, AGENTE_QUALIFICADOR]) {
      expect(prompt).toContain('pergunta_instituicao');
      expect(prompt).toContain('nunca de cabeça');
    }
  });
});
