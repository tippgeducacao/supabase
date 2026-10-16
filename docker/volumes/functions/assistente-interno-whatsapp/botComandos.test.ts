import { describe, expect, it } from 'vitest';
import {
  dec2, encontrarPorNome, inicioSemanaComercial, interpretarComando, interpretarPeriodo, lerItensPos, linhaDasFontes,
  mesesDoPeriodo, textoCac, textoFaturamento, textoMenu, textoPendentes, textoRanking, textoResumoPessoa, textoResumoPos,
  type ItemPos, type LinhaPessoa, type PessoaComercial,
} from './botComandos';

const HOJE = '2026-10-16'; // sexta

describe('interpretarPeriodo', () => {
  it('vazio e "semana" = semana comercial, de quarta até hoje', () => {
    expect(interpretarPeriodo('', HOJE)).toMatchObject({ de: '2026-10-14', ate: '2026-10-16' });
    expect(interpretarPeriodo('semana', HOJE)?.rotulo).toBe('Semana comercial · qua 14/10 a sex 16/10');
  });
  it('hoje, ontem, semana passada, mês, mês passado', () => {
    expect(interpretarPeriodo('hoje', HOJE)).toMatchObject({ de: HOJE, ate: HOJE });
    expect(interpretarPeriodo('ontem', HOJE)).toMatchObject({ de: '2026-10-15', ate: '2026-10-15' });
    expect(interpretarPeriodo('semana passada', HOJE)).toMatchObject({ de: '2026-10-07', ate: '2026-10-13' });
    expect(interpretarPeriodo('mês', HOJE)).toMatchObject({ de: '2026-10-01', ate: HOJE });
    expect(interpretarPeriodo('mes passado', HOJE)).toMatchObject({ de: '2026-09-01', ate: '2026-09-30' });
  });
  it('datas: um dia e faixa (a / até / -)', () => {
    expect(interpretarPeriodo('15/10', HOJE)).toMatchObject({ de: '2026-10-15', ate: '2026-10-15' });
    expect(interpretarPeriodo('01/10 a 15/10', HOJE)).toMatchObject({ de: '2026-10-01', ate: '2026-10-15', rotulo: '01/10 a 15/10' });
    expect(interpretarPeriodo('de 1/10 até 10/10', HOJE)).toMatchObject({ de: '2026-10-01', ate: '2026-10-10' });
    expect(interpretarPeriodo('01/09/2026 - 30/09/2026', HOJE)).toMatchObject({ de: '2026-09-01', ate: '2026-09-30' });
  });
  it('não passa de hoje; futuro, data inválida e mais de 120 dias = null', () => {
    expect(interpretarPeriodo('10/10 a 30/10', HOJE)).toMatchObject({ de: '2026-10-10', ate: HOJE });
    expect(interpretarPeriodo('20/10', HOJE)).toBeNull();
    expect(interpretarPeriodo('31/02', HOJE)).toBeNull();
    expect(interpretarPeriodo('01/01 a 16/10', HOJE)).toBeNull();
    expect(interpretarPeriodo('xyz', HOJE)).toBeNull();
  });
  it('a semana comercial começa na quarta', () => {
    expect(inicioSemanaComercial('2026-10-14')).toBe('2026-10-14'); // qua
    expect(inicioSemanaComercial('2026-10-20')).toBe('2026-10-14'); // ter
    expect(inicioSemanaComercial('2026-10-21')).toBe('2026-10-21'); // qua seguinte
  });
});

describe('interpretarComando', () => {
  it('saudação e desconhecido', () => {
    expect(interpretarComando('Oi', HOJE)).toEqual({ tipo: 'menu' });
    expect(interpretarComando('MENU', HOJE)).toEqual({ tipo: 'menu' });
    expect(interpretarComando('quanto vendemos?', HOJE)).toEqual({ tipo: 'desconhecido' });
  });
  it('resumo: nome sozinho = semana; nome composto + período', () => {
    expect(interpretarComando('resumo Aline', HOJE)).toMatchObject({ tipo: 'resumo', nome: 'aline', periodo: { de: '2026-10-14' } });
    expect(interpretarComando('Resumo da Ana Paula mês passado', HOJE))
      .toMatchObject({ tipo: 'resumo', nome: 'ana paula', periodo: { de: '2026-09-01', ate: '2026-09-30' } });
    expect(interpretarComando('resumo Pedro 01/10 a 15/10', HOJE))
      .toMatchObject({ tipo: 'resumo', nome: 'pedro', periodo: { de: '2026-10-01', ate: '2026-10-15' } });
    expect(interpretarComando('resumo', HOJE)).toEqual({ tipo: 'resumo_sem_nome' });
  });
  it('comercial e pendentes', () => {
    expect(interpretarComando('comercial ontem', HOJE)).toMatchObject({ tipo: 'comercial', periodo: { de: '2026-10-15' } });
    expect(interpretarComando('comercial', HOJE)).toMatchObject({ tipo: 'comercial', periodo: { de: '2026-10-14' } });
    expect(interpretarComando('comercial amanhã', HOJE)).toMatchObject({ tipo: 'periodo_invalido' });
    expect(interpretarComando('pendentes', HOJE)).toEqual({ tipo: 'pendentes' });
  });
});

