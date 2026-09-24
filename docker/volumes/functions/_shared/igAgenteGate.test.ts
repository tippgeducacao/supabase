import { describe, expect, it } from 'vitest';
import { avaliarGateIg, normalizarUsername } from './igAgenteGate';

const base = { modo: 'teste', usernamesTeste: ['sutil_gu'], contaIaAtiva: true, username: 'sutil_gu' };

describe('normalizarUsername', () => {
  it('tira @, espaço e caixa', () => {
    expect(normalizarUsername(' @Sutil_Gu ')).toBe('sutil_gu');
    expect(normalizarUsername(null)).toBe('');
  });
});

describe('avaliarGateIg: quem a IA do direct atende', () => {
  it('libera só o @ da lista do teste', () => {
    expect(avaliarGateIg(base)).toEqual({ liberado: true, motivo: 'teste' });
    expect(avaliarGateIg({ ...base, username: 'outra.pessoa' })).toEqual({ liberado: false, motivo: 'fora_do_teste' });
  });

  it('compara o @ sem depender de caixa ou do @ na lista', () => {
    expect(avaliarGateIg({ ...base, usernamesTeste: ['@SUTIL_GU'], username: 'Sutil_Gu' }).liberado).toBe(true);
  });

  it('desligado, modo desconhecido ou "producao" não liberam ninguém', () => {
    for (const modo of ['desligado', 'producao', '', null, undefined]) {
      expect(avaliarGateIg({ ...base, modo })).toEqual({ liberado: false, motivo: 'ia_desligada' });
    }
  });

  it('conta com a IA desligada não fala, mesmo com o @ na lista', () => {
    expect(avaliarGateIg({ ...base, contaIaAtiva: false })).toEqual({ liberado: false, motivo: 'conta_sem_ia' });
  });

  it('sem o @ resolvido (token morto, perfil não buscado) falha fechado', () => {
    expect(avaliarGateIg({ ...base, username: null })).toEqual({ liberado: false, motivo: 'sem_username' });
    expect(avaliarGateIg({ ...base, username: '  ' })).toEqual({ liberado: false, motivo: 'sem_username' });
  });

  it('lista vazia ou nula não libera ninguém', () => {
    expect(avaliarGateIg({ ...base, usernamesTeste: [] }).liberado).toBe(false);
    expect(avaliarGateIg({ ...base, usernamesTeste: null }).liberado).toBe(false);
  });
});
