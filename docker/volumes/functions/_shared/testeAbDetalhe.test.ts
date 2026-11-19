import { describe, expect, it } from 'vitest';
import type { RespostaCrm, RespostaGa4 } from './mktAnalytics.ts';
import { checagens, diasCompletos, montarDetalhe, progresso, situacao, versaoDoRotulo } from './testeAbDetalhe.ts';

type Detalhe = NonNullable<RespostaGa4['experimentos_detalhe']>;
const ga4 = (exp: Record<string, number>, detalhe?: Partial<Detalhe>) =>
  ({
    experimentos: Object.entries(exp).map(([e, usuarios]) => ({ exp: e, usuarios })),
    experimentos_detalhe: detalhe ? { acumulado: [], por_pagina: [], por_aparelho: [], form_start: [], hoje: [], ...detalhe } : null,
  }) as unknown as RespostaGa4;
const crm = (exp: Record<string, number>, extra: Partial<RespostaCrm> = {}) =>
  ({
    experimentos: Object.entries(exp).map(([e, leads]) => ({ exp: e, leads, qualificados: Math.round(leads / 2), reunioes: 0, matriculas: 0 })),
    ...extra,
  }) as unknown as RespostaCrm;
const TESTE = { chave: 'form-aberto', versoes: ['a', 'b'], inicio: '2026-11-18', fim: null, situacao: 'rodando' as const, pesos: { a: 0.5, b: 0.5 }, plano: null };
const A = 'PPG-form-aberto-a', B = 'PPG-form-aberto-b';

