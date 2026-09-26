import { describe, expect, it } from 'vitest';
import { avaliarGateIg, conversaComecadaPeloTime, ehMensagemDoManychat, normalizarUsername } from './igAgenteGate';

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

  it('ligado (26/09): qualquer pessoa, até sem @ resolvido; conta sem IA continua fora', () => {
    expect(avaliarGateIg({ ...base, modo: 'ligado', username: 'outra.pessoa', usernamesTeste: [] }))
      .toEqual({ liberado: true, motivo: 'ligado' });
    expect(avaliarGateIg({ ...base, modo: 'ligado', username: null }).liberado).toBe(true);
    expect(avaliarGateIg({ ...base, modo: 'ligado', contaIaAtiva: false }))
      .toEqual({ liberado: false, motivo: 'conta_sem_ia' });
  });
});

describe('conversa do time: a IA não entra por cima (26/09/2026)', () => {
  it('o "Oii, tudo bem?" e o card com botões são do ManyChat', () => {
    expect(ehMensagemDoManychat({ conteudo: 'Oii, tudo bem?' })).toBe(true);
    expect(ehMensagemDoManychat({ conteudo: 'Oii, tudo bem? \nTô feliz demais por te você na  PPGVET' })).toBe(true);
    expect(ehMensagemDoManychat({ tipo: 'template', conteudo: null })).toBe(true);
    expect(ehMensagemDoManychat({ conteudo: 'Sou a Flávia aqui da PPGVET! 💜 Vi seu perfil' })).toBe(false);
  });

  it('prospecção do time, "show!", mídia mandada à mão: conversa do time', () => {
    expect(conversaComecadaPeloTime([{ conteudo: 'Oii, tudo bem?', origem: 'humano' },
      { conteudo: 'eu sou o Wellyngton aqui da PPGvet', origem: 'humano' }])).toBe(true);
    expect(conversaComecadaPeloTime([{ conteudo: 'show!', origem: 'humano' }])).toBe(true);
    expect(conversaComecadaPeloTime([{ tipo: 'image', conteudo: null, origem: 'humano' }])).toBe(true);
  });

  it('só ManyChat, só a própria IA ou a pessoa escreveu primeiro: a IA entra', () => {
    expect(conversaComecadaPeloTime([{ conteudo: 'Oii, tudo bem?', origem: 'humano' }])).toBe(false);
    expect(conversaComecadaPeloTime([{ conteudo: 'Tudo ótimo por aqui!', origem: 'ia' },
      { conteudo: 'conversa zerada', origem: 'sistema' }])).toBe(false);
    expect(conversaComecadaPeloTime([])).toBe(false);
  });
});
