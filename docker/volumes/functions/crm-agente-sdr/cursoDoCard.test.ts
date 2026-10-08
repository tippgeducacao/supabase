import { describe, expect, it, vi } from 'vitest';
import { cursoDoCardSeFaltar } from './cursoDoCard';

const banco = (data: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) });

describe('cursoDoCardSeFaltar', () => {
  it('lead sem curso recebe o curso canônico do card', async () => {
    const b = banco('PÓS | COMPORTAMENTO E BEM-ESTAR DE ANIMAIS DE COMPANHIA E SILVESTRES');
    expect(await cursoDoCardSeFaltar(b, '5541999350494', { curso_interesse_original: null }))
      .toBe('PÓS | COMPORTAMENTO E BEM-ESTAR DE ANIMAIS DE COMPANHIA E SILVESTRES');
    expect(b.rpc).toHaveBeenCalledWith('crm_agente_curso_do_card', { p_telefone: '5541999350494' });
  });
  it('não consulta nem troca curso que já existe', async () => {
    const b = banco('OUTRO CURSO');
    expect(await cursoDoCardSeFaltar(b, '5541999350494', { curso_interesse_original: 'SANIDADE AVÍCOLA' })).toBeNull();
    expect(b.rpc).not.toHaveBeenCalled();
  });
  it('card sem curso reconhecido, erro ou exceção não inventam curso', async () => {
    expect(await cursoDoCardSeFaltar(banco(null), '1', {})).toBeNull();
    expect(await cursoDoCardSeFaltar(banco('X', { message: 'falhou' }), '1', {})).toBeNull();
    expect(await cursoDoCardSeFaltar({ rpc: () => { throw new Error('rede'); } }, '1', null)).toBeNull();
  });
});