describe('encontrarPorNome', () => {
  const p = (nome: string): PessoaComercial => ({ id: nome, nome, user_type: 'vendedor' });
  const time = [p('Aline Souza'), p('Ana Ligia'), p('Anabela Costa'), p('Pedro Flores'), p('Pedro Henrique'), p('Flávia')];
  it('prefixo de cada palavra, sem acento', () => {
    expect(encontrarPorNome(time, 'ped flo')).toMatchObject({ tipo: 'ok', item: { nome: 'Pedro Flores' } });
    expect(encontrarPorNome(time, 'flavia')).toMatchObject({ tipo: 'ok', item: { nome: 'Flávia' } });
  });
  it('palavra inteira vence o prefixo ("ana" = Ana Ligia, não Anabela)', () => {
    expect(encontrarPorNome(time, 'ana')).toMatchObject({ tipo: 'ok', item: { nome: 'Ana Ligia' } });
  });
  it('empate pergunta de volta; ninguém = nenhuma', () => {
    const r = encontrarPorNome(time, 'pedro');
    expect(r.tipo).toBe('varias');
    expect(r.tipo === 'varias' && r.opcoes.map((o) => o.nome)).toEqual(['Pedro Flores', 'Pedro Henrique']);
    expect(encontrarPorNome(time, 'zé')).toEqual({ tipo: 'nenhuma' });
  });
});

describe('linhaDasFontes', () => {
  const ID = '746b9d73-dc58-47d3-905f-cdb176567b4e';
  it('vendedor: leads do funil, reuniões/vendas da atividade, interações dos extras (dado real de 14–16/10)', () => {
    const f = {
      papel: 'vendedor', nome: 'Erika Costa',
      funil: {
        vendedores: [{ id: ID, leads: 58, agendaram: 2, compareceram: 0, converteram: 0 }],
        atividade: { vendedores: [{ id: ID, reunioes: 6, compareceram: 1, nao_compareceram: 1, convertidas: 2 }] },
      },
      atividade: { linhas: [{ vendedor_id: ID, mensagens_humanas_enviadas: 201, mensagens_com_lead: 201, leads_contatados_whatsapp: 72, tempo_conversa_segundos: 749, indicacoes_cadastradas: 0, organicos_cadastrados: 0 }] },
    };
    expect(linhaDasFontes(f, ID)).toEqual({
      nome: 'Erika Costa', papel: 'vendedor', leads: 58, agendamentos: 6, comparecimentos: 1, naoCompareceram: 1, matriculas: 2,
      interacoes: 201, interacoesComLead: 201, leadsInteragidos: 72, ligacaoSegundos: 749, indicacoes: 0, organicos: 0,
    });
  });
  it('SDR: leads de recebidos, o resto da atividade do SDR', () => {
    const f = {
      papel: 'sdr', nome: 'Flávia',
      recebidos: { linhas: [{ usuario_id: ID, leads_recebidos: 24 }] },
      atividade: { linhas: [{ sdr_id: ID, agendamentos: 4, comparecimentos: 1, nao_compareceram: 0, matriculas: 2, mensagens_humanas_enviadas: 451, mensagens_com_lead: 451, leads_contatados_whatsapp: 140, tempo_conversa_segundos: 2794, indicacoes_cadastradas: 0, organicos_cadastrados: 6 }] },
    };
    expect(linhaDasFontes(f, ID)).toMatchObject({ papel: 'sdr', leads: 24, agendamentos: 4, comparecimentos: 1, matriculas: 2, interacoes: 451, organicos: 6 });
  });
  it('sem linha na fonte = zeros, e atividade ausente = "—" (null), nunca zero inventado', () => {
    const l = linhaDasFontes({ papel: 'sdr', nome: 'X', recebidos: { linhas: [] }, atividade: { linhas: [] } }, ID);
    expect(l).toMatchObject({ leads: 0, agendamentos: 0, matriculas: 0, interacoes: null, ligacaoSegundos: null });
  });
});

