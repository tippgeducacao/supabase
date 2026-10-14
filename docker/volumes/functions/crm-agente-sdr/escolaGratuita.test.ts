import { describe, expect, it } from 'vitest';
import {
  comBlocoDaEscola,
  comLinkPedido,
  comPresenteNaDespedida,
  jaTemOPresente,
  LINK_ESCOLA_GRATUITA,
  mereceOPresente,
  pediuLinkDaEscola,
  PRESENTE_ESCOLA_ATIVO,
} from './escolaGratuita';

const pausa = (motivo: string, tipo?: string) => ({
  tool: 'pausa_ia',
  input: tipo ? { tipo, motivo } : { motivo },
});

// 14/10/2026: o convite está DESLIGADO (PRESENTE_ESCOLA_ATIVO). A régua abaixo é testada ligada.
const merece = (e: Parameters<typeof mereceOPresente>[0], jaEsta = false) => mereceOPresente(e, jaEsta, true);
const comPresente = (t: string, e: Parameters<typeof mereceOPresente>[0], conversa: string, jaEsta = false) =>
  comPresenteNaDespedida(t, e, conversa, jaEsta, true);

describe('convite da Escola desligado (14/10/2026)', () => {
  it('nenhuma despedida leva o convite e o prompt não recebe o bloco', () => {
    expect(PRESENTE_ESCOLA_ATIVO).toBe(false);
    expect(mereceOPresente(pausa('Lead demonstrou desinteresse'))).toBe(false);
    expect(mereceOPresente({ tool: 'agendar_retorno', input: { tipo: 'formatura' } })).toBe(false);
    expect(comPresenteNaDespedida('tranquilo, agradeço a preferência.', pausa('desinteresse'), '')).toEqual({ texto: 'tranquilo, agradeço a preferência.', anexou: false });
    expect(comBlocoDaEscola('PROMPT', false)).toBe('PROMPT');
    expect(comBlocoDaEscola('PROMPT', true)).toContain('ESTA PESSOA JÁ TEM ACESSO');
  });
});

describe('quem leva o presente da Escola', () => {
  it('leva quem desistiu de verdade', () => {
    expect(merece(pausa('Lead demonstrou desinteresse'))).toBe(true);
  });

  it('leva quem não tem graduação — a régua cita, e estava dando 0%', () => {
    expect(merece(pausa('Lead não possui graduação completa', 'sem_graduacao'))).toBe(true);
  });

  it('leva o retorno agendado e o temporizador de turma', () => {
    expect(merece({ tool: 'agendar_retorno', input: { tipo: 'formatura' } })).toBe(true);
    expect(merece({ tool: 'temporizador_proxima_turma', input: {} })).toBe(true);
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
      expect(merece(pausa(m))).toBe(false);
    }
  });

  it('quem informou que pagou a matrícula também fica de fora', () => {
    expect(merece(pausa('Lead informou que pagou a matrícula'))).toBe(false);
  });

  // Assimetria deliberada: errar pra menos custa ~3.260 leads/mês, errar pra mais custa 46
  // mensagens contraditórias. Motivo que ninguém classificou leva o presente.
  it('motivo que o classificador não reconhece LEVA (default-sim)', () => {
    expect(merece(pausa('algo que ninguém previu'))).toBe(true);
  });

  it('sem encerramento nenhum, não leva', () => {
    expect(merece(null)).toBe(false);
    expect(merece({ tool: 'consulta_disponibilidade', input: {} })).toBe(false);
  });

  // Decisão do diretor 21/08: "quem está na escola não precisa receber o link de novo,
  // ela está no acesso". 2.351 dos 2.550 da Escola também falam com o João.
  it('NUNCA leva quem já tem acesso à Escola, por mais legítima que seja a despedida', () => {
    expect(merece(pausa('Lead demonstrou desinteresse'), true)).toBe(false);
    expect(merece({ tool: 'agendar_retorno', input: {} }, true)).toBe(false);
  });
});

