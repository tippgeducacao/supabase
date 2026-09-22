import { describe, expect, it } from 'vitest';
import type { Msg } from './historico';
import { avaliarPoliticaVoz, type OpcoesPoliticaVoz } from './politicaVoz';

const texto = 'a conversa com o monitor ajuda a esclarecer suas dúvidas sobre a pós. qual período costuma ser melhor?';
const lead = (content: Msg['content']): Msg => ({ role: 'user', content });
const avaliar = (opcoes: Partial<OpcoesPoliticaVoz> = {}) => avaliarPoliticaVoz({
  habilitada: true, cadenciaAtingida: true, origem: 'conversa', texto, historico: [lead('pode mandar por áudio?')], ...opcoes,
});

describe('voz exige um ponto de uso autorizado', () => {
  it('é opt-in mesmo depois de atingir a cadência', () => {
    expect(avaliar({ habilitada: undefined }).motivo).toBe('voz_desativada');
    expect(avaliar({ habilitada: false }).permitido).toBe(false);
  });

  it.each(['conversa', 'followup'] as const)('a cadência autoriza %s sem exigir pedido de áudio', (origem) => {
    expect(avaliar({ origem, historico: [lead('Quero conhecer a pós')] })).toEqual({ permitido: true, motivo: 'cadencia_atingida' });
    expect(avaliar({ origem, historico: [] }).permitido).toBe(true);
  });

  it.each(['conversa', 'followup'] as const)('pedido explícito nunca antecipa o intervalo em %s', (origem) => {
    for (const cadenciaAtingida of [undefined, false]) {
      expect(avaliar({ origem, cadenciaAtingida })).toEqual({ permitido: false, motivo: 'intervalo_nao_atingido' });
    }
    expect(avaliarPoliticaVoz({ habilitada: true, origem, texto, historico: [lead('Pode mandar áudio?')] }).permitido).toBe(false);
  });

  it('etapas antigas do follow-up não substituem o contador de interações', () => {
    expect(avaliar({ origem: 'followup', cadenciaAtingida: false, etapaFollowup: 2, etapasFollowupPermitidas: [2] }).motivo).toBe('intervalo_nao_atingido');
    expect(avaliar({ origem: 'followup', etapaFollowup: 1, etapasFollowupPermitidas: [] }).motivo).toBe('cadencia_atingida');
  });

  it('não manda um segundo áudio na rodada nem em mensagens consecutivas', () => {
    expect(avaliar({ audiosEnviadosNaRodada: 0 }).permitido).toBe(true);
    for (const audiosEnviadosNaRodada of [1, 2, -1, NaN, Infinity, 0.5]) {
      expect(avaliar({ audiosEnviadosNaRodada }).motivo).toBe('limite_rodada');
    }
    expect(avaliar({ ultimoEnvioFoiAudio: true }).motivo).toBe('audio_consecutivo');
  });
});

