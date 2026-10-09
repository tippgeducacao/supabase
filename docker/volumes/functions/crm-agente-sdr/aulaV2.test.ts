import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AULA_V2_ABERTURA, AULA_V2_REGRAS, varsAulaV2 } from './prompts-aula-v2';

let aulaV2Ligada: typeof import('./aulaV2').aulaV2Ligada;
let toolsDaAulaV2: typeof import('./aulaV2').toolsDaAulaV2;
let renderPrompt: typeof import('./contexto').renderPrompt;
let montarPedidoPrincipal: typeof import('./agente').montarPedidoPrincipal;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  ({ aulaV2Ligada, toolsDaAulaV2 } = await import('./aulaV2'));
  ({ renderPrompt } = await import('./contexto'));
  ({ montarPedidoPrincipal } = await import('./agente'));
});

// Banco falso: devolve `linhas[tabela]` para qualquer select encadeado.
function banco(linhas: Record<string, any>) {
  const consulta = (tabela: string) => {
    const r: any = {
      select: () => r, eq: () => r, order: () => r, limit: () => r, in: () => r,
      maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
      then: (ok: any) => ok({ data: linhas[tabela] ?? [], error: null }),
    };
    return r;
  };
  return { from: consulta };
}

describe('prompt da aula v2 (fonte única do n8n e da produção)', () => {
  it('não sobra expressão do n8n: só variáveis simples, todas preenchidas', () => {
    const vars = { nome: 'carla', ...varsAulaV2('MBA | GESTÃO DE COOPERATIVAS DE CRÉDITO') };
    const texto = renderPrompt(AULA_V2_ABERTURA, vars) + renderPrompt(AULA_V2_REGRAS, vars);
    expect(texto).not.toMatch(/\{\{/);
    expect(texto).not.toContain('$json.aula?');
    expect(texto).toContain('topa conhecer o nosso mba em gestão de cooperativas de crédito');
  });
  it('pós x MBA', () => {
    expect(varsAulaV2('PÓS | SANIDADE AVÍCOLA')).toEqual({ aula_pos_nome: 'sanidade avícola', nosso_curso: 'a nossa pós', o_curso: 'a pós' });
    expect(varsAulaV2('MBA | POSTURA COMERCIAL').o_curso).toBe('o mba');
  });
});

describe('chave da aula v2 na produção', () => {
  it('lista casa com e sem o 9º dígito; fora da lista e sem percentual, desligada', async () => {
    const b = banco({ crm_agente_sdr_config: { aula_v2_telefones: ['5546988166051'], aula_v2_percentual: 0 } });
    expect(await aulaV2Ligada(b, '554688166051')).toEqual({ ligada: true, origem: 'lista' });
    expect(await aulaV2Ligada(b, '5511999998888')).toEqual({ ligada: false });
  });
  it('percentual 100 liga todo mundo; erro de leitura desliga', async () => {
    expect((await aulaV2Ligada(banco({ crm_agente_sdr_config: { aula_v2_telefones: [], aula_v2_percentual: 100 } }), '5511999998888')).ligada).toBe(true);
    expect(await aulaV2Ligada({ from: () => { throw new Error('fora'); } }, '5511999998888')).toEqual({ ligada: false });
  });
});

describe('ferramentas da aula v2', () => {
  it('enxutas + busca_carreira antes do canal, sem duplicar o canal', async () => {
    const base = [{ name: 'pausa_ia', description: 'longa', input_schema: { type: 'object', properties: {} } },
      { name: 'responder_ao_cliente', description: 'original', input_schema: { type: 'object', properties: {} } }];
    const tools = await toolsDaAulaV2(banco({}), base, '');
    expect(tools.map((t: any) => t.name)).toEqual(['pausa_ia', 'busca_carreira', 'responder_ao_cliente']);
    expect(tools[0].description).not.toBe('longa');
  });
  it('o pedido com regras substitutas usa o canal enxuto que veio nas tools', () => {
    const canal = { name: 'responder_ao_cliente', description: 'canal enxuto', input_schema: { type: 'object', properties: {} } };
    const { pedido } = montarPedidoPrincipal({ promptAgente: 'p', regrasSubstitutas: 'r', tools: [canal], messages: [{ role: 'user', content: 'oi' }], contextoTemporal: '' } as any);
    const t = (pedido.tools as any[]).find((x) => x.name === 'responder_ao_cliente');
    expect(t.description).toBe('canal enxuto');
    expect((pedido.system as any[]).map((b) => b.text)).toEqual(['p', 'r']);
  });
});
