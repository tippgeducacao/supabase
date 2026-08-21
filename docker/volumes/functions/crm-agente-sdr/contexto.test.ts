import { describe, expect, it } from 'vitest';
import { extrairPrimeiroNome, notaDoNome } from './contexto';

describe('o nome repetido a cada turno', () => {
  // Caso real de 21/08/2026: a lead se chamava Flávia e o João escreveu "vitória, então
  // segue assim:". O nome vivia só no topo do prompt, a dezenas de turnos de distância.
  it('manda usar só o primeiro nome', () => {
    const n = notaDoNome(extrairPrimeiroNome('Flávia Radaelli Corá'));
    expect(n).toContain('SE CHAMA: Flávia');
    expect(n).not.toContain('Radaelli');
    expect(n).toContain('Na dúvida, NÃO use nome');
  });

  it('corta o sobrenome mesmo se o nome chegar inteiro', () => {
    expect(notaDoNome('Flávia Radaelli Corá')).toContain('SE CHAMA: Flávia');
  });

  // O número de anúncio (persona campanha_direta) recebe lead SEM cadastro: é
  // justamente quem mais precisa ouvir "não invente nome" — o roteiro dele coleta
  // nome → curso → formação antes de qualquer coisa.
  it('sem nome, proíbe chutar em vez de ficar em silêncio', () => {
    for (const vazio of ['', null, undefined]) {
      const n = notaDoNome(vazio);
      expect(n).toContain('NÃO SABE O NOME');
      expect(n).toContain('nem chute');
    }
  });
});
