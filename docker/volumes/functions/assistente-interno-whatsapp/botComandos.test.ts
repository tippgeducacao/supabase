import { describe, expect, it } from 'vitest';
import {
  dec2, encontrarPessoa, inicioSemanaComercial, interpretarComando, interpretarPeriodo, linhaDasFontes,
  textoMenu, textoPendentes, textoResumoPessoa, type LinhaPessoa, type PessoaComercial,
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

describe('encontrarPessoa', () => {
  const p = (nome: string): PessoaComercial => ({ id: nome, nome, user_type: 'vendedor' });
  const time = [p('Aline Souza'), p('Ana Ligia'), p('Anabela Costa'), p('Pedro Flores'), p('Pedro Henrique'), p('Flávia')];
  it('prefixo de cada palavra, sem acento', () => {
    expect(encontrarPessoa(time, 'ped flo')).toMatchObject({ tipo: 'ok', pessoa: { nome: 'Pedro Flores' } });
    expect(encontrarPessoa(time, 'flavia')).toMatchObject({ tipo: 'ok', pessoa: { nome: 'Flávia' } });
  });
  it('palavra inteira vence o prefixo ("ana" = Ana Ligia, não Anabela)', () => {
    expect(encontrarPessoa(time, 'ana')).toMatchObject({ tipo: 'ok', pessoa: { nome: 'Ana Ligia' } });
  });
  it('empate pergunta de volta; ninguém = nenhuma', () => {
    const r = encontrarPessoa(time, 'pedro');
    expect(r.tipo).toBe('varias');
    expect(r.tipo === 'varias' && r.opcoes.map((o) => o.nome)).toEqual(['Pedro Flores', 'Pedro Henrique']);
    expect(encontrarPessoa(time, 'zé')).toEqual({ tipo: 'nenhuma' });
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
