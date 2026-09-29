// Travas ligadas de verdade (29/09/2026): a ferramenta de agenda recusa horário que não saiu da
// consulta ANTES de tocar banco/agenda, e só no canário (ctx.ficha).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CtxConversa } from './tools';

let executarTool: typeof import('./tools').executarTool;
const rede = vi.fn(async () => { throw new Error('Rede não autorizada neste teste'); });
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (k: string) => (k === 'SUPABASE_URL' ? 'https://supabase.invalid' : '') } });
  vi.stubGlobal('fetch', rede);
  ({ executarTool } = await import('./tools'));
});
afterAll(() => vi.unstubAllGlobals());

const bancoQueNaoPodeSerUsado = { from: () => { throw new Error('banco não deveria ser consultado'); }, rpc: () => { throw new Error('rpc não deveria ser chamada'); } };
const canario = (historicoConversa: CtxConversa['historicoConversa']): CtxConversa => ({
  telefone: '5500000000000', remotejid: '5500000000000@s.whatsapp.net', waAccountId: null, leadId: null, oportunidadeId: null,
  ficha: { inicioRodada: new Date().toISOString() }, historicoConversa,
});
const consultaGuardada = [{ role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'c', content: JSON.stringify({
  resultado: 'Horários…', slots_raw: [{ data: '2099-01-10', horario: '15:00', vendedor_id: 7, vendedor_nome: 'Ana' }] }) }] }];

describe('confirmar/remarcar no canário: horário só da agenda', () => {
  it('confirmar com horário inventado é recusado sem tocar banco, agenda nem Google', async () => {
    const r = await executarTool(bancoQueNaoPodeSerUsado, { id: 'x', name: 'confirmar_agendamento',
      input: { curso_escolhido: 'Pós X', data_escolhida: '2099-01-10', horario_escolhido: '16:00', vendedor_id: 7 } }, canario(consultaGuardada));
    expect(r).toMatchObject({ trava: 'horario_fora_da_consulta', agendamento_id: null });
    expect(String(r.resultado)).toContain('2099-01-10 15:00 · vendedor_id 7 (Ana)');
    expect(rede).not.toHaveBeenCalled();
  });
  it('confirmar sem nenhuma consulta na conversa é recusado', async () => {
    const r = await executarTool(bancoQueNaoPodeSerUsado, { id: 'x', name: 'confirmar_agendamento',
      input: { curso_escolhido: 'Pós X', data_escolhida: '2099-01-10', horario_escolhido: '15:00', vendedor_id: 7 } }, canario([]));
    expect(r).toMatchObject({ trava: 'sem_consulta' });
  });
  it('remarcar para horário que não saiu da agenda é recusado', async () => {
    const r = await executarTool(bancoQueNaoPodeSerUsado, { id: 'x', name: 'remarcar_agendamento',
      input: { motivo: 'lead pediu', data_escolhida: '2099-01-11', horario_escolhido: '09:00' } }, canario(consultaGuardada));
    expect(r).toMatchObject({ trava: 'horario_fora_da_consulta' });
  });
});
