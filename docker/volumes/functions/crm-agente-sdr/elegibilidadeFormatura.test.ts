import { describe, expect, it } from 'vitest';
import {
  blocoElegibilidadeFormatura,
  limiteFormatura,
  limiteFormaturaFormatado,
} from './elegibilidadeFormatura.ts';

// Régua (usuário, 2026-08-06): elegível quem conclui a graduação em até 3 meses OU até
// 31/12 do ano corrente — o que for MAIOR. "Quem se forma em dezembro já pode conhecer a
// pós." Aritmética de calendário quebra nas bordas, então elas estão todas aqui.

/** Instante UTC equivalente a uma hora de Brasília (UTC-3). */
const brt = (iso: string) => new Date(`${iso}-03:00`);

const emDias = (agora: Date) => {
  const base = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  return Math.round((limiteFormatura(agora).getTime() - base.getTime()) / 86_400_000);
};

describe('limiteFormatura', () => {
  it('em agosto, alcança 31/12 do ano corrente (o caso que motivou a mudança)', () => {
    expect(limiteFormaturaFormatado(brt('2026-08-06T12:00:00'))).toBe('31/12/2026');
  });

  it('quem se forma em dezembro é elegível; quem se forma no ano seguinte, não', () => {
    const agora = brt('2026-08-06T12:00:00');
    const limite = limiteFormatura(agora);
    expect(new Date(Date.UTC(2026, 11, 15)) <= limite).toBe(true);  // 15/12/2026 entra
    expect(new Date(Date.UTC(2027, 2, 1)) <= limite).toBe(false);   // 01/03/2027 não
  });

  it('no início do ano a janela cobre o ano inteiro', () => {
    expect(limiteFormaturaFormatado(brt('2026-01-01T09:00:00'))).toBe('31/12/2026');
    expect(limiteFormaturaFormatado(brt('2027-01-31T09:00:00'))).toBe('31/12/2027');
  });

  // ⚠️ O PISO É O CORAÇÃO DA RÉGUA: sem ele, "até dezembro" ficaria MAIS restritiva que os
  // 90 dias antigos a cada fim de ano (em 20/12 sobrariam 10 dias) e quem se forma em
  // fevereiro passaria a ser recusado — regressão silenciosa, todo mês de novembro.
  it('nunca fica mais restritiva que os 3 meses antigos, em nenhuma data do ano', () => {
    for (let mes = 0; mes < 12; mes++) {
      for (const dia of [1, 15, 28]) {
        const agora = new Date(Date.UTC(2026, mes, dia, 15, 0, 0));
        expect(emDias(agora)).toBeGreaterThanOrEqual(89); // 3 meses ≈ 89-92 dias
      }
    }
  });

  it('no fim do ano o piso de 3 meses assume e atravessa a virada', () => {
    expect(limiteFormaturaFormatado(brt('2026-10-15T09:00:00'))).toBe('15/01/2027');
    expect(limiteFormaturaFormatado(brt('2026-12-20T09:00:00'))).toBe('20/03/2027');
  });

  it('vira o ano junto com Brasília, não com o UTC', () => {
    // 31/12/2026 23:00 BRT = 01/01/2027 02:00 UTC. Se lesse UTC, o ano seria 2027 e a
    // janela pularia para 31/12/2027 — quase um ano a mais, em silêncio.
    expect(limiteFormaturaFormatado(brt('2026-12-31T23:00:00'))).toBe('31/03/2027');
  });

  it('sobrevive a mês de 31 dias e a ano bissexto', () => {
    expect(limiteFormaturaFormatado(brt('2026-10-31T09:00:00'))).toBe('31/01/2027');
    expect(limiteFormaturaFormatado(brt('2028-02-29T09:00:00'))).toBe('31/12/2028');
  });
});

describe('blocoElegibilidadeFormatura', () => {
  it('entrega a data pronta ao modelo e o proíbe de calcular de cabeça', () => {
    const bloco = blocoElegibilidadeFormatura(brt('2026-08-06T12:00:00'));
    expect(bloco).toContain('31/12/2026');
    expect(bloco).toMatch(/não calcule/i);
  });

  it('avisa que a régua é interna e não pode ser citada ao lead', () => {
    expect(blocoElegibilidadeFormatura()).toMatch(/NUNCA cite ao lead/i);
  });

  // Com a régua nova o caminho "aprovado" ficou MUITO mais comum (antes quase todo
  // estudante era recusado), e no 1º teste de comportamento o agente escorregou:
  // "show, sua formação atende sim, dezembro tá dentro do prazo certinho" — dois laudos
  // proibidos numa frase só. O bloco carrega a proibição com o anti-exemplo real.
  it('proíbe comentar o resultado da checagem, com o anti-exemplo real', () => {
    const bloco = blocoElegibilidadeFormatura();
    expect(bloco).toMatch(/PROIBIDO/);
    expect(bloco).toMatch(/atende/i);
    expect(bloco).toMatch(/dentro do prazo/i);
    expect(bloco).toMatch(/ERRADO:/);
  });
});
