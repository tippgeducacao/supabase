import { describe, expect, it } from 'vitest';
import corpus from '../../../scripts/teste-agente/fracionamento/corpus-real.json';
import { fracionarTextoDeterministico as dividir, prepararQuebras } from './fracionamentoTexto';

const normalizar = (t: string) => t.replace(/\s+/g, ' ').trim();
const semEspacos = (t: string) => t.replace(/\s/g, '');

describe('replay das respostas reais do piloto em 22/09/2026', () => {
  it.each(corpus)('$caso: conteúdo integral, ordem e divisão reproduzível', ({ texto, baloesAtuais }) => {
    // A comparação usa os balões efetivamente entregues, não outra chamada ao LLM.
    expect(normalizar(baloesAtuais.join(' '))).toBe(normalizar(texto));
    const resultado = dividir(texto);
    expect(normalizar(resultado.join(' '))).toBe(normalizar(texto));
    expect(dividir(texto)).toEqual(resultado);
    expect(resultado.every((b) => b.trim().length > 0)).toBe(true);
  });

  it('mantém o pitch de 243 caracteres inteiro e junta o convite à pergunta', () => {
    expect(dividir(corpus[0].texto)).toEqual(corpus[0].baloesAtuais);
  });

  it('reúne a explicação curta do formato e a pergunta em um balão', () => {
    expect(dividir(corpus[4].texto)).toEqual([corpus[4].texto]);
  });

  it('mantém a biblioteca inteira, mesmo acima de 300 caracteres', () => {
    expect(dividir(corpus[7].texto)).toEqual([corpus[7].texto]);
  });
});

describe('fracionamento sem perda nos casos em que o code node falhava', () => {
  it('preserva texto dos dois lados da mídia com break e dois anexos', () => {
    const texto = 'segue o material <documento>https://exemplo.com/a.pdf</documento><break>'
      + 'e este vídeo <video>https://exemplo.com/b.mp4</video> conseguiu abrir?';
    expect(dividir(texto)).toEqual(['segue o material', '<documento>https://exemplo.com/a.pdf</documento>',
      'e este vídeo', '<video>https://exemplo.com/b.mp4</video>', 'conseguiu abrir?']);
  });

  it('preserva as vírgulas ao repartir uma frase longa', () => {
    const texto = 'a pós aborda manejo reprodutivo e protocolos para o trabalho no campo, '.repeat(8) + 'quer conhecer o programa?';
    const baloes = dividir(texto);
    expect(baloes.length).toBeGreaterThan(1);
    expect(normalizar(baloes.join(' '))).toBe(normalizar(texto));
    expect(baloes.every((b) => b.length <= 300)).toBe(true);
  });

  it('divide uma frase sem pontuação por palavras, nunca por letras', () => {
    const texto = 'reprodução nutrição gestão manejo protocolos fazendas '.repeat(14).trim();
    const baloes = dividir(texto);
    expect(baloes.every((b) => b.length <= 300)).toBe(true);
    expect(normalizar(baloes.join(' '))).toBe(texto);
  });

  it('break não desliga o limite dos trechos longos', () => {
    const texto = 'a pós trata de manejo e gestão de bovinos '.repeat(12) + '<break>qual período fica melhor?';
    const baloes = dividir(texto);
    expect(baloes.length).toBeGreaterThan(2);
    expect(baloes.every((b) => b.length <= 300)).toBe(true);
    expect(normalizar(baloes.join(' '))).toBe(normalizar(prepararQuebras(texto)));
  });

  it('não trata strings parecidas com placeholders como dados internos', () => {
    const texto = 'o identificador é <<MEDIA_0>> e o código é <<URL_PLACEHOLDER>>. recebeu?';
    expect(dividir(texto)).toEqual([texto]);
  });
});

