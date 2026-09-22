import { describe, expect, it } from 'vitest';
import { textoVozIaParaPersistir } from './textoVozIa';

const origem = { tipo: 'audio', origem: 'ia', conteudo: 'Posso explicar como funciona a conversa com o monitor.', chamadaServico: true };

describe('texto conhecido da voz IA no mesmo registro do áudio', () => {
  it('preserva o texto exato da síntese, inclusive espaços e quebras', () => {
    const conteudo = '  Olá!\nPodemos conversar sobre a pós.  ';
    expect(textoVozIaParaPersistir({ ...origem, conteudo })).toBe(conteudo);
  });

  it('conta caracteres Unicode e nunca persiste um texto truncado', () => {
    expect(textoVozIaParaPersistir({ ...origem, conteudo: '🙂'.repeat(600) })).toBe('🙂'.repeat(600));
    expect(textoVozIaParaPersistir({ ...origem, conteudo: '🙂'.repeat(601) })).toBe('');
  });

  it.each([
    { origem: 'humano' }, { origem: null }, { origem: 'IA' },
    { tipo: 'sticker' }, { tipo: 'text' }, { tipo: 'document' },
    { chamadaServico: false }, { enviadoPorId: 'atendente' },
  ])('não trata outra autoria/modalidade como fala sintetizada: %j', (alteracao) => {
    expect(textoVozIaParaPersistir({ ...origem, ...alteracao })).toBe('');
  });

  it.each([undefined, null, 42, { mensagem: 'texto' }, '', ' \n\t ', 'fala\u0000inválida', 'fala\u007finválida'])(
    'ignora conteúdo inválido: %j', (conteudo) => {
      expect(textoVozIaParaPersistir({ ...origem, conteudo })).toBe('');
    },
  );
});
