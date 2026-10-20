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

  it('disparo com horário antes da resposta não conta como convite (caso Márcia)', () => {
    const hist = h(['assistant', 'Oii Márcia Tudo bem? sou o monitor responsável pelo seu atendimento! Consegue me retornar?'],
      ['assistant', 'Vamos ter a última abertura de turma do ano agora dia 24/10. Podemos conversar hoje às 16h30 ou às 19h30?'],
      ['user', 'Bom dia quero mais detalhes'],
      ['assistant', [{ type: 'tool_use', id: 'x', name: 'consulta_pos_disponiveis', input: {} }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }]],
      ['assistant', 'bom dia, claro, te mando o cronograma completo da pós em saúde única e zoonoses. qual é sua graduação e em que área vc atua hoje?'],
      ['user', '[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE]'],
      ['assistant', 'Márcia, estamos em fechamento do primeiro lote promocional da pós em saúde única e zoonoses. me conta, qual é sua graduação?']);
    expect(conviteFeito(hist)).toBe(false);
    // Convite na resposta ao lead (em pedaços, depois de ferramenta) e convite do vendedor contam.
    expect(conviteFeito([...hist.slice(0, 5), ['assistant', 'bacana'], ['assistant', 'é uma conversa rápida no meet com um monitor especialista']]
      .map((m: any) => Array.isArray(m) ? { role: m[0], content: m[1] } : m) as any)).toBe(true);
    expect(conviteFeito([...hist, { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Erika · 2026-10-20 12:00:00 UTC consigo 15h, pode ser?' }] as any)).toBe(true);
    // O próprio toque de agenda do follow-up não vira convite.
    expect(conviteFeito([...hist, { role: 'user', content: '[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE]' },
      { role: 'assistant', content: 'márcia, faz sentido procurar um horário para sua conversa com o monitor?' }] as any)).toBe(false);
  });

  it('a última pergunta nossa que já é o convite não é pendência', () => {
    const hist = h(['assistant', 'oi'], ['user', 'sou vet'], ['assistant', 'bacana. pra conversa com o monitor, tenho hoje 16h ou 17h. qual fica melhor?']);
    expect(perguntaPendente(hist)).toBe('');
  });
});