describe('teste A/B: lista e detalhe', () => {
  it('dias completos não contam hoje', () => {
    expect(diasCompletos('2026-11-18', '2026-11-18')).toBe(0);
    expect(diasCompletos('2026-11-18', '2026-11-25')).toBe(7);
  });

  it('rótulo só da chave certa (chave que é prefixo de outra não mistura)', () => {
    expect(versaoDoRotulo('form-aberto', 'PPG-form-aberto-b')).toBe('b');
    expect(versaoDoRotulo('form', 'PPG-form-aberto-b')).toBeNull();
    expect(versaoDoRotulo('form-aberto', '')).toBeNull();
  });

  it('sem ninguém exposto: coletando; encerrado sem dado: inconclusivo', () => {
    const ch = checagens(null, 0);
    expect(situacao(null, ch, false)).toBe('coletando');
    expect(situacao(null, ch, true)).toBe('inconclusivo');
    expect(progresso(ch, null)).toEqual({ tipo: 'minimo', valor: 0 });
  });

  it('com diferença grande mas menos de 7 dias: pouco dado e sem certeza; com 7 dias: B ganha', () => {
    const g = ga4({ [A]: 2000, [B]: 2000 }), c = crm({ [A]: 40, [B]: 120 });
    const cedo = montarDetalhe(TESTE, g, c, '2026-11-21');
    expect(cedo.checagens.dias.ok).toBe(false);
    expect(cedo.checagens.minimo.ok).toBe(true);
    expect(cedo.situacao).toBe('pouco-dado');
    expect(cedo.certeza).toBeNull();
    expect(cedo.progresso.tipo).toBe('minimo');
    const semana = montarDetalhe(TESTE, g, c, '2026-11-25');
    expect(semana.situacao).toBe('b-ganha');
    expect(semana.progresso.tipo).toBe('certeza');
    expect(semana.certeza).toBeGreaterThan(0.9);
  });

  it('passou das pessoas do plano sem resposta: inconclusivo', () => {
    const g = ga4({ [A]: 5000, [B]: 5000 }), c = crm({ [A]: 400, [B]: 405 });
    expect(montarDetalhe(TESTE, g, c, '2026-12-30').situacao).toBe('sem-resposta');
    const comPlano = { ...TESTE, plano: { efeito: 0.25, base: 0.079, pessoas: 4532, semanas: 10 } };
    expect(montarDetalhe(comPlano, g, c, '2026-12-30').situacao).toBe('inconclusivo');
  });

  it('divisão torta num dia: alerta com a data, mesmo que o total pareça ok; peso vem do cadastro', () => {
    const det = { acumulado: [
      { dia: '2026-11-18', exp: A, usuarios: 300 }, { dia: '2026-11-18', exp: B, usuarios: 100 },
      { dia: '2026-11-19', exp: A, usuarios: 320 }, { dia: '2026-11-19', exp: B, usuarios: 300 },
    ] };
    const d = montarDetalhe(TESTE, ga4({ [A]: 320, [B]: 300 }, det), crm({ [A]: 10, [B]: 10 }), '2026-11-20');
    expect(d.checagens.divisao.ok).toBe(false);
    expect(d.checagens.divisao.desde).toBe('2026-11-18');
    expect(d.situacao).toBe('alerta');
    expect(d.avisos[0]).toContain('desde 18/11');
    // 75/25 de propósito: 300 × 100 é a divisão certa.
    const torto = montarDetalhe({ ...TESTE, pesos: { a: 0.75, b: 0.25 } }, ga4({ [A]: 300, [B]: 100 }), crm({}), '2026-11-20');
    expect(torto.checagens.divisao.ok).toBe(true);
  });

  it('detalhe: conversão acumulada por dia, por pós, por aparelho, começou formulário e saúde', () => {
    const det = {
      acumulado: [
        { dia: '2026-11-18', exp: A, usuarios: 40 }, { dia: '2026-11-18', exp: B, usuarios: 50 },
        { dia: '2026-11-19', exp: A, usuarios: 50 }, { dia: '2026-11-19', exp: B, usuarios: 40 + 20 },
        { dia: '2026-11-19', exp: 'PPG-outro-a', usuarios: 999 },
      ],
      por_pagina: [{ exp: A, caminho: '/pos-sa', usuarios: 30 }, { exp: B, caminho: '/pos-sa', usuarios: 20 }, { exp: A, caminho: '/pos-gcc', usuarios: 5 }],
      por_aparelho: [{ exp: A, aparelho: 'mobile', usuarios: 35 }, { exp: B, aparelho: 'mobile', usuarios: 45 }, { exp: A, aparelho: 'desktop', usuarios: 15 }],
      form_start: [{ exp: B, usuarios: 7 }],
      hoje: [{ exp: A, usuarios: 8 }],
    };
    const d = montarDetalhe(
      TESTE,
      ga4({ [A]: 50, [B]: 60 }, det),
      crm({ [A]: 2, [B]: 6 }, {
        experimentos_dia: [{ exp: B, dia: '2026-11-18', leads: 4, qualificados: 2 }, { exp: B, dia: '2026-11-19', leads: 2, qualificados: 1 }, { exp: A, dia: '2026-11-19', leads: 2, qualificados: 1 }],
        experimentos_pagina: [{ exp: B, slug: 'pos-sa', leads: 4, qualificados: 2, reunioes: 1, matriculas: 0 }],
        experimentos_sem_versao: [{ chave: 'form-aberto', leads: 8, sem_versao: 0 }],
      }),
      '2026-11-19',
    );
    expect(d.versoes.map((v) => [v.versao, v.pessoas, v.comecou, v.leads])).toEqual([['a', 50, 0, 2], ['b', 60, 7, 6]]);
    expect(d.versoes[1].conversao).toBe(0.1);
    // Acumulado: no dia 19 a B tem 6 leads ÷ 60 pessoas (não só os do dia).
    expect(d.porDia).toEqual([
      { dia: '2026-11-18', conversao: { a: 0, b: 0.08 } },
      { dia: '2026-11-19', conversao: { a: 0.04, b: 0.1 } },
    ]);
    expect(d.porPos.map((p) => p.pos)).toEqual(['sa', 'gcc']);
    expect(d.porPos[0].conversao).toEqual({ a: 0, b: 0.2 });
    expect(d.porAparelho).toEqual([{ aparelho: 'Celular', pessoas: { a: 35, b: 45 } }, { aparelho: 'Computador', pessoas: { a: 15 } }]);
    expect(d.saude).toEqual({ semVersao: { leads: 8, sem: 0 }, hoje: { a: 8, b: 0 }, semNinguemHoje: ['b'] });
    expect(d.situacao).toBe('pouco-dado');
    expect(d.leitura?.rel).toBeCloseTo(1.5, 9);
    // Sem o detalhe do GA4: começou formulário e saúde de hoje ficam null (não 0).
    const vazio = montarDetalhe(TESTE, ga4({}), crm({}), '2026-11-18');
    expect(vazio.versoes[0].comecou).toBeNull();
    expect(vazio.saude).toEqual({ semVersao: null, hoje: null, semNinguemHoje: [] });
  });
});
