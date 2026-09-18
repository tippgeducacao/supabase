import { describe, expect, it } from 'vitest';
import {
  aplicarColetaNaJornada,
  aplicarPerguntasNaJornada,
  avaliarFicha,
  bloqueioCronograma,
  contarObjecaoNaJornada,
  detectarPedidoDeCronograma,
  deveMarcarPergunta,
  grupoDoCadastro,
  montarBlocoFicha,
  perguntasFeitas,
  perguntouColeta,
  perguntouPos,
  registrarBloqueioNaJornada,
  registrarEnvioNaJornada,
  registrarPerguntaNaJornada,
  SCRIPT_ANTES_DO_CRONOGRAMA,
  SCRIPT_PERGUNTA_POS,
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
  it('cadastro vago sem nada dito: graduação e área, com o script que NOMEIA o cronograma', () => {
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada: {} });
    expect(a.faltaParaCronograma).toEqual(['qual é a graduação dele', 'em que área ele atua hoje']);
    expect(a.liberaCronograma).toBe(false);
    expect(a.proximoPasso).toContain(SCRIPT_ANTES_DO_CRONOGRAMA);
    expect(SCRIPT_ANTES_DO_CRONOGRAMA).toContain('cronograma');
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
    expect(a.graduacaoConcluida).toBe(false);
  });
  it('profissão nomeada e ficou claro que atua: não pergunta e conta como formado', () => {
    const a = avaliarFicha({ cadastro: 'Zootecnista', jornada: { coleta: { atua_na_area: 'sim' } } });
    expect(a.faltaParaCronograma).toEqual([]);
    expect(a.liberaCronograma).toBe(true);
    expect(a.graduacaoConcluida).toBe(true);
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
    expect(a.proximoPasso).toContain('já perguntou uma vez');
  });
  it('bloqueio na MESMA rodada continua bloqueando (o modelo não pode insistir sozinho)', () => {
    const jornada: Jornada = { cronograma: { bloqueios: 1, bloqueado_em: '2026-09-19T14:00:05.000Z' } };
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada, inicioRodada });
    expect(a.jaPerguntou).toBe(false);
    expect(a.liberaCronograma).toBe(false);
  });
  it('a pergunta só conta quando o texto ENVIADO perguntou de fato (a rodada pode ter ido para uma objeção)', () => {
    const entrada = { cadastro: 'Sou formado em outra área', jornada: { cronograma: { pedido_em: '2026-09-19T13:58:00.000Z', pedido_por: 'texto' as const } }, inicioRodada };
    const a = avaliarFicha(entrada);
    expect(deveMarcarPergunta(entrada, a)).toBe(true);
    // 18/09 16:52: o pedido veio junto com "tô sem tempo" e o João tratou a objeção — não perguntou.
    expect(perguntasFeitas(entrada, a, 'tranquilo, sei que a rotina pode ser corrida. a conversa com o monitor leva cerca de 10 minutos. qual período fica melhor, manhã, tarde ou noite?')).toEqual([]);
    // 18/09 16:54: aqui sim perguntou.
    const marcas = perguntasFeitas(entrada, a, 'claro, te mando o cronograma completo da pós por aqui. só antes me confirma: qual é a sua graduação e em que área vc atua hoje?');
    expect(marcas).toEqual(['coleta']);
    const marcada = aplicarPerguntasNaJornada(entrada.jornada, marcas, new Date('2026-09-19T14:00:30Z'));
    expect(avaliarFicha({ ...entrada, jornada: marcada }).jaPerguntou).toBe(false);
    const depois = avaliarFicha({ ...entrada, jornada: marcada, inicioRodada: '2026-09-19T14:03:00.000Z' });
    expect(depois.jaPerguntou).toBe(true);
    expect(depois.liberaCronograma).toBe(true);
  });
  it('sem pedido pendente (nada pedido, ou já enviado depois do pedido) não marca pergunta', () => {
    const base = { cadastro: 'Sou formado em outra área', inicioRodada };
    expect(deveMarcarPergunta({ ...base, jornada: {} }, avaliarFicha({ ...base, jornada: {} }))).toBe(false);
    const enviado: Jornada = { cronograma: { pedido_em: '2026-09-19T13:00:00.000Z', enviado_em: '2026-09-19T13:01:00.000Z' } };
    expect(deveMarcarPergunta({ ...base, jornada: enviado }, avaliarFicha({ ...base, jornada: enviado }))).toBe(false);
    const pediuDeNovo: Jornada = { cronograma: { pedido_em: '2026-09-19T13:05:00.000Z', enviado_em: '2026-09-19T13:01:00.000Z' } };
    expect(deveMarcarPergunta({ ...base, jornada: pediuDeNovo }, avaliarFicha({ ...base, jornada: pediuDeNovo }))).toBe(true);
  });
  it('registrarBloqueioNaJornada conta e carimba', () => {
    const j = registrarBloqueioNaJornada(registrarBloqueioNaJornada({}, new Date('2026-09-19T14:00:00Z')), new Date('2026-09-19T14:05:00Z'));
    expect(j.cronograma?.bloqueios).toBe(2);
    expect(j.cronograma?.bloqueado_em).toBe('2026-09-19T14:05:00.000Z');
  });
});

