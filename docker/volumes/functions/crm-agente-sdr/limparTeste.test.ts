import { describe, expect, it } from 'vitest';
import { ehComandoLimpar, ehTelefoneDeTeste, estadoZerado, limparConversaDeTeste, limpoEm } from './limparTeste';

// Banco falso que anota cada operação (tabela, verbo, filtro) e responde sem erro, ou com erro numa tabela.
function banco(opcoes: { config?: unknown; erroEm?: string } = {}) {
  const ops: { tabela: string; verbo: string; valor?: unknown; coluna?: string; filtro?: unknown }[] = [];
  const from = (tabela: string) => {
    const op: (typeof ops)[number] = { tabela, verbo: 'select' };
    const resposta = () => Promise.resolve(tabela === opcoes.erroEm ? { error: { message: 'falhou' } } : { data: opcoes.config ?? null, error: null });
    const q: any = {
      select: () => q, eq: () => q, maybeSingle: resposta,
      delete: () => { op.verbo = 'delete'; ops.push(op); return q; },
      update: (valor: unknown) => { op.verbo = 'update'; op.valor = valor; ops.push(op); return q; },
      insert: (valor: unknown) => { op.verbo = 'insert'; op.valor = valor; ops.push(op); return q; },
      in: (coluna: string, filtro: unknown) => { op.coluna = coluna; op.filtro = filtro; return q; },
      then: (ok: any, erro: any) => resposta().then(ok, erro),
    };
    return q;
  };
  return { from, ops };
}

describe('/limpar', () => {
  it('reconhece só o comando exato', () => {
    expect(ehComandoLimpar('/limpar')).toBe(true);
    expect(ehComandoLimpar('  /LIMPAR ')).toBe(true);
    expect(ehComandoLimpar('/limpar agora')).toBe(false);
    expect(ehComandoLimpar('limpar')).toBe(false);
  });

  it('só telefone da lista de teste, pelo número exato (outro DDD com o mesmo final não entra)', async () => {
    const cfg = { luna_telefones: ['5546988166051'] };
    expect(await ehTelefoneDeTeste(banco({ config: cfg }), '5546988166051')).toBe(true);
    expect(await ehTelefoneDeTeste(banco({ config: cfg }), '554688166051')).toBe(true); // sem o 9º dígito
    expect(await ehTelefoneDeTeste(banco({ config: cfg }), '5511988166051')).toBe(false);
    expect(await ehTelefoneDeTeste(banco({ config: { luna_telefones: [] } }), '5546988166051')).toBe(false);
    expect(await ehTelefoneDeTeste(banco({ erroEm: 'crm_agente_sdr_config' }), '5546988166051')).toBe(false);
  });

  it('zera o estado do agente e mantém o cadastro', () => {
    const e = estadoZerado('2026-09-29T20:00:00.000Z');
    expect(e).toMatchObject({ agente_atual: null, agendado: false, pausa_ia: false, jornada: { limpo_em: '2026-09-29T20:00:00.000Z' } });
    for (const cadastro of ['nome', 'curso_interesse_original', 'email', 'formacao_academica', 'remotejid']) {
      expect(e, `${cadastro} é cadastro e fica`).not.toHaveProperty(cadastro);
    }
  });

  it('apaga memória, elegibilidade, buffer e lock e zera o lead, em todas as variantes do número', async () => {
    const b = banco();
    const r = await limparConversaDeTeste(b, '5546988166051@s.whatsapp.net', '5546988166051');
    expect(b.ops.map((o) => `${o.verbo} ${o.tabela}`)).toEqual([
      'delete cliente_ppg_mensagens_sdr', 'update cliente_ppg_leads_sdr', 'delete crm_agente_elegibilidade',
      'delete crm_agente_sdr_buffer', 'delete crm_agente_sdr_lock', 'insert crm_agente_sdr_eventos',
    ]);
    expect(b.ops[0].filtro).toEqual(expect.arrayContaining(['5546988166051@s.whatsapp.net', '554688166051@s.whatsapp.net']));
    expect(b.ops[1].valor).toMatchObject({ jornada: { limpo_em: r.limpo_em } });
    expect(b.ops[2].coluna).toBe('telefone_canonico');
  });

  it('fecha a rodada nas duas variantes do número, senão a reconciliação reenvia o /limpar e apaga o teste de novo', async () => {
    const b = banco();
    await limparConversaDeTeste(b, '5546988166051@s.whatsapp.net', '5546988166051');
    const eventos = b.ops.at(-1)!.valor as { remotejid: string; tipo: string; dados: { motivo: string } }[];
    expect(eventos.map((e) => e.remotejid).sort()).toEqual(['554688166051@s.whatsapp.net', '5546988166051@s.whatsapp.net']);
    expect(eventos.every((e) => e.tipo === 'rodada_fim' && e.dados.motivo === 'limpar_teste')).toBe(true);
  });

  it('erro em qualquer passo interrompe e avisa onde', async () => {
    await expect(limparConversaDeTeste(banco({ erroEm: 'cliente_ppg_leads_sdr' }), '5546988166051@s.whatsapp.net', '5546988166051'))
      .rejects.toThrow('/limpar (lead)');
  });

  it('limpo_em só vale como data', () => {
    expect(limpoEm({ jornada: { limpo_em: '2026-09-29T20:00:00.000Z' } })).toBe('2026-09-29T20:00:00.000Z');
    expect(limpoEm({ jornada: { limpo_em: 'ontem' } })).toBeNull();
    expect(limpoEm({ jornada: {} })).toBeNull();
    expect(limpoEm(null)).toBeNull();
  });
});
