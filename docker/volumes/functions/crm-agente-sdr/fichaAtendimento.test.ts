import { describe, expect, it } from 'vitest';
import {
  aplicarColetaNaJornada,
  avaliarFicha,
  bloqueioCronograma,
  contarObjecaoNaJornada,
  detectarPedidoDeCronograma,
  grupoDoCadastro,
  montarBlocoFicha,
  registrarBloqueioNaJornada,
  type Jornada,
} from './fichaAtendimento';

describe('grupo do cadastro (resposta do formulário da LP)', () => {
  it('cadastro vago: outra área, sem formação', () => {
    expect(grupoDoCadastro('Sou formado em outra área').grupo).toBe('vago');
    expect(grupoDoCadastro('Não possuo formação').grupo).toBe('vago');
  });
  it('sem cadastro: vazio ou "Não informado"', () => {
    expect(grupoDoCadastro('').grupo).toBe('desconhecido');
    expect(grupoDoCadastro(null).grupo).toBe('desconhecido');
    expect(grupoDoCadastro('Não informado').grupo).toBe('desconhecido');
  });
  it('profissão nomeada vira a formação oficial', () => {
    expect(grupoDoCadastro('Médico Veterinário (a)')).toEqual({ grupo: 'profissao', profissao: 'Medicina Veterinária' });
    expect(grupoDoCadastro('Zootecnista').grupo).toBe('profissao');
    expect(grupoDoCadastro('Engenheiro de Alimentos').grupo).toBe('profissao');
  });
  it('estudante: pelas opções do formulário e pelo texto livre', () => {
    expect(grupoDoCadastro('Estudante da área').grupo).toBe('estudante');
    expect(grupoDoCadastro('Na faculdade do 1º ao 8º período').grupo).toBe('estudante');
    expect(grupoDoCadastro('Na faculdade entre o 9º e 10º período').grupo).toBe('estudante');
  });
});

describe('o que falta coletar antes do cronograma', () => {
  it('cadastro vago sem nada dito: graduação e área', () => {
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada: {} });
    expect(a.faltaParaCronograma).toEqual(['qual é a graduação dele', 'em que área ele atua hoje']);
    expect(a.liberaCronograma).toBe(false);
    expect(a.proximoPasso).toContain('claro, te envio aqui');
  });
  it('cadastro vago com graduação e área ditas: libera', () => {
    const jornada: Jornada = { coleta: { graduacao: 'Agronomia', area_atuacao: 'venda de insumos' } };
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada });
    expect(a.faltaParaCronograma).toEqual([]);
    expect(a.liberaCronograma).toBe(true);
  });
  it('sem cadastro é tratado como vago', () => {
    expect(avaliarFicha({ cadastro: null, jornada: {} }).faltaParaCronograma).toHaveLength(2);
  });
  it('profissão nomeada: só falta saber se já é formado', () => {
    const a = avaliarFicha({ cadastro: 'Médico Veterinário (a)', jornada: {} });
    expect(a.faltaParaCronograma).toEqual(['se ele já é formado em Medicina Veterinária (graduação concluída)']);
  });
  it('profissão nomeada e ficou claro que atua: não pergunta', () => {
    const a = avaliarFicha({ cadastro: 'Zootecnista', jornada: { coleta: { atua_na_area: 'sim' } } });
    expect(a.faltaParaCronograma).toEqual([]);
    expect(a.liberaCronograma).toBe(true);
  });
  it('profissão nomeada e "formado" registrado em tempo_formacao: não pergunta', () => {
    const a = avaliarFicha({ cadastro: 'Zootecnista', jornada: { coleta: { tempo_formacao: 'formado há 3 anos' } } });
    expect(a.faltaParaCronograma).toEqual([]);
  });
  it('estudante: falta a previsão de conclusão', () => {
    const a = avaliarFicha({ cadastro: 'Na faculdade do 1º ao 8º período', jornada: {} });
    expect(a.faltaParaCronograma).toEqual(['quando ele conclui a graduação (mês e ano)']);
    expect(avaliarFicha({ cadastro: 'Estudante da área', jornada: { coleta: { tempo_formacao: 'conclui em 12/2027' } } }).liberaCronograma).toBe(true);
  });
  it('sem graduação nenhuma: não libera e diz por quê', () => {
    const a = avaliarFicha({ cadastro: 'Não possuo formação', jornada: { coleta: { graduacao_concluida: 'nao' } } });
    expect(a.semGraduacao).toBe(true);
    expect(a.liberaCronograma).toBe(false);
    expect(bloqueioCronograma('t1', a).output).toBe('SEM_GRADUACAO');
  });
});

