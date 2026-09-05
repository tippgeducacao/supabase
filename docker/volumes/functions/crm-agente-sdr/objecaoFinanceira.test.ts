import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtxConversa } from './tools';

// Regressão da regra financeira (05/09/2026): uma negação explícita da dificuldade
// não pode substituir o tipo de objeção fornecido pelo agente. Executa a tool real;
// banco, Voyage e LLM são fronteiras simuladas, sem tráfego externo nem escritas.
const fronteiras = vi.hoisted(() => ({ fetch: vi.fn(), modelo: vi.fn() }));
vi.mock('./agente.ts', () => ({ chamarAnthropic: fronteiras.modelo }));

const CONTEXTO: CtxConversa = {
  telefone: '5500000000000', remotejid: '5500000000000@s.whatsapp.net',
  waAccountId: null, leadId: null, oportunidadeId: null,
};
const EMBEDDING = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
let executarTool: typeof import('./tools').executarTool;

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => ({
    SUPABASE_URL: 'https://supabase.invalid',
    AGENTE_SDR_VOYAGE_KEY: 'chave-sintetica-sem-acesso',
  } as Record<string, string>)[chave] } });
  vi.stubGlobal('fetch', fronteiras.fetch);
  ({ executarTool } = await import('./tools'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  fronteiras.modelo.mockRejectedValue(new Error('Modelo não deve ser chamado pela recuperação de objeção'));
  fronteiras.fetch.mockImplementation(async (url: string) => {
    if (url !== 'https://api.voyageai.com/v1/embeddings') throw new Error(`HTTP não previsto: ${url}`);
    return new Response(JSON.stringify({ data: [{ embedding: EMBEDDING }] }), { status: 200 });
  });
});

async function conferirFiltro(mensagem: string, tipoEsperado: string) {
  const supabase = {
    rpc: vi.fn(async (nome: string, _params: Record<string, unknown>) => {
      if (nome !== 'match_ppg_voyage') throw new Error(`RPC não prevista: ${nome}`);
      return { data: [{ metadata: { resposta: 'Resposta sintética recuperada.' }, similarity: 0.9 }], error: null };
    }),
    from: vi.fn(() => { throw new Error('Este teste não autoriza acesso a tabelas'); }),
  };
  const resposta = await executarTool(supabase, {
    id: 'objecao-sintetica', name: 'consulta_objecoes',
    input: { mensagem_lead: mensagem, tipo_objecao: 'pergunta_modalidade' },
  }, CONTEXTO);

  expect(resposta.resposta_objecao).toBe('Resposta sintética recuperada.');
  expect(fronteiras.fetch).toHaveBeenCalledTimes(1);
  const [, opcoes] = fronteiras.fetch.mock.calls[0] as [string, RequestInit];
  expect(JSON.parse(String(opcoes.body))).toMatchObject({ input: [mensagem] });
  expect(supabase.rpc).toHaveBeenCalledTimes(1);
  expect(supabase.rpc.mock.calls[0][1]).toMatchObject({
    match_count: 1,
    filter: { tipo_objecao: tipoEsperado },
  });
  expect(supabase.from).not.toHaveBeenCalled();
  expect(fronteiras.modelo).not.toHaveBeenCalled();
}

describe('consulta_objecoes: negação explícita de dificuldade financeira', () => {
  it.each([
    'Não estou sem dinheiro; só quero saber se é online',
    'não estou desempregado',
    'não está fora do meu orçamento',
    'não é uma parcela alta',
    'não está muito caro pra mim',
    'sem dinheiro não estou',
    'não é que eu não consiga pagar',
    'nao to sem grana',
    'Não tá caro demais',
    'Não estou sem dinheiro e não estou desempregado',
    'Não é que eu não consigo pagar; só prefiro mensagem',
  ])('preserva pergunta_modalidade: %s', async (mensagem) => {
    await conferirFiltro(mensagem, 'pergunta_modalidade');
  });
});

describe('consulta_objecoes: dificuldade financeira afirmada', () => {
  it.each([
    'não consigo pagar',
    'não tenho condições',
    'estou sem dinheiro',
    'parcela alta',
    'não tenho como pagar',
    'não sei se é online, estou sem dinheiro',
    'não estou desempregado, mas não consigo pagar',
    'Não estou só sem dinheiro, estou sem tempo',
    'Estou sem dinheiro, não é de hoje',
    'Não estou sem dinheiro, mas a parcela não cabe no meu bolso',
    'É uma parcela alta, não é?',
    'Estou sem dinheiro, não estou?',
  ])('prioriza pergunta_condicao: %s', async (mensagem) => {
    await conferirFiltro(mensagem, 'pergunta_condicao');
  });
});
