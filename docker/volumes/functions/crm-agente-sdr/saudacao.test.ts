import { describe, expect, it } from 'vitest';
import { alertaSaudacao, garantirSaudacao, saudacaoDoLead } from './saudacao';

// Pedido de 26/09/2026: a Luna sempre retribui o cumprimento do lead.
describe('saudacaoDoLead', () => {
  it.each([
    ['Bom dia hoje pela manhã as 09', 'bom dia', false],
    ['Boa tarde, tudo bem?', 'boa tarde', true],
    ['boa noite', 'boa noite', false],
    ['Oi', 'oi', false],
    ['Olá, gostaria de saber o valor', 'oi', false],
    ['tudo bem?', null, true],
    ['Bom diaa, tudo bem ??', 'bom dia', true],
    ['boa tardee', 'boa tarde', false],
    ['quanto custa?', null, false],
    ['[Em resposta à mensagem: "bom dia, lucas"] quanto custa?', null, false],
  ])('%s', (fala, cumprimento, perguntou) => {
    expect(saudacaoDoLead(fala)).toEqual({ cumprimento, perguntouComoEsta: perguntou });
  });
});

describe('garantirSaudacao', () => {
  it('caso real do duelo: "Bom dia hoje pela manhã as 09" sem retribuição ganha o "bom dia"', () => {
    expect(garantirSaudacao('vc já se formou em Medicina Veterinária?', 'Bom dia hoje pela manhã as 09').texto)
      .toBe('bom dia. vc já se formou em Medicina Veterinária?');
  });
  it('responde também ao "tudo bem?"', () => {
    expect(garantirSaudacao('qual pós te interessa?', 'Boa tarde, tudo bem?').texto).toBe('boa tarde, tudo bem sim. qual pós te interessa?');
    expect(garantirSaudacao('qual pós te interessa?', 'tudo bem?').texto).toBe('tudo bem sim. qual pós te interessa?');
  });
  it('não mexe quando a fala já retribui', () => {
    const r = garantirSaudacao('bom dia, jailson. vc já se formou?', 'Bom dia');
    expect(r).toEqual({ texto: 'bom dia, jailson. vc já se formou?', acrescentou: null });
    expect(garantirSaudacao('oi, tudo bem sim. me conta', 'Oi, tudo bem?').acrescentou).toBeNull();
    expect(garantirSaudacao('boa tarde, tudo certo por aqui. e vc?', 'boa tarde tudo bem?').acrescentou).toBeNull();
  });
  it('sem cumprimento do lead, ou fala vazia, não mexe', () => {
    expect(garantirSaudacao('te enviei o cronograma', 'manda o cronograma').acrescentou).toBeNull();
    expect(garantirSaudacao('', 'Bom dia').texto).toBe('');
  });
});

describe('alertaSaudacao', () => {
  it('avisa o modelo, e some quando não há cumprimento', () => {
    expect(alertaSaudacao('Bom dia, tudo bem?')).toContain('"bom dia"');
    expect(alertaSaudacao('Bom dia, tudo bem?')).toContain('tudo bem');
    expect(alertaSaudacao('quanto custa?')).toBeNull();
  });
});