describe('textos', () => {
  const linha: LinhaPessoa = {
    nome: 'Erika Costa', papel: 'vendedor', leads: 58, agendamentos: 6, comparecimentos: 1, naoCompareceram: 1, matriculas: 2,
    interacoes: 201, interacoesComLead: 201, leadsInteragidos: 72, ligacaoSegundos: 749, indicacoes: 0, organicos: 0,
  };
  const periodo = { de: '2026-10-14', ate: '2026-10-16', rotulo: 'Semana comercial · qua 14/10 a sex 16/10' };
  it('resumo: números, taxas com 2 casas e comparecimento só sobre reuniões com resultado', () => {
    const t = textoResumoPessoa(linha, periodo);
    expect(t).toContain('👤 *Erika Costa* · Vendedor(a)');
    expect(t).toContain('📥 Leads recebidos: *58*');
    expect(t).toContain('• Vendas ÷ leads: *3,45%*');
    expect(t).toContain('• Vendas ÷ comparecidas: *200,00%*');
    expect(t).toContain('• Comparecimento: *50,00%*'); // 1 ÷ (1 + 1), não 1 ÷ 6
    expect(t).toContain('• Comparecidas ÷ leads: *1,72%*');
    expect(t).toContain('💬 Interações no WhatsApp: *201* · média *2,79* por lead (72 leads)');
    expect(t).toContain('📞 Tempo em ligação (3C): *12min*');
  });
  it('sem denominador = "—", não 0,00%', () => {
    const t = textoResumoPessoa({ ...linha, leads: 0, comparecimentos: 0, naoCompareceram: 0 }, periodo);
    expect(t).toContain('• Vendas ÷ leads: *—*');
    expect(t).toContain('• Comparecimento: *—*');
  });
  it('menu lista os comandos', () => {
    const t = textoMenu();
    for (const c of ['resumo <nome>', 'comercial', 'pendentes', 'menu']) expect(t).toContain(c);
  });
  it('pendentes: quantidade, quebra e valor em reais', () => {
    expect(textoPendentes({ qtd: 5, faturamento: 61234.5, quebra: { pos: { qtd: 5 }, cursos: { qtd: 0 }, modulos: { qtd: 0 } } }))
      .toContain('*5* (5 pós)');
    expect(textoPendentes({ qtd: 5, faturamento: 61234.5, quebra: {} })).toContain('R$ 61.234,50');
    expect(textoPendentes({ qtd: 0 })).toContain('nenhuma');
  });
  it('dec2 sempre com 2 casas', () => {
    expect(dec2(5)).toBe('5,00');
  });
});

