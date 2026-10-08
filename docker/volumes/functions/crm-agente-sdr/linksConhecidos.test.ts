import { describe, expect, it } from 'vitest';
import { corrigirLinksConhecidos } from './linksConhecidos';

const AULA = 'https://www.youtube.com/watch?v=BT7D20ltjNs';

describe('corrigirLinksConhecidos', () => {
  it('devolve a grafia cadastrada quando o modelo troca a caixa do id do vídeo', () => {
    const r = corrigirLinksConhecidos('o link é esse: https://www.youtube.com/watch?v=BT7D20ltJns', [AULA]);
    expect(r.texto).toBe(`o link é esse: ${AULA}`);
    expect(r.corrigidos).toEqual(['https://www.youtube.com/watch?v=BT7D20ltJns']);
  });
  it('preserva a pontuação depois do link', () => {
    expect(corrigirLinksConhecidos('nesse link: https://www.youtube.com/watch?v=bt7d20ltjns.', [AULA]).texto)
      .toBe(`nesse link: ${AULA}.`);
  });
  it('não mexe em link certo, em link desconhecido nem sem links conhecidos', () => {
    expect(corrigirLinksConhecidos(`link: ${AULA}`, [AULA]).corrigidos).toEqual([]);
    expect(corrigirLinksConhecidos('https://exemplo.com/Abc', [AULA]).texto).toBe('https://exemplo.com/Abc');
    expect(corrigirLinksConhecidos('https://www.youtube.com/watch?v=BT7D20ltJns', [null, '']).corrigidos).toEqual([]);
  });
});