describe('a pergunta da pós depois do cronograma', () => {
  const enviado = (coleta: Jornada['coleta']): Jornada => registrarEnvioNaJornada({ cronograma: { pedido_em: '2026-09-19T13:00:00.000Z', pedido_por: 'botao' }, coleta }, new Date('2026-09-19T13:01:00Z'));
  it('graduação concluída + cronograma enviado + pós desconhecida: pergunta junto com o "chegou?"', () => {
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada: enviado({ graduacao: 'Agronomia', area_atuacao: 'insumos', graduacao_concluida: 'sim' }) });
    expect(a.perguntarPos).toBe(true);
    expect(a.proximoPasso).toContain(SCRIPT_PERGUNTA_POS);
  });
  it('ainda cursando: não pergunta se tem pós', () => {
    const a = avaliarFicha({ cadastro: 'Estudante da área', jornada: enviado({ tempo_formacao: 'conclui em 12/2027', graduacao_concluida: 'cursando' }) });
    expect(a.perguntarPos).toBe(false);
  });
  it('já respondeu ou já foi perguntado: não repete', () => {
    const respondeu = avaliarFicha({ cadastro: 'Zootecnista', jornada: enviado({ atua_na_area: 'sim', possui_pos: 'nao' }) });
    expect(respondeu.perguntarPos).toBe(false);
    expect(respondeu.proximoPasso).toContain('Cronograma já enviado');
    const jornada = enviado({ atua_na_area: 'sim' });
    const a = avaliarFicha({ cadastro: 'Zootecnista', jornada });
    expect(perguntasFeitas({ cadastro: 'Zootecnista', jornada }, a, 'te enviei o cronograma por aqui. chegou o arquivo pra vc? e me diz, vc já possui alguma pós-graduação?')).toEqual(['pos']);
    const marcada = aplicarPerguntasNaJornada(jornada, ['pos']);
    expect(avaliarFicha({ cadastro: 'Zootecnista', jornada: marcada }).perguntarPos).toBe(false);
  });
  it('perguntouPos reconhece as formas naturais e ignora a abertura da pós', () => {
    expect(perguntouPos('chegou o arquivo pra vc? e me diz, vc já possui alguma pós-graduação?')).toBe(true);
    expect(perguntouPos('vc já tem alguma pós?')).toBe(true);
    expect(perguntouPos('estamos no fechamento do primeiro lote promocional da pós em X. procuro um encaixe pra ainda hoje?')).toBe(false);
  });
  it('perguntouColeta: pergunta de graduação/área sim, período do dia não', () => {
    expect(perguntouColeta('qual é a sua graduação?')).toBe(true);
    expect(perguntouColeta('em que área vc atua hoje?')).toBe(true);
    expect(perguntouColeta('qual período fica melhor, manhã, tarde ou noite?')).toBe(false);
  });
});

describe('a recusa do envia_informacoes', () => {
  it('é um bloqueio (não concluiu) com o que perguntar e o script que nomeia o cronograma', () => {
    const a = avaliarFicha({ cadastro: 'Sou formado em outra área', jornada: {} });
    const r = bloqueioCronograma('t9', a);
    expect(r.status).toBe('bloqueado');
    expect(r.output).toBe('PRECISA_COLETAR');
    expect(r.cronograma_enviado).toBe(false);
    expect(r.resultado).toContain('qual é a graduação dele e em que área ele atua hoje');
    expect(r.instrucao).toContain(SCRIPT_ANTES_DO_CRONOGRAMA);
  });
});

describe('pedido de cronograma no lote de entrada', () => {
  it('clique no botão do template, com a citação embutida pelo webhook', () => {
    const itens = [{ tipo: 'button', mensagem: '[Em resposta à mensagem: "Oii Gustavo Tudo bem?\n\nJá estou com seu cadastro"] Receber Cronograma' }];
    expect(detectarPedidoDeCronograma(itens)).toBe('botao');
  });
  it('pedido em texto curto: cronograma, informações, "manda por aqui"', () => {
    expect(detectarPedidoDeCronograma([{ tipo: 'text', mensagem: 'me manda o cronograma por aqui?' }])).toBe('texto');
    expect(detectarPedidoDeCronograma([{ tipo: 'text', mensagem: 'eu tenho mas to sem tempo agora, manda as informações por aqui' }])).toBe('texto');
    expect(detectarPedidoDeCronograma([{ tipo: 'text', mensagem: 'sem condições mesmo, não consegue mandar nada por aqui?' }])).toBe('texto');
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
    j = aplicarColetaNaJornada(j, { area_atuacao: 'venda de insumos', atua_na_area: 'NAO', tempo_formacao: 'terminei em 2022', possui_pos: 'sim', qual_pos: 'gestão' });
    expect(j.coleta).toMatchObject({ graduacao: 'Agronomia', graduacao_concluida: 'sim', area_atuacao: 'venda de insumos', atua_na_area: 'nao', tempo_formacao: 'terminei em 2022', possui_pos: 'sim', qual_pos: 'gestão' });
    expect(aplicarColetaNaJornada({}, { atua_na_area: 'talvez' }).coleta?.atua_na_area).toBeUndefined();
  });
  it('as objeções contam por tipo', () => {
    const j = contarObjecaoNaJornada(contarObjecaoNaJornada({}, 'objecao_tempo'), 'objecao_tempo');
    expect(contarObjecaoNaJornada(j, 'objecao_canal').objecoes).toEqual({ objecao_tempo: 2, objecao_canal: 1 });
  });
  it('registrarPerguntaNaJornada carimba a coleta', () => {
    expect(registrarPerguntaNaJornada({}, new Date('2026-09-19T14:00:00Z')).cronograma?.coleta_perguntada_em).toBe('2026-09-19T14:00:00.000Z');
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
    expect(bloco).toContain('já tem pós-graduação —');
    expect(bloco).toContain('FALTA COLETAR antes de enviar o cronograma: em que área ele atua hoje');
    expect(bloco).not.toContain('undefined');
  });
});
