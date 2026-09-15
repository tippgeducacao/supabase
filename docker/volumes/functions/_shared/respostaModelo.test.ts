// O agente de RH mandou uma chamada de ferramenta para o WhatsApp de uma candidata em
// 14/09/2026. O defeito não é de conteúdo — é de CANAL: o modelo escreveu no texto o que
// devia ter emitido como `tool_use`. Instrução no prompt não impede; esta régua impede.
//
// O corpus abaixo tem o vazamento REAL (copiado de crm_whatsapp_messages) e as variações
// que a mesma falha produz. A metade de baixo pesa tanto quanto a de cima: uma régua que
// come mensagem legítima troca um problema visível por um silencioso.
import { describe, expect, it } from 'vitest';
import { extrairToolsVazadas, limparResposta } from './respostaModelo';

const VAZAMENTO_REAL = [
  '<invoke name="salvar_dados_candidato">',
  '<parameter name="cidade">Ampére/PR</parameter>',
  '<parameter name="conhece_alguem">não</parameter>',
  '</invoke>',
].join('\n');

describe('chamada de ferramenta escrita no texto', () => {
  it('não deixa sobrar nada do caso real da candidata', () => {
    expect(limparResposta(VAZAMENTO_REAL)).toBe('');
  });

  it('remonta a chamada para quem quiser executá-la', () => {
    const { limpo, chamadas } = extrairToolsVazadas(VAZAMENTO_REAL);
    expect(limpo).toBe('');
    expect(chamadas).toEqual([
      { name: 'salvar_dados_candidato', input: { cidade: 'Ampére/PR', conhece_alguem: 'não' } },
    ]);
  });

  it('preserva a mensagem quando ela vem junto da chamada', () => {
    const bruto = [
      'Recebi seu currículo, obrigado!',
      '<invoke name="salvar_dados_candidato">',
      '<parameter name="habilidades">organização, comunicação, Excel</parameter>',
      '</invoke>',
      'Quais são suas 3 principais habilidades?',
    ].join('\n');
    const { limpo, chamadas } = extrairToolsVazadas(bruto);
    expect(limpo).toContain('Recebi seu currículo, obrigado!');
    expect(limpo).toContain('Quais são suas 3 principais habilidades?');
    expect(limpo).not.toMatch(/invoke|parameter/i);
    expect(chamadas[0].input.habilidades).toBe('organização, comunicação, Excel');
  });

  it('pega as duas quando o modelo vaza mais de uma', () => {
    const { chamadas } = extrairToolsVazadas(
      '<invoke name="conferir_colaborador"><parameter name="nome">Marisa</parameter></invoke>' +
      '<invoke name="encerrar_contato"><parameter name="motivo">pediu para parar</parameter></invoke>',
    );
    expect(chamadas.map((c) => c.name)).toEqual(['conferir_colaborador', 'encerrar_contato']);
    expect(chamadas[1].input.motivo).toBe('pediu para parar');
  });

  it('aceita o prefixo do protocolo, o embrulho function_calls e aspas simples', () => {
    // O prefixo é montado em runtime de propósito: literal no arquivo, ele confunde
    // ferramenta que lê este repo.
    const P = `${'antml'}:`;
    const bruto = [
      '<function_calls>',
      `<${P}invoke name='salvar_dados_candidato'>`,
      `<${P}parameter name='cidade'>Realeza/PR</${P}parameter>`,
      `</${P}invoke>`,
      '</function_calls>',
    ].join('\n');
    const { limpo, chamadas } = extrairToolsVazadas(bruto);
    expect(limpo).toBe('');
    expect(chamadas).toEqual([{ name: 'salvar_dados_candidato', input: { cidade: 'Realeza/PR' } }]);
  });

  it('não deixa passar a tag meio escrita, que é o caso sem conserto', () => {
    // Aqui não dá para remontar a chamada — só garantir que ninguém veja o caco.
    const saida = limparResposta(
      'Boa tarde!\n<invoke name="salvar_dados_candidato">\n<parameter name="cidade">',
    );
    expect(saida).toBe('Boa tarde!');
    expect(saida).not.toMatch(/invoke|parameter/i);
  });

  it('continua tirando o raciocínio simulado, que é a outra metade da régua', () => {
    expect(limparResposta('<thinking>ela já disse a cidade</thinking>E aí, tudo certo?')).toBe(
      'E aí, tudo certo?',
    );
  });
});

describe('mensagem legítima sai intacta', () => {
  const INTACTAS = [
    'Oi, Ana! Tudo tranquilo?\n\nMe manda seu currículo? Pode ser PDF, foto ou link.',
    'Que bom! 😀 Ampére mesmo, então nem tem essa questão de deslocamento.',
    'O salário da vaga é < R$ 2.500 no período de experiência.',
    'Formação: Técnico em Contabilidade, 2024',
    '1 > 0, e toda experiência conta :)',
  ];
  it.each(INTACTAS)('não mexe em %j', (texto) => {
    expect(limparResposta(texto)).toBe(texto);
  });

  it('aguenta vazio e nulo sem estourar', () => {
    expect(limparResposta('')).toBe('');
    expect(limparResposta(undefined as unknown as string)).toBe('');
    expect(extrairToolsVazadas(null as unknown as string).chamadas).toEqual([]);
  });

  it('não guarda estado entre chamadas (regex global é armadilha)', () => {
    const uma = extrairToolsVazadas(VAZAMENTO_REAL);
    const outra = extrairToolsVazadas(VAZAMENTO_REAL);
    expect(outra).toEqual(uma);
    expect(outra.chamadas).toHaveLength(1);
  });
});
