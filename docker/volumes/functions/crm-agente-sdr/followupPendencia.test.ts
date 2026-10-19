import { describe, expect, it } from 'vitest';
import { conviteFeito, followupDaPendencia, perguntaPendente } from './followupPendencia';

const h = (...m: [string, unknown][]) => m.map(([role, content]) => ({ role, content })) as any;
const TEMPLATE = 'Oii José Tudo bem? Me fala, você atua na parte técnica, com extensão ou sanidade junto aos produtores, ou possui granja de postura comercial? Consegue me retornar?';

describe('follow-up antes do convite (caso José)', () => {
  const hist = h(['assistant', TEMPLATE], ['user', 'Sou nutricionista'],
    ['assistant', 'bacana, como nutricionista, vc trabalha numa empresa do agro ou em outra área?']);

  it('sem convite: a pergunta pendente volta com o gancho do lote', () => {
    expect(conviteFeito(hist)).toBe(false);
    expect(perguntaPendente(hist)).toBe('vc trabalha numa empresa do agro ou em outra área?');
    expect(followupDaPendencia(hist, 'José', 'MBA | POSTURA COMERCIAL'))
      .toBe('José, estamos em fechamento do primeiro lote promocional do MBA em postura comercial. me conta, vc trabalha numa empresa do agro ou em outra área?');
  });

  it('com convite feito, lead que respondeu, só o template ou vendedor: nada', () => {
    const convite = [...hist, { role: 'assistant', content: 'a gente tá fechando o primeiro lote promocional do MBA… é uma conversa rápida no meet com um monitor especialista' }] as any;
    // O próprio toque da pendência fala do lote e não é convite.
    expect(conviteFeito([...hist, { role: 'assistant', content: 'José, estamos em fechamento do primeiro lote promocional do MBA em postura comercial. me conta, vc trabalha onde?' }] as any)).toBe(false);
    expect(conviteFeito(convite)).toBe(true);
    expect(followupDaPendencia(convite, 'José', 'MBA | POSTURA COMERCIAL')).toBe('');
    expect(perguntaPendente([...hist, { role: 'user', content: 'trabalho numa integradora' }] as any)).toBe('');
    expect(perguntaPendente(h(['assistant', TEMPLATE]))).toBe('');
    expect(perguntaPendente([...hist, { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Amanda · 2026-10-17 12:00:00 UTC oi' }] as any)).toBe('');
  });

  it('o marcador do follow-up não conta como fala do lead', () => {
    expect(perguntaPendente([...hist, { role: 'user', content: '[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE]' }] as any)).not.toBe('');
  });
});

describe('disparo com horário antes da conversa (caso Mariela)', () => {
  it('a pergunta do mapa que ficou pendente vale, mesmo depois de um disparo com horário', () => {
    const hist = h(['assistant', 'Oii Mariela Tudo bem? Me fala, você já trabalha em frigorífico ou laticínio?'],
      ['assistant', 'Vamos ter a última abertura de turma do ano! Podemos conversar hoje às 11h30 ou às 18h30? Qual horário fica melhor para você?'],
      ['user', 'Oi tudo ótimo Sim trabalho no frigorífico'],
      ['assistant', 'bacana, no frigorífico vc é servidora pública, RT autônoma ou contratada pela empresa?'],
      ['user', 'Contratada pela empresa'],
      ['assistant', 'legal, trabalhando contratada no frigorífico, a empresa tem plano de carreira pra vc?']);
    expect(followupDaPendencia(hist, 'Mariela', 'PÓS | QUALIDADE E SEGURANÇA DE ALIMENTOS DE ORIGEM ANIMAL'))
      .toBe('Mariela, estamos em fechamento do primeiro lote promocional da pós em qualidade e segurança de alimentos de origem animal. me conta, a empresa tem plano de carreira pra vc?');
  });

  it('a última pergunta nossa que já é o convite não é pendência', () => {
    const hist = h(['assistant', 'oi'], ['user', 'sou vet'], ['assistant', 'bacana. pra conversa com o monitor, tenho hoje 16h ou 17h. qual fica melhor?']);
    expect(perguntaPendente(hist)).toBe('');
  });
});