describe('anexar o presente à despedida', () => {
  it('anexa quando falta, preservando o texto do modelo', () => {
    const r = comPresente('tranquilo, agradeço a preferência.', pausa('desinteresse'), '');
    expect(r.anexou).toBe(true);
    expect(r.texto).toContain('tranquilo, agradeço a preferência.');
    expect(r.texto).toContain(LINK_ESCOLA_GRATUITA);
  });

  it('não repete quando o modelo já escreveu o convite nesta resposta', () => {
    const texto = `me despeço. aproveita: ${LINK_ESCOLA_GRATUITA}`;
    const r = comPresente(texto, pausa('desinteresse'), '');
    expect(r.anexou).toBe(false);
    expect(r.texto).toBe(texto);
  });

  // "é UMA vez só" vale pra conversa inteira, não só pra mensagem.
  it('não repete quando o convite já saiu antes na conversa', () => {
    const r = comPresente(
      'tranquilo, fico à disposição.',
      pausa('desinteresse'),
      `lead: oi\njoão: ${LINK_ESCOLA_GRATUITA}\nlead: valeu`,
    );
    expect(r.anexou).toBe(false);
  });

  it('não anexa a quem já está na Escola', () => {
    const r = comPresente('tranquilo.', pausa('desinteresse'), '', true);
    expect(r.anexou).toBe(false);
    expect(r.texto).toBe('tranquilo.');
  });

  it('jaTemOPresente aguenta nulo e vazio', () => {
    expect(jaTemOPresente(null)).toBe(false);
    expect(jaTemOPresente('')).toBe(false);
    expect(jaTemOPresente(`vai aqui ${LINK_ESCOLA_GRATUITA} ó`)).toBe(true);
  });
});

// Caso Leandro (10/09/2026): já estava na Escola, pediu "Me manda o link" duas vezes e o
// João respondeu que o acesso "continuava ativo" — sem o endereço. Quem pede recebe.
describe('quem pede o link da Escola recebe o link', () => {
  it('reconhece o pedido de quem já está na Escola, mesmo sem citar a Escola', () => {
    for (const m of [
      'Me manda o link',
      'me manda o link de novo',
      'pode mandar o acesso?',
      'perdi o acesso',
      'não acho onde entrar na escola',
      'qual o site mesmo?',
      'cadê o link',
      'tem o link aí?',
      'me dá o link',
    ]) {
      expect(pediuLinkDaEscola(m, true), m).toBe(true);
    }
  });

  it('sem contexto da Escola, só reconhece quando a mensagem cita a Escola', () => {
    expect(pediuLinkDaEscola('me manda o link', false)).toBe(false);
    expect(pediuLinkDaEscola('me manda o link da escola de especialização', false)).toBe(true);
    expect(pediuLinkDaEscola('manda o link dos cursos gratuitos', false)).toBe(true);
  });

  // "link" de reunião é do fluxo de agendamento, não da Escola.
  it('NÃO confunde com o link da reunião', () => {
    expect(pediuLinkDaEscola('me manda o link da reunião', true)).toBe(false);
    expect(pediuLinkDaEscola('manda o link do meet', true)).toBe(false);
    expect(pediuLinkDaEscola('qual o link da call?', true)).toBe(false);
  });

  it('conversa normal fica quieta', () => {
    expect(pediuLinkDaEscola('Sim', true)).toBe(false);
    expect(pediuLinkDaEscola('Consigo assistir ainda?', true)).toBe(false);
    expect(pediuLinkDaEscola('quero saber o valor da pós', true)).toBe(false);
    expect(pediuLinkDaEscola('', true)).toBe(false);
    expect(pediuLinkDaEscola(null, true)).toBe(false);
  });

  it('acrescenta o endereço à resposta do modelo, sem trocar o texto', () => {
    const r = comLinkPedido('esse acesso é o mesmo de antes, é só entrar com seu cadastro.', 'Me manda o link', true);
    expect(r.anexou).toBe(true);
    expect(r.texto).toBe(`esse acesso é o mesmo de antes, é só entrar com seu cadastro.\n${LINK_ESCOLA_GRATUITA}`);
  });

  it('não duplica quando o modelo já mandou o link', () => {
    const texto = `aqui: ${LINK_ESCOLA_GRATUITA}`;
    const r = comLinkPedido(texto, 'Me manda o link', true);
    expect(r.anexou).toBe(false);
    expect(r.texto).toBe(texto);
  });

  // Harness 11/09: com horários recém-oferecidos, o modelo leu "me manda o link" como link
  // do Meet. A resposta dele desempata: fala de horário e não de acesso ⇒ não é a Escola.
  it('NÃO anexa quando a resposta do modelo trata o pedido como link da reunião', () => {
    const r = comLinkPedido('esse link só sai depois que a gente fechar um horário certinho, leandro', 'Me manda o link', true);
    expect(r.anexou).toBe(false);
  });

  // Caso Leandro real: a resposta fala do ACESSO (e também de horário) ⇒ é a Escola, anexa.
  it('anexa quando a resposta fala do acesso, mesmo citando horário junto', () => {
    const r = comLinkPedido(
      'esse acesso já é o mesmo que te mandei antes, o link continua ativo. amanhã consigo às 9h ou 10h, algum fica bom?',
      'Me manda o link', true,
    );
    expect(r.anexou).toBe(true);
    expect(r.texto).toContain(LINK_ESCOLA_GRATUITA);
  });

  it('não mexe quando ninguém pediu', () => {
    const r = comLinkPedido('beleza.', 'Sim', true);
    expect(r.anexou).toBe(false);
    expect(r.texto).toBe('beleza.');
  });
});
