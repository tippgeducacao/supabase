import { describe, expect, it } from 'vitest';
import {
  canonDdd8,
  dentroDoHorario,
  descreverParaModelo,
  diasDesde,
  esperaSorteada,
  ESPERA_MAX_S,
  ESPERA_MIN_S,
  descreverModeloDaRegua,
  horarioLegivel,
  interpretarBotao,
  mesmoTelefone,
  montarContexto,
  limparResposta,
  linhaDaAula,
  primeiroNome,
  rotuloDiasSemana,
  sanearParaModelo,
  temPalavraProibida,
} from './regras';

// Os traços por código: este arquivo também não carrega nenhum.
const TRAVESSAO = '\u2014';
const MEIA_RISCA = '\u2013';

describe('horário de atendimento (8h às 21h, horário de Ampére)', () => {
  // Ampére é UTC-3 o ano inteiro desde 2019: 08:00 local = 11:00 UTC.
  const em = (utc: string) => new Date(utc);

  it('07:59 ainda é fora, 08:00 já é dentro', () => {
    expect(dentroDoHorario(em('2026-09-11T10:59:00Z'))).toBe(false);
    expect(dentroDoHorario(em('2026-09-11T11:00:00Z'))).toBe(true);
  });

  it('20:59 ainda é dentro, 21:00 já é fora', () => {
    expect(dentroDoHorario(em('2026-09-11T23:59:00Z'))).toBe(true);
    expect(dentroDoHorario(em('2026-09-12T00:00:00Z'))).toBe(false);
  });

  it('a virada do dia em UTC não engana: 22:30 de Ampére já é outro dia em UTC', () => {
    expect(dentroDoHorario(em('2026-09-12T01:30:00Z'))).toBe(false);
    expect(dentroDoHorario(em('2026-09-12T03:00:00Z'))).toBe(false); // meia-noite local
  });

  it('aceita o time do Postgres com segundos, e janela configurada', () => {
    expect(dentroDoHorario(em('2026-09-11T12:00:00Z'), '09:00:00', '18:00:00')).toBe(true);
    expect(dentroDoHorario(em('2026-09-11T11:30:00Z'), '09:00:00', '18:00:00')).toBe(false);
  });

  it('configuração estragada cai no padrão das 8h às 21h, nunca em "sempre aberto"', () => {
    expect(dentroDoHorario(em('2026-09-12T02:00:00Z'), 'lixo', '')).toBe(false);
    expect(dentroDoHorario(em('2026-09-11T15:00:00Z'), 'lixo', '')).toBe(true);
  });
});

describe('dias desde a matrícula, no calendário de Ampére', () => {
  it('conta a virada do dia local, e não a de UTC', () => {
    // 23:30 do dia 10 em Ampére é 02:30 do dia 11 em UTC: continua sendo o dia 10.
    expect(diasDesde('2026-09-11T02:30:00Z', new Date('2026-09-11T12:00:00Z'))).toBe(1);
    expect(diasDesde('2026-09-11T11:00:00Z', new Date('2026-09-11T20:00:00Z'))).toBe(0);
    expect(diasDesde(null)).toBeNull();
  });
});

describe('espera antes de responder', () => {
  it('fica sempre entre 120 e 165 segundos', () => {
    expect(esperaSorteada(() => 0)).toBe(ESPERA_MIN_S);
    expect(esperaSorteada(() => 0.999999)).toBe(ESPERA_MAX_S);
    expect(esperaSorteada(() => 1)).toBe(ESPERA_MAX_S);
    for (let i = 0; i < 200; i++) {
      const s = esperaSorteada();
      expect(s).toBeGreaterThanOrEqual(120);
      expect(s).toBeLessThanOrEqual(165);
    }
  });
});

describe('telefone canônico (DDD + 8)', () => {
  it('ignora DDI, 9º dígito e formatação, e distingue DDD', () => {
    expect(canonDdd8('+55 (46) 99982-3250')).toBe('4699823250');
    expect(canonDdd8('554699823250')).toBe('4699823250');
    expect(canonDdd8('46 9982-3250')).toBe('4699823250');
    expect(canonDdd8('5511999823250')).toBe('1199823250');
    expect(canonDdd8('5511999823250')).not.toBe(canonDdd8('5546999823250'));
  });

  it('número que não é brasileiro plausível não vira chave', () => {
    expect(canonDdd8('123')).toBeNull();
    expect(canonDdd8('')).toBeNull();
    expect(canonDdd8('0999823250')).toBeNull();
  });
});

