import { beforeAll, describe, expect, it, vi } from 'vitest';

// saida.ts lê Deno.env no import: importa depois do stub (mesmo padrão de saida.test.ts).
let comInterrogacao: typeof import('./saida').comInterrogacao;
let humanizarTexto: typeof import('./saida').humanizarTexto;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => undefined } });
  ({ comInterrogacao, humanizarTexto } = await import('./saida'));
});

// 28/09/2026: pergunta termina com "?". Casos reais do Sonnet na simulação da aula MVP.
describe('pergunta termina com ?', () => {
  it.each([
    ['sobre o tema dessa aula a gente ainda não tem uma pós específica, mas temos o nosso catálogo. quer que eu te mande pra vc dar uma olhada',
      'sobre o tema dessa aula a gente ainda não tem uma pós específica, mas temos o nosso catálogo. quer que eu te mande pra vc dar uma olhada?'],
    ['claro, já te envio. mas antes só me confirma: sua graduação está completa? e qual o curso',
      'claro, já te envio. mas antes só me confirma: sua graduação está completa? e qual o curso?'],
    ['te enviei o portfólio por aqui. qual área chamou mais a sua atenção', 'te enviei o portfólio por aqui. qual área chamou mais a sua atenção?'],
    ['achei duas próximas. alguma delas bate com o que vc procura', 'achei duas próximas. alguma delas bate com o que vc procura?'],
    ['qual período fica melhor, de manhã ou à tarde/noite', 'qual período fica melhor, de manhã ou à tarde/noite?'],
    ['vc prefere hoje ou amanhã', 'vc prefere hoje ou amanhã?'],
  ])('acrescenta: %s', (entrada, esperado) => {
    expect(comInterrogacao(entrada)).toBe(esperado);
  });

  it.each([
    'vc pode ficar tranquila',
    'como a pós é lato sensu, não vou marcar a reunião agora',
    'qual fica melhor pra vc?',
    'Horário reservado pra você:',
    'te enviei o cronograma por aqui.',
    'o link da aula é esse: https://www.youtube.com/watch?v=abc',
    'tranquilo, sem problema',
    'show 👍',
  ])('não mexe: %s', (entrada) => {
    expect(comInterrogacao(entrada)).toBe(entrada);
  });

  it('vale por linha (balões) e dentro do humanizarTexto', () => {
    expect(comInterrogacao('show, anotado\n\nqual horário fica melhor')).toBe('show, anotado\n\nqual horário fica melhor?');
    expect(humanizarTexto('beleza! qual fica melhor pra vc')).toBe('beleza. qual fica melhor pra vc?');
  });
});
