import { describe, expect, it } from 'vitest';
import { detalhar, diaFechado, FORA_DO_ANALYTICS, linhas, montarRelatorios, periodoAnterior, pontosAcumulados, regexDaPagina, validarPedido, type Guardado, type LinhaGa4 } from './ga4';

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
      inicio: '2026-11-01', fim: '2026-11-30', site: 'site.ppgvet.com.br', pagina: null, detalhe: false,
    });
    expect(validarPedido({ inicio: '2026-11-01', fim: '2026-11-01', site: 'site.ppgvet.com.br', pagina: 'Pos-CA' }).pagina).toBe('pos-ca');
    // Página só dentro de um site (a home de cada site tem o slug do subdomínio) e sem pedaço de caminho.
    expect(() => validarPedido({ inicio: '2026-11-01', fim: '2026-11-01', pagina: 'pos-ca' })).toThrow();
    expect(() => validarPedido({ inicio: '2026-11-01', fim: '2026-11-01', site: 'site.ppgvet.com.br', pagina: 'a/b' })).toThrow();
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

  it('página escolhida: filtra a página de entrada nos relatórios do site, com os endereços do mesmo slug', () => {
    const casa = (site: string, slug: string, caminho: string) => new RegExp(`^(?:${regexDaPagina(site, slug)})$`, 'i').test(caminho);
    expect(casa('site.ppgvet.com.br', 'pos-ca', '/pos-ca')).toBe(true);
    expect(casa('site.ppgvet.com.br', 'pos-ca', '/pos-ca/')).toBe(true);
    expect(casa('site.ppgvet.com.br', 'pos-ca', '/POS-CA.html')).toBe(true);
    expect(casa('site.ppgvet.com.br', 'pos-ca', '/x/pos-ca')).toBe(true);
    expect(casa('site.ppgvet.com.br', 'pos-ca', '/pos-cab')).toBe(false);
    expect(casa('site.ppgvet.com.br', 'pos-ca', '/')).toBe(false);
    // A home ("/") é o subdomínio, como no slugDaPagina.
    expect(casa('site.ppgvet.com.br', 'site', '/')).toBe(true);
    expect(casa('site.ppgvet.com.br', 'site', '/pos-ca')).toBe(false);
    // Ponto no slug não vira "qualquer letra".
    expect(casa('site.ppgvet.com.br', 'a.b', '/axb')).toBe(false);
    const { lote, anterior } = montarRelatorios({ inicio: '2026-11-01', fim: '2026-11-02', site: 'site.ppgvet.com.br', pagina: 'pos-ca' });
    for (const r of [...lote.requests, ...anterior.requests]) expect(JSON.stringify(r.dimensionFilter)).toContain('landingPage');
    expect(JSON.stringify(montarRelatorios({ inicio: '2026-11-01', fim: '2026-11-02', site: 'site.ppgvet.com.br', pagina: 'pos-ca' }).sites)).not.toContain('landingPage');
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
    // 7 dias = 7 pontos, todos do início até o dia.
    expect(detalheTeste!.dias).toHaveLength(7);
    expect(detalheTeste!.pontoAcumulado('2026-11-24').dateRanges).toEqual([{ startDate: '2026-11-18', endDate: '2026-11-24' }]);
    expect(JSON.stringify(detalheTeste!.pontoAcumulado('2026-11-20').dimensionFilter)).toContain('experience_impression');
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
      expect(anterior.requests).toHaveLength(5); // limite do batchRunReports é 5
      const [, , atual, ant, porPagina] = anterior.requests;
      expect(JSON.stringify(porPagina.dimensionFilter)).toContain('form_start');
      expect((porPagina as { dimensions?: { name: string }[] }).dimensions?.map((d) => d.name)).toEqual(['hostName', 'landingPage']);
      expect(JSON.stringify(atual.dimensionFilter)).toContain('form_start');
      expect(atual.dateRanges).toEqual([{ startDate: '2026-11-10', endDate: '2026-11-16' }]);
      expect(ant.dateRanges).toEqual([{ startDate: '2026-11-03', endDate: '2026-11-09' }]);
    }
    expect(FORA_DO_ANALYTICS).toContain('ppgteste.ppgvet.com.br');
  });

  it('página de entrada traz a rejeição', () => {
    const { lote } = montarRelatorios({ inicio: '2026-11-10', fim: '2026-11-16', site: null });
    expect(lote.requests[3].metrics.map((x) => x.name)).toContain('bounceRate');
    expect(linhas({ dimensionHeaders: [{ name: 'landingPage' }], metricHeaders: [{ name: 'sessions' }, { name: 'bounceRate' }], rows: [{ dimensionValues: [{ value: '/pos-x' }], metricValues: [{ value: '40' }, { value: '0.25' }] }] }))
      .toEqual([{ pagina: '/pos-x', sessoes: 40, rejeicao: 0.25 }]);
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

  it('dia fechado = 3 dias ou mais pelo relógio (o GA4 pode mudar o dia por 24-48 h)', () => {
    const agora = new Date('2026-11-25T15:00:00Z');
    expect(diaFechado('2026-11-22', agora)).toBe(true);
    expect(diaFechado('2026-11-23', agora)).toBe(false);
    expect(diaFechado('2026-11-25', agora)).toBe(false);
  });

  describe('série acumulada com os dias guardados', () => {
    // 01 a 10/11/2026: todos fechados hoje (o relógio é o de verdade, bem depois).
    const { detalheTeste } = montarRelatorios({ inicio: '2026-11-01', fim: '2026-11-10', site: null, detalhe: true });
    const chave = { inicio: '2026-11-01', site: '' };
    const linha = (n: number): LinhaGa4[] => [{ exp: 'PPG-x-a', usuarios: n }];
    /** GA4 falso: responde cada ponto com o número do dia e conta os pontos pedidos. */
    const ga4Falso = () => {
      const pedidos: string[] = [];
      const enviar = async (_t: string, _m: string, corpo: unknown) => {
        const reqs = (corpo as { requests: { dateRanges: { endDate: string }[]; dimensions: unknown[]; dimensionFilter: unknown }[] }).requests;
        // O lote de extras (por página, aparelho, form_start e hoje) não é ponto da curva.
        if (reqs.some((r) => r.dimensions.length > 1 || JSON.stringify(r.dimensionFilter).includes('form_start'))) return { reports: [] };
        pedidos.push(...reqs.map((r) => r.dateRanges[0].endDate));
        return { reports: reqs.map((r) => ({ dimensionHeaders: [{ name: 'customEvent:exp_variant_string' }], metricHeaders: [{ name: 'totalUsers' }], rows: [{ dimensionValues: [{ value: 'PPG-x-a' }], metricValues: [{ value: String(Number(r.dateRanges[0].endDate.slice(8))) }] }] })) };
      };
      return { pedidos, enviar };
    };

    it('só pede ao GA4 o que não está guardado, e guarda o que pediu', async () => {
      const guardados = new Map([['2026-11-01', linha(100)], ['2026-11-02', linha(200)]]);
      const gravados: string[] = [];
      const guardado: Guardado = {
        ler: async (_c, dias) => new Map(dias.filter((d) => guardados.has(d)).map((d) => [d, guardados.get(d)!])),
        gravar: async (_c, pontos) => { gravados.push(...pontos.keys()); },
      };
      const { pedidos, enviar } = ga4Falso();
      const d = await detalhar('t', detalheTeste!, chave, guardado, enviar);
      expect(pedidos.filter((x) => x <= '2026-11-02')).toEqual([]); // os 2 guardados não vão ao GA4
      expect(gravados).toHaveLength(8);
      expect(d!.acumulado.find((l) => l.dia === '2026-11-01')?.usuarios).toBe(100);
      expect(d!.acumulado.find((l) => l.dia === '2026-11-10')?.usuarios).toBe(10);
      expect(d!.acumulado).toHaveLength(10);
    });

    it('banco fora do ar: pede tudo ao GA4 e a aba abre igual', async () => {
      const guardado: Guardado = { ler: async () => { throw new Error('fora'); }, gravar: async () => { throw new Error('fora'); } };
      const { pedidos, enviar } = ga4Falso();
      const d = await detalhar('t', detalheTeste!, chave, guardado, enviar);
      expect(pedidos).toHaveLength(10);
      expect(d!.acumulado).toHaveLength(10);
    });

    it('dia recente nunca é guardado', async () => {
      const hoje = new Date().toISOString().slice(0, 10);
      const ontem = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      const recente = montarRelatorios({ inicio: ontem, fim: hoje, site: null, detalhe: true }).detalheTeste!;
      const gravados: string[] = [];
      const guardado: Guardado = { ler: async () => new Map(), gravar: async (_c, p) => { gravados.push(...p.keys()); } };
      await detalhar('t', recente, { inicio: ontem, site: '' }, guardado, ga4Falso().enviar);
      expect(gravados).toEqual([]);
    });
  });
});

