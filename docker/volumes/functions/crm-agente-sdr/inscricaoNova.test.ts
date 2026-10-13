import { describe, expect, it } from 'vitest';
import { aplicarInscricaoPendente, notaDaInscricao } from './inscricaoNova';

const AGORA = new Date('2026-10-13T15:00:00Z');
const banco = (data: unknown, error: unknown = null) => {
  const chamadas: Record<string, unknown>[] = [];
  return { chamadas, rpc: async (nome: string, args: Record<string, unknown>) => { chamadas.push({ nome, ...args }); return { data, error }; } };
};

describe('nota da inscrição nova', () => {
  it('caso Eliel: conta a pós nova, a data e de onde ele veio', () => {
    const nota = notaDaInscricao(
      { curso_anterior: { curso: 'PÓS | SANIDADE AVÍCOLA', trocado_em: '2026-10-13T12:00:00Z', inscrito_em: '2026-10-13T02:30:00Z' } },
      'PÓS | QUALIDADE E SEGURANÇA DE ALIMENTOS DE ORIGEM ANIMAL', AGORA);
    expect(nota).toContain('"inscricao_mais_recente":"PÓS | QUALIDADE E SEGURANÇA DE ALIMENTOS DE ORIGEM ANIMAL"');
    expect(nota).toContain('"curso_anterior":"PÓS | SANIDADE AVÍCOLA"');
    // 02:30 UTC ainda é dia 12 em Brasília.
    expect(nota).toContain('"inscrito_em":"12/10/2026"');
    expect(nota).toContain('o histórico pode falar do curso anterior');
  });

  it('com reunião marcada: avisa da outra inscrição e que a reunião segue na pós atual', () => {
    const nota = notaDaInscricao(
      { inscricao_pendente: { curso: 'PÓS | PRODUÇÃO DE SUÍNOS', em: '2026-10-13T12:00:00Z', reuniao_em: '2026-10-15T14:00:00Z' },
        curso_anterior: { curso: 'X', trocado_em: '2026-10-01T12:00:00Z' } },
      'PÓS | SANIDADE AVÍCOLA', AGORA);
    expect(nota).toContain('"tambem_se_inscreveu_em":"PÓS | PRODUÇÃO DE SUÍNOS"');
    expect(nota).toContain('A reunião marcada continua sendo a da pós atual');
    expect(nota).not.toContain('inscricao_mais_recente');
  });

  it('troca antiga (mais de 45 dias) e jornada sem inscrição: nada', () => {
    expect(notaDaInscricao({ curso_anterior: { curso: 'X', trocado_em: '2026-08-01T12:00:00Z' } }, 'Y', AGORA)).toBe('');
    expect(notaDaInscricao({ coleta: { graduacao: 'Zootecnia' } }, 'Y', AGORA)).toBe('');
    expect(notaDaInscricao(null, 'Y', AGORA)).toBe('');
    expect(notaDaInscricao({ curso_anterior: { curso: 'X', trocado_em: 'ontem' } }, 'Y', AGORA)).toBe('');
  });
});

describe('inscrição que esperava a reunião passar', () => {
  const lead = { remotejid: '5546988166051@s.whatsapp.net', jornada: { inscricao_pendente: { curso: 'PÓS | PRODUÇÃO DE SUÍNOS' } } };

  it('sem pendência não consulta o banco', async () => {
    const b = banco({ trocou: true, curso: 'X' });
    expect(await aplicarInscricaoPendente(b, { remotejid: lead.remotejid, jornada: { coleta: {} } })).toBeNull();
    expect(await aplicarInscricaoPendente(b, null)).toBeNull();
    expect(b.chamadas).toHaveLength(0);
  });

  it('a reunião passou: aplica a troca (p_curso nulo = a pendente)', async () => {
    const b = banco({ trocou: true, curso: 'PÓS | PRODUÇÃO DE SUÍNOS', curso_anterior: 'PÓS | SANIDADE AVÍCOLA' });
    expect(await aplicarInscricaoPendente(b, lead)).toEqual({ curso: 'PÓS | PRODUÇÃO DE SUÍNOS', curso_anterior: 'PÓS | SANIDADE AVÍCOLA' });
    expect(b.chamadas).toEqual([{ nome: 'crm_sdr_curso_da_inscricao', p_remotejid: lead.remotejid }]);
  });

  it('reunião ainda marcada, erro ou resposta estranha: segue com o curso atual', async () => {
    expect(await aplicarInscricaoPendente(banco({ trocou: false, motivo: 'reuniao_marcada' }), lead)).toBeNull();
    expect(await aplicarInscricaoPendente(banco(null, { message: 'x' }), lead)).toBeNull();
    expect(await aplicarInscricaoPendente(banco('ok'), lead)).toBeNull();
    expect(await aplicarInscricaoPendente({ rpc: async () => { throw new Error('rede'); } }, lead)).toBeNull();
  });
});
