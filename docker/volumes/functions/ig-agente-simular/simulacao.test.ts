import { beforeEach, describe, expect, it, vi } from 'vitest';

// O harness roda o pensarRodada REAL (rodada.ts → fluxo.ts); só o classificador é
// simulado aqui — nenhuma requisição sai para a OpenAI ou a Anthropic.
const m = vi.hoisted(() => ({ classificar: vi.fn() }));
vi.mock('../ig-agente/classificador.ts', () => ({ classificar: m.classificar }));

import { TEXTOS } from '../ig-agente/fluxo';
import { ESTADO_INICIAL } from '../ig-agente/rodada';
import { ABERTURA_MANYCHAT, avaliar, executarCenario, MAX_TURNOS, validarCenario, type Cenario } from './simulacao';

const neutra = { intencao: 'outro', situacao: 'nao_informou', area: null, telefone: null, conclusao: null, resposta_pergunta: null };
const cls = (c: Record<string, unknown>) => ({ classificacao: { ...neutra, ...c }, erro: null, modelo: 'gpt-5.6-luna' });

function cenario(turnos: string[][], extra: Partial<Cenario> = {}): Cenario {
  return { id: 't', nomePerfil: 'Carla Souza', abertura: ABERTURA_MANYCHAT, estadoInicial: ESTADO_INICIAL, turnos, esperado: null, ...extra };
}

beforeEach(() => m.classificar.mockReset());

describe('validarCenario', () => {
  it('aceita turno como texto ou lista e põe a abertura do ManyChat por padrão', () => {
    const v = validarCenario({ id: 'x', turnos: ['oi', ['sou vet', 'formada']] });
    expect('cenario' in v && v.cenario.turnos).toEqual([['oi'], ['sou vet', 'formada']]);
    expect('cenario' in v && v.cenario.abertura).toBe(ABERTURA_MANYCHAT);
  });

  it('abertura null = conversa sem a boas-vindas', () => {
    const v = validarCenario({ turnos: ['oi'], abertura: null });
    expect('cenario' in v && v.cenario.abertura).toBeNull();
  });

  it('recusa o que custaria caro ou não faz sentido', () => {
    expect(validarCenario({})).toHaveProperty('erro');
    expect(validarCenario({ turnos: Array(MAX_TURNOS + 1).fill('oi') })).toHaveProperty('erro');
    expect(validarCenario({ turnos: [['oi', '']] })).toHaveProperty('erro');
    expect(validarCenario({ turnos: ['x'.repeat(1001)] })).toHaveProperty('erro');
    expect(validarCenario({ turnos: ['oi'], estado_inicial: { etapa: 'inventada' } })).toHaveProperty('erro');
    expect(validarCenario({ turnos: ['oi'], esperado: { etapas: 'pergunta_formacao' } })).toHaveProperty('erro');
  });

  it('estado inicial: começa numa etapa do meio, com o que já se sabe', () => {
    const v = validarCenario({ turnos: ['sim'], estado_inicial: { etapa: 'pergunta_interesse', situacao: 'estudante', data_formacao: '2027-07-31' } });
    expect('cenario' in v && v.cenario.estadoInicial).toMatchObject({ etapa: 'pergunta_interesse', situacao: 'estudante', dataFormacao: '2027-07-31' });
  });
});

describe('executarCenario: o histórico que o classificador lê é o da produção', () => {
  it('1º turno: a boas-vindas é histórico e as DMs seguidas são as novas', async () => {
    m.classificar.mockResolvedValue(cls({}));
    await executarCenario(cenario([['oii', 'tudo sim e vc?']]));
    expect(m.classificar).toHaveBeenCalledWith('boas_vindas', [{ role: 'assistant', text: ABERTURA_MANYCHAT }], ['oii', 'tudo sim e vc?']);
  });

  it('2º turno: o que a pessoa disse e o que a IA respondeu viram histórico', async () => {
    m.classificar.mockResolvedValueOnce(cls({})).mockResolvedValueOnce(cls({ situacao: 'formado' }));
    await executarCenario(cenario([['tudo sim'], ['sou vet']]));
    expect(m.classificar).toHaveBeenLastCalledWith('pergunta_formacao', [
      { role: 'assistant', text: ABERTURA_MANYCHAT },
      { role: 'user', text: 'tudo sim' },
      { role: 'assistant', text: TEXTOS.perguntaFormacao('Carla') },
    ], ['sou vet']);
  });
});

