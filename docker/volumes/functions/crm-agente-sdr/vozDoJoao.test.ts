import { describe, expect, it } from 'vitest';
import { INSTRUCAO_VOZ } from './vozDoJoao';

describe('VOZ DO JOÃO (persona destilada da SDR de referência)', () => {
  const ancoras = INSTRUCAO_VOZ.slice(INSTRUCAO_VOZ.indexOf('### Âncoras de voz'), INSTRUCAO_VOZ.indexOf('### O que esta voz NUNCA faz'));
  it('as âncoras respeitam a escrita do João: sem exclamação, sem "você", sem maiúscula de início', () => {
    const falas = [...ancoras.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(falas.length).toBeGreaterThanOrEqual(15);
    for (const fala of falas) {
      expect(fala).not.toContain('!');
      expect(fala).not.toMatch(/\bvocê\b/i);
      expect(fala[0]).toBe(fala[0].toLowerCase());
    }
  });
  it('nenhuma âncora afirma o que o João não pode afirmar', () => {
    expect(ancoras).not.toMatch(/12 a 18|bolsa|negoci|desconto/i);
  });
  it('traz as regras que fazem a voz: reagir antes, pergunta de escolha, nunca argumentar', () => {
    expect(INSTRUCAO_VOZ).toContain('Reaja primeiro, conduza depois');
    expect(INSTRUCAO_VOZ).toContain('pergunta de escolha');
    expect(INSTRUCAO_VOZ).toContain('Nunca argumente');
  });
});
