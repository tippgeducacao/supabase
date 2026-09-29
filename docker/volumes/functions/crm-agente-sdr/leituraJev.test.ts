import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Msg } from './historico';
import {
  AVISO_DATA_INFORMADA, AVISO_DOIS_ASSUNTOS, AVISO_SEM_GRADUACAO, blocoDaLeitura, CABECALHO_LEITURA,
  carregarConfigLeituraJev, efeitosDaLeitura, estadoDaLeitura, lerLeadComJev, type LeituraLead,
} from './leituraJev';

beforeAll(() => vi.stubGlobal('Deno', { env: { get: () => '' } }));
afterAll(() => vi.unstubAllGlobals());

const leitura = (parcial: Partial<LeituraLead>): LeituraLead => ({
  conclusao: null, graduacao: null, informou_data: null, pediu_material: null, dois_assuntos: null, dor_financeira: null,
  modelo: 'jev-1.13.0', tokens_entrada: 900, ms: 300, ...parcial,
});

describe('estadoDaLeitura', () => {
  it('separa a conversa anterior das mensagens novas e mascara dado pessoal', () => {
    const historico: Msg[] = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'e vc se forma quando?' },
      { role: 'user', content: 'me formo 2027.2\nmeu zap é 46 98816-6051' },
    ];
    expect(estadoDaLeitura(historico, ['me formo 2027.2', 'meu zap é 46 98816-6051'])).toEqual({
      conversa_anterior: [{ de: 'lead', texto: 'oi' }, { de: 'sdr', texto: 'e vc se forma quando?' }],
      mensagens_novas_do_lead: ['me formo 2027.2', 'meu zap é [NUMERO]'],
    });
  });
});

describe('efeitosDaLeitura', () => {
  it('preenche conclusão e graduação vazias com certeza alta', () => {
    const e = efeitosDaLeitura(leitura({
      conclusao: { valor: 'concluiu', confianca: 0.98 }, graduacao: { valor: 'medicina_veterinaria', confianca: 0.97 },
    }), 0.9, {});
    expect(e.coleta).toEqual({ graduacao_concluida: 'sim', graduacao: 'Medicina Veterinária' });
    expect(e.aplicado).toEqual(['conclusao:sim', 'graduacao:medicina_veterinaria']);
  });

  it('só SOMA: não mexe no que a Luna ou a palavra-chave já registraram', () => {
    const e = efeitosDaLeitura(leitura({
      conclusao: { valor: 'cursando', confianca: 0.99 }, graduacao: { valor: 'zootecnia', confianca: 0.99 },
    }), 0.9, { coleta: { graduacao_concluida: 'sim', graduacao: 'Agronomia' } });
    expect(e.coleta).toEqual({});
    expect(e.aplicado).toEqual([]);
  });

  it('abaixo do limiar não faz nada', () => {
    const e = efeitosDaLeitura(leitura({
      conclusao: { valor: 'concluiu', confianca: 0.85 }, graduacao: { valor: 'agronomia', confianca: 0.6 },
      informou_data: 0.8, pediu_material: 0.7, dois_assuntos: 0.5, dor_financeira: 0.89,
    }), 0.9, {});
    expect(e).toEqual({ coleta: {}, pedidoMaterial: false, dorFinanceira: false, avisos: [], aplicado: [] });
  });

  it('"não tem graduação" nunca é gravado: vira aviso para a Luna confirmar', () => {
    const e = efeitosDaLeitura(leitura({ conclusao: { valor: 'nao_tem_graduacao', confianca: 0.99 } }), 0.9, {});
    expect(e.coleta).toEqual({});
    expect(e.avisos).toEqual([AVISO_SEM_GRADUACAO]);
  });

  it('outra graduação e "não disse" não gravam curso', () => {
    for (const valor of ['outra_graduacao', 'nao_disse']) {
      expect(efeitosDaLeitura(leitura({ graduacao: { valor, confianca: 0.99 } }), 0.9, {}).coleta).toEqual({});
    }
  });

  it('data informada e dois assuntos viram aviso; a data em si não é lida pelo Jev', () => {
    const e = efeitosDaLeitura(leitura({ informou_data: 0.97, dois_assuntos: 0.93 }), 0.9, {});
    expect(e.avisos).toEqual([AVISO_DATA_INFORMADA, AVISO_DOIS_ASSUNTOS]);
    expect(e.coleta).toEqual({});
  });

  it('pedido de material só quando a palavra-chave não pegou', () => {
    const l = leitura({ pediu_material: 0.98 });
    expect(efeitosDaLeitura(l, 0.9, {}).pedidoMaterial).toBe(true);
    expect(efeitosDaLeitura(l, 0.9, {}, { pedidoMaterial: true }).pedidoMaterial).toBe(false);
  });

  it('dor financeira segura liga o filtro da objeção', () => {
    expect(efeitosDaLeitura(leitura({ dor_financeira: 0.95 }), 0.9, {}).dorFinanceira).toBe(true);
  });

  it('leitura com erro não produz efeito', () => {
    expect(efeitosDaLeitura(leitura({ erro: 'Jev: HTTP 529' }), 0.9, {}).aplicado).toEqual([]);
  });
});

