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
    comentarioDeLive: vi.fn(async () => null),
    saidaDepois: vi.fn(async () => false),
    responderComentario: vi.fn(async () => ({ ok: true as const, mid: 'mid-privada' })),
    token: vi.fn(async () => 'IGAA-token'),
    enviar: vi.fn(async () => ({ ok: true as const, mid: `mid-${++n}`, via: 'instagram' as const })),
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
    expect(d.enviar).toHaveBeenCalledWith(DESTINO, 'IGAA-token', 'Oi Fulana!', AUTOR);
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
      enviar: vi.fn(async () => ({ ok: false as const, via: 'instagram' as const, erro: { status: 400, code: 100, subcode: 2534037, message: 'not the thread owner' } })),
    });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'conversa_de_outro_app', enviadas: 0 });
    expect(!r.ok && r.erro).toContain('app do Instagram');
  });

  it('conversa do ManyChat, enviado POR ELE (28/09): não grava — a linha nasce do eco', async () => {
    const { d, gravadas } = deps({ enviar: vi.fn(async () => ({ ok: true as const, mid: '', via: 'manychat' as const })) });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toEqual({ ok: true, enviadas: 1 });
    expect(gravadas).toEqual([]);
  });

  it('o ManyChat também falhou: a mensagem dele volta para o atendente', async () => {
    const { d } = deps({
      enviar: vi.fn(async () => ({ ok: false as const, via: 'manychat' as const, erro: { status: 401, message: 'ManyChat: Wrong token' } })),
    });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'falha_envio' });
    expect(!r.ok && r.erro).toContain('Não saiu pelo ManyChat');
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

describe('comentário de live: a resposta sai como resposta privada (12/11/2026)', () => {
  const SEM_DM = { ultimoInbound: vi.fn(async () => null) };
  const COMENTOU = { commentId: '17890018740485756', criadoEm: new Date(AGORA - 120_000).toISOString() };

  it('só comentou na live: manda UMA mensagem pelo comment_id e grava como humano', async () => {
    const { d, gravadas } = deps({ ...SEM_DM, comentarioDeLive: vi.fn(async () => COMENTOU) });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'Oi! Te mando a condição por aqui 😉', autor: AUTOR });
    expect(r).toEqual({ ok: true, enviadas: 1 });
    expect(d.responderComentario).toHaveBeenCalledWith(DESTINO, 'IGAA-token', '17890018740485756', 'Oi! Te mando a condição por aqui 😉');
    expect(d.enviar).not.toHaveBeenCalled();
    expect(gravadas).toEqual([{
      enviou: true,
      linha: {
        conta_id: 'conta-1', ig_user_id: '1784', contato_igsid: '999', direcao: 'outbound', tipo: 'text',
        conteudo: 'Oi! Te mando a condição por aqui 😉', mid: 'mid-privada', status_entrega: 'sent',
        metadata: {
          is_echo: false, origem: 'humano', via: 'sac', enviado_por_id: 'user-1', enviado_por_nome: 'Ana Atendente',
          resposta_privada: true, comment_id: '17890018740485756',
        },
      },
    }]);
  });

  it('a mensagem permitida já saiu: não manda outra', async () => {
    const { d, gravadas } = deps({ ...SEM_DM, comentarioDeLive: vi.fn(async () => COMENTOU), saidaDepois: vi.fn(async () => true) });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'e aí?', autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'comentario_ja_respondido' });
    expect(d.saidaDepois).toHaveBeenCalledWith(DESTINO, COMENTOU.criadoEm);
    expect(d.responderComentario).not.toHaveBeenCalled();
    expect(gravadas).toEqual([]);
  });

  it('texto que não cabe numa mensagem só: recusa antes de mandar', async () => {
    const { d } = deps({ ...SEM_DM, comentarioDeLive: vi.fn(async () => COMENTOU) });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'palavra '.repeat(200).trim(), autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'comentario_longo' });
    expect(d.responderComentario).not.toHaveBeenCalled();
  });

  it('a live já acabou (a Meta recusa): grava a falha e explica o motivo', async () => {
    const { d, gravadas } = deps({
      ...SEM_DM,
      comentarioDeLive: vi.fn(async () => COMENTOU),
      responderComentario: vi.fn(async () => ({ ok: false as const, erro: { status: 400, code: 10, message: 'This message is sent outside of allowed window' } })),
    });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toMatchObject({ ok: false, codigo: 'comentario_recusado', enviadas: 0 });
    expect(!r.ok && r.erro).toContain('enquanto a live está no ar');
    expect(gravadas[0]).toMatchObject({ enviou: false, linha: { mid: null, status_entrega: 'failed', erro: { code: 10 } } });
  });

  it('a pessoa TAMBÉM mandou DM nas últimas 24h: vale a janela normal, não a resposta privada', async () => {
    const { d } = deps({ comentarioDeLive: vi.fn(async () => COMENTOU) });
    const r = await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR });
    expect(r).toEqual({ ok: true, enviadas: 1 });
    expect(d.enviar).toHaveBeenCalledTimes(1);
    expect(d.comentarioDeLive).not.toHaveBeenCalled();
    expect(d.responderComentario).not.toHaveBeenCalled();
  });

  it('comentário de mais de 24h atrás: janela fechada', async () => {
    const velho = { ...COMENTOU, criadoEm: new Date(AGORA - JANELA_IG_MS - 1).toISOString() };
    const { d } = deps({ ...SEM_DM, comentarioDeLive: vi.fn(async () => velho) });
    expect(await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR })).toMatchObject({ codigo: 'janela_fechada' });
    expect(d.responderComentario).not.toHaveBeenCalled();
  });

  it('token morto na resposta privada: avisa para reconectar', async () => {
    const { d } = deps({
      ...SEM_DM,
      comentarioDeLive: vi.fn(async () => COMENTOU),
      responderComentario: vi.fn(async () => ({ ok: false as const, erro: { status: 400, code: 190, message: 'Invalid OAuth access token' } })),
    });
    expect(await enviarDoSac(d, { conversaId: 'c1', texto: 'oi', autor: AUTOR })).toMatchObject({ codigo: 'token_invalido' });
  });
});
