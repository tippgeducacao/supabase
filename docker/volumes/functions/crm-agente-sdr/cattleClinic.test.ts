import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CATTLE_CLINIC, consultarCattleClinic, INSTRUCAO_CATTLE_CLINIC } from './cattleClinic';
import { consultarCatalogo } from './catalogoCursos';

beforeAll(() => vi.stubGlobal('Deno', { env: { get: () => '' } }));
afterAll(() => vi.unstubAllGlobals());

describe('Cattle Clinic — caso de curso livre confundido com pós', () => {
  it('reconhece nome e checkout oficial sem consultar o catálogo exclusivo de pós', async () => {
    const banco = { from: vi.fn(), rpc: vi.fn() };
    for (const alvo of ['CATTLE CLINIC', CATTLE_CLINIC.checkout]) {
      const resultado = await consultarCatalogo(banco as any, alvo);
      expect(resultado).toMatchObject({ status: 'curso_livre_confirmado', curso: { exige_graduacao: false, tipo: 'curso_livre' } });
    }
    expect(banco.from).not.toHaveBeenCalled();
  });
  it('não libera a pós de bovinos ou outro produto Hotmart por semelhança', () => {
    for (const alvo of ['Pós em Clínica Médica e Cirúrgica de Bovinos', 'https://pay.hotmart.com/OUTRO', 'https://pay.hotmart.com/Y86165228Mfraude']) {
      expect(consultarCattleClinic(alvo)).toBeNull();
    }
  });
  it('não consulta a matriz de pós para uma pessoa sem graduação interessada no curso', async () => {
    const { executarTool } = await import('./tools');
    const banco = { from: vi.fn(), rpc: vi.fn() };
    const resultado = await executarTool(banco,
      { id: 'teste', name: 'verificar_compatibilidade_curso', input: { curso_interesse: 'Cattle Clinic', formacao_academica: 'Sem formação superior' } },
      { remotejid: 'teste', telefone: 'teste', waAccountId: null, leadId: null, oportunidadeId: null });
    expect(resultado).toMatchObject({ status: 'curso_livre_confirmado', pode_cursar: true });
    expect(banco.from).not.toHaveBeenCalled();
    expect(banco.rpc).not.toHaveBeenCalled();
  });
  it('inclui a fonte no pedido real montado, inclusive após uma ferramenta, sem contaminar outro assunto', async () => {
    const { montarPedidoPrincipal } = await import('./agente');
    const base = { promptAgente: 'Persona', tools: [], comFicha: false };
    for (const content of ['Quero Cattle Clinic, não tenho faculdade', CATTLE_CLINIC.checkout]) {
      const pedido = montarPedidoPrincipal({ ...base, messages: [{ role: 'user', content }] });
      expect(pedido.pedido.system.map((b: any) => b.text)).toContain(INSTRUCAO_CATTLE_CLINIC);
      expect(pedido.origens.system.at(-1)).toContain('cattleClinic.ts');
    }
    const outro = montarPedidoPrincipal({ ...base, messages: [{ role: 'user', content: 'Quero a pós em sanidade avícola' }] });
    expect(outro.pedido.system.map((b: any) => b.text)).not.toContain(INSTRUCAO_CATTLE_CLINIC);
    const depois = montarPedidoPrincipal({ ...base, messages: [
      { role: 'user', content: 'Quero Cattle Clinic' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'consulta', name: 'consulta_pos_disponiveis', input: { curso_consulta: 'Cattle Clinic' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'consulta', content: JSON.stringify(consultarCattleClinic('Cattle Clinic')) }] },
    ] });
    expect(depois.pedido.system.map((b: any) => b.text)).toContain(INSTRUCAO_CATTLE_CLINIC);
  });
});