describe('meses pelo nome e comandos novos', () => {
  it('"setembro" = o mês inteiro; mês corrente vai até hoje; mês futuro = ano passado', () => {
    expect(interpretarPeriodo('setembro', HOJE)).toMatchObject({ de: '2026-09-01', ate: '2026-09-30', rotulo: 'Setembro/2026 · 01/09 a 30/09' });
    expect(interpretarPeriodo('outubro', HOJE)).toMatchObject({ de: '2026-10-01', ate: HOJE });
    expect(interpretarPeriodo('dezembro', HOJE)).toMatchObject({ de: '2025-12-01', ate: '2025-12-31' });
    expect(interpretarPeriodo('março de 2026', HOJE)).toMatchObject({ de: '2026-03-01', ate: '2026-03-31' });
    expect(interpretarPeriodo('fevereiro', HOJE)).toMatchObject({ de: '2026-02-01', ate: '2026-02-28' });
  });
  it('pos: nome + período, como o resumo', () => {
    expect(interpretarComando('pos sanidade avícola mês', HOJE))
      .toMatchObject({ tipo: 'pos', nome: 'sanidade avicola', periodo: { de: '2026-10-01' } });
    expect(interpretarComando('Pós bovinos', HOJE)).toMatchObject({ tipo: 'pos', nome: 'bovinos', periodo: { de: '2026-10-14' } });
    expect(interpretarComando('pos', HOJE)).toEqual({ tipo: 'pos_sem_nome' });
  });
  it('ranking e faturamento: período padrão = semana; cac: padrão = mês atual', () => {
    expect(interpretarComando('ranking setembro', HOJE)).toMatchObject({ tipo: 'ranking', periodo: { de: '2026-09-01', ate: '2026-09-30' } });
    expect(interpretarComando('faturamento', HOJE)).toMatchObject({ tipo: 'faturamento', periodo: { de: '2026-10-14' } });
    expect(interpretarComando('receita ontem', HOJE)).toMatchObject({ tipo: 'faturamento', periodo: { de: '2026-10-15' } });
    expect(interpretarComando('cac', HOJE)).toMatchObject({ tipo: 'cac', periodo: { de: '2026-10-01', ate: HOJE } });
    expect(interpretarComando('cac mês passado', HOJE)).toMatchObject({ tipo: 'cac', periodo: { de: '2026-09-01' } });
  });
  it('"resumo comercial ontem" e "resumo da pós X" viram os comandos certos (uso real de 16/10)', () => {
    expect(interpretarComando('Resumo comercial ontem', HOJE)).toMatchObject({ tipo: 'comercial', periodo: { de: '2026-10-15' } });
    expect(interpretarComando('resumo do time mês', HOJE)).toMatchObject({ tipo: 'comercial', periodo: { de: '2026-10-01' } });
    expect(interpretarComando('resumo da pós sanidade', HOJE)).toMatchObject({ tipo: 'pos', nome: 'sanidade' });
    expect(interpretarComando('resumo adones mês', HOJE)).toMatchObject({ tipo: 'resumo', nome: 'adones' });
  });
  it('busca de pós ignora o "PÓS |" e acha por qualquer palavra', () => {
    const pos = [{ nome: 'PÓS | SANIDADE AVÍCOLA' }, { nome: 'PÓS | NUTRIÇÃO E GESTÃO DE BOVINOS' }, { nome: 'PÓS | CLÍNICA MÉDICA E CIRÚRGICA DE BOVINOS' }];
    expect(encontrarPorNome(pos, 'sanidade')).toMatchObject({ tipo: 'ok', item: { nome: 'PÓS | SANIDADE AVÍCOLA' } });
    expect(encontrarPorNome(pos, 'bovinos').tipo).toBe('varias');
    expect(encontrarPorNome(pos, 'clinica bov')).toMatchObject({ tipo: 'ok', item: { nome: 'PÓS | CLÍNICA MÉDICA E CIRÚRGICA DE BOVINOS' } });
  });
});

const item = (o: Partial<ItemPos>): ItemPos => ({
  curso_id: 'x', nome: 'PÓS | X', tipo: 'Pós-Graduação', ativo: true, categoria: 'pos_graduacao',
  vendas: 0, faturamento: 0, valor_contratos: 0, valor_matriculas: 0, leads: 0, qualificados: 0,
  verba: 0, reunioes: 0, avaliadas: 0, comparecidas: 0, ...o,
});
const SETEMBRO = { de: '2026-09-01', ate: '2026-09-30', rotulo: 'Setembro/2026 · 01/09 a 30/09' };

