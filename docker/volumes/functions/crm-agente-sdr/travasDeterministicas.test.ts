import { describe, expect, it } from 'vitest';
import type { Msg } from './historico';
import {
  afirmaReuniaoSemCriar, conferirHorarioDaFerramenta, correcaoDaFala, historicoDeConsultas, horariosNaoOfertados, opcoesDeAgenda,
  slotsDoTextoDeAgenda, valoresInventados,
} from './travasDeterministicas';

const resultado = (saida: Record<string, unknown>): Msg => ({
  role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: JSON.stringify(saida) }],
});
const consulta = (slots: [string, string, number][]) => resultado({
  resultado: 'Horários disponíveis…', slots_raw: slots.map(([data, horario, v]) => ({ data, horario, vendedor_id: v, vendedor_nome: `Monitor ${v}` })),
});
const AGORA = new Date('2026-09-29T15:00:00-03:00');
const historico: Msg[] = [
  { role: 'user', content: 'oi, quero saber da pós' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'consulta_disponibilidade', input: {} }] },
  consulta([['2026-09-29', '16:30', 7], ['2026-09-29', '18:00', 9], ['2026-09-30', '09:30', 7]]),
];

describe('opções de agenda', () => {
  it('sem consulta = null; com consulta, os slots', () => {
    expect(opcoesDeAgenda([{ role: 'user', content: 'oi' }])).toBeNull();
    expect(opcoesDeAgenda(historico)?.map((o) => `${o.data} ${o.horario} ${o.vendedor_id}`))
      .toEqual(['2026-09-29 16:30 7', '2026-09-29 18:00 9', '2026-09-30 09:30 7']);
  });
  it('só as 3 últimas consultas valem', () => {
    const h = [consulta([['2026-09-29', '10:00', 1]]), consulta([['2026-09-29', '11:00', 1]]),
      consulta([['2026-09-29', '12:00', 1]]), consulta([['2026-09-29', '13:00', 1]])];
    expect(opcoesDeAgenda(h)?.map((o) => o.horario)).toEqual(['11:00', '12:00', '13:00']);
  });
});

describe('ao chamar confirmar/remarcar: o horário tem de ter saído da agenda', () => {
  const conferir = (input: Record<string, unknown>, vendedorObrigatorio = true, h = historico) =>
    conferirHorarioDaFerramenta(input, h, { vendedorObrigatorio, agora: AGORA });

  it('slot da consulta, no futuro: passa (aceita hora sem zero à esquerda)', () => {
    expect(conferir({ data_escolhida: '2026-09-29', horario_escolhido: '16:30', vendedor_id: 7 })).toEqual({ ok: true });
    expect(conferir({ data_escolhida: '2026-09-30', horario_escolhido: '9:30', vendedor_id: '7' })).toEqual({ ok: true });
  });
  it('horário inventado é barrado, com a lista certa no retorno', () => {
    const r = conferir({ data_escolhida: '2026-09-29', horario_escolhido: '17:00', vendedor_id: 7 });
    expect(r).toMatchObject({ ok: false, motivo: 'horario_fora_da_consulta' });
    expect(!r.ok && r.mensagem).toContain('2026-09-29 16:30 · vendedor_id 7');
    expect(!r.ok && r.mensagem).toContain('Nada foi agendado');
  });
  it('data errada (ano, dia) é barrada', () => {
    expect(conferir({ data_escolhida: '2025-09-29', horario_escolhido: '16:30', vendedor_id: 7 })).toMatchObject({ motivo: 'horario_fora_da_consulta' });
  });
  it('vendedor trocado é barrado e o certo é dito', () => {
    const r = conferir({ data_escolhida: '2026-09-29', horario_escolhido: '18:00', vendedor_id: 7 });
    expect(r).toMatchObject({ ok: false, motivo: 'vendedor_diferente' });
    expect(!r.ok && r.mensagem).toContain('vendedor_id 9');
  });
  it('sem consulta nenhuma: barrado', () => {
    expect(conferir({ data_escolhida: '2026-09-29', horario_escolhido: '16:30', vendedor_id: 7 }, true, [])).toMatchObject({ motivo: 'sem_consulta' });
  });
  it('horário que já passou: barrado', () => {
    const h = [consulta([['2026-09-29', '14:00', 7]])];
    expect(conferir({ data_escolhida: '2026-09-29', horario_escolhido: '14:00', vendedor_id: 7 }, true, h)).toMatchObject({ motivo: 'horario_passou' });
  });
  it('remarcar sem vendedor (mantém o atual): basta o horário existir', () => {
    expect(conferir({ data_escolhida: '2026-09-29', horario_escolhido: '18:00' }, false)).toEqual({ ok: true });
    expect(conferir({ data_escolhida: '2026-09-29', horario_escolhido: '18:00' }, true)).toMatchObject({ motivo: 'sem_vendedor' });
  });
});