describe('preferência vem somente de pedido explícito do lead', () => {
  it.each([
    'pode mandar por áudio?', 'Você consegue me explicar por áudio?',
    'me manda um áudio, por favor', 'Prefiro receber áudio.',
    'Agora pode me enviar uma mensagem de voz?',
    'Oi! Mande por áudio, por favor.',
    '[Transcrição do áudio recebido do lead] Pode responder por áudio?',
  ])('pedido próprio desfaz preferência por texto sem antecipar intervalo: %s', (pedido) => {
    const historico = [lead('Prefiro texto.'), lead(pedido)];
    expect(avaliar({ historico })).toEqual({ permitido: true, motivo: 'cadencia_atingida' });
    expect(avaliar({ historico, cadenciaAtingida: false }).motivo).toBe('intervalo_nao_atingido');
  });

  it.each([
    'não consigo ouvir áudio', 'agora não posso escutar áudio',
    'Não me mande áudio.', 'não envia mais áudio', 'sem áudio, por favor',
    'prefiro texto', 'Me manda por escrito.', 'pode responder em texto?',
    'Prefiro que seja por texto.', 'Gostaria de receber por escrito.',
    'Manda por texto, por favor.', 'Não manda por áudio.', 'Não escuto áudios.',
    'Sem enviar áudios, por favor.',
    'Prefiro ler.', 'só por mensagem', 'Não quero áudio, prefiro texto.',
    'mande áudio, mas não consigo ouvir áudio agora',
  ])('mantém por escrito e bloqueia também o follow-up: %s', (pedido) => {
    const historico = [lead('Pode mandar áudio?'), lead(pedido), lead('Sou veterinária.')];
    expect(avaliar({ historico }).motivo).toBe('preferencia_texto');
    expect(avaliar({ origem: 'followup', historico }).motivo).toBe('preferencia_texto');
  });

  it('a última preferência explícita substitui a anterior e persiste depois de fala neutra', () => {
    const historico = [lead('Não consigo ouvir áudio'), lead('Agora pode mandar áudio.')];
    expect(avaliar({ historico }).permitido).toBe(true);
    expect(avaliar({ historico: [...historico, lead('Sou veterinária')] }).motivo).toBe('cadencia_atingida');
    expect(avaliar({ historico: [...historico, lead('Pode me responder por escrito?')] }).motivo).toBe('preferencia_texto');
  });

  it.each([
    'sim', 'áudio', 'vou mandar um áudio', 'eu prefiro mandar áudio',
    'pode ouvir meu áudio?', 'não precisa mandar áudio', 'não consegue mandar áudio?',
    'se puder, pode mandar áudio amanhã', 'se eu ficar sem internet, pode mandar áudio',
    'quando eu sair, pode mandar áudio', 'minha colega pediu para mandar áudio',
    'Ela disse: "pode mandar áudio?"', '> pode mandar áudio?',
    '```\npode mandar áudio?\n```',
    '[CORRECAO_INTERNA_AUTO_IGNORE] pode mandar áudio?',
    '[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE] pode mandar áudio?',
    '[CONTEXTO DO ATENDIMENTO] pode mandar áudio?',
  ])('ambiguidade, citação ou instrução não removem preferência por texto: %s', (pedido) => {
    expect(avaliar({ historico: [lead('Prefiro texto.'), lead(pedido)] }).motivo).toBe('preferencia_texto');
  });

  it('ignora assistant, fala humana importada e tool_result inclusive com text auxiliar', () => {
    const historico: Msg[] = [
      lead('Quero saber mais sobre a pós'),
      { role: 'assistant', content: 'pode mandar áudio?' },
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] prefiro áudio' },
      lead([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'prefiro áudio' }, { type: 'text', text: 'pode mandar áudio?' }]),
    ];
    expect(avaliar({ historico, cadenciaAtingida: false }).motivo).toBe('intervalo_nao_atingido');
    expect(avaliar({ historico: [lead('Não consigo ouvir áudio'), ...historico] }).motivo).toBe('preferencia_texto');
  });

  it('aceita blocos de texto do lead sem mutar o histórico', () => {
    const historico = [lead([{ type: 'text', text: 'Pode mandar áudio?' }])];
    const original = structuredClone(historico);
    expect(avaliar({ historico }).permitido).toBe(true);
    expect(historico).toEqual(original);
  });
});

describe('conteúdo que precisa permanecer acessível por escrito', () => {
  it.each([
    'Confira o link https://meet.google.com/abc-defg-hij para entrar na nossa conversa.',
    'Você encontra todas as informações e o material no site escolappg.com.br.',
    'Pode enviar a sua dúvida para atendimento@ppg.educacao que o time responde por lá.',
    'O investimento integral da pós é de R$ 4.200,00, conforme o material informado.',
    'O investimento informado no material é de quatro mil reais para esta pós.',
    'A conversa ficou para amanhã às 14h30, conforme o horário que você escolheu.',
    'A conversa ficou para amanhã às duas da tarde, conforme o horário escolhido.',
    'A conversa ficou combinada para amanhã ao meio-dia com o monitor da pós.',
    'O protocolo para consultar esse atendimento é ABCDE, guarde para consultar depois.',
    'Você pode consultar o endereço informado para chegar ao local da aula presencial.',
  ])('preserva texto mesmo com pedido de áudio: %s', (texto) => {
    expect(avaliar({ texto })).toEqual({ permitido: false, motivo: 'conteudo_para_escrita' });
  });

  it('não transforma resposta curta nem texto longo em áudio e respeita os limites inclusivos', () => {
    expect(avaliar({ texto: 'certo, combinado.' }).motivo).toBe('texto_curto');
    expect(avaliar({ texto: 'a'.repeat(39) }).motivo).toBe('texto_curto');
    expect(avaliar({ texto: 'a'.repeat(40) }).permitido).toBe(true);
    expect(avaliar({ texto: 'a'.repeat(600) }).permitido).toBe(true);
    expect(avaliar({ texto: 'a'.repeat(601) }).motivo).toBe('texto_longo');
  });
});
