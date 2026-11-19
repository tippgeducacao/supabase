import { describe, expect, it } from 'vitest';
import { FORA_DO_ANALYTICS, linhas, montarRelatorios, periodoAnterior, pontosAcumulados, validarPedido } from './ga4';

describe('mkt-ga4-relatorio', () => {
  it('período anterior: mesmo tamanho, logo antes', () => {
    expect(periodoAnterior({ inicio: '2026-11-12', fim: '2026-11-18', site: null })).toEqual({ inicio: '2026-11-05', fim: '2026-11-11' });
    expect(periodoAnterior({ inicio: '2026-03-02', fim: '2026-03-02', site: null })).toEqual({ inicio: '2026-03-01', fim: '2026-03-01' });
  });

  it('período anterior: mês com mês', () => {
    // Mês passado inteiro → o mês inteiro antes (31 × 30 dias).
    expect(periodoAnterior({ inicio: '2026-10-01', fim: '2026-10-31', site: null })).toEqual({ inicio: '2026-09-01', fim: '2026-09-30' });
    expect(periodoAnterior({ inicio: '2026-03-01', fim: '2026-03-31', site: null })).toEqual({ inicio: '2026-02-01', fim: '2026-02-28' });
    // Este mês até ontem → os mesmos dias do mês anterior.
    expect(periodoAnterior({ inicio: '2026-11-01', fim: '2026-11-17', site: null })).toEqual({ inicio: '2026-10-01', fim: '2026-10-17' });
    // 1 a 30/03 → 1 a 28/02 (fevereiro não tem 29 e 30).
    expect(periodoAnterior({ inicio: '2026-03-01', fim: '2026-03-30', site: null })).toEqual({ inicio: '2026-02-01', fim: '2026-02-28' });
    // Janeiro → dezembro do ano anterior.
    expect(periodoAnterior({ inicio: '2027-01-01', fim: '2027-01-31', site: null })).toEqual({ inicio: '2026-12-01', fim: '2026-12-31' });
  });

  it('valida o pedido', () => {
    expect(validarPedido({ inicio: '2026-11-01', fim: '2026-11-30', site: 'Site.PPGVET.com.br' })).toEqual({
      inicio: '2026-11-01', fim: '2026-11-30', site: 'site.ppgvet.com.br', detalhe: false,
    });
    expect(validarPedido({ inicio: '2026-11-18', fim: '2026-11-18', detalhe: true }).detalhe).toBe(true);
    expect(validarPedido({ inicio: '2026-11-18', fim: '2026-11-18', detalhe: 'sim' }).detalhe).toBe(false);
    expect(validarPedido({ inicio: '2026-11-01', fim: '2026-11-01' }).site).toBeNull();
    expect(() => validarPedido({ inicio: '2026-02-30', fim: '2026-03-01' })).toThrow();
    expect(() => validarPedido({ inicio: '2026-11-02', fim: '2026-11-01' })).toThrow();
    expect(() => validarPedido({ inicio: '2024-01-01', fim: '2026-11-01' })).toThrow();
    expect(() => validarPedido({ inicio: '2026-11-01', fim: '2026-11-02', site: 'x" OR 1' })).toThrow();
    expect(() => validarPedido(null)).toThrow();
  });

  it('filtra o site em todos os relatórios, e no de experimento junto com o evento', () => {
    const { lote, experimentos } = montarRelatorios({ inicio: '2026-11-01', fim: '2026-11-02', site: 'site.ppgvet.com.br' });
    expect(lote.requests).toHaveLength(5); // limite do batchRunReports
    for (const r of lote.requests) expect(JSON.stringify(r.dimensionFilter)).toContain('site.ppgvet.com.br');
    expect(JSON.stringify(experimentos.dimensionFilter)).toContain('experience_impression');
    expect(JSON.stringify(experimentos.dimensionFilter)).toContain('site.ppgvet.com.br');
    // Sem site escolhido: tira os sites que não são captação de aluno (contratação, fórum, curso presencial).
    const todos = montarRelatorios({ inicio: '2026-11-01', fim: '2026-11-02', site: null });
    for (const r of todos.lote.requests) expect(JSON.stringify(r.dimensionFilter)).toContain('"notExpression"');
    expect(JSON.stringify(todos.sites.dimensionFilter)).toContain(FORA_DO_ANALYTICS[0]);
    // 01 a 02/11 começa no dia 1: compara com os mesmos dias do mês anterior.
    expect(todos.anterior.requests[0].dateRanges).toEqual([{ startDate: '2026-10-01', endDate: '2026-10-02' }]);
    // A lista de sites nunca leva o site escolhido, senão o seletor encolhe para um só.
    expect(JSON.stringify(montarRelatorios({ inicio: '2026-11-01', fim: '2026-11-02', site: 'site.ppgvet.com.br' }).sites)).not.toContain('site.ppgvet.com.br');
  });

  it('detalhe do teste: só quando pedido; série acumulada desde o início, por página, aparelho, hoje e form_start só nas pós', () => {
    expect(montarRelatorios({ inicio: '2026-11-18', fim: '2026-11-20', site: null }).detalheTeste).toBeNull();
    const { detalheTeste } = montarRelatorios({ inicio: '2026-11-18', fim: '2026-11-24', site: null, detalhe: true });
    const [pagina, aparelho, form, hoje] = detalheTeste!.extras.requests;
    expect(pagina.dimensions.map((d) => d.name)).toEqual(['customEvent:exp_variant_string', 'pagePath']);
    expect(aparelho.dimensions.map((d) => d.name)).toEqual(['customEvent:exp_variant_string', 'deviceCategory']);
    expect(JSON.stringify(form.dimensionFilter)).toContain('form_start');
    expect(JSON.stringify(form.dimensionFilter)).toContain('^/pos-[a-z0-9]+/?$');
    expect(hoje.dateRanges).toEqual([{ startDate: '2026-11-24', endDate: '2026-11-24' }]);
    // 7 dias = 7 pontos, todos do início até o dia: 2 lotes (5 + 2).
    expect(detalheTeste!.dias).toHaveLength(7);
    expect(detalheTeste!.acumulado.map((l) => l.requests.length)).toEqual([5, 2]);
    expect(detalheTeste!.acumulado[1].requests[1].dateRanges).toEqual([{ startDate: '2026-11-18', endDate: '2026-11-24' }]);
    expect(JSON.stringify(detalheTeste!.acumulado[0].requests[0].dimensionFilter)).toContain('experience_impression');
    expect(linhas({ dimensionHeaders: [{ name: 'customEvent:exp_variant_string' }, { name: 'deviceCategory' }], metricHeaders: [{ name: 'totalUsers' }], rows: [{ dimensionValues: [{ value: 'PPG-form-aberto-b' }, { value: 'mobile' }], metricValues: [{ value: '3' }] }] }))
      .toEqual([{ exp: 'PPG-form-aberto-b', aparelho: 'mobile', usuarios: 3 }]);
  });

  it('série acumulada: no máximo 30 pontos, sempre com o último dia', () => {
    expect(pontosAcumulados('2026-11-18', '2026-11-18')).toEqual(['2026-11-18']);
    const longo = pontosAcumulados('2026-01-01', '2026-03-31'); // 90 dias
    expect(longo.length).toBeLessThanOrEqual(30);
    expect(longo.at(-1)).toBe('2026-03-31');
  });

  it('visitas de teste nunca contam; form_start nos dois períodos', () => {
    for (const site of [null, 'site.ppgvet.com.br']) {
      const { lote, anterior, experimentos } = montarRelatorios({ inicio: '2026-11-10', fim: '2026-11-16', site });
      for (const r of [...lote.requests, ...anterior.requests, experimentos]) expect(JSON.stringify(r.dimensionFilter)).toContain('teste_claude');
      expect(anterior.requests).toHaveLength(4); // limite do batchRunReports é 5
      const [, , atual, ant] = anterior.requests;
      expect(JSON.stringify(atual.dimensionFilter)).toContain('form_start');
      expect(atual.dateRanges).toEqual([{ startDate: '2026-11-10', endDate: '2026-11-16' }]);
      expect(ant.dateRanges).toEqual([{ startDate: '2026-11-03', endDate: '2026-11-09' }]);
    }
    expect(FORA_DO_ANALYTICS).toContain('ppgteste.ppgvet.com.br');
  });

  it('lê as linhas com nome curto, data e número', () => {
    expect(linhas({
      dimensionHeaders: [{ name: 'date' }],
      metricHeaders: [{ name: 'sessions' }, { name: 'keyEvents:generate_lead' }],
      rows: [{ dimensionValues: [{ value: '20261118' }], metricValues: [{ value: '10' }, { value: '2' }] }],
    })).toEqual([{ dia: '2026-11-18', sessoes: 10, leads: 2 }]);
    // Total (sem dimensão) vem sem dimensionValues.
    expect(linhas({ metricHeaders: [{ name: 'totalUsers' }], rows: [{ metricValues: [{ value: '7' }] }] })).toEqual([{ usuarios: 7 }]);
    expect(linhas({})).toEqual([]);
    // Pessoas que viraram lead = taxa por pessoa × pessoas.
    expect(linhas({ metricHeaders: [{ name: 'totalUsers' }, { name: 'userKeyEventRate:generate_lead' }], rows: [{ metricValues: [{ value: '200' }, { value: '0.115' }] }] }))
      .toEqual([{ usuarios: 200, taxa_pessoa: 0.115, pessoas_lead: 23 }]);
  });
});
