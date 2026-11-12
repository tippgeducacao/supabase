import { describe, expect, it } from 'vitest';
import {
  FILTRO_NAO_SAO_DM, linhaDoComentarioDeLive, midDoComentarioDeLive, textoDoComentarioDeLive,
} from './igComentarioDeLive';

const CONTA = 'conta-1';
const IG_USER = '17841453422080445';
// O `value` REAL de um live_comments (live da @ppgvet_oficial, 12/11/2026).
const DA_PESSOA = {
  id: '17890018740485756',
  from: { id: '1137367455202552', username: 'ivansaldanha__' },
  text: 'pós',
  media: { id: '18082395839383597', media_product_type: 'FEED' },
};
const DA_PROPRIA_CONTA = {
  id: '18647547007033996',
  from: { id: IG_USER, username: 'ppgvet_oficial', self_ig_scoped_id: '475135902256043' },
  text: 'Manda "Pós" aqui no chat e receba a condição exclusiva!',
  media: { id: '18082395839383597', media_product_type: 'FEED' },
};

describe('linhaDoComentarioDeLive: o comentário da live vira mensagem da pessoa', () => {
  it('comentário de outra pessoa → linha de entrada, com o rótulo e o id do comentário', () => {
    expect(linhaDoComentarioDeLive(CONTA, IG_USER, DA_PESSOA)).toEqual({
      conta_id: CONTA,
      ig_user_id: IG_USER,
      contato_igsid: '1137367455202552',
      contato_username: 'ivansaldanha__',
      direcao: 'inbound',
      tipo: 'live_comment',
      conteudo: '🔴 Comentou na live: pós',
      mid: 'live_comment:17890018740485756',
      anexos: [],
      metadata: {
        origem: 'lead', is_echo: false, live_comment: true,
        comment_id: '17890018740485756', media_id: '18082395839383597', texto: 'pós',
      },
    });
  });

  it('comentário da PRÓPRIA conta não abre conversa', () => {
    expect(linhaDoComentarioDeLive(CONTA, IG_USER, DA_PROPRIA_CONTA)).toBeNull();
  });

  it('conta não cadastrada, evento sem id ou sem autor → nada', () => {
    expect(linhaDoComentarioDeLive(null, IG_USER, DA_PESSOA)).toBeNull();
    expect(linhaDoComentarioDeLive(CONTA, IG_USER, { ...DA_PESSOA, id: undefined })).toBeNull();
    expect(linhaDoComentarioDeLive(CONTA, IG_USER, { ...DA_PESSOA, from: {} })).toBeNull();
    expect(linhaDoComentarioDeLive(CONTA, IG_USER, null)).toBeNull();
  });

  it('comentário sem texto ainda aparece, só com o rótulo', () => {
    const l = linhaDoComentarioDeLive(CONTA, IG_USER, { ...DA_PESSOA, text: '   ' });
    expect(l?.conteudo).toBe('🔴 Comentou na live');
    expect(l?.metadata.texto).toBeNull();
  });

  it('o mesmo comentário reenviado pela Meta cai na mesma chave', () => {
    expect(midDoComentarioDeLive('123')).toBe('live_comment:123');
    expect(linhaDoComentarioDeLive(CONTA, IG_USER, DA_PESSOA)?.mid)
      .toBe(linhaDoComentarioDeLive(CONTA, IG_USER, { ...DA_PESSOA })?.mid);
  });
});

describe('o comentário de live não é DM', () => {
  it('filtro pronto para tirar reação e comentário de live da janela e da vez', () => {
    expect(FILTRO_NAO_SAO_DM).toBe('(reaction,live_comment)');
  });

  it('rótulo', () => {
    expect(textoDoComentarioDeLive('Pós')).toBe('🔴 Comentou na live: Pós');
    expect(textoDoComentarioDeLive(null)).toBe('🔴 Comentou na live');
  });
});
