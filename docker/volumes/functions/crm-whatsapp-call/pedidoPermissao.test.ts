import { describe, expect, it } from 'vitest';
import {
  TEXTO_PADRAO_PEDIDO_PERMISSAO,
  TITULO_PEDIDO_PERMISSAO,
  textoPedidoPermissao,
} from './pedidoPermissao';

describe('balão do pedido de permissão para ligar', () => {
  it('começa pelo título fixo e traz o corpo que o lead recebeu', () => {
    const t = textoPedidoPermissao('Posso te ligar agora?');
    expect(t.startsWith(TITULO_PEDIDO_PERMISSAO + '\n')).toBe(true);
    expect(t).toContain('Posso te ligar agora?');
  });

  it('corpo vazio ou só espaços cai no texto padrão — o mesmo enviado à Meta', () => {
    for (const vazio of ['', '   ', null, undefined]) {
      expect(textoPedidoPermissao(vazio)).toContain(TEXTO_PADRAO_PEDIDO_PERMISSAO);
    }
  });

  it('não repete o corpo nem inventa linha extra', () => {
    const t = textoPedidoPermissao('  Olá  ');
    expect(t.split('\n')).toHaveLength(2);
    expect(t.split('\n')[1]).toBe('“Olá”');
  });
});
