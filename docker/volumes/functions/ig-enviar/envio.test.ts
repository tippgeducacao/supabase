import { describe, expect, it, vi } from 'vitest';
import { type DepsEnvioIg, enviarDoSac, JANELA_IG_MS, janelaAberta } from './envio';

// Banco e Instagram simulados: nenhuma DM sai, nenhuma linha é escrita.
const AGORA = Date.parse('2026-09-25T20:00:00Z');
const DESTINO = { contaId: 'conta-1', igUserId: '1784', igsid: '999' };
const AUTOR = { id: 'user-1', nome: 'Ana Atendente' };

function deps(extra: Partial<DepsEnvioIg> = {}) {
  const gravadas: { linha: Record<string, any>; enviou: boolean }[] = [];
  let n = 0;
  const d: DepsEnvioIg = {
    destino: vi.fn(async () => DESTINO),
    ultimoInbound: vi.fn(async () => new Date(AGORA - 60_000).toISOString()),
    token: vi.fn(async () => 'IGAA-token'),
    enviar: vi.fn(async () => ({ ok: true as const, mid: `mid-${++n}` })),
    gravar: vi.fn(async (linha, enviou) => { gravadas.push({ linha, enviou }); }),
    agora: () => AGORA,
    ...extra,
  };
  return { d, gravadas };
}

describe('janelaAberta', () => {
  it('24h desde a última DM da pessoa; sem DM = fechada', () => {
    expect(janelaAberta(new Date(AGORA - JANELA_IG_MS + 1000).toISOString(), AGORA)).toBe(true);
    expect(janelaAberta(new Date(AGORA - JANELA_IG_MS).toISOString(), AGORA)).toBe(false);
    expect(janelaAberta(null, AGORA)).toBe(false);
    expect(janelaAberta('lixo', AGORA)).toBe(false);
  });
});

describe('enviarDoSac', () => {
  it('manda, grava como humano com o autor (o espelho do SAC e a pausa da IA dependem disso)', async () => {
    const { d, gravadas } = deps();
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: '  Oi Fulana!  ', autor: AUTOR });
    expect(r).toEqual({ ok: true, enviadas: 1 });
    expect(d.enviar).toHaveBeenCalledWith('IGAA-token', '999', 'Oi Fulana!');
    expect(gravadas).toEqual([{
      enviou: true,
      linha: {
        conta_id: 'conta-1', ig_user_id: '1784', contato_igsid: '999', direcao: 'outbound', tipo: 'text',
        conteudo: 'Oi Fulana!', mid: 'mid-1', status_entrega: 'sent',
        metadata: { is_echo: false, origem: 'humano', via: 'sac', enviado_por_id: 'user-1', enviado_por_nome: 'Ana Atendente' },
      },
    }]);
  });

  it('janela fechada: não tenta mandar nem grava', async () => {
    const { d, gravadas } = deps({ ultimoInbound: vi.fn(async () => new Date(AGORA - JANELA_IG_MS - 1).toISOString()) });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'janela_fechada' });
    expect(d.enviar).not.toHaveBeenCalled();
    expect(gravadas).toEqual([]);
  });

  it('texto vazio, conversa que não é do Instagram e conta sem token', async () => {
    expect(await enviarDoSac(deps().d, { conversaId: 'c1', texto: '   ', autor: AUTOR })).toMatchObject({ codigo: 'texto_vazio' });
    expect(await enviarDoSac(deps().d, { conversaId: 'c1', texto: 'x'.repeat(4001), autor: AUTOR })).toMatchObject({ codigo: 'texto_vazio' });
    expect(await enviarDoSac(deps({ destino: vi.fn(async () => null) }).d, { conversaId: 'c1', texto: 'oi', autor: AUTOR }))
      .toMatchObject({ codigo: 'conversa_invalida' });
    expect(await enviarDoSac(deps({ token: vi.fn(async () => null) }).d, { conversaId: 'c1', texto: 'oi', autor: AUTOR }))
      .toMatchObject({ codigo: 'sem_conta' });
  });

  it('texto acima de 1000 bytes vira vários balões, em ordem', async () => {
    const { d, gravadas } = deps();
    const texto = ('palavra ').repeat(300).trim(); // ~2400 bytes
    const r = await enviarDoSac(d, { conversaId: 'c1', texto, autor: AUTOR });
    expect(r.ok && r.enviadas).toBeGreaterThan(1);
    expect(gravadas.map((g) => g.linha.mid)).toEqual(gravadas.map((_, i) => `mid-${i + 1}`));
    expect(gravadas.map((g) => g.linha.conteudo).join(' ')).toBe(texto);
  });

  it('token morto (190): grava a falha e avisa para reconectar', async () => {
    const { d, gravadas } = deps({
      enviar: vi.fn(async () => ({ ok: false as const, erro: { status: 400, code: 190, message: 'Invalid OAuth access token' } })),
    });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'token_invalido', enviadas: 0 });
    expect(gravadas[0]).toMatchObject({ enviou: false, linha: { mid: null, status_entrega: 'failed', erro: { code: 190 } } });
  });

  it('conversa presa a outro app (ManyChat, 2534037): diz para responder pelo app', async () => {
    const { d } = deps({
      enviar: vi.fn(async () => ({ ok: false as const, erro: { status: 400, code: 100, subcode: 2534037, message: 'not the thread owner' } })),
    });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'conversa_de_outro_app', enviadas: 0 });
    expect(!r.ok && r.erro).toContain('app do Instagram');
  });

  it('outra recusa da Meta: para no balão que falhou', async () => {
    let n = 0;
    const { d, gravadas } = deps({
      enviar: vi.fn(async () => (++n === 1
        ? { ok: true as const, mid: 'mid-1' }
        : { ok: false as const, erro: { status: 400, code: 10, message: 'fora da janela' } })),
    });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: ('abc ').repeat(400).trim(), autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'falha_envio', enviadas: 1 });
    expect(d.enviar).toHaveBeenCalledTimes(2);
    expect(gravadas.map((g) => g.enviou)).toEqual([true, false]);
  });
});
