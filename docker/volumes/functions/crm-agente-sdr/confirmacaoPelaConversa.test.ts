import { describe, expect, it } from 'vitest';
import { leadConfirmouConclusao, simPelaConversaLigado } from './confirmacaoPelaConversa';
import type { Msg } from './historico';

const conversa = (ia: string, ...lead: string[]): Msg[] => [
  { role: 'user', content: 'A noite' },
  { role: 'assistant', content: ia },
  ...lead.map((t): Msg => ({ role: 'user', content: t })),
];
const PERGUNTA = 'à noite então. vc já se formou em agronomia?';

describe('o sim que o modelo esqueceu de registrar', () => {
  it('caso Kamila: pergunta de conclusão seguida de "Sim"', () => {
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'Sim'))).toBe(true);
  });

  it.each(['Sim', 'sim!', 'Já sim', 'Ja', 'Sim, já me formei', 'sou formada', 'Isso', 'ss', 'Já concluí', 'Uhum', 'Sim 👍', 'SIM.'])(
    'sim claro: %s', (resposta) => {
      expect(leadConfirmouConclusao(conversa(PERGUNTA, resposta))).toBe(true);
    });

  it.each([
    'sim, mas falta o TCC', 'quase', 'ainda não', 'não', 'me formo ano que vem', 'sim, termino em dezembro', 'estou no 8 período',
    'sim, ainda cursando', 'acho que sim', 'sim e vc?', 'qual o valor?', 'tranquei', 'sim, vou colar grau em março', 'sim mas em outra área',
  ])('resposta com ressalva ou fora do roteiro não conta: %s', (resposta) => {
    expect(leadConfirmouConclusao(conversa(PERGUNTA, resposta))).toBe(false);
  });

  it('o "sim" só vale para a pergunta que FECHA a fala da IA', () => {
    expect(leadConfirmouConclusao(conversa('vc já se formou em agronomia? consigo te encaixar hoje à noite, pode ser?', 'Sim'))).toBe(false);
    expect(leadConfirmouConclusao(conversa('consigo te encaixar ainda hoje, pode ser?', 'Sim'))).toBe(false);
    expect(leadConfirmouConclusao(conversa('te enviei o cronograma. vc já se formou em agronomia', 'Sim'))).toBe(false);
  });

  it('pergunta com alternativa deixa o "sim" ambíguo', () => {
    expect(leadConfirmouConclusao(conversa('vc já se formou ou ainda tá cursando?', 'Sim'))).toBe(false);
    expect(leadConfirmouConclusao(conversa('e quando vc conclui a graduação?', 'Sim'))).toBe(false);
  });

  it('variações da pergunta de conclusão', () => {
    expect(leadConfirmouConclusao(conversa('show, à noite então. vc já concluiu a graduação em zootecnia?', 'já'))).toBe(true);
    expect(leadConfirmouConclusao(conversa('quando der eu te chamo.\nvc já é formada em medicina veterinária?', 'sou formada'))).toBe(true);
  });

  it('duas mensagens do lead: a primeira é o sim, a segunda não pode trazer ressalva', () => {
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'Sim', '20h30 fica bom'))).toBe(true);
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'Sim', 'mas ainda falta a colação'))).toBe(false);
    expect(leadConfirmouConclusao(conversa(PERGUNTA, '20h30', 'sim'))).toBe(false);
  });

  it('blocos de ferramenta no meio não atrapalham; sem resposta ou sem histórico, nada', () => {
    const comTool: Msg[] = [
      { role: 'assistant', content: PERGUNTA },
      { role: 'user', content: 'Sim' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'verificar_compatibilidade_curso', input: {} }] as any },
    ];
    expect(leadConfirmouConclusao(comTool)).toBe(true);
    expect(leadConfirmouConclusao(conversa(PERGUNTA))).toBe(false);
    expect(leadConfirmouConclusao([])).toBe(false);
    expect(leadConfirmouConclusao(null)).toBe(false);
  });

  it('a chave da produção: só liga com true no banco; erro ou ausência = desligada', async () => {
    const banco = (data: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
    expect(await simPelaConversaLigado(banco({ formacao_sim_pela_conversa: true }))).toBe(true);
    expect(await simPelaConversaLigado(banco({ formacao_sim_pela_conversa: false }))).toBe(false);
    expect(await simPelaConversaLigado(banco(null))).toBe(false);
    expect(await simPelaConversaLigado(banco({ formacao_sim_pela_conversa: true }, { message: 'x' }))).toBe(false);
    expect(await simPelaConversaLigado({ from: () => { throw new Error('rede'); } })).toBe(false);
  });
});
