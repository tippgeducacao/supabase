import { describe, expect, it } from 'vitest';
import { comAnterior, desistencia, funil, paginaRelevante, semUtmNoCrm, juntarDias, linkDaVersao, juntarPaginas, juntarUtm, ordenar, sitesDoSeletor, slugDaPagina, testesPorSorteio, valorUtm, variacao } from './mktAnalytics.ts';

const crm = (n: number) => ({ leads: n, qualificados: 0, reunioes: 0, matriculas: 0 });

describe('slugDaPagina (espelho de crm_pagina_slug)', () => {
  it.each([
    ['site.ppgvet.com.br', 'site'],
    ['site.ppgvet.com.br/', 'site'],
    ['https://site.ppgeducacao.com.br/?utm_source=x', 'site'],
    ['site.ppgvet.com.br/pos-sa-b', 'pos-sa-b'],
    ['https://site.ppgvet.com.br/pos/Pos-QSAOA?gclid=1', 'pos-qsaoa'],
    ['www.ppgvet.com.br', 'www.ppgvet.com.br'],
    ['AVES 02', 'aves 02'],
    ['', null],
  ])('%s → %s', (entrada, saida) => expect(slugDaPagina(entrada)).toBe(saida));
});

describe('sitesDoSeletor', () => {
  it('lista os do GA4, sem máquina local nem prévia, e mantém o escolhido', () => {
    const r = sitesDoSeletor(
      [{ host: 'site.ppgvet.com.br', sessoes: 9 }, { host: '127.0.0.1', sessoes: 3 }, { host: 'x-git-y.vercel.app', sessoes: 1 }, { host: 'forum.ppgvet.com.br', sessoes: 2 }],
      'blog.ppgvet.com.br',
    );
    expect(r.map((s) => s.host)).toEqual(['site.ppgvet.com.br', 'forum.ppgvet.com.br', 'blog.ppgvet.com.br']);
    expect(r[0].rotulo).toBe('PPGVET (site.ppgvet.com.br)');
  });
});

describe('juntar GA4 e CRM', () => {
  it('UTM: GA4 em maiúscula e "(not set)" casa com o CRM em minúsculo e null', () => {
    expect(valorUtm('(not set)')).toBeNull();
    const r = juntarUtm(
      [{ source: 'Meta', medium: 'paid_social', campaign: 'X', content: '(not set)', term: '(not set)', usuarios: 10, pessoas_lead: 2 }],
      [{ source: 'meta', medium: 'paid_social', campaign: 'x', content: null, term: null, ...crm(3) }],
      'tudo',
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ pessoas: 10, leadsGa4: 2, leads: 3 });
  });

  it('UTM agrupado por origem soma as campanhas', () => {
    const r = juntarUtm(
      [
        { source: 'meta', medium: 'paid_social', campaign: 'a', content: '', term: '', usuarios: 1, pessoas_lead: 0 },
        { source: 'meta', medium: 'paid_social', campaign: 'b', content: '', term: '', usuarios: 2, pessoas_lead: 1 },
      ],
      [],
      'origem',
    );
    expect(r).toEqual([expect.objectContaining({ pessoas: 3, leadsGa4: 1, chave: { source: 'meta', medium: 'paid_social' } })]);
  });

  it('agrupar só por origem ou só por meio', () => {
    const ga4 = [
      { source: 'meta', medium: 'paid_social', campaign: 'a', content: '', term: '', usuarios: 10, pessoas_lead: 1 },
      { source: 'google', medium: 'paid_social', campaign: 'b', content: '', term: '', usuarios: 5, pessoas_lead: 1 },
    ];
    expect(juntarUtm(ga4, [], 'meio')).toEqual([expect.objectContaining({ pessoas: 15, chave: { medium: 'paid_social' } })]);
    expect(juntarUtm(ga4, [], 'fonte').map((l) => l.chave.source)).toEqual(['meta', 'google']);
  });

  it('página: home do GA4 ("/") casa com a do CRM e www some', () => {
    const r = juntarPaginas(
      [{ host: 'www.site.ppgvet.com.br', pagina: '/', usuarios: 5, pessoas_lead: 1 }],
      [{ host: 'site.ppgvet.com.br', slug: 'site', ...crm(2) }],
    );
    expect(r).toEqual([expect.objectContaining({ slug: 'site', pessoas: 5, leads: 2 })]);
  });

  it('dias: período inteiro, inclusive o dia sem nada', () => {
    const r = juntarDias('2026-11-01', '2026-11-03', [{ dia: '2026-11-01', usuarios: 4, pessoas_lead: 1 }], [{ dia: '2026-11-03', ...crm(2) }]);
    expect(r.map((d) => [d.dia, d.pessoas, d.leads])).toEqual([['2026-11-01', 4, 0], ['2026-11-02', 0, 0], ['2026-11-03', 0, 2]]);
  });
});

describe('UTMs e páginas', () => {
  it('orgânico e indicação sem lead no CRM viram "—"; com lead, mostra o número', () => {
    expect(semUtmNoCrm({ chave: { source: 'google', medium: 'organic' }, leads: 0 })).toBe(true);
    expect(semUtmNoCrm({ chave: { source: 'facebook.com', medium: 'referral' }, leads: 0 })).toBe(true);
    expect(semUtmNoCrm({ chave: { source: 'google', medium: 'organic' }, leads: 2 })).toBe(false);
    expect(semUtmNoCrm({ chave: { source: 'google', medium: 'cpc' }, leads: 0 })).toBe(false);
    expect(semUtmNoCrm({ chave: { source: 'google' }, leads: 0 })).toBe(false);
  });
  it('lista enxuta: 5 pessoas ou mais, ou com lead', () => {
    const l = { pessoas: 1, leadsGa4: 0, leads: 0, qualificados: 0, reunioes: 0, matriculas: 0 };
    expect(paginaRelevante(l)).toBe(false);
    expect(paginaRelevante({ ...l, pessoas: 5 })).toBe(true);
    expect(paginaRelevante({ ...l, leads: 1 })).toBe(true);
    expect(paginaRelevante({ ...l, leadsGa4: 1 })).toBe(true);
  });
});

