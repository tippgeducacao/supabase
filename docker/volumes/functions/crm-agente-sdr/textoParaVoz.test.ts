import { describe, expect, it } from 'vitest';
import { normalizarTextoParaVoz } from './textoParaVoz';
import { caminhoCacheVozElevenlabs } from './vozElevenlabs';

describe('texto escrito do SDR adaptado só para a fala', () => {
  it('expande o vc que apareceu no áudio real do piloto', () => {
    expect(normalizarTextoParaVoz('claro, te mando o cronograma completo da pós por aqui. vc já é formado em Medicina Veterinária?'))
      .toBe('claro, te mando o cronograma completo da pós por aqui. você já é formado em Medicina Veterinária?');
  });
  it.each([
    ['vc e vcs', 'você e vocês'], ['VC, VCS e Vc?', 'você, vocês e você?'],
    ['tbm consigo hj, dps te mando uma msg', 'também consigo hoje, depois te mando uma mensagem'],
    ['blz, qdo vc puder manda as msgs, pfv', 'beleza, quando você puder manda as mensagens, por favor'],
    ['amnh, agr, tb, qnd, pq, ctz, msm, vdd, td e pfvr', 'amanhã, agora, também, quando, por que, certeza, mesmo, verdade, tudo e por favor'],
  ])('prepara abreviações: %s', (original, falado) => {
    expect(normalizarTextoParaVoz(original)).toBe(falado);
  });
  it.each(['kkk', 'KKKKK', 'rsrs', 'hahaha', 'hehehe', '[risos]', '[laughs]'])('omite %s sem ler letras nem inserir comandos V3', (risada) => {
    expect(normalizarTextoParaVoz(`imagino ${risada}, vc trabalha bastante`)).toBe('imagino, você trabalha bastante');
    expect(normalizarTextoParaVoz(`${risada}, vc consegue?`)).toBe('você consegue?');
    expect(normalizarTextoParaVoz(`vc consegue, ${risada}?`)).toBe('você consegue?');
  });
  it('mantém siglas profissionais, palavras e identificadores', () => {
    const texto = 'NASEM, PPGVET, MBA, RS, TB, TD, AGR, q, n, código_vc, AVC, álvc, vca, abcvc, 3vc';
    expect(normalizarTextoParaVoz(texto)).toBe(texto);
  });
  it.each([
    ['hoje às 18h, 18h30 ou 19h', 'hoje às dezoito horas, dezoito horas e trinta minutos ou dezenove horas'],
    ['às 01h01 e 02:05', 'às uma hora e um minuto e duas horas e cinco minutos'],
    ['das 00:00 às 23:59', 'das zero horas às vinte e três horas e cinquenta e nove minutos'],
    ['às 12h15 ou 20h45.', 'às doze horas e quinze minutos ou vinte horas e quarenta e cinco minutos.'],
    ['18h60, 24h, abc18h30, 18h300, 18:30:20', '18h60, 24h, abc18h30, 18h300, 18:30:20'],
    ['https://exemplo.com/18h30 `18h30`', 'https://exemplo.com/18h30 `18h30`'],
  ])('adapta somente horários válidos para fala: %s', (original, falado) => {
    expect(normalizarTextoParaVoz(original)).toBe(falado);
    expect(normalizarTextoParaVoz(falado)).toBe(falado);
  });
  it('preserva links, e-mails e literais sem trocar trechos internos', () => {
    const enderecos = 'https://exemplo.com/vc/kkk?q=tbm vc@exemplo.com `vc`';
    expect(normalizarTextoParaVoz(`vc pode ler ${enderecos}`)).toBe(`você pode ler ${enderecos}`);
  });
  it('conserva conteúdo, pontuação e negações além das marcas de chat', () => {
    expect(normalizarTextoParaVoz('vc não está inscrito. hj não consigo; amanhã pode ser?'))
      .toBe('você não está inscrito. hoje não consigo; amanhã pode ser?');
    expect(normalizarTextoParaVoz('vamos conversar sobre a pós?')).toBe('vamos conversar sobre a pós?');
    expect(normalizarTextoParaVoz('kkk rsrs hahaha')).toBe('');
  });
  it('é idempotente e o texto falado usa cache diferente da abreviação antiga', async () => {
    const original = 'vc consegue conversar hj? kkk';
    const falado = normalizarTextoParaVoz(original);
    expect(normalizarTextoParaVoz(falado)).toBe(falado);
    expect(await caminhoCacheVozElevenlabs(falado)).not.toBe(await caminhoCacheVozElevenlabs(original));
  });
});