describe('blocoDaLeitura', () => {
  it('sem aviso não gera bloco; com aviso, cabeçalho de sistema + itens', () => {
    expect(blocoDaLeitura([])).toBeNull();
    expect(blocoDaLeitura([AVISO_DOIS_ASSUNTOS])).toBe(`${CABECALHO_LEITURA}\n- ${AVISO_DOIS_ASSUNTOS}`);
  });
});

describe('lerLeadComJev', () => {
  const historico: Msg[] = [{ role: 'assistant', content: 'qual a sua formação?' }, { role: 'user', content: 'sou zootecnista' }];

  it('sem chave não chama nada', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect(await lerLeadComJev(historico, ['sou zootecnista'], { fetchFn })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('manda as 6 perguntas numa chamada e lê as respostas', async () => {
    let corpo: any;
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      corpo = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          conclusao: { type: 'choice', choice: 'concluiu', confidence: 0.99, probabilities: {} },
          graduacao: { type: 'choice', choice: 'zootecnia', confidence: 0.98, probabilities: {} },
          informou_data: { type: 'noul', noul: 0.02 }, pediu_material: { type: 'noul', noul: 0.01 },
          dois_assuntos: { type: 'noul', noul: 0.03 }, dor_financeira: { type: 'noul', noul: 0.01 },
        },
        usage: { input_tokens: 1100, output_tokens: 80 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const l = await lerLeadComJev(historico, ['sou zootecnista'], { chave: 'k', fetchFn });
    expect(Object.keys(corpo.questions)).toEqual(['conclusao', 'graduacao', 'informou_data', 'pediu_material', 'dois_assuntos', 'dor_financeira']);
    expect(corpo.state.mensagens_novas_do_lead).toEqual(['sou zootecnista']);
    expect(l).toMatchObject({
      conclusao: { valor: 'concluiu', confianca: 0.99 }, graduacao: { valor: 'zootecnia', confianca: 0.98 },
      informou_data: 0.02, dor_financeira: 0.01, modelo: 'jev-1.13.0', tokens_entrada: 1100,
    });
  });

  it('erro do Jev vira leitura vazia com o status, nunca exceção', async () => {
    const fetchFn = vi.fn(async () => new Response('{"eco":"conversa"}', { status: 500 })) as unknown as typeof fetch;
    const l = await lerLeadComJev(historico, ['sou zootecnista'], { chave: 'k', fetchFn });
    expect(l).toMatchObject({ conclusao: null, graduacao: null, erro: 'Jev: HTTP 500' });
  });
});

describe('carregarConfigLeituraJev', () => {
  const banco = (data: unknown, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }),
  });
  it('lê modo e limiar; qualquer coisa estranha vira off', async () => {
    expect(await carregarConfigLeituraJev(banco({ ficha_jev_modo: 'sombra', ficha_jev_limiar: '0.950' }))).toEqual({ modo: 'sombra', limiar: 0.95 });
    expect(await carregarConfigLeituraJev(banco({ ficha_jev_modo: 'ativo', ficha_jev_limiar: 0.2 }))).toEqual({ modo: 'ativo', limiar: 0.9 });
    expect(await carregarConfigLeituraJev(banco({ ficha_jev_modo: 'off' }))).toBeNull();
    expect(await carregarConfigLeituraJev(banco(null, { message: 'column does not exist' }))).toBeNull();
  });
});
