import { beforeAll, describe, expect, it, vi } from 'vitest';

let T: typeof import('./tools');
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  T = await import('./tools');
});

const base = { hoje: { iso: '2026-09-30', display: 'quarta-feira, 30/09/2026' }, data_pedida: '2026-10-01', horarios: [], formacao_checada: true };
const h = { data: '2026-10-01', dia_semana: 'quinta-feira', horario: '10:00', display: '10h', vendedor_id: 'v1', vendedor_nome: 'Ana' };

describe('consulta de agenda: dados × texto (o texto é o mesmo de sempre)', () => {
  it('cada situação tem o seu texto', () => {
    expect(T.textoDisponibilidade({ ...base, situacao: 'data_passada', data_pedida: '2026-09-01' })).toContain('JÁ PASSOU');
    expect(T.textoDisponibilidade({ ...base, situacao: 'erro_tecnico', erro: 'HTTP 500' })).toContain('falha técnica, NÃO é falta de horário');
    expect(T.textoDisponibilidade({ ...base, situacao: 'sem_horario' })).toContain('Nenhum horário disponível');
    const ok = T.textoDisponibilidade({ ...base, situacao: 'ok', horarios: [h] });
    expect(ok).toContain('- 10h de quinta-feira, dia 2026-10-01 (vendedor_id: v1, nome: Ana)');
    expect(ok).not.toContain('graduação');
    expect(T.textoDisponibilidade({ ...base, situacao: 'ok', horarios: [h], formacao_checada: false })).toContain('graduação deste lead ainda NÃO foi verificada');
  });

  it('a saída mantém a ordem dos campos (é o texto que a conversa guarda) e o slots_raw', () => {
    const saida = T.saidaDisponibilidade({ ...base, situacao: 'ok', horarios: [h] }, 'c1');
    expect(Object.keys(saida)).toEqual(['resultado', 'slots_raw', 'id']);
    expect(saida.slots_raw).toEqual([{ data: '2026-10-01', dia_semana: 'quinta-feira', horario: '10:00', vendedor_id: 'v1', vendedor_nome: 'Ana' }]);
    expect(Object.keys(T.saidaDisponibilidade({ ...base, situacao: 'erro_tecnico', erro: 'x' }, 'c1'))).toEqual(['resultado', 'erro', 'slots_raw', 'id']);
  });
});
