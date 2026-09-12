import { describe, expect, it } from 'vitest';
import {
  CATEGORIAS_COMO_CONHECEU,
  CATEGORIAS_META_PESSOAL,
  canonDdd8,
  dentroDoHorario,
  diaDaSemanaEmSP,
  janelaDoDia,
  linhaDoPerfil,
  parametrosDoPerfil,
  perfilDoContexto,
  perguntasDoPerfilDeHoje,
  vetoDaPerguntaDoPerfil,
  type ContextoAluno,
  type PerfilDoAluno,
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

describe('horário de atendimento (segunda a sexta 8h às 21h, sábado até meio-dia, domingo fechado)', () => {
  // Ampére é UTC-3 o ano inteiro desde 2019: 08:00 local = 11:00 UTC.
  // 11/09/2026 é uma sexta-feira; 12/09 é sábado e 13/09, domingo.
  const em = (utc: string) => new Date(utc);

  it('07:59 ainda é fora, 08:00 já é dentro (sexta-feira)', () => {
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
    // sábado 22h em Ampére é domingo em UTC, e continua sendo sábado para a régua
    expect(diaDaSemanaEmSP(em('2026-09-13T01:00:00Z'))).toBe(6);
    expect(diaDaSemanaEmSP(em('2026-09-11T11:00:00Z'))).toBe(5);
  });

  it('sábado atende até o meio-dia: 11:59 responde, 12:00 já fica para segunda', () => {
    expect(dentroDoHorario(em('2026-09-12T11:00:00Z'))).toBe(true);  // 08:00 de sábado
    expect(dentroDoHorario(em('2026-09-12T14:59:00Z'))).toBe(true);  // 11:59
    expect(dentroDoHorario(em('2026-09-12T15:00:00Z'))).toBe(false); // 12:00
    expect(dentroDoHorario(em('2026-09-12T20:00:00Z'))).toBe(false); // 17:00
  });

  it('domingo é fechado o dia inteiro, e só abre com atende_domingo ligado', () => {
    for (const h of ['11:00', '15:00', '20:00']) {
      expect(dentroDoHorario(em(`2026-09-13T${h}:00Z`))).toBe(false);
    }
    expect(dentroDoHorario(em('2026-09-13T15:00:00Z'), { atendeDomingo: true })).toBe(true);
    expect(dentroDoHorario(em('2026-09-13T10:00:00Z'), { atendeDomingo: true })).toBe(false); // 07:00
  });

  it('aceita o time do Postgres com segundos, e a janela que vier da config', () => {
    expect(dentroDoHorario(em('2026-09-11T12:00:00Z'), { inicio: '09:00:00', fim: '18:00:00' })).toBe(true);
    expect(dentroDoHorario(em('2026-09-11T11:30:00Z'), { inicio: '09:00:00', fim: '18:00:00' })).toBe(false);
    // sábado segue o fim do sábado, e não o da semana
    expect(dentroDoHorario(em('2026-09-12T16:00:00Z'), { fimSabado: '17:00:00' })).toBe(true);
    expect(dentroDoHorario(em('2026-09-12T14:00:00Z'), { fimSabado: '10:00' })).toBe(false);
  });

  it('configuração estragada cai na reserva, nunca em "sempre aberto"', () => {
    expect(dentroDoHorario(em('2026-09-12T02:00:00Z'), { inicio: 'lixo', fim: '' })).toBe(false);
    expect(dentroDoHorario(em('2026-09-11T15:00:00Z'), { inicio: 'lixo', fim: '' })).toBe(true);
    // sábado com fim estragado volta ao meio-dia, e não ao fim da semana
    expect(dentroDoHorario(em('2026-09-12T16:00:00Z'), { fimSabado: 'meio-dia' })).toBe(false);
    expect(janelaDoDia(0, {})).toBeNull();
    expect(janelaDoDia(6, {})).toEqual({ inicio: 8 * 60, fim: 12 * 60 });
    expect(janelaDoDia(3, {})).toEqual({ inicio: 8 * 60, fim: 21 * 60 });
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
  /**
   * O Rafael pediu de 2 a 4 minutos, e o sorteio não é o tempo total: a resposta vai para a fila
   * e o cron `crm-mensagens-agendadas-dispatch` varre de minuto em minuto, então soma-se até 60 s.
   * O teto do sorteio é 180 (3 min), que com a varredura fecha em 4 minutos no pior caso. Subir
   * para 240 "para chegar aos 4 minutos" é o que estoura a janela, e foi o erro de 12/09/2026.
   */
  const VARREDURA_S = 60;
  it('fica entre 120 e 180 s, e com a varredura da fila ainda cabe nos 4 minutos', () => {
    expect(ESPERA_MIN_S).toBe(120);
    expect(ESPERA_MAX_S).toBe(180);
    expect(ESPERA_MAX_S + VARREDURA_S).toBeLessThanOrEqual(240);
    expect(esperaSorteada(() => 0)).toBe(ESPERA_MIN_S);
    expect(esperaSorteada(() => 0.999999)).toBe(ESPERA_MAX_S);
    expect(esperaSorteada(() => 1)).toBe(ESPERA_MAX_S);
    for (let i = 0; i < 200; i++) {
      const s = esperaSorteada();
      expect(s).toBeGreaterThanOrEqual(120);
      expect(s).toBeLessThanOrEqual(180);
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

  it('retomada da manhã e instrução do botão entram no fim, sem hora cravada', () => {
    const t = montarContexto(base, { ...opcoes, ehManha: true, instrucaoAgora: 'Mande o link.' });
    expect(t).toContain('ESTA RESPOSTA SAI NA ABERTURA DO ATENDIMENTO');
    // A abertura sai de `horario_inicio`, que muda por UPDATE: nada de "às 8h" escrito aqui.
    expect(t).not.toContain('SAI ÀS 8H');
    expect(t.trim().endsWith('AGORA: Mande o link.')).toBe(true);
  });

  it('o horário de atendimento vai no contexto, e segue a config', () => {
    expect(montarContexto(base, opcoes))
      .toContain('Horário de atendimento daqui, o que está valendo: segunda a sexta das 8h às 21h, ' +
        'sábado das 8h ao meio-dia, domingo não tem atendimento.');
    expect(montarContexto(base, { ...opcoes, horario: { fim: '20:00:00', fimSabado: '14:00' } }))
      .toContain('segunda a sexta das 8h às 20h, sábado das 8h às 14h, domingo não tem atendimento.');
  });

  it('o nome do modelo da régua vira a descrição da mensagem', () => {
    expect(descreverModeloDaRegua('int_aluno_05_pedido_ligacao')).toBe('D+5, o pedido de ligação');
    expect(descreverModeloDaRegua('outro_modelo')).toBe('outro_modelo');
  });

  it('a linha do perfil aparece, legível, com o dia de Ampére e a contagem sem casas', () => {
    const t = montarContexto({
      ...base,
      meta_pessoal_respondida: false, meta_pessoal_perguntas: 1,
      // 10/09 às 22:00 de Ampére, que já é 11/09 em UTC: a última vez foi no dia 10.
      meta_pessoal_perguntada_em: '2026-09-11T01:00:00Z',
      como_conheceu_respondido: false, como_conheceu_perguntas: 0, como_conheceu_perguntada_em: null,
    }, opcoes);
    expect(t).toContain(
      '- Perfil do aluno: meta pessoal com a pós ainda não respondida, perguntada 1 vez, a última em 10/09/2026; ' +
      'como ele conheceu a gente ainda não respondido, nunca perguntado. ' +
      'Hoje, se a conversa estiver tranquila, você pode perguntar a meta pessoal dele com a pós ou como ele ' +
      'conheceu a gente, uma das duas só.',
    );
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });

  it('o perfil respondido, esgotado ou já perguntado hoje não pede pergunta nova', () => {
    const feito = montarContexto({
      ...base,
      meta_pessoal_respondida: true, meta_pessoal_perguntas: 1, meta_pessoal_perguntada_em: '2026-09-09T15:00:00Z',
      como_conheceu_respondido: false, como_conheceu_perguntas: 2, como_conheceu_perguntada_em: '2026-09-10T15:00:00Z',
    }, opcoes);
    expect(feito).toContain('meta pessoal com a pós já respondida, perguntada 1 vez, a última em 09/09/2026');
    expect(feito).toContain('como ele conheceu a gente ainda não respondido, perguntado 2 vezes, a última em 10/09/2026');
    expect(feito).toContain('Não pergunte mais nada do perfil');

    const hoje = montarContexto({
      ...base,
      meta_pessoal_respondida: false, meta_pessoal_perguntas: 1, meta_pessoal_perguntada_em: '2026-09-11T12:00:00Z',
      como_conheceu_respondido: false, como_conheceu_perguntas: 0, como_conheceu_perguntada_em: null,
    }, opcoes);
    expect(hoje).toContain('Hoje você já fez uma pergunta do perfil: não pergunte de novo.');
  });

  it('sem os campos do perfil (migration ainda não aplicada): diz para não perguntar', () => {
    const t = montarContexto(base, opcoes);
    expect(t).toContain('- Perfil do aluno: não disponível agora. Não pergunte a meta dele nem como ele conheceu a gente.');
  });

  it('sexo nunca aparece no contexto, nem se o banco mandar', () => {
    const comSexo = {
      ...base,
      sexo: 'F', sexo_origem: 'nome', sexo_confianca: 0.98,
      meta_pessoal_respondida: false, meta_pessoal_perguntas: 0, meta_pessoal_perguntada_em: null,
      como_conheceu_respondido: false, como_conheceu_perguntas: 0, como_conheceu_perguntada_em: null,
    } as ContextoAluno;
    for (const t of [montarContexto(comSexo, opcoes), linhaDoPerfil(comSexo, agora)]) {
      expect(t).not.toMatch(/sexo|feminin|masculin|mulher|homem/i);
      expect(t).not.toContain('0.98');
    }
  });
});

describe('perfil do aluno: a entrada da ferramenta', () => {
  const OP = '00000000-0000-4000-8000-000000000001';
  /** O que o aluno escreveu neste turno: é contra isto que o texto livre é conferido. */
  const falas = [
    'oi! quero abrir minha clínica depois da pós',
    'quem me indicou foi a colega Júlia, da turma de 2024',
    'ficar rico, né rs',
    'crescer',
    'o Pedro',
    'Instagram',
    'a'.repeat(900),
  ];

  it('a resposta da meta vira os parâmetros da RPC, com as palavras dele numa linha', () => {
    expect(parametrosDoPerfil(OP, { meta_pessoal: '  quero abrir\n minha clínica  ', meta_pessoal_categoria: 'empreender' }, falas))
      .toEqual({
        ok: true,
        params: {
          p_oportunidade_id: OP, p_meta_pessoal: 'quero abrir minha clínica', p_meta_categoria: 'empreender',
          p_como_conheceu: null, p_como_detalhe: null, p_perguntou: null,
        },
      });
  });

  it('como conheceu, com e sem detalhe, e a marca da pergunta', () => {
    const r = parametrosDoPerfil(OP, { como_conheceu: 'indicacao', como_conheceu_detalhe: 'a colega Júlia, da turma de 2024' }, falas);
    expect(r).toMatchObject({ ok: true, params: { p_como_conheceu: 'indicacao', p_como_detalhe: 'a colega Júlia, da turma de 2024' } });
    expect(parametrosDoPerfil(OP, { como_conheceu: 'youtube' }, falas)).toMatchObject({ ok: true, params: { p_como_detalhe: null } });
    expect(parametrosDoPerfil(OP, { acabei_de_perguntar: 'meta_pessoal' }, falas))
      .toMatchObject({ ok: true, params: { p_perguntou: 'meta_pessoal', p_meta_pessoal: null, p_como_conheceu: null } });
  });

  it('o que ele não disse não é registrado: o texto tem de estar nas mensagens dele', () => {
    // o modelo resumindo: "abrir clínica" não é o que ele escreveu
    expect(parametrosDoPerfil(OP, { meta_pessoal: 'abrir clínica própria', meta_pessoal_categoria: 'empreender' }, falas))
      .toMatchObject({ ok: false, motivo: 'meta_nao_e_do_aluno' });
    expect(parametrosDoPerfil(OP, { como_conheceu: 'indicacao', como_conheceu_detalhe: 'a colega Juliana' }, falas))
      .toMatchObject({ ok: false, motivo: 'detalhe_nao_e_do_aluno' });
    // acento, caixa e pontuação não contam; o que vale é a fala dele
    expect(parametrosDoPerfil(OP, { meta_pessoal: 'QUERO ABRIR MINHA CLINICA!', meta_pessoal_categoria: 'empreender' }, falas).ok)
      .toBe(true);
    // sem nenhuma fala lida (só um botão, por exemplo), nada de texto livre entra
    expect(parametrosDoPerfil(OP, { meta_pessoal: 'crescer', meta_pessoal_categoria: 'outro' }, []))
      .toMatchObject({ ok: false, motivo: 'meta_nao_e_do_aluno' });
  });

  it('resposta e pergunta nunca na mesma chamada', () => {
    const r = parametrosDoPerfil(OP, { como_conheceu: 'youtube', acabei_de_perguntar: 'meta_pessoal' }, falas);
    expect(r).toMatchObject({ ok: false, motivo: 'pergunta_com_resposta' });
    if (!r.ok) expect(r.paraOModelo).toContain('acabei_de_perguntar');
    expect(parametrosDoPerfil(OP, { meta_pessoal: 'crescer', meta_pessoal_categoria: 'outro', acabei_de_perguntar: 'como_conheceu' }, falas))
      .toMatchObject({ ok: false, motivo: 'pergunta_com_resposta' });
  });

  it('categoria fora da lista é recusada, e não trocada por outro', () => {
    const meta = parametrosDoPerfil(OP, { meta_pessoal: 'ficar rico', meta_pessoal_categoria: 'ficar_rico' }, falas);
    expect(meta).toMatchObject({ ok: false, motivo: 'meta_categoria_fora_da_lista' });
    if (!meta.ok) for (const c of CATEGORIAS_META_PESSOAL) expect(meta.paraOModelo).toContain(c);
    const como = parametrosDoPerfil(OP, { como_conheceu: 'tiktok' }, falas);
    expect(como).toMatchObject({ ok: false, motivo: 'como_conheceu_fora_da_lista' });
    if (!como.ok) for (const c of CATEGORIAS_COMO_CONHECEU) expect(como.paraOModelo).toContain(c);
    expect(parametrosDoPerfil(OP, { acabei_de_perguntar: 'sexo' }, falas)).toMatchObject({ ok: false, motivo: 'pergunta_fora_da_lista' });
  });

  it('meta sem categoria, categoria sem as palavras, detalhe sem como conheceu e nada: recusa', () => {
    expect(parametrosDoPerfil(OP, { meta_pessoal: 'crescer' }, falas)).toMatchObject({ ok: false, motivo: 'meta_sem_categoria' });
    expect(parametrosDoPerfil(OP, { meta_pessoal_categoria: 'concurso' }, falas)).toMatchObject({ ok: false, motivo: 'categoria_sem_meta' });
    expect(parametrosDoPerfil(OP, { meta_pessoal: '   ', meta_pessoal_categoria: 'concurso' }, falas))
      .toMatchObject({ ok: false, motivo: 'categoria_sem_meta' });
    expect(parametrosDoPerfil(OP, { como_conheceu_detalhe: 'o Pedro' }, falas)).toMatchObject({ ok: false, motivo: 'detalhe_sem_categoria' });
    expect(parametrosDoPerfil(OP, {}, falas)).toMatchObject({ ok: false, motivo: 'vazio' });
    expect(parametrosDoPerfil(OP, null, falas)).toMatchObject({ ok: false, motivo: 'vazio' });
  });

  it('sem a oportunidade não há parâmetro (e a edge não chama a RPC)', () => {
    for (const op of [null, undefined, '', '   ']) {
      expect(parametrosDoPerfil(op, { meta_pessoal: 'crescer', meta_pessoal_categoria: 'crescer_na_carreira' }, falas))
        .toMatchObject({ ok: false, motivo: 'sem_oportunidade' });
    }
  });

  it('sexo, idade ou qualquer outro campo que o modelo invente não passa', () => {
    const r = parametrosDoPerfil(OP, { como_conheceu: 'redes_sociais', sexo: 'F', idade: 32, estado_civil: 'casada' }, falas);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.params).sort()).toEqual(
        ['p_como_conheceu', 'p_como_detalhe', 'p_meta_categoria', 'p_meta_pessoal', 'p_oportunidade_id', 'p_perguntou'],
      );
      expect(JSON.stringify(r.params)).not.toMatch(/sexo|"F"|casada|32/);
    }
  });

  it('as palavras dele têm teto', () => {
    const r = parametrosDoPerfil(OP, { meta_pessoal: 'a'.repeat(900), meta_pessoal_categoria: 'outro' }, falas);
    expect(r.ok && r.params.p_meta_pessoal?.length).toBe(500);
  });
});

describe('perfil do aluno: quando pode perguntar', () => {
  const agora = new Date('2026-09-11T15:00:00Z'); // 12:00 em Ampére
  const nada: PerfilDoAluno = {
    metaRespondida: false, metaPerguntas: 0, metaPerguntadaEm: null,
    comoRespondido: false, comoPerguntas: 0, comoPerguntadaEm: null,
  };
  const ontem = '2026-09-10T15:00:00Z';

  it('o contexto sem os campos é indisponível; campo nulo (sem linha no estado) é zero', () => {
    expect(perfilDoContexto({ lead_nome: 'Ana' })).toBeNull();
    expect(perfilDoContexto({ meta_pessoal_respondida: null, meta_pessoal_perguntas: null, como_conheceu_respondido: null, como_conheceu_perguntas: null }))
      .toEqual(nada);
    expect(perguntasDoPerfilDeHoje(null, agora)).toEqual({ liberadas: [], motivo: 'indisponivel' });
  });

  it('a meta primeiro: como conheceu só depois de a meta ser perguntada ou respondida', () => {
    expect(perguntasDoPerfilDeHoje(nada, agora).liberadas).toEqual(['meta_pessoal']);
    expect(perguntasDoPerfilDeHoje({ ...nada, metaPerguntas: 1, metaPerguntadaEm: ontem }, agora).liberadas)
      .toEqual(['meta_pessoal', 'como_conheceu']);
    expect(perguntasDoPerfilDeHoje({ ...nada, metaRespondida: true }, agora).liberadas).toEqual(['como_conheceu']);
  });

  it('uma por dia, no dia de Ampére, e nunca as duas no mesmo dia', () => {
    // 11/09 às 00:30 de Ampére: hoje.
    const hoje = '2026-09-11T03:30:00Z';
    expect(perguntasDoPerfilDeHoje({ ...nada, metaPerguntas: 1, metaPerguntadaEm: hoje }, agora))
      .toEqual({ liberadas: [], motivo: 'ja_perguntou_hoje' });
    expect(perguntasDoPerfilDeHoje({ ...nada, metaRespondida: true, comoPerguntas: 1, comoPerguntadaEm: hoje }, agora))
      .toEqual({ liberadas: [], motivo: 'ja_perguntou_hoje' });
    // 10/09 às 23:30 de Ampére (já 11/09 em UTC): foi ontem.
    expect(perguntasDoPerfilDeHoje({ ...nada, metaPerguntas: 1, metaPerguntadaEm: '2026-09-11T02:30:00Z' }, agora).liberadas)
      .toContain('meta_pessoal');
  });

  it('duas vezes no máximo, e o que ele respondeu não volta', () => {
    expect(perguntasDoPerfilDeHoje({ ...nada, metaPerguntas: 2, metaPerguntadaEm: ontem, comoPerguntas: 2, comoPerguntadaEm: ontem }, agora))
      .toEqual({ liberadas: [], motivo: 'nada_mais' });
    expect(perguntasDoPerfilDeHoje({ ...nada, metaPerguntas: 2, metaPerguntadaEm: ontem }, agora).liberadas).toEqual(['como_conheceu']);
    expect(perguntasDoPerfilDeHoje({ ...nada, metaRespondida: true, comoRespondido: true }, agora).motivo).toBe('nada_mais');
  });

  it('a ferramenta veta o que não podia ir, e explica ao modelo', () => {
    const o = { perfil: nada, agora, outraMarcadaNesteTurno: false, passouParaEquipe: false };
    expect(vetoDaPerguntaDoPerfil('meta_pessoal', o)).toBeNull();
    expect(vetoDaPerguntaDoPerfil('como_conheceu', o)).toContain('a meta pessoal dele com a pós');
    expect(vetoDaPerguntaDoPerfil('meta_pessoal', { ...o, passouParaEquipe: true })).toContain('passada para a equipe');
    expect(vetoDaPerguntaDoPerfil('meta_pessoal', { ...o, outraMarcadaNesteTurno: true })).toContain('Nunca as duas');
    expect(vetoDaPerguntaDoPerfil('meta_pessoal', { ...o, perfil: null })).toContain('não está disponível');
    expect(vetoDaPerguntaDoPerfil('meta_pessoal', { ...o, perfil: { ...nada, metaRespondida: true, comoRespondido: true } }))
      .toContain('não vai mais');
    for (const v of [vetoDaPerguntaDoPerfil('como_conheceu', o), vetoDaPerguntaDoPerfil('meta_pessoal', { ...o, perfil: null })]) {
      expect(v).toContain('Tire essa pergunta da mensagem');
      expect(v).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