describe('simulador: slots lidos do texto da consulta', () => {
  it('lê o mesmo formato do executor real e confere com ele', () => {
    const texto = 'Horários disponíveis para a conversa com o monitor (Brasília):\n'
      + '- 15h de quinta, dia 2099-10-01 (vendedor_id: v1, nome: Ana)\n- 16h30 de quinta, dia 2099-10-01 (vendedor_id: v1, nome: Ana)\n(O dia da semana…)';
    const slots = slotsDoTextoDeAgenda(texto);
    expect(slots).toEqual([
      { data: '2099-10-01', horario: '15:00', vendedor_id: 'v1', vendedor_nome: 'Ana' },
      { data: '2099-10-01', horario: '16:30', vendedor_id: 'v1', vendedor_nome: 'Ana' },
    ]);
    const h = historicoDeConsultas([slots]);
    expect(conferirHorarioDaFerramenta({ data_escolhida: '2099-10-01', horario_escolhido: '16:30', vendedor_id: 'v1' }, h, { vendedorObrigatorio: true })).toEqual({ ok: true });
    expect(conferirHorarioDaFerramenta({ data_escolhida: '2099-10-01', horario_escolhido: '17:00', vendedor_id: 'v1' }, h, { vendedorObrigatorio: true }))
      .toMatchObject({ ok: false, motivo: 'horario_fora_da_consulta' });
  });
  it('replay de conversa real: lê o JSON do executor (slots_raw)', () => {
    const real = JSON.stringify({ resultado: 'Horários…', slots_raw: [{ data: '2099-10-01', horario: '15:00', vendedor_id: 7, vendedor_nome: 'Ana' }] });
    expect(slotsDoTextoDeAgenda(real)).toEqual([{ data: '2099-10-01', horario: '15:00', vendedor_id: '7', vendedor_nome: 'Ana' }]);
    expect(slotsDoTextoDeAgenda(JSON.stringify({ resultado: '- 9h de sexta, dia 2099-10-02 (vendedor_id: 3, nome: Bia)' })))
      .toEqual([{ data: '2099-10-02', horario: '09:00', vendedor_id: '3', vendedor_nome: 'Bia' }]);
  });
});