describe('executarCenario: roteiro real, do "tudo bem" ao WhatsApp', () => {
  it('formado: 4 turnos até capturar o número, e o plano do CRM sai em Formados', async () => {
    m.classificar
      .mockResolvedValueOnce(cls({}))
      .mockResolvedValueOnce(cls({ situacao: 'formado', area: 'medicina veterinária' }))
      .mockResolvedValueOnce(cls({ intencao: 'aceita' }))
      .mockResolvedValueOnce(cls({}));
    const s = await executarCenario(cenario([['tudo sim'], ['sou vet'], ['quero'], ['46 99988-1234']], {
      esperado: {
        etapas: ['pergunta_formacao', 'pergunta_interesse', 'pergunta_whatsapp', 'whatsapp_enviado'],
        situacao: 'formado', telefone: '5546999881234', etapa_crm: 'Formados', ia_contem: ['portfólio'],
      },
    }));
    expect(s.turnos.map((t) => t.ia)).toEqual([
      [TEXTOS.perguntaFormacao('Carla')], [TEXTOS.perguntaInteresse], [TEXTOS.pedirWhatsapp], [TEXTOS.confirmacaoWhatsapp],
    ]);
    expect(s.final).toMatchObject({ etapa: 'whatsapp_enviado', situacao: 'formado', area: 'medicina veterinária', telefone: '5546999881234' });
    expect(s.whatsapp).toMatchObject({ simulado: true, situacao: 'formado', etapa_crm: 'Formados' });
    expect(s.veredito).toEqual({ passou: true, falhas: [] });
  });

  it('classificador fora do ar (neutra): o roteiro repergunta e o erro aparece no turno', async () => {
    m.classificar.mockResolvedValue({ classificacao: neutra, erro: 'Luna: HTTP 500; Claude: HTTP 529', modelo: null });
    const s = await executarCenario(cenario([['tudo sim'], ['hmm']]));
    expect(s.turnos[1]).toMatchObject({ etapa_depois: 'pergunta_formacao', modelo: null, erro_classificador: 'Luna: HTTP 500; Claude: HTTP 529' });
    expect(s.turnos[1].ia).toEqual([TEXTOS.reperguntarFormacao]);
  });
});

describe('avaliar', () => {
  const base = {
    turnos: [{ etapa_depois: 'pergunta_formacao', ia: ['Carla, você já se formou?'] }, { etapa_depois: 'encerrada', ia: [] }] as any,
    final: { ...ESTADO_INICIAL, etapa: 'encerrada' as const },
    whatsapp: null,
  };

  it('"*" aceita qualquer etapa naquele turno', () => {
    expect(avaliar({ etapas: ['*', 'encerrada'] }, base).passou).toBe(true);
  });

  it('cada divergência vira uma linha legível', () => {
    const v = avaliar({ etapas: ['pergunta_formacao', 'pergunta_interesse'], etapa_crm: 'Formados', ia_contem: ['portfólio'], ia_nao_contem: ['carla'] }, base);
    expect(v.passou).toBe(false);
    expect(v.falhas).toEqual([
      'etapas: esperado pergunta_formacao → pergunta_interesse | veio pergunta_formacao → encerrada',
      'etapa do CRM: esperado "Formados" | veio ∅',
      'a IA não disse "portfólio"',
      'a IA disse "carla", que não podia',
    ]);
  });

  it('etapa_crm null = o cenário não pode capturar WhatsApp', () => {
    expect(avaliar({ etapa_crm: null }, base).passou).toBe(true);
  });

  it('silêncio: o turno tem de sair sem fala da IA', () => {
    expect(avaliar({ silencio_nos_turnos: [2] }, base).passou).toBe(true);
    expect(avaliar({ silencio_nos_turnos: [1, 3] }, base).falhas).toEqual([
      'turno 1: a IA devia ficar calada e disse "Carla, você já se formou?"',
      'silêncio no turno 3: o cenário não tem esse turno',
    ]);
    expect(validarCenario({ turnos: ['oi'], esperado: { silencio_nos_turnos: [0] } })).toHaveProperty('erro');
  });
});