describe('botões da régua', () => {
  it('lê o payload fixo, quando o modelo da Meta tiver', () => {
    expect(interpretarBotao({ tipo: 'template_button', id: 'ONB_GRUPO_NAO', title: 'Não estou' }))
      .toEqual({ tipo: 'grupo', estaNoGrupo: false });
    expect(interpretarBotao({ tipo: 'template_button', id: 'onb_ligar_tarde', title: 'x' }))
      .toEqual({ tipo: 'ligacao', periodo: 'fim_da_tarde' });
  });

  it('sem payload a Meta devolve o texto do botão, e o título normalizado resolve', () => {
    expect(interpretarBotao({ tipo: 'template_button', id: 'Sim, estou', title: 'Sim, estou' }))
      .toEqual({ tipo: 'grupo', estaNoGrupo: true });
    expect(interpretarBotao({ tipo: 'template_button', id: 'Não estou', title: 'Não estou' }))
      .toEqual({ tipo: 'grupo', estaNoGrupo: false });
    expect(interpretarBotao({ tipo: 'button_reply', id: null, title: 'Começo da manhã' }))
      .toEqual({ tipo: 'ligacao', periodo: 'comeco_da_manha' });
    expect(interpretarBotao({ tipo: 'template_button', id: 'FIM DA TARDE!', title: null }))
      .toEqual({ tipo: 'ligacao', periodo: 'fim_da_tarde' });
  });

  it('botão de outro modelo, lista, texto livre e lixo não viram nada', () => {
    expect(interpretarBotao({ tipo: 'template_button', id: 'Receber Cronograma', title: 'Receber Cronograma' })).toBeNull();
    expect(interpretarBotao({ tipo: 'list_reply', id: 'Sim, estou', title: 'Sim, estou' })).toBeNull();
    expect(interpretarBotao({ tipo: 'call_permission_reply', id: 'accept', title: 'Sim, estou' })).toBeNull();
    expect(interpretarBotao(null)).toBeNull();
    expect(interpretarBotao('Sim, estou')).toBeNull();
  });
});

describe('saneamento do que o modelo lê', () => {
  it('travessão e meia-risca viram vírgula', () => {
    expect(sanearParaModelo(`Pré-abertura ${TRAVESSAO} Boas-vindas`)).toBe('Pré-abertura, Boas-vindas');
    expect(sanearParaModelo(`Prático${MEIA_RISCA}Ampére`)).toBe('Prático, Ampére');
    expect(sanearParaModelo(`${TRAVESSAO} começo solto`)).toBe('começo solto');
    expect(sanearParaModelo(`fim solto ${TRAVESSAO}`)).toBe('fim solto');
  });

  it('intervalo de horário e de número não vira vírgula', () => {
    expect(sanearParaModelo(`19:00 ${MEIA_RISCA} 22:00`)).toBe('19:00 às 22:00');
    expect(sanearParaModelo(`módulos 1${TRAVESSAO}3`)).toBe('módulos 1 a 3');
  });

  it('negrito de Markdown vira o negrito do WhatsApp', () => {
    expect(sanearParaModelo('o **material didático do curso** fica lá')).toBe('o *material didático do curso* fica lá');
  });

  it('nada do que sai tem traço longo', () => {
    const t = sanearParaModelo(`a ${TRAVESSAO} b ${MEIA_RISCA} c\n${TRAVESSAO} d`);
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });

  it('o raciocínio simulado nunca chega ao aluno', () => {
    expect(limparResposta('<thinking>vou ver</thinking>Oi, Ana!')).toBe('Oi, Ana!');
    expect(limparResposta('Oi <reasoning>x</reasoning>de novo')).toBe('Oi de novo');
  });

  it('acusa "biblioteca" em qualquer forma', () => {
    expect(temPalavraProibida('na Biblioteca do curso')).toBe(true);
    expect(temPalavraProibida('bibliotecas')).toBe(true);
    expect(temPalavraProibida('no material didático do curso')).toBe(false);
  });
});

