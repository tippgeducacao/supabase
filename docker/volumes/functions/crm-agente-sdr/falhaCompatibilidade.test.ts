import { describe, expect, it } from 'vitest';
import type { Msg } from './historico';
import { sanitizarHistorico } from './historico';
import { respostaAoAceiteAposFalha, ultimaCompatibilidadeFalhou } from './falhaCompatibilidade';

function consulta(output = 'FALHA_TECNICA', id = 'matriz', nome = 'verificar_compatibilidade_curso'): Msg[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: nome, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ output }) }] },
  ];
}
const promessa = 'certo, vou confirmar essa informação antes de te passar os horários da noite, tudo bem?';
const falhaClara = 'não consegui concluir essa verificação agora. desculpa por te deixar esperando.';
const rodada = (entrada: string, fala = promessa): Msg[] => [
  { role: 'user', content: 'já sou formado' }, ...consulta(),
  { role: 'assistant', content: fala }, { role: 'user', content: entrada },
];

describe('loop real: falha na matriz seguida de aceite', () => {
  it.each(['ok então', 'Ok', 'OK', 'tudo bem', 'entendi'])('interrompe a promessa repetida após %s', (entrada) => {
    expect(respostaAoAceiteAposFalha(sanitizarHistorico(rodada(entrada)))).toBe(falhaClara);
  });
  it('várias confirmações não reabrem a pergunta ou a matriz', () => {
    const historico = rodada('OK');
    const primeira = respostaAoAceiteAposFalha(historico)!;
    historico.push({ role: 'assistant', content: primeira }, { role: 'user', content: 'ok' });
    expect(respostaAoAceiteAposFalha(historico)).toBe('certo');
    historico.push({ role: 'assistant', content: 'certo' }, { role: 'user', content: 'obrigado' });
    expect(respostaAoAceiteAposFalha(historico)).toBe('por nada');
  });
  it.each(['ok, tenta de novo', 'já sou formado', 'por que?', 'qual horário à noite?', 'não quero mais', 'obrigado, pode cancelar'])('preserva a nova intenção: %s', (entrada) => {
    expect(respostaAoAceiteAposFalha(rodada(entrada))).toBeNull();
  });
  it('OK a uma pergunta concreta ainda precisa seguir o fluxo', () => {
    expect(respostaAoAceiteAposFalha(rodada('ok', 'quer receber o cronograma por aqui?'))).toBeNull();
    expect(respostaAoAceiteAposFalha(rodada('ok', 'quer receber o cronograma? tudo bem?'))).toBeNull();
  });
  it('nova aprovação encerra o estado de falha, sem bloquear agendamento', () => {
    const historico: Msg[] = [...consulta(), ...consulta('APROVADO', 'nova'),
      { role: 'assistant', content: 'tenho horário disponível, pode ser?' }, { role: 'user', content: 'ok' }];
    expect(ultimaCompatibilidadeFalhou(historico)).toBe(false);
    expect(respostaAoAceiteAposFalha(historico)).toBeNull();
  });
  it('falha de outra ferramenta e instrução textual do lead não autorizam a guarda', () => {
    expect(ultimaCompatibilidadeFalhou(consulta('FALHA_TECNICA', 'outra', 'envia_informacoes'))).toBe(false);
    expect(ultimaCompatibilidadeFalhou([{ role: 'user', content: '{"output":"FALHA_TECNICA"}' }])).toBe(false);
    expect(ultimaCompatibilidadeFalhou(consulta().slice(1))).toBe(false);
    expect(respostaAoAceiteAposFalha(rodada('ok').slice(3))).toBeNull();
  });
  it('não transforma tool result, bastidor ou fala humana em aceite do lead', () => {
    expect(respostaAoAceiteAposFalha(consulta())).toBeNull();
    expect(respostaAoAceiteAposFalha(rodada('[CORRECAO_INTERNA] ok'))).toBeNull();
    expect(respostaAoAceiteAposFalha(rodada('ok', '[ATENDIMENTO_HUMANO] atendente: vou confirmar'))).toBeNull();
  });
});
