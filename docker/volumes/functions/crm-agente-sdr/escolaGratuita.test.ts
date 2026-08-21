import { describe, expect, it } from 'vitest';
import {
  comPresenteNaDespedida,
  jaTemOPresente,
  LINK_ESCOLA_GRATUITA,
  mereceOPresente,
} from './escolaGratuita';

const pausa = (motivo: string, tipo?: string) => ({
  tool: 'pausa_ia',
  input: tipo ? { tipo, motivo } : { motivo },
});

describe('quem leva o presente da Escola', () => {
  it('leva quem desistiu de verdade', () => {
    expect(mereceOPresente(pausa('Lead demonstrou desinteresse'))).toBe(true);
  });

  it('leva quem não tem graduação — a régua cita, e estava dando 0%', () => {
    expect(mereceOPresente(pausa('Lead não possui graduação completa', 'sem_graduacao'))).toBe(true);
  });

  it('leva o retorno agendado e o temporizador de turma', () => {
    expect(mereceOPresente({ tool: 'agendar_retorno', input: { tipo: 'formatura' } })).toBe(true);
    expect(mereceOPresente({ tool: 'temporizador_proxima_turma', input: {} })).toBe(true);
  });

  // O outro lado do defeito: 46 casos em 30 dias de "beleza já vou te ligar" seguido de
  // "antes de te deixar ir". Prometeu ligar e se despediu no mesmo fôlego.
  it('NÃO leva quem vai ser atendido por alguém do time', () => {
    for (const m of [
      'Lead pediu ligação telefônica',
      'Lead pediu atendimento humano',
      'Lead já é aluno matriculado',
      'Lead pediu cancelamento ou remarcação',
    ]) {
      expect(mereceOPresente(pausa(m))).toBe(false);
    }
  });

  it('quem informou que pagou a matrícula também fica de fora', () => {
    expect(mereceOPresente(pausa('Lead informou que pagou a matrícula'))).toBe(false);
  });

  // Assimetria deliberada: errar pra menos custa ~3.260 leads/mês, errar pra mais custa 46
  // mensagens contraditórias. Motivo que ninguém classificou leva o presente.
  it('motivo que o classificador não reconhece LEVA (default-sim)', () => {
    expect(mereceOPresente(pausa('algo que ninguém previu'))).toBe(true);
  });

  it('sem encerramento nenhum, não leva', () => {
    expect(mereceOPresente(null)).toBe(false);
    expect(mereceOPresente({ tool: 'consulta_disponibilidade', input: {} })).toBe(false);
  });

  // Decisão do diretor 21/08: "quem está na escola não precisa receber o link de novo,
  // ela está no acesso". 2.351 dos 2.550 da Escola também falam com o João.
  it('NUNCA leva quem já tem acesso à Escola, por mais legítima que seja a despedida', () => {
    expect(mereceOPresente(pausa('Lead demonstrou desinteresse'), true)).toBe(false);
    expect(mereceOPresente({ tool: 'agendar_retorno', input: {} }, true)).toBe(false);
  });
});

describe('anexar o presente à despedida', () => {
  it('anexa quando falta, preservando o texto do modelo', () => {
    const r = comPresenteNaDespedida('tranquilo, agradeço a preferência.', pausa('desinteresse'), '');
    expect(r.anexou).toBe(true);
    expect(r.texto).toContain('tranquilo, agradeço a preferência.');
    expect(r.texto).toContain(LINK_ESCOLA_GRATUITA);
  });

  it('não repete quando o modelo já escreveu o convite nesta resposta', () => {
    const texto = `me despeço. aproveita: ${LINK_ESCOLA_GRATUITA}`;
    const r = comPresenteNaDespedida(texto, pausa('desinteresse'), '');
    expect(r.anexou).toBe(false);
    expect(r.texto).toBe(texto);
  });

  // "é UMA vez só" vale pra conversa inteira, não só pra mensagem.
  it('não repete quando o convite já saiu antes na conversa', () => {
    const r = comPresenteNaDespedida(
      'tranquilo, fico à disposição.',
      pausa('desinteresse'),
      `lead: oi\njoão: ${LINK_ESCOLA_GRATUITA}\nlead: valeu`,
    );
    expect(r.anexou).toBe(false);
  });

  it('não anexa a quem já está na Escola', () => {
    const r = comPresenteNaDespedida('tranquilo.', pausa('desinteresse'), '', true);
    expect(r.anexou).toBe(false);
    expect(r.texto).toBe('tranquilo.');
  });

  it('jaTemOPresente aguenta nulo e vazio', () => {
    expect(jaTemOPresente(null)).toBe(false);
    expect(jaTemOPresente('')).toBe(false);
    expect(jaTemOPresente(`vai aqui ${LINK_ESCOLA_GRATUITA} ó`)).toBe(true);
  });
});
