import { beforeAll, describe, expect, it, vi } from 'vitest';

let T: typeof import('./tools');
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  T = await import('./tools');
});

describe('resposta da base de objeções com o nome do lead', () => {
  it('troca {{nome}} pelo primeiro nome', () => {
    expect(T.comNomeDoLead('{{nome}}, somos a PPG Educação.', 'Gustavo Sutil')).toBe('Gustavo, somos a PPG Educação.');
    expect(T.comNomeDoLead('Entendo, {{ nome }}. Vamos lá.', 'ana')).toMatch(/^Entendo, Ana\. Vamos lá\.$|^Entendo, ana\. Vamos lá\.$/);
  });

  it('sem nome, tira o marcador e a vírgula (nunca chega cru)', () => {
    expect(T.comNomeDoLead('{{nome}}, somos a PPG Educação.', null)).toBe('somos a PPG Educação.');
    expect(T.comNomeDoLead('{{nome}}, somos a PPG Educação.', '')).not.toContain('{{');
  });
});
