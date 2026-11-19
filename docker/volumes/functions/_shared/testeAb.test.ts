import { describe, expect, it } from 'vitest';
import { acompanhar, bh, faltam, sequencial, srm, veredito } from './testeAb.ts';

// Números de referência tirados do ab.mjs da skill teste-ab-site (18/11/2026): a tela tem que dar a mesma conta.
describe('testeAb (igual ao ab.mjs)', () => {
  it('sequencial', () => {
    const r = sequencial({ n: 1000, conv: 50 }, { n: 1000, conv: 75 });
    expect(r.rel).toBeCloseTo(0.5, 9);
    expect(r.p).toBeCloseTo(0.33281763101930717, 9);
    expect(r.ic[0]).toBeCloseTo(-0.16760392309964567, 9);
    expect(r.ic[1]).toBeCloseTo(1.1676039230996453, 9);
    const s = sequencial({ n: 277, conv: 41 }, { n: 300, conv: 30 });
    expect(s.p).toBeCloseTo(0.6221045737367639, 9);
    expect(s.ic[0]).toBeCloseTo(-0.873611123581722, 9);
  });

  it('srm', () => {
    expect(srm(5300, 4700)).toBeCloseTo(1.9802435247129324e-9, 15);
    expect(srm(5000, 5000)).toBeGreaterThan(0.99);
  });

  it('bh', () => {
    expect(bh([0.01, 0.04, 0.03]).map((x) => +x.toFixed(3))).toEqual([0.03, 0.04, 0.04]);
  });

  it('faltam ~X pessoas pela conta sequencial (mesmos números do faltamSequencial do ab.mjs)', () => {
    expect(faltam({ n: 500, conv: 39.5 }, { n: 500, conv: 51.35 }, 50)).toEqual({ pessoas: 1754, semanas: 6 });
    expect(faltam({ n: 1000, conv: 80 }, { n: 1000, conv: 70 }, 100)).toEqual({ pessoas: 10643, semanas: 16 });
    // Sem diferença: usa o piso de 5% e, sem ritmo, não estima semanas.
    expect(faltam({ n: 100, conv: 8 }, { n: 100, conv: 8 }, 0)).toEqual({ pessoas: 95775, semanas: null });
    expect(faltam({ n: 0, conv: 0 }, { n: 10, conv: 1 }, 5)).toBeNull();
  });

  it('acompanhar: certeza que não volta atrás e recomeço (mesmos números do acompanhar do ab.mjs)', () => {
    const r = acompanhar([
      { a: { n: 200, conv: 10 }, b: { n: 200, conv: 20 } },
      { a: { n: 400, conv: 20 }, b: { n: 400, conv: 40 } },
      { a: { n: 600, conv: 30 }, b: { n: 600, conv: 48 } },
    ])!;
    expect(r.rel).toBeCloseTo(0.6, 9);
    expect(r.p).toBeCloseTo(0.3932953305602051, 9);
    expect(r.ic[0]).toBeCloseTo(-0.37883661546332253, 9);
    expect(r.ic[1]).toBeCloseTo(1.5788366154633227, 9);
    expect(r.recomecou).toBeNull();
    const s = acompanhar([
      { a: { n: 500, conv: 25 }, b: { n: 500, conv: 50 } },
      { a: { n: 1000, conv: 50 }, b: { n: 1000, conv: 100 } },
      { a: { n: 3000, conv: 150 }, b: { n: 3000, conv: 140 } },
    ])!;
    expect(s.recomecou).toBe(2);
    expect(s.p).toBe(1);
    expect(s.ic[1]).toBeCloseTo(0.24007245517552878, 9);
    expect(acompanhar([{ a: { n: 0, conv: 0 }, b: { n: 0, conv: 0 } }])).toBeNull();
  });

  it('veredito', () => {
    expect(veredito({ n: 90, conv: 30 }, { n: 500, conv: 40 }, 0.01, 0.2)).toBe('amostra-pequena');
    expect(veredito({ n: 500, conv: 30 }, { n: 500, conv: 60 }, 0.01, 1)).toBe('b-ganha');
    expect(veredito({ n: 500, conv: 60 }, { n: 500, conv: 30 }, 0.01, -0.5)).toBe('b-perde');
    expect(veredito({ n: 500, conv: 30 }, { n: 500, conv: 33 }, 0.5, 0.1)).toBe('sem-resposta');
    // Antes de 7 dias, nenhum vencedor, mesmo com certeza alta.
    expect(veredito({ n: 500, conv: 30 }, { n: 500, conv: 60 }, 0.01, 1, 3)).toBe('cedo');
  });
});
