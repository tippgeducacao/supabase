import { describe, expect, it } from 'vitest';
import { aplicarDeclaracaoNaJornada, avaliarFicha, declaracaoDeConclusao } from './fichaAtendimento';
import { falasDoLead } from './perguntasRecentes';

// Duelo cego Luna × Sonnet 5 (25/09/2026): a ficha vazia de conversa anterior ao canário fazia a
// Luna perguntar "vc já se formou em Direito?" a quem tinha escrito "sou advogado pós graduado".
describe('declaracaoDeConclusao', () => {
  it.each([
    'Sou advogado pós graduado',
    'já me formei faz 3 anos',
    'sou formada em zootecnia',
    'tenho uma pós em nutrição',
    'fiz mestrado na UFPR',
    'já concluí a graduação',
    'quando me formei em 2019 fui direto pro campo',
    // Caso Ludia (13/10/2026): a IA perguntou "já concluiu a graduação em biologia?" a quem cursa mestrado.
    'Oi, tudo bem? Desculpe. É que no momento estou fazendo mestrado...',
    'estou cursando o doutorado na UFV',
    'tô terminando minha residência',
    'faço mestrado em ciência animal',
    'sou mestranda',
  ])('declara: %s', (fala) => {
    expect(declaracaoDeConclusao([fala])).not.toBeNull();
  });

  it.each([
    'ainda não me formei',
    'quero ser pós graduado',
    'vou fazer mestrado depois',
    'sou estudante de veterinária',
    'tenho interesse na pós',
    'estou fazendo pós',
    'não estou fazendo mestrado',
    'quero fazer mestrado ano que vem',
    'pretendo cursar o doutorado',
    'fazendo essa pós eu consigo atuar na área?',
  ])('não declara: %s', (fala) => {
    expect(declaracaoDeConclusao([fala])).toBeNull();
  });

  it('lê só as falas do lead, sem a citação do WhatsApp nem registros internos', () => {
    const falas = falasDoLead([
      { role: 'assistant', content: 'vc já se formou?' },
      { role: 'user', content: '[Em resposta à mensagem: "já me formei?"] oi' },
      { role: 'user', content: '[FICHA DO ATENDIMENTO] sou formado' },
      { role: 'user', content: 'Sou advogado pós graduado' },
    ]);
    expect(falas).toEqual(['oi', 'Sou advogado pós graduado']);
    expect(declaracaoDeConclusao(falas)).toBe('Sou advogado pós graduado');
  });
});

describe('aplicarDeclaracaoNaJornada', () => {
  it('aproveita Medicina Veterinária e atuação clínica sem repetir a conclusão', () => {
    const falas = ['Quero o cronograma da pós. Minha graduação é Medicina Veterinária e atuo em clínica de pequenos animais.'];
    expect(declaracaoDeConclusao(falas)).toBe(falas[0]);
    const jornada = aplicarDeclaracaoNaJornada({ coleta: { graduacao: 'Medicina Veterinária', area_atuacao: 'clínica de pequenos animais', atua_na_area: 'sim' } });
    const ficha = avaliarFicha({ cadastro: 'Médico Veterinário (a)', jornada });
    expect(ficha.graduacaoConcluida).toBe(true);
    expect(ficha.perguntaConfirmacaoFormacao).toBeNull();
  });

  it('combina duas respostas próprias, sem usar pergunta, citação ou formulário', () => {
    expect(declaracaoDeConclusao(['Medicina Veterinária', 'Já atuo em clínica de pequenos animais'])).not.toBeNull();
    expect(declaracaoDeConclusao(falasDoLead([
      { role: 'assistant', content: 'Sua graduação é Medicina Veterinária?' },
      { role: 'user', content: '[Em resposta à mensagem: "Minha graduação é Medicina Veterinária"] atuo em clínica' },
    ]))).toBeNull();
    expect(avaliarFicha({ cadastro: 'Médico Veterinário (a)', jornada: { coleta: { area_atuacao: 'clínica', atua_na_area: 'sim' } } }).graduacaoConcluida).toBe(false);
  });

  it.each([
    ['Minha graduação é Medicina Veterinária'],
    ['Atuo em clínica de pequenos animais'],
    ['Minha irmã tem graduação em Medicina Veterinária e eu atuo em clínica'],
    ['Minha graduação é Medicina Veterinária. Meu marido atua em clínica'],
    ['Minha graduação é Medicina Veterinária e não atuo em clínica'],
    ['Minha graduação é Medicina Veterinária e pretendo atuar em clínica'],
    ['Minha graduação é Medicina Veterinária e atuo em clínica como auxiliar. Ainda não me formei'],
    ['Minha graduação é Medicina Veterinária e atuo em clínica como auxiliar'],
    ['Minha graduação é Medicina Veterinária e trabalho de recepcionista em clínica'],
    ['Medicina Veterinária', 'Atuo em clínica', 'Sou estagiária'],
    ['Minha graduação é Medicina Veterinária e trabalho em clínica. Sou recepcionista'],
    ['Ainda curso Medicina Veterinária e atuo em clínica'],
    ['Minha graduação é Medicina Veterinária e atuo em clínica', 'Ainda curso a graduação'],
  ])('não conclui só por combinar curso com contexto insuficiente: %s', (...falas) => {
    expect(declaracaoDeConclusao(falas)).toBeNull();
  });

  it('ficha que pediria "vc já se formou em Direito?" deixa de pedir', () => {
    const antes = avaliarFicha({ cadastro: 'Advogado (a)', jornada: {} });
    expect(antes.perguntaConfirmacaoFormacao).toBe('vc já se formou em Direito?');
    const jornada = aplicarDeclaracaoNaJornada({});
    const depois = avaliarFicha({ cadastro: 'Advogado (a)', jornada });
    expect(jornada.coleta?.graduacao_concluida).toBe('sim');
    expect(depois.graduacaoConcluida).toBe(true);
    expect(depois.perguntaConfirmacaoFormacao).toBeNull();
  });
  it('não sobrescreve o que a ficha já sabe (cursando, não tem graduação)', () => {
    expect(aplicarDeclaracaoNaJornada({ coleta: { graduacao_concluida: 'cursando' } }).coleta?.graduacao_concluida).toBe('cursando');
    expect(aplicarDeclaracaoNaJornada({ coleta: { graduacao_concluida: 'nao' } }).coleta?.graduacao_concluida).toBe('nao');
  });
});