describe('Visão geral', () => {
  const ga4 = { sessoes: 120, usuarios: 100, leads: 12, pessoas_lead: 11, comecou: 20 };
  const crm1 = { leads: 10, qualificados: 6, reunioes: 2, matriculas: 1 };
  it('funil: sem dado do GA4 no período anterior, a comparação some só na etapa do GA4', () => {
    const f = funil(ga4, crm1, { sessoes: 0, usuarios: 0, leads: 0, pessoas_lead: 0, comecou: 0 }, { leads: 8, qualificados: 4, reunioes: 2, matriculas: 0 });
    expect(f.map((e) => [e.nome, e.valor, e.anterior])).toEqual([
      ['Pessoas', 100, null], ['Começou o formulário', 20, null], ['Leads', 10, 8], ['Qualificados', 6, 4], ['Reunião realizada', 2, 2], ['Matrícula', 1, 0],
    ]);
    // Com o período anterior do GA4, o começou compara também.
    expect(funil(ga4, crm1, { ...ga4, comecou: 16 }, null)[1]).toEqual({ nome: 'Começou o formulário', valor: 20, anterior: 16 });
  });
  it('desistência: começou e não mandou, nunca negativa', () => {
    expect(desistencia(ga4)).toEqual({ pessoas: 9, taxa: 45 });
    expect(desistencia({ ...ga4, comecou: 5 })).toEqual({ pessoas: 0, taxa: 0 });
    expect(desistencia({ ...ga4, comecou: undefined })).toEqual({ pessoas: 0, taxa: null });
  });
  it('variação: sem base é null (nunca "-100%" falso)', () => {
    expect(variacao(10, 8)).toBe(25);
    expect(variacao(10, 0)).toBeNull();
    expect(variacao(10, null)).toBeNull();
  });
  it('série com o período anterior alinhada por posição', () => {
    const dias = juntarDias('2026-11-08', '2026-11-09', [{ dia: '2026-11-08', usuarios: 50, pessoas_lead: 5 }], [{ dia: '2026-11-08', ...crm(4) }]);
    const ant = juntarDias('2026-11-06', '2026-11-07', [{ dia: '2026-11-06', usuarios: 40, pessoas_lead: 2 }], []);
    const s = comAnterior(dias, ant);
    expect(s[0]).toMatchObject({ dia: '2026-11-08', pessoas: 50, leads: 4, taxa: 8, ant_pessoas: 40, ant_leads: 0 });
    expect(s[1].ant_taxa).toBeNull();
  });
});

describe('ordenar', () => {
  it('número, texto em português e vazio sempre no fim', () => {
    const l = [{ n: 2, t: 'Ônibus' }, { n: null, t: '' }, { n: 10, t: 'abacate' }];
    expect(ordenar(l, (x) => x.n, true).map((x) => x.n)).toEqual([10, 2, null]);
    expect(ordenar(l, (x) => x.n, false).map((x) => x.n)).toEqual([2, 10, null]);
    expect(ordenar(l, (x) => x.t, false).map((x) => x.t)).toEqual(['abacate', 'Ônibus', '']);
  });
});

describe('testes A/B', () => {
  it('por sorteio: controle é a versão a e divisão torta avisa', () => {
    const [t] = testesPorSorteio(
      [{ exp: 'PPG-hero-a', usuarios: 5300 }, { exp: 'PPG-hero-b', usuarios: 4700 }],
      [{ exp: 'PPG-hero-a', ...crm(30) }, { exp: 'PPG-hero-b', ...crm(30) }],
    );
    expect(t).toMatchObject({ nome: 'hero', versaoA: 'a', versaoB: 'b', expostos: [5300, 4700] });
    expect(t.avisos.some((a) => a.startsWith('Divisão torta'))).toBe(true);
    // A regra dos 7 dias vem do cadastro: com 3 dias de teste, nada de vencedor.
    const [cedo] = testesPorSorteio(
      [{ exp: 'PPG-hero-a', usuarios: 1000 }, { exp: 'PPG-hero-b', usuarios: 1000 }],
      [{ exp: 'PPG-hero-a', ...crm(40) }, { exp: 'PPG-hero-b', ...crm(120) }],
      3, { hero: 3 },
    );
    expect(cedo.lead.veredito).toBe('cedo');
    // Pouco dado: sem vencedor, com "faltam ~X".
    expect(t.lead.veredito).not.toBe('b-ganha');
    expect(t.faltam?.pessoas).toBeGreaterThan(0);
  });

  it('chave com hífen não se confunde com a versão', () => {
    const r = testesPorSorteio([{ exp: 'PPG-hero-form-a', usuarios: 10 }, { exp: 'PPG-hero-form-b', usuarios: 10 }], []);
    expect(r.map((x) => x.nome)).toEqual(['hero-form']);
  });
});

describe('linkDaVersao', () => {
  it('abre a versão pelo ?ab= dos sites, mantendo a query da página', () => {
    expect(linkDaVersao('https://site.ppgvet.com.br/pos-sa', 'form-aberto', 'b')).toBe('https://site.ppgvet.com.br/pos-sa?ab=form-aberto:b');
    expect(linkDaVersao('https://site.ppgvet.com.br/pos-sa?x=1', 'form-aberto', 'a')).toBe('https://site.ppgvet.com.br/pos-sa?x=1&ab=form-aberto:a');
  });
});