describe('aula e turma, do jeito que o aluno lê', () => {
  it('uma aula por linha, com o dia da semana calculado da data, sem fuso', () => {
    expect(linhaDaAula({ data: '2026-09-15', horario: '19:00 - 22:00', titulo: `Pré-abertura ${TRAVESSAO} Boas-vindas` }))
      .toBe('terça-feira, 15/09/2026, das 19:00 às 22:00: Pré-abertura, Boas-vindas');
    expect(linhaDaAula({ data: '2026-09-13', horario: '', titulo: '' }))
      .toBe('domingo, 13/09/2026, horário ainda não informado: tema ainda não informado');
  });

  it('horário que não é intervalo passa saneado', () => {
    expect(horarioLegivel('19:00:00 - 22:30:00')).toBe('das 19:00 às 22:30');
    expect(horarioLegivel('noite')).toBe('noite');
  });

  it('dias da semana por extenso, começando na segunda', () => {
    expect(rotuloDiasSemana([2])).toBe('terça');
    expect(rotuloDiasSemana([4, 2])).toBe('terça e quinta');
    expect(rotuloDiasSemana([0, 6, 1])).toBe('segunda, sábado e domingo');
    expect(rotuloDiasSemana([])).toBe('');
    expect(rotuloDiasSemana(null)).toBe('');
    expect(rotuloDiasSemana([9, 'x'])).toBe('');
  });

  it('primeiro nome com a caixa arrumada', () => {
    expect(primeiroNome('MARIA DA SILVA')).toBe('Maria');
    expect(primeiroNome('  joão pedro ')).toBe('João');
    expect(primeiroNome(null)).toBe('');
  });
});

describe('mídia sem texto vira descrição honesta', () => {
  it('troca o marcador do webhook e mantém a citação', () => {
    expect(descreverParaModelo('audio', '[Em resposta à mensagem: "Oi"] [áudio]'))
      .toBe('[Em resposta à mensagem: "Oi"] (ele mandou um áudio, que você não consegue ouvir)');
    expect(descreverParaModelo('document', 'rg.pdf')).toBe('(ele mandou um arquivo, que você não consegue abrir) rg.pdf');
    expect(descreverParaModelo('reaction', '[reacao]👍')).toBe('(ele reagiu com 👍)');
    expect(descreverParaModelo('text', 'bom dia')).toBe('bom dia');
  });
});

describe('mesma pessoa pelo telefone', () => {
  it('casa com e sem 9 e com e sem 55, e separa DDD', () => {
    expect(mesmoTelefone('554699823250', '+55 46 99982-3250')).toBe(true);
    expect(mesmoTelefone('5546999823250', '5511999823250')).toBe(false);
    expect(mesmoTelefone('', '')).toBe(false);
  });
});

