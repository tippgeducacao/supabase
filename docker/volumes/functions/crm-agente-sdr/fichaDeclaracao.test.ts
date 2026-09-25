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
  ])('declara: %s', (fala) => {
    expect(declaracaoDeConclusao([fala])).not.toBeNull();
  });

  it.each([
    'ainda não me formei',
    'quero ser pós graduado',
    'vou fazer mestrado depois',
    'sou nutricionista',
    'sou estudante de veterinária',
    'tenho interesse na pós',
    'estou fazendo pós',
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
