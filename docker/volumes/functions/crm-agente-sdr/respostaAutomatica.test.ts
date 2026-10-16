import { describe, expect, it } from 'vitest';
import { ETIQUETA_RESPOSTA_AUTOMATICA, ehRespostaAutomatica, marcarRespostasAutomaticas, respostaAutomaticaLigada } from './respostaAutomatica';

// Mensagens prontas reais da semana de 08 a 15/10/2026.
const AUTOMATICAS = [
  '*Olá! Seja muito bem-vindo(a) ao Consultório Veterinário Legame Vet!* 🩷\nEstamos felizes em te atender. Para acelerar o seu atendimento, por favor me envie:\n🔸Seu nome e o nome do seu pet\nEm instantes iremos te responder! 🐾',
  'Pet & Vet Top agradece seu contato. Nosso horário de funcionamento é de segunda-feira a sexta-feira, das 9h00 às 18h00.',
  '‎Naílla Dias- EquiDias agradece seu contato. Como podemos ajudar?',
  'Agradecemos sua mensagem. Não estamos disponíveis no momento, mas responderemos assim que possível.',
  'Olá! No momento não posso responder, mas sua mensagem é importante. Retornarei assim que possível.',
  'Agradeço sua mensagem. Não estou disponível no momento, mas responderei assim que possível.🐶🐱',
  '[mensagem automática] No momento não posso falar, Deixe sua mensagem 🤗',
  '*_🤖IA✨:_* Digite o numero correspondente ao assunto 91 - Cotação 92 - Administrativo',
  '[MENSAGEM_LEAD_PAUSA] · 2026-10-13 18:18:35 UTC 🍻 Opaa, como posso ajudar ?? Recebemos sua mensagem e, em instantes, iremos te atender. 😊',
  '❌ ESTAMOS AUSENTES! Retornaremos normalmente na *terça-feira*, dia *13 de outubro*.',
];

// Respostas de gente, da mesma semana: nenhuma pode ser lida como mensagem pronta.
const DE_GENTE = [
  'No momento não, obrigado',
  'No momento não consigo, estou trabalhando',
  'Obrigado pelo contato',
  'Tem um horário de atendimento?',
  'Em instantes eu entro no link',
  'No momento não posso falar, te chamo mais tarde',
  'Oi João. Boa noite, obrigado pelo convite e atenção. No momento não conseguirei fazer a pós, fica para o próximo ano!',
  '[Em resposta à mensagem: "Oi karoline. Você tem interesse? Consegue confirmar?"] No momento não! Obrigada',
  '[Transcrição do áudio recebido do lead] Oi, seja bem-vindo, desculpa a demora',
  'Já conversei com outro atendente. Só queria entender pq vcs fazem um cadastro onde perguntam a profissão',
];

