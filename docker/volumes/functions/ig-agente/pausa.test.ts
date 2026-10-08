import { describe, expect, it } from 'vitest';
import { pausaIgVigente } from './pausa';

describe('pausaIgVigente', () => {
  const agora = Date.parse('2026-10-08T15:00:00Z');

  it('sem pausa = IA ligada', () => {
    expect(pausaIgVigente(null, agora)).toBe(false);
    expect(pausaIgVigente({ pausada: false }, agora)).toBe(false);
    expect(pausaIgVigente({ pausada: false, pausada_ate: '2026-10-08T16:00:00Z' }, agora)).toBe(false);
  });

  it('pausa sem prazo é permanente', () => {
    expect(pausaIgVigente({ pausada: true, pausada_ate: null }, agora)).toBe(true);
  });

  it('pausa com prazo vale até vencer', () => {
    expect(pausaIgVigente({ pausada: true, pausada_ate: '2026-10-08T15:10:00Z' }, agora)).toBe(true);
    expect(pausaIgVigente({ pausada: true, pausada_ate: '2026-10-08T14:59:00Z' }, agora)).toBe(false);
  });

  it('prazo ilegível conta como pausa (fail-closed)', () => {
    expect(pausaIgVigente({ pausada: true, pausada_ate: 'lixo' }, agora)).toBe(true);
  });
});
