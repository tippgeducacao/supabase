import { describe, it, expect } from 'vitest';
import { limparSaidaIA, tirarTravessao } from './limparSaidaIA';

describe('limparSaidaIA — moldura', () => {
  it('tira o preâmbulo + separador do caso real que o Rafael reportou', () => {
    const bruto = `Aqui está a mensagem gerada seguindo todas as regras:

---

Pessoal, uma pergunta rápida pra quem trabalha com suinocultura 👇

A maioria não sabe. E esse desconhecimento custa caro na prática.`;
    expect(limparSaidaIA(bruto)).toBe(
      `Pessoal, uma pergunta rápida pra quem trabalha com suinocultura 👇

A maioria não sabe. E esse desconhecimento custa caro na prática.`,
    );
  });

  it('tira "Aqui está a mensagem gerada:" mesmo sem separador', () => {
    expect(limparSaidaIA('Aqui está a mensagem gerada:\n\nVocê confirmou presença.')).toBe(
      'Você confirmou presença.',
    );
  });

  it('NÃO come a mensagem quando ela mesma abre com vocativo', () => {
    const msg = 'Pessoal, uma pergunta rápida:\n\nvocês sabem o que muda na granja?';
    expect(limparSaidaIA(msg)).toBe(msg);
  });

  it('NÃO corta quando o texto inteiro é uma linha só que parece preâmbulo', () => {
    expect(limparSaidaIA('Segue o link da aula: ppgvet.com/aula')).toBe(
      'Segue o link da aula: ppgvet.com/aula',
    );
  });

  it('NÃO come linha legítima que abre com "Segue" sem falar da mensagem', () => {
    // Caso real de regressão: o link da aula é conteúdo, não moldura.
    const msg = 'Segue o link da aula de hoje:\nhttps://meet.google.com/abc-defg-hij';
    expect(limparSaidaIA(msg)).toBe(msg);
  });

  it('corta "Segue a mensagem" porque aí fala da própria mensagem', () => {
    expect(limparSaidaIA('Segue a mensagem para o grupo:\n\nBom dia, pessoal!')).toBe('Bom dia, pessoal!');
  });

  it('NÃO come "Abaixo os horários da semana", que é conteúdo', () => {
    const msg = 'Abaixo os horários da semana:\nSegunda 19h\nQuarta 19h';
    expect(limparSaidaIA(msg)).toBe(msg);
  });

  it('interjeição solta cai sozinha, sem precisar falar de mensagem', () => {
    expect(limparSaidaIA('Claro!\n\nBom dia, pessoal.')).toBe('Bom dia, pessoal.');
  });

  it('tira cerca de markdown que envolve tudo', () => {
    expect(limparSaidaIA('```\nOlá, tudo bem?\n```')).toBe('Olá, tudo bem?');
    expect(limparSaidaIA('```markdown\nOlá, tudo bem?\n```')).toBe('Olá, tudo bem?');
  });

  it('tira a pergunta final ao operador', () => {
    expect(limparSaidaIA('Te espero na aula.\n\nQuer que eu ajuste o tom?')).toBe('Te espero na aula.');
  });

  it('NÃO tira pergunta que é parte da mensagem', () => {
    const msg = 'Te espero na aula.\n\nVocê já garantiu sua vaga?';
    expect(limparSaidaIA(msg)).toBe(msg);
  });

  it('tira separadores soltos das pontas e preserva o miolo', () => {
    expect(limparSaidaIA('---\nLinha A\n\n---\n\nLinha B\n---')).toBe('Linha A\n\n---\n\nLinha B');
  });

  it('texto vazio não quebra', () => {
    expect(limparSaidaIA('')).toBe('');
  });
});

describe('tirarTravessao', () => {
  it('travessão no meio da frase vira vírgula', () => {
    expect(tirarTravessao('O nível é alto — e você vai querer estar lá.')).toBe(
      'O nível é alto, e você vai querer estar lá.',
    );
  });

  it('travessão abrindo linha de lista some', () => {
    expect(tirarTravessao('— Primeiro ponto\n— Segundo ponto')).toBe('Primeiro ponto\nSegundo ponto');
  });

  it('intervalo entre números vira hífen, que é o certo ali', () => {
    expect(tirarTravessao('das 19—20h')).toBe('das 19-20h');
    // Com espaços também é intervalo: "das 19:00 — 20:00" quer hífen, não vírgula.
    expect(tirarTravessao('19:00 — 20:00')).toBe('19:00-20:00');
    // Só vira vírgula quando o outro lado não é número.
    expect(tirarTravessao('custou 100 — foi caro')).toBe('custou 100, foi caro');
  });

  it('meia-risca (–) também é cacoete e cai junto', () => {
    expect(tirarTravessao('Aula ao vivo – amanhã')).toBe('Aula ao vivo, amanhã');
  });

  it('não deixa vírgula dobrada nem vírgula antes de ponto', () => {
    expect(tirarTravessao('Chega junto — .')).toBe('Chega junto.');
    expect(tirarTravessao('A, — B')).toBe('A, B');
  });

  it('hífen comum é preservado', () => {
    expect(tirarTravessao('pós-graduação em suinocultura')).toBe('pós-graduação em suinocultura');
  });
});
