import { describe, expect, it } from 'vitest';
import { carimboInbound, REENTREGA_MIN_MS } from './carimbo';

// 03/09/2026 15:26:00 BRT = 18:26:00Z
const AGORA = Date.parse('2026-09-03T18:26:00.000Z');
const seg = (ms: number) => String(Math.floor(ms / 1000));

describe('carimbo do inbound da Meta', () => {
  it('chegada normal (segundos de atraso) mantém a hora de chegada', () => {
    const c = carimboInbound(seg(AGORA - 2_000), AGORA);
    expect(c.reentrega).toBe(false);
    expect(c.iso).toBe(new Date(AGORA).toISOString());
    expect(c.atrasoS).toBe(2);
  });

  it('abaixo do limiar ainda é chegada; no limiar vira reentrega', () => {
    const quase = carimboInbound(seg(AGORA - REENTREGA_MIN_MS + 1_000), AGORA);
    expect(quase.reentrega).toBe(false);
    const limiar = carimboInbound(seg(AGORA - REENTREGA_MIN_MS), AGORA);
    expect(limiar.reentrega).toBe(true);
    expect(limiar.atrasoS).toBe(60);
  });

  it('reentrega de 2 dias grava a hora REAL da Meta e guarda a chegada', () => {
    // O caso do protocolo 177562: lead escreveu 31/08 18:09 BRT, chegou 03/09 15:26 BRT.
    const escrita = Date.parse('2026-08-31T21:09:00.000Z');
    const c = carimboInbound(seg(escrita), AGORA);
    expect(c.reentrega).toBe(true);
    expect(c.iso).toBe('2026-08-31T21:09:00.000Z');
    expect(c.chegouEm).toBe('2026-09-03T18:26:00.000Z');
    expect(c.atrasoS).toBe(Math.floor((AGORA - escrita) / 1000));
  });

  it('aceita o timestamp como número ou string numérica', () => {
    const escrita = AGORA - 3 * 3600_000;
    expect(carimboInbound(Math.floor(escrita / 1000), AGORA).iso).toBe(
      carimboInbound(seg(escrita), AGORA).iso,
    );
  });

  it('sem timestamp confiável cai na chegada (fail-open, nunca inventa hora)', () => {
    for (const ruim of [undefined, null, '', 'abc', 0, -5, NaN]) {
      const c = carimboInbound(ruim, AGORA);
      expect(c.reentrega).toBe(false);
      expect(c.iso).toBe(new Date(AGORA).toISOString());
      expect(c.atrasoS).toBe(0);
    }
  });

  it('relógio da Meta à frente do nosso não vira carimbo no futuro', () => {
    const c = carimboInbound(seg(AGORA + 3 * 60_000), AGORA);
    expect(c.reentrega).toBe(false);
    expect(c.iso).toBe(new Date(AGORA).toISOString());
    expect(c.atrasoS).toBe(0);
  });

  it('timestamp em milissegundos (13 dígitos) não é tratado como segundos', () => {
    // Multiplicado por 1000 cairia séculos no futuro → atraso negativo → chegada.
    const c = carimboInbound(String(AGORA - 5 * 3600_000), AGORA);
    expect(c.reentrega).toBe(false);
    expect(c.iso).toBe(new Date(AGORA).toISOString());
  });
});