describe('pós, ranking e faturamento', () => {
  it('lerItensPos converte o jsonb da função', () => {
    const [i] = lerItensPos({ itens: [{ curso_id: 'a', nome: 'PÓS | A', tipo: 'Pós-Graduação', categoria: 'pos_graduacao', vendas: 3, faturamento: '45000.00', verba: '9363.98' }] });
    expect(i).toMatchObject({ vendas: 3, faturamento: 45000, verba: 9363.98, leads: 0 });
  });
  it('resumo da pós: faturamento com matrícula, ticket e CAC de mídia', () => {
    const t = textoResumoPos(item({ nome: 'PÓS | SANIDADE AVÍCOLA', vendas: 3, faturamento: 45000, valor_contratos: 43522.5, valor_matriculas: 1477.5,
      leads: 210, qualificados: 150, verba: 9363.98, reunioes: 18, avaliadas: 15, comparecidas: 9 }), SETEMBRO);
    expect(t).toContain('🎓 *PÓS | SANIDADE AVÍCOLA*');
    expect(t).toContain('✅ Comparecidas: *9* · comparecimento *60,00%*');
    expect(t).toContain('💵 Faturamento: *R$ 45.000,00*');
    expect(t).toContain('contratos R$ 43.522,50 + matrículas R$ 1.477,50');
    expect(t).toContain('ticket médio R$ 15.000,00');
    expect(t).toContain('💸 CAC de mídia (verba ÷ vendas): *R$ 3.121,33*');
  });
  it('ranking: só pós com venda, por vendas e depois faturamento, com medalhas e total', () => {
    const t = textoRanking([
      item({ nome: 'PÓS | B', vendas: 5, faturamento: 60000 }),
      item({ nome: 'PÓS | A', vendas: 5, faturamento: 80000 }),
      item({ nome: 'PÓS | C', vendas: 1, faturamento: 15000 }),
      item({ nome: 'PÓS | SEM VENDA', vendas: 0 }),
      item({ nome: 'CURSO | LIVRE', tipo: null, categoria: 'curso_livre', vendas: 9, faturamento: 900 }),
    ], SETEMBRO);
    expect(t.indexOf('🥇 PÓS | A')).toBeGreaterThan(-1);
    expect(t.indexOf('🥈 PÓS | B')).toBeGreaterThan(-1);
    expect(t).toContain('🥉 PÓS | C — *1* venda · R$ 15.000,00');
    expect(t).not.toContain('SEM VENDA');
    expect(t).not.toContain('CURSO | LIVRE');
    expect(t).toContain('*Total:* 11 vendas de pós · R$ 155.000,00 (matrícula inclusa)');
  });
  it('faturamento: pós com contrato + matrícula, cursos e módulos, e o total', () => {
    const t = textoFaturamento([
      item({ vendas: 121, faturamento: 1440000, valor_contratos: 1417812.25, valor_matriculas: 22187.75 }),
      item({ nome: 'CURSO | Y', tipo: null, categoria: 'curso_livre', vendas: 13, faturamento: 23437.99 }),
    ], SETEMBRO);
    expect(t).toContain('🎓 Pós-graduação: *R$ 1.440.000,00* · 121 vendas');
    expect(t).toContain('contratos R$ 1.417.812,25 + matrículas R$ 22.187,75');
    expect(t).toContain('📘 Cursos livres: *R$ 23.437,99* · 13 vendas');
    expect(t).toContain('*Total: R$ 1.463.437,99* · 134 vendas');
  });
});

describe('CAC', () => {
  // mkt_cac_mensal de setembro/2026 (dado real, 16/10/2026).
  const setembro = [
    { mes: '2026-09-01', canal_nome: 'Indicação', custo: 4710, verba_midia: 0, matriculas: 17, mes_consolidado: true },
    { mes: '2026-09-01', canal_nome: 'Orgânico', custo: 17110, verba_midia: 0, matriculas: 36, mes_consolidado: true },
    { mes: '2026-09-01', canal_nome: 'Tráfego pago', custo: 180751.66, verba_midia: 123871.66, matriculas: 68, mes_consolidado: true },
  ];
  it('geral = custo total ÷ matrículas; por canal, maior primeiro', () => {
    const t = textoCac(setembro, SETEMBRO);
    expect(t).toContain('💸 *CAC* · Setembro/2026 (fechado)');
    expect(t).toContain('Custo total (mídia + times): *R$ 202.571,66*');
    expect(t).toContain('*CAC geral: R$ 1.674,15 por matrícula*');
    expect(t.indexOf('Tráfego pago')).toBeLessThan(t.indexOf('Orgânico'));
    expect(t).toContain('• Tráfego pago: *R$ 2.658,11* por matrícula (68 matr.) · mídia R$ 123.871,66');
  });
  it('mês aberto avisa da premiação', () => {
    const t = textoCac([{ ...setembro[0], mes: '2026-10-01', mes_consolidado: false }], SETEMBRO);
    expect(t).toContain('(mês aberto)');
    expect(t).toContain('a premiação só entra quando o mês fecha');
  });
  it('o período vira os meses inteiros que ele toca', () => {
    expect(mesesDoPeriodo({ de: '2026-09-28', ate: '2026-10-02', rotulo: '' })).toEqual({ ini: '2026-09-01', fim: '2026-10-31' });
    expect(mesesDoPeriodo({ de: '2026-12-10', ate: '2026-12-11', rotulo: '' })).toEqual({ ini: '2026-12-01', fim: '2026-12-31' });
  });
});
