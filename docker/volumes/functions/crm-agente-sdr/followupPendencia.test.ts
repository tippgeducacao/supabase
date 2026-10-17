import { describe, expect, it } from 'vitest';
import { conviteFeito, followupDaPendencia, perguntaPendente } from './followupPendencia';

const h = (...m: [string, unknown][]) => m.map(([role, content]) => ({ role, content })) as any;
const TEMPLATE = 'Oii José Tudo bem? Me fala, você atua na parte técnica, com extensão ou sanidade junto aos produtores, ou possui granja de postura comercial? Consegue me retornar?';

describe('follow-up antes do convite (caso José)', () => {
  const hist = h(['assistant', TEMPLATE], ['user', 'Sou nutricionista'],
    ['assistant', 'bacana, como nutricionista, vc trabalha numa empresa do agro ou em outra área?']);

  it('sem convite: a pergunta pendente volta com o gancho do lote', () => {
    expect(conviteFeito(hist)).toBe(false);
    expect(perguntaPendente(hist)).toBe('como nutricionista, vc trabalha numa empresa do agro ou em outra área?');
    expect(followupDaPendencia(hist, 'José', 'MBA | POSTURA COMERCIAL'))
      .toBe('José, estamos em fechamento do primeiro lote promocional do MBA em postura comercial. me conta, como nutricionista, vc trabalha numa empresa do agro ou em outra área?');
  });

  it('com convite feito, lead que respondeu, só o template ou vendedor: nada', () => {
    const convite = [...hist, { role: 'assistant', content: 'a gente tá fechando o primeiro lote promocional do MBA…' }] as any;
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