describe('na fala: horário oferecido', () => {
  it('oferta com horário da consulta passa; inventado é pego', () => {
    expect(horariosNaoOfertados('consigo hoje 16h30 ou 18h, qual fica melhor?', historico)).toEqual([]);
    expect(horariosNaoOfertados('consigo hoje 17h ou 18h, qual fica melhor?', historico)).toEqual(['17:00']);
  });
  it('horário que o próprio lead disse pode ser repetido', () => {
    const h: Msg[] = [...historico, { role: 'user', content: 'e às 20h, tem?' }];
    expect(horariosNaoOfertados('às 20h não tenho, mas consigo 18h, pode ser?', h)).toEqual([]);
  });
  it('lead escreve a hora sem "h" ("quero as 18") — 1º teste real, 29/09', () => {
    const h: Msg[] = [{ role: 'assistant', content: 'podemos agendar amanhã ás 11:00h ou 18:00h?' }, { role: 'user', content: 'oi quero as 18' }];
    expect(horariosNaoOfertados('vc já se formou? aí confiro a disponibilidade para amanhã, perto das 18h.', h)).toEqual([]);
    expect(horariosNaoOfertados('vc já se formou? aí confiro amanhã às 11h ou 18h?', h)).toEqual(['11:00']);
    for (const fala of ['pode ser às 9', 'lá pelas 20 horas', 'depois das 19']) {
      expect(horariosNaoOfertados('consigo esse horário, pode ser?'.replace('esse horário', fala.match(/\d+/)![0] + 'h'), [{ role: 'user', content: fala }])).toEqual([]);
    }
    // quantidade não é hora
    expect(horariosNaoOfertados('consigo 2h, pode ser?', [{ role: 'user', content: 'tenho as 2 opções' }])).toEqual(['02:00']);
  });
  it('a correção interna (que cita o texto barrado) não vira "fala do lead" na segunda tentativa', () => {
    const h: Msg[] = [...historico, { role: 'user', content: '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada: """consigo 17h, pode ser?"""' }];
    expect(horariosNaoOfertados('consigo 17h, pode ser?', h)).toEqual(['17:00']);
    expect(valoresInventados('fica R$ 300', [...historico, { role: 'user', content: '[CORRECAO_INTERNA_AUTO_IGNORE] """fica R$ 300"""' }])).toEqual(['R$ 300']);
  });
  it('horário de consulta antiga (fora das 3 últimas) não vale mais', () => {
    const h = [consulta([['2026-09-29', '10:00', 1]]), consulta([['2026-09-29', '11:00', 1]]),
      consulta([['2026-09-29', '12:00', 1]]), consulta([['2026-09-29', '13:00', 1]])];
    expect(horariosNaoOfertados('consigo 10h, pode ser?', h)).toEqual(['10:00']);
  });
  it('sem pergunta não é oferta; duração não é horário', () => {
    expect(horariosNaoOfertados('a gente atende até 20h30, deixa eu ver um encaixe pra vc', historico)).toEqual([]);
    expect(horariosNaoOfertados('me avisa com 2h de antecedência, combinado?', historico)).toEqual([]);
  });
});

describe('na fala: valor', () => {
  const comPreco: Msg[] = [...historico, resultado({ resultado: 'Valor integral da pós: R$ 4.200,00. Matrícula: R$ 150,00.' })];
  it('valor que veio da ferramenta passa, em qualquer formato', () => {
    expect(valoresInventados('o valor integral é R$ 4.200,00 e a matrícula R$ 150', comPreco)).toEqual([]);
    expect(valoresInventados('fica 4.200,00 reais no integral', comPreco)).toEqual([]);
  });
  it('valor inventado é pego', () => {
    expect(valoresInventados('fica em torno de R$ 300 por mês', comPreco)).toEqual(['R$ 300']);
    expect(valoresInventados('fica em torno de R$ 300 por mês', historico)).toEqual(['R$ 300']);
  });
  it('sem valor na fala, nada a conferir', () => {
    expect(valoresInventados('o valor o monitor apresenta na conversa', historico)).toEqual([]);
  });
});

describe('na fala: reunião marcada sem agendamento', () => {
  it('afirmar marcado sem ter agendado é pego', () => {
    expect(afirmaReuniaoSemCriar('show, sua reunião está confirmada pras 16h30', historico, false)).toBe(true);
    expect(afirmaReuniaoSemCriar('beleza, já agendei aqui pra vc', historico, false)).toBe(true);
    expect(afirmaReuniaoSemCriar('segue o link: https://meet.google.com/abc-defg-hij', historico, false)).toBe(true);
  });
  it('convite e pergunta não são afirmação', () => {
    expect(afirmaReuniaoSemCriar('vamos marcar sua conversa pra garantir essa condição?', historico, false)).toBe(false);
    expect(afirmaReuniaoSemCriar('beleza, fico com as 16h30 então. antes de eu fechar esse horário, preciso confirmar duas coisinhas', historico, false)).toBe(false);
  });
  it('com agendamento criado nesta conversa, ou lead já agendado, pode falar', () => {
    const agendado: Msg[] = [...historico, resultado({ resultado: 'ok', agendamento_id: 'ag-1', confirmacao: { data: '29/09 16h30' } })];
    expect(afirmaReuniaoSemCriar('sua reunião está confirmada', agendado, false)).toBe(false);
    expect(afirmaReuniaoSemCriar('sua reunião está confirmada', historico, true)).toBe(false);
  });
  it('a correção é interna e manda preservar o resto', () => {
    const c = correcaoDaFala('reuniao', 'show, tá marcado', '');
    expect(c.startsWith('[CORRECAO_INTERNA_AUTO_IGNORE]')).toBe(true);
    expect(c).toContain('PRESERVANDO');
  });
});
