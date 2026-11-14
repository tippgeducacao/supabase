import { describe, expect, it } from 'vitest';
import { detalheNaoSuportada, TETO_BRUTO } from './naoSuportada';

// Formato real do webhook da Cloud API para o que ela não repassa.
const NAO_SUPORTADA = {
  from: '558100000000',
  id: 'wamid.TESTE',
  timestamp: '1794565504',
  type: 'unsupported',
  errors: [
    {
      code: 131051,
      title: 'Message type unknown',
      message: 'Message type unknown',
      error_data: { details: 'Message type is currently not supported.' },
    },
  ],
};

describe('motivo da mensagem não suportada (webhook)', () => {
  it('mensagem comum não gera detalhe', () => {
    expect(detalheNaoSuportada({ type: 'text', text: { body: 'oi' } })).toBeNull();
    expect(detalheNaoSuportada(null)).toBeNull();
    expect(detalheNaoSuportada('unsupported')).toBeNull();
  });

  it('guarda código, título e explicação que a Meta mandou', () => {
    const d = detalheNaoSuportada(NAO_SUPORTADA);
    expect(d?.erros).toEqual([
      {
        code: 131051,
        title: 'Message type unknown',
        message: 'Message type unknown',
        details: 'Message type is currently not supported.',
      },
    ]);
    expect(d?.tipo_informado).toBeNull();
    expect(d?.bruto).toEqual(NAO_SUPORTADA);
  });

  it('guarda o tipo original quando a Meta informa', () => {
    const d = detalheNaoSuportada({ ...NAO_SUPORTADA, unsupported: { type: 'poll' } });
    expect(d?.tipo_informado).toBe('poll');
  });

  it('não suportada SEM errors[] ainda é registrada (com o cru)', () => {
    const d = detalheNaoSuportada({ type: 'unsupported', id: 'wamid.X' });
    expect(d).not.toBeNull();
    expect(d?.erros).toEqual([]);
    expect(d?.bruto).toEqual({ type: 'unsupported', id: 'wamid.X' });
  });

  it('errors[] em mensagem de outro tipo também é guardado', () => {
    const d = detalheNaoSuportada({ type: 'document', errors: [{ code: '131052', title: 'Media download error' }] });
    expect(d?.erros[0]).toEqual({ code: 131052, title: 'Media download error', message: null, details: null });
  });

  it('payload gigante fica sem o cru, mas com o resumo', () => {
    const d = detalheNaoSuportada({ ...NAO_SUPORTADA, lixo: 'x'.repeat(TETO_BRUTO) });
    expect(d?.bruto).toBeUndefined();
    expect(d?.erros[0].code).toBe(131051);
  });
});
