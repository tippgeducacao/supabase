import { describe, expect, it } from 'vitest';
import { blocoPerguntasRecentes, perguntasDaFala } from './perguntasRecentes';
import type { Msg } from './historico';

describe('perguntas já feitas na conversa', () => {
  it('pergunta do João com a resposta do lead; escolha de horário fica fora', () => {
    const historico: Msg[] = [
      { role: 'user', content: 'quero saber da pós' },
      { role: 'assistant', content: 'bacana. antes, qual é a sua graduação?' },
      { role: 'user', content: 'sou veterinário formado' },
      { role: 'assistant', content: [{ type: 'text', text: 'tenho 15h ou 16h30 amanhã. qual fica melhor pra vc?' }] },
      { role: 'user', content: '16h30' },
    ];
    expect(blocoPerguntasRecentes(historico)).toBe(
      '[PERGUNTAS JÁ FEITAS NESTA CONVERSA — tirado do histórico; não é fala do lead]\n'
      + '- você: "antes, qual é a sua graduação?" → o lead escreveu depois: "sou veterinário formado"\n'
      + 'Se o que o lead escreveu depois já responde a pergunta, não a refaça, nem com outras palavras: use a resposta e siga. '
      + 'Se não responde, você pode retomá-la uma vez, de outro jeito.',
    );
  });

  it('fala humana vira "atendente"; citação do WhatsApp e correção interna não entram como resposta', () => {
    const historico: Msg[] = [
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Flávia · 2026-09-21 14:15:02 UTC\nvc atua com bovinos de leite ou de corte?' },
      { role: 'user', content: '[Em resposta à mensagem: "vc atua com bovinos de leite ou de corte?"] leite' },
      { role: 'user', content: '[CORRECAO_INTERNA_AUTO_IGNORE] responda de novo' },
    ];
    expect(blocoPerguntasRecentes(historico)).toContain('- atendente: "vc atua com bovinos de leite ou de corte?" → o lead escreveu depois: "leite"');
    expect(blocoPerguntasRecentes(historico)).not.toContain('CORRECAO');
  });

  it('a mesma pergunta repetida conta uma vez (a mais recente); sem resposta fica marcada; limite de 5', () => {
    const historico: Msg[] = [
      { role: 'assistant', content: 'vc já é formado em medicina veterinária?' },
      { role: 'user', content: 'ainda não' },
      { role: 'assistant', content: 'entendi. vc já é formado em medicina veterinária mesmo?' },
    ];
    const bloco = blocoPerguntasRecentes(historico);
    expect(bloco.match(/formado em medicina/g)).toHaveLength(1);
    expect(bloco).toContain('(nada ainda)');
    const muitas: Msg[] = [
      'qual é a sua graduação?', 'vc atua com bovinos hoje?', 'em que cidade vc mora?', 'já fez alguma pós antes?',
      'o que te chamou atenção na aula?', 'prefere conversar de manhã?', 'conhece o app do nasem?',
    ].map((content) => ({ role: 'assistant' as const, content }));
    expect(blocoPerguntasRecentes(muitas).split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5);
  });

  it('sem perguntas não há bloco; pergunta curta demais não conta', () => {
    expect(blocoPerguntasRecentes([{ role: 'assistant', content: 'show, combinado.' }])).toBe('');
    expect(perguntasDaFala('beleza, né? qual área vc atua hoje?')).toEqual(['qual área vc atua hoje?']);
  });
});