describe('unidades que não podem ser partidas', () => {
  it.each(['https://meet.google.com/abc-defg-hij', 'https://us02.zoom.us/j/123456',
    'https://teams.microsoft.com/l/meetup-join/exemplo', 'https://escoladeespecializacao.ppgvet.com.br'])(
  'data, instruções e link crítico ficam juntos: %s', (link) => {
    const texto = `a conversa ficou para amanhã às 15h com a monitora. ${'instrução de acesso. '.repeat(18)}\n${link}`;
    expect(dividir(texto)).toEqual([texto]);
  });

  it('links repetidos e longos preservam conteúdo, contagem e ordem', () => {
    const link = `https://exemplo.com/${'caminho'.repeat(50)}?curso=3em1&origem=teste`;
    const texto = `${'conheça a programação completa. '.repeat(9)} ${link} e também ${link} tudo certo?`;
    const baloes = dividir(texto);
    expect(baloes.filter((b) => b.includes(link))).toHaveLength(2);
    expect(normalizar(baloes.join(' '))).toBe(normalizar(texto));
  });

  it('não corta valor, e-mail, decimal ou horário', () => {
    const valores = ['R$ 1.250,50', 'atendimento@exemplo.com.br', '14h30', '10,50'];
    for (const valor of valores) {
      const texto = `${'informação '.repeat(21)}${valor} pode confirmar o recebimento?`;
      expect(dividir(texto).some((b) => b.includes(valor))).toBe(true);
      expect(normalizar(dividir(texto).join(' '))).toBe(normalizar(texto));
    }
  });

  it('não confunde abreviação com fim da frase', () => {
    const texto = `${'a conversa sobre a pós é com o monitor especialista. '.repeat(3)} Dr. Silva vai explicar o programa e tirar suas dúvidas sobre a turma.`;
    const baloes = dividir(texto);
    expect(baloes.some((b) => b.endsWith('Dr.'))).toBe(false);
    expect(normalizar(baloes.join(' '))).toBe(normalizar(texto));
  });

  it.each(['**conteúdo. com pontuação?**', '*conteúdo. com pontuação?*', '_conteúdo. com pontuação?_',
    '~conteúdo. com pontuação?~', '`código. com pontuação?`'])('mantém a formatação fechada: %s', (trecho) => {
    const texto = `${'conheça o programa. '.repeat(12)} ${trecho} podemos conversar?`;
    expect(dividir(texto).some((b) => b.includes(trecho))).toBe(true);
    expect(normalizar(dividir(texto).join(' '))).toBe(normalizar(texto));
  });

  it('não interpreta tags citadas dentro de código como mídia ou quebra', () => {
    const codigo = '```texto\n<break>\n<video>https://exemplo.com/v.mp4</video>\n' + 'conteúdo. '.repeat(35) + '\n```';
    const texto = `exemplo abaixo:\n\n${codigo}\n\nfim do exemplo.`;
    expect(dividir(texto)).toEqual(['exemplo abaixo:', codigo, 'fim do exemplo.']);
  });

  it('item numerado não perde seu rótulo nem divide o horário', () => {
    const itens = Array.from({ length: 6 }, (_, i) => `${i + 1}. conversa com o monitor da pós e apresentação do cronograma às 14h30`);
    const texto = itens.join('\n');
    const baloes = dividir(texto);
    expect(itens.every((item) => baloes.some((b) => b.includes(item)))).toBe(true);
    expect(normalizar(baloes.join(' '))).toBe(normalizar(texto));
  });

  it('palavra maior que o alvo fica inteira, sem truncar ou entrar em loop', () => {
    const palavra = 'a'.repeat(450);
    expect(dividir(palavra)).toEqual([palavra]);
  });

  it('preserva emojis compostos e acentos', () => {
    const texto = ('Olá, reprodução 👩🏽‍⚕️ e nutrição 🐄. ').repeat(20).trim();
    expect(normalizar(dividir(texto).join(' '))).toBe(texto);
    expect(dividir(texto).every((b) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(b))).toBe(true);
  });
});

describe('controle de apresentação e conservação', () => {
  it('respeita parágrafo e break explícitos, mesmo em frases curtas', () => {
    expect(dividir('primeira ideia.\n\nsegunda ideia.<break/>terceira ideia.')).toEqual([
      'primeira ideia.', 'segunda ideia.', 'terceira ideia.',
    ]);
  });

  it.each(['', ' \n\t ', '<break><break/>'])('não produz balões vazios: %j', (texto) => {
    expect(dividir(texto)).toEqual([]);
  });

  it('mantém pergunta curta junto da explicação quando cabe na margem', () => {
    const texto = `${'detalhe do programa '.repeat(12).trim()}. qual fica melhor?`;
    expect(dividir(texto)).toEqual([texto]);
  });

  it('preserva todo caractere não branco em combinações adversas reproduzíveis', () => {
    const trechos = ['reprodução, nutrição e gestão. ', 'o médico veterinário atende às 14h30? ',
      'consulte https://exemplo.com/a?x=1&y=2 ', '**formação concluída** ', '<break>',
      '<imagem>https://exemplo.com/i.jpg</imagem>', '\n\n', 'o valor é R$ 1.250,50, '];
    for (let i = 0; i < 100; i++) {
      const texto = Array.from({ length: 5 + i }, (_, j) => trechos[(j * 7 + i * 3) % trechos.length]).join('');
      const baloes = dividir(texto);
      expect(semEspacos(baloes.join(''))).toBe(semEspacos(prepararQuebras(texto)));
      expect(baloes.every((b) => Boolean(b.trim()))).toBe(true);
    }
  });
});