describe('a mensagem pronta do WhatsApp do lead', () => {
  it.each(AUTOMATICAS)('reconhece: %s', (t) => expect(ehRespostaAutomatica(t)).toBe(true));
  it.each(DE_GENTE)('não confunde com gente: %s', (t) => expect(ehRespostaAutomatica(t)).toBe(false));

  it('no histórico, só a fala do lead que é mensagem pronta ganha a etiqueta', () => {
    const h = [
      { role: 'assistant', content: 'Oii Adriana Tudo bem? você já atua na área clínica?' },
      { role: 'user', content: AUTOMATICAS[0] },
      { role: 'assistant', content: [{ type: 'text', text: 'fico no aguardo' }] },
      { role: 'user', content: [{ type: 'text', text: AUTOMATICAS[3] }] },
      { role: 'user', content: 'sim, atuo na clínica' },
    ] as any;
    const { history, marcadas } = marcarRespostasAutomaticas(h);
    expect(marcadas).toBe(2);
    expect(history[1].content).toBe(`${ETIQUETA_RESPOSTA_AUTOMATICA} ${AUTOMATICAS[0]}`);
    expect(history[3].content).toContain(ETIQUETA_RESPOSTA_AUTOMATICA);
    expect(history[4]).toBe(h[4]);
    expect(history[0]).toBe(h[0]);
  });

  it('a chave: desligada por padrão; liga para todos ou só para o telefone de ensaio', async () => {
    const banco = (data: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
    expect(await respostaAutomaticaLigada(banco({ followup_resposta_automatica: false, followup_resposta_automatica_telefones: [] }), '5546988166051')).toBe(false);
    expect(await respostaAutomaticaLigada(banco({ followup_resposta_automatica: true, followup_resposta_automatica_telefones: [] }), '5511999990000')).toBe(true);
    expect(await respostaAutomaticaLigada(banco({ followup_resposta_automatica: false, followup_resposta_automatica_telefones: ['5546988166051'] }), '554688166051')).toBe(true);
    expect(await respostaAutomaticaLigada(banco(null, { message: 'x' }), '5546988166051')).toBe(false);
  });
});

describe('o lote do agente só com mensagem pronta', () => {
  it('só robô: sim; robô junto de gente, arquivo ou clique: não', async () => {
    const { loteSoDeRespostaAutomatica } = await import('./respostaAutomatica');
    expect(loteSoDeRespostaAutomatica([{ mensagem: AUTOMATICAS[0] }, { mensagem: AUTOMATICAS[3] }])).toBe(true);
    expect(loteSoDeRespostaAutomatica([{ mensagem: AUTOMATICAS[0] }, { mensagem: 'sou eu mesma, tenho interesse' }])).toBe(false);
    expect(loteSoDeRespostaAutomatica([{ mensagem: AUTOMATICAS[2], arquivo: { tipo: 'image' } }])).toBe(false);
    expect(loteSoDeRespostaAutomatica([{ mensagem: AUTOMATICAS[2], clique: { botao: 'Quero' } }])).toBe(false);
    expect(loteSoDeRespostaAutomatica([])).toBe(false);
  });
});

describe('o robô do lead: "fico no aguardo" e a sequência do follow-up', () => {
  it('"fico no aguardo" sai uma vez até o lead escrever de verdade', async () => {
    const { jaAguardandoRobo } = await import('./respostaAutomatica');
    const robo = { role: 'user', content: AUTOMATICAS[3] } as any;
    expect(jaAguardandoRobo([{ role: 'assistant', content: 'template' }, robo] as any)).toBe(false);
    expect(jaAguardandoRobo([robo, { role: 'assistant', content: 'fico no aguardo' }, robo] as any)).toBe(true);
    expect(jaAguardandoRobo([robo, { role: 'assistant', content: 'fico no aguardo' }, { role: 'user', content: 'oi, sou eu' }, robo] as any)).toBe(false);
  });

  it('só robô no histórico: sim; qualquer fala de gente: não', async () => {
    const { soRoboRespondeu, ETIQUETA_RESPOSTA_AUTOMATICA } = await import('./respostaAutomatica');
    const t = { role: 'assistant', content: 'template' };
    expect(soRoboRespondeu([t, { role: 'user', content: `${ETIQUETA_RESPOSTA_AUTOMATICA} ${AUTOMATICAS[0]}` }] as any)).toBe(true);
    expect(soRoboRespondeu([t, { role: 'user', content: AUTOMATICAS[2] }, { role: 'user', content: '[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE]' }] as any)).toBe(true);
    expect(soRoboRespondeu([t, { role: 'user', content: AUTOMATICAS[2] }, { role: 'user', content: 'tenho interesse' }] as any)).toBe(false);
    expect(soRoboRespondeu([t] as any)).toBe(false);
  });

  it('a sequência é a do Gustavo (duas mensagens), e para no 2º toque', async () => {
    const { falaDoFollowupDoRobo } = await import('./respostaAutomatica');
    expect(falaDoFollowupDoRobo(1, 'Adriana')).toBe('Adriana, pode conversar agora?');
    expect(falaDoFollowupDoRobo(2, 'Adriana')).toBe('Adriana, temos uma condição promocional liberada hoje, eu preciso falar com você hoje.');
    expect(falaDoFollowupDoRobo(1, '')).toBe('Pode conversar agora?');
    expect(falaDoFollowupDoRobo(3, 'Adriana')).toBe('');
  });
});