describe('contexto do aluno', () => {
  const agora = new Date('2026-09-11T15:00:00Z'); // 12:00 em Ampére
  const base = {
    lead_nome: 'MARIA DA SILVA',
    marca: 'PPGVET Educação',
    pos_nome: 'Clínica Médica de Bovinos',
    pos_formato: 'ao_vivo',
    pos_tcc: 'obrigatorio',
    turma_id: 't1',
    turma_nome: `02/26 #01 ${TRAVESSAO} Ampére`,
    turma_inicio: '2026-09-15',
    turma_fim: '2028-03-20',
    dias_semana: [2],
    horario_inicio: '19:00:00',
    horario_fim: '22:00:00',
    grupo_url: 'https://chat.whatsapp.com/abc',
    no_grupo: null,
    matricula_em: '2026-09-08T13:00:00Z',
    etapa_nome: 'D+3 · CRONOGRAMA',
    etapa_entrou_em: '2026-09-11T11:00:00Z',
    ultima_regua: { template_name: 'int_aluno_03_cronograma', enviado_em: '2026-09-11T11:05:00Z' },
  };
  const opcoes = {
    agora, ehManha: false, totalEmIntegracao: 1,
    tccSiteUrl: 'https://tcc.ppgeducacao.com.br',
    mentoriaQuando: 'todo sábado, às 9h',
    mentoriaUrl: 'https://meet.google.com/cft-inax-tbw',
  };

  it('traz o que o aluno precisa, sem travessão e sem a palavra proibida', () => {
    const t = montarContexto(base, opcoes);
    expect(t).toContain('Primeiro nome do aluno: Maria.');
    expect(t).toContain('PPGVET Educação');
    expect(t).toContain('Turma: 02/26 #01, Ampére, que começa em 15/09/2026 e termina em 20/03/2028.');
    expect(t).toContain('Aulas ao vivo da turma: terça, das 19:00 às 22:00.');
    expect(t).toContain('https://chat.whatsapp.com/abc');
    expect(t).toContain('Matrícula: há 3 dias (08/09/2026).');
    expect(t).toContain('D+3, o vídeo do acesso às aulas ao vivo');
    expect(t).not.toMatch(/[\u2013\u2014]/);
    expect(temPalavraProibida(t)).toBe(false);
  });

  it('TCC: links só para curso que tem TCC', () => {
    expect(montarContexto(base, opcoes)).toContain('TCC obrigatório. Site do TCC: https://tcc.ppgeducacao.com.br');
    expect(montarContexto({ ...base, pos_tcc: 'opcional' }, opcoes)).toContain('ele é opcional');
    const semTcc = montarContexto({ ...base, pos_tcc: 'nao_tem' }, opcoes);
    expect(semTcc).toContain('NÃO tem TCC');
    expect(semTcc).not.toContain('tcc.ppgeducacao.com.br');
    expect(semTcc).not.toContain('meet.google.com');
    const indefinido = montarContexto({ ...base, pos_tcc: null }, opcoes);
    expect(indefinido).toContain('não está definido se o curso tem TCC');
    expect(indefinido).not.toContain('tcc.ppgeducacao.com.br');
  });

  it('turma desconhecida ou ambígua: manda não chutar', () => {
    const sem = montarContexto({ ...base, turma_id: null, turma_nome: null }, opcoes);
    expect(sem).toContain('NÃO SEI A TURMA DELE');
    expect(sem).toContain('turma_desconhecida');
    const duas = montarContexto(base, { ...opcoes, totalEmIntegracao: 2 });
    expect(duas).toContain('mais de uma matrícula em integração');
    const ambigua = montarContexto({ ...base, turma_ambigua: true }, opcoes);
    expect(ambigua).toContain('NÃO SEI A TURMA DELE');
  });

  it('sem marca, sem link do grupo e sem régua: diz que não sabe', () => {
    const t = montarContexto({ ...base, marca: null, grupo_url: null, ultima_regua: null }, opcoes);
    expect(t).toContain('Fale só "aqui da PPG"');
    expect(t).toContain('não temos. Nunca mande o de outra turma');
    expect(t).toContain('Última mensagem da régua que ele recebeu: nenhuma ainda.');
  });

  it('a data da matrícula é o dia de Ampére, não o dia UTC do timestamp', () => {
    // Venda aprovada em 10/09 às 22:00 de Ampére é 11/09 01:00 em UTC.
    const t = montarContexto({ ...base, matricula_em: '2026-09-11T01:00:00+00:00' }, opcoes);
    expect(t).toContain('Matrícula: há 1 dia (10/09/2026).');
    // A data da planilha (DATE à meia-noite de Ampére) continua no próprio dia.
    const meiaNoite = montarContexto({ ...base, matricula_em: '2026-09-08T03:00:00+00:00' }, opcoes);
    expect(meiaNoite).toContain('(08/09/2026)');
  });

  it('retomada das 8h e instrução do botão entram no fim', () => {
    const t = montarContexto(base, { ...opcoes, ehManha: true, instrucaoAgora: 'Mande o link.' });
    expect(t).toContain('ESTA RESPOSTA SAI ÀS 8H');
    expect(t.trim().endsWith('AGORA: Mande o link.')).toBe(true);
  });

  it('o nome do modelo da régua vira a descrição da mensagem', () => {
    expect(descreverModeloDaRegua('int_aluno_05_pedido_ligacao')).toBe('D+5, o pedido de ligação');
    expect(descreverModeloDaRegua('outro_modelo')).toBe('outro_modelo');
  });
});
