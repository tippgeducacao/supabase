import { describe, expect, it } from 'vitest';
import { pausaVigente } from './pausa.ts';

const AGORA = Date.parse('2026-09-11T15:00:00Z');

describe('pausaVigente', () => {
  it('sem flag = IA ligada, mesmo com prazo esquecido na linha', () => {
    expect(pausaVigente(null, AGORA)).toBe(false);
    expect(pausaVigente({ pausa_ia: false, pausa_ia_ate: '2026-09-11T15:10:00Z' }, AGORA)).toBe(false);
    expect(pausaVigente({ pausa_ia: null }, AGORA)).toBe(false);
  });

  it('flag sem prazo = pausa permanente', () => {
    expect(pausaVigente({ pausa_ia: true, pausa_ia_ate: null }, AGORA)).toBe(true);
    expect(pausaVigente({ pausa_ia: true }, AGORA)).toBe(true);
  });

  it('prazo no futuro = pausada; prazo vencido = ligada (não espera o cron)', () => {
    expect(pausaVigente({ pausa_ia: true, pausa_ia_ate: '2026-09-11T15:10:00Z' }, AGORA)).toBe(true);
    expect(pausaVigente({ pausa_ia: true, pausa_ia_ate: '2026-09-11T14:59:59Z' }, AGORA)).toBe(false);
    expect(pausaVigente({ pausa_ia: true, pausa_ia_ate: '2026-09-11T15:00:00Z' }, AGORA)).toBe(false);
  });

  it('prazo ilegível = pausada (fail-closed)', () => {
    expect(pausaVigente({ pausa_ia: true, pausa_ia_ate: 'ontem' }, AGORA)).toBe(true);
  });
});