describe('perguntou uma vez e o lead insistiu', () => {
  const inicioRodada = '2026-09-19T14:00:00.000Z';
  it('bloqueio em rodada ANTERIOR libera o envio mesmo sem o dado', () => {
    const jornada: Jornada = { cronograma: { bloqueios: 1, bloqueado_em: '2026-09-19T13:58:00.000Z' } };
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada, inicioRodada });
    expect(a.jaPerguntou).toBe(true);
    expect(a.liberaCronograma).toBe(true);
    expect(a.proximoPasso).toContain('insistiu');
  });
  it('bloqueio na MESMA rodada continua bloqueando (o modelo não pode insistir sozinho)', () => {
    const jornada: Jornada = { cronograma: { bloqueios: 1, bloqueado_em: '2026-09-19T14:00:05.000Z' } };
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada, inicioRodada });
    expect(a.jaPerguntou).toBe(false);
    expect(a.liberaCronograma).toBe(false);
  });
  it('registrarBloqueioNaJornada conta e carimba', () => {
    const j = registrarBloqueioNaJornada(registrarBloqueioNaJornada({}, new Date('2026-09-19T14:00:00Z')), new Date('2026-09-19T14:05:00Z'));
    expect(j.cronograma?.bloqueios).toBe(2);
    expect(j.cronograma?.bloqueado_em).toBe('2026-09-19T14:05:00.000Z');
  });
});

describe('a recusa do envia_informacoes', () => {
  it('é um bloqueio (não concluiu) com o que perguntar', () => {
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada: {} });
    const r = bloqueioCronograma('t9', a);
    expect(r.status).toBe('bloqueado');
    expect(r.output).toBe('PRECISA_COLETAR');
    expect(r.cronograma_enviado).toBe(false);
    expect(r.resultado).toContain('qual é a graduação dele e em que área ele atua hoje');
  });
});

describe('pedido de cronograma no lote de entrada', () => {
  it('clique no botão do template, com a citação embutida pelo webhook', () => {
    const itens = [{ tipo: 'button', mensagem: '[Em resposta à mensagem: "Oii Gustavo Tudo bem?\n\nJá estou com seu cadastro"] Receber Cronograma' }];
    expect(detectarPedidoDeCronograma(itens)).toBe('botao');
  });
  it('pedido em texto curto', () => {
    expect(detectarPedidoDeCronograma([{ tipo: 'text', mensagem: 'me manda o cronograma por aqui?' }])).toBe('texto');
  });
  it('não é pedido: sem a palavra, ou texto longo demais para ser um pedido', () => {
    expect(detectarPedidoDeCronograma([{ tipo: 'text', mensagem: 'boa tarde João tudo bem?' }])).toBeNull();
    expect(detectarPedidoDeCronograma([{ tipo: 'text', mensagem: `${'x'.repeat(130)} cronograma` }])).toBeNull();
  });
  it('a citação do template que fala em cronograma não conta como pedido', () => {
    expect(detectarPedidoDeCronograma([{ tipo: 'text', mensagem: '[Em resposta à mensagem: "te mando o cronograma"] boa tarde' }])).toBeNull();
  });
});

describe('mutações da jornada', () => {
  it('a coleta acumula e normaliza os enums', () => {
    let j = aplicarColetaNaJornada({}, { formacao: 'Agronomia', graduacao_concluida: 'Sim' }, new Date('2026-09-19T14:00:00Z'));
    j = aplicarColetaNaJornada(j, { area_atuacao: 'venda de insumos', atua_na_area: 'NAO', tempo_formacao: 'terminei em 2022' });
    expect(j.coleta).toMatchObject({ graduacao: 'Agronomia', graduacao_concluida: 'sim', area_atuacao: 'venda de insumos', atua_na_area: 'nao', tempo_formacao: 'terminei em 2022' });
    expect(aplicarColetaNaJornada({}, { atua_na_area: 'talvez' }).coleta?.atua_na_area).toBeUndefined();
  });
  it('as objeções contam por tipo', () => {
    const j = contarObjecaoNaJornada(contarObjecaoNaJornada({}, 'objecao_tempo'), 'objecao_tempo');
    expect(contarObjecaoNaJornada(j, 'objecao_canal').objecoes).toEqual({ objecao_tempo: 2, objecao_canal: 1 });
  });
});

describe('o bloco que o modelo lê', () => {
  it('traz cadastro, coleta, cronograma, objeções e o próximo passo, sem "undefined"', () => {
    const jornada: Jornada = {
      cronograma: { pedido_em: '2026-09-18T17:04:38.641Z', pedido_por: 'botao' },
      objecoes: { objecao_tempo: 1 },
      coleta: { graduacao: 'Agronomia' },
    };
    const entrada = { cadastro: 'Sou formado em outra área', jornada, agendado: false, elegibilidade: null };
    const bloco = montarBlocoFicha(entrada, avaliarFicha(entrada));
    expect(bloco).toContain('[FICHA DO ATENDIMENTO');
    expect(bloco).toContain('"Sou formado em outra área" → grupo: formação vaga');
    expect(bloco).toContain('pedido pelo botão do template (18/09 14:04) · ainda não enviado');
    expect(bloco).toContain('Objeções já tratadas: tempo 1x');
    expect(bloco).toContain('FALTA COLETAR antes de enviar o cronograma: em que área ele atua hoje');
    expect(bloco).not.toContain('undefined');
  });
});
