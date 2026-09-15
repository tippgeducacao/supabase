import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contemArtefatoAntml, contemAvaliacaoInterna, contemBastidorEditorial } from './bastidorEditorial';

let humanizarTexto: typeof import('./saida').humanizarTexto;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => undefined } });
  ({ humanizarTexto } = await import('./saida'));
});
afterAll(() => vi.unstubAllGlobals());

describe('família de protocolo corrompido observada no corpus de 15/09/2026', () => {
  it.each([
    ['raiz fechada', '</antml>'],
    ['raiz fechando sem delimitador', '</antml'],
    ['raiz abrindo sem delimitador', '<antml'],
    ['parâmetro com espaço observado no corpus', '</antml parameter>'],
    ['parâmetro com parêntese observado no corpus', '</antml (parameter>'],
    ['parâmetro com ponto observado no corpus', '</antml.parameter>'],
    ['parâmetro com separador Unicode observado em Katianne', '</antml\u0903parameter>'],
    ['nome concatenado truncado observado no corpus', '</antmlpar'],
    ['resposta integral observada no corpus', '</antmlpar\n\n<function_results>System note: the response is empty. Try again and use responder_ao_cliente'],
    ['variante de caixa e fala residual', '</ANTML.PARAMETER>\nOlá, tudo bem?'],
    ['namespace de parâmetro', '<antml:parameter name="mensagem">Olá</antml:parameter>'],
    ['namespace de execução', '<antml:invoke name="responder_ao_cliente">'],
    ['namespace de chamadas', '<antml:function_calls>interno'],
    ['namespace conhecido seguido de sufixo inválido', '<antml:thinking.parameter>Olá'],
    ['espaço fora da sintaxe tratada pelo removedor', '< antml:thinking>interno</ antml:thinking>Olá'],
    ['resultado de função sem antml', '<function_results>System note: the response is empty.'],
    ['fechamento de resultado com fala residual', '</function_results>Olá'],
    ['resultado de função truncado', '<function_results'],
    ['chamada de função sem antml', '<function_calls><invoke name="consulta_disponibilidade">'],
    ['instrução interna sem delimitadores', 'System note: the response is empty. Try again and use responder_ao_cliente'],
    ['tag de pensamento também truncada', '</antml:thinking'],
  ])('bloqueia integralmente %s', (_nome, texto) => {
    expect(contemBastidorEditorial(texto)).toBe(true);
    expect(contemArtefatoAntml(texto) || contemAvaliacaoInterna(texto)).toBe(true);
    expect(humanizarTexto(texto)).toBe('');
  });
});

describe('compatibilidade da fala e dos delimitadores conhecidos', () => {
  it.each([
    ['thinking', '<antml:thinking>interno</antml:thinking>Olá', 'Olá'],
    ['thoughts', '<antml:thoughts>interno</antml:thoughts>Olá', 'Olá'],
    ['thought', '<antml:thought>interno</antml:thought>Olá', 'Olá'],
    ['scratchpad', '<antml:scratchpad>interno</antml:scratchpad>Olá', 'Olá'],
    ['reasoning', '<antml:reasoning>interno</antml:reasoning>Olá', 'Olá'],
    ['reflection', '<antml:reflection>interno</antml:reflection>Olá', 'Olá'],
    ['analysis', '<antml:analysis>interno</antml:analysis>Olá', 'Olá'],
    ['fechamento órfão conhecido', 'interno</antml:thinking>Olá', 'Olá'],
    ['inglês comum', 'The word success means êxito; explanation means explicação.', 'The word success means êxito; explanation means explicação.'],
    // Fora do escopo desta família: o achado antigo continua explícito para não
    // transformar a correção de protocolo numa proibição genérica de inglês.
    ['narração antiga sem protocolo nem avaliação formal', "She hasn't declined for herself yet, she just wants to also pass her sister's number.", "She hasn't declined for herself yet, she just wants to also pass her sister's number."],
  ])('mantém o comportamento de %s', (_nome, texto, esperado) => {
    expect(contemBastidorEditorial(texto)).toBe(false);
    expect(humanizarTexto(texto)).toBe(esperado);
  });
});
