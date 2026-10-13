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

  // Formas vistas nas 50 conversas reais de 07 a 13/10/2026 em que a conferência mandou perguntar.
  it('resposta citando a própria pergunta (o gateway embute a citação)', () => {
    expect(leadConfirmouConclusao(conversa('certo, vc já se formou em medicina veterinária?',
      '[Em resposta à mensagem: "certo, vc já se formou em medicina veterinária?"] Sim'))).toBe(true);
    // Citou OUTRA mensagem: o "isso" não responde à pergunta de conclusão.
    expect(leadConfirmouConclusao(conversa('certo, vc já se formou em medicina veterinária?',
      '[Em resposta à mensagem: "procuro um encaixe pra ainda hoje?"] Isso'))).toBe(false);
  });

  it.each(['Sim, a muito tempo.', 'Sim, 11 anos de formação', 'Ja sim,a 5 anos', 'sim, há 3 anos', 'Sim. Já tenho até doutorado'])(
    'sim com o tempo de formado ou com pós: %s', (resposta) => {
      expect(leadConfirmouConclusao(conversa(PERGUNTA, resposta))).toBe(true);
    });

  it('pergunta com "ou": só uma declaração responde, o sim sozinho não', () => {
    const comOu = 'certo. vc já concluiu agronomia ou ainda está cursando?';
    expect(leadConfirmouConclusao(conversa(comOu, 'Concluído'))).toBe(true);
    expect(leadConfirmouConclusao(conversa(comOu, 'já me formei'))).toBe(true);
    expect(leadConfirmouConclusao(conversa(comOu, 'Sim'))).toBe(false);
    expect(leadConfirmouConclusao(conversa(comOu, 'cursando'))).toBe(false);
  });

  it('reação não é resposta; "sim" com detalhe que muda o sentido fica de fora', () => {
    expect(leadConfirmouConclusao(conversa(PERGUNTA, '[reacao]👍'))).toBe(false);
    expect(leadConfirmouConclusao(conversa(PERGUNTA, '[reacao]❤️', 'Sim'))).toBe(true);
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'Sim… MAs agora sou fotógrafa'))).toBe(false);
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'sim, daqui a 2 anos'))).toBe(false);
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'Sim?'))).toBe(false);
    // Vistos em 08/10 e 13/10: o sim vem primeiro e a mensagem seguinte é outro assunto.
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'Sim', 'Qual são as formas de pagamento de vcs?'))).toBe(true);
    expect(leadConfirmouConclusao(conversa(PERGUNTA, 'Ja sim', '[Em resposta à mensagem: "oi, a pós está disponível online."] Perfeito'))).toBe(true);
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
