import { describe, expect, it, vi } from 'vitest';
import { casaSubscriber, enviarComDonoDaConversa, enviarPeloManychat } from './igManychat';

// Instagram, ManyChat e banco simulados: nenhuma DM sai, nenhuma linha é escrita.
const ALVO = { contaId: 'conta-1', igsid: '1404604485122474', token: 'IGAA-x', nome: 'Ana Souza', username: 'ana.vet' };
const DONO_OUTRO = { error: { code: 100, error_subcode: 2534037, message: 'not the thread owner' } };

type Chamada = { url: string; corpo: any };
function rede(respostas: { ig?: any; igStatus?: number; busca?: any; envio?: any; envioStatus?: number }) {
  const chamadas: Chamada[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const corpo = init?.body ? JSON.parse(String(init.body)) : null;
    chamadas.push({ url: String(url), corpo });
    if (String(url).includes('graph.instagram.com')) {
      return new Response(JSON.stringify(respostas.ig ?? { message_id: 'mid-ig' }), { status: respostas.igStatus ?? 200 });
    }
    if (String(url).includes('findByName')) return new Response(JSON.stringify(respostas.busca ?? { status: 'success', data: [] }));
    return new Response(JSON.stringify(respostas.envio ?? { status: 'success' }), { status: respostas.envioStatus ?? 200 });
  });
  return { f: f as unknown as typeof fetch, chamadas };
}

function banco(p: { chave?: string | null; cache?: number | null } = {}) {
  const escritas: { tabela: string; op: string; payload: any }[] = [];
  const db = {
    from(tabela: string) {
      const q: any = {
        op: 'select', payload: null,
        select: () => q, eq: () => q,
        insert: (x: any) => { q.op = 'insert'; q.payload = x; escritas.push({ tabela, op: 'insert', payload: x }); return q; },
        update: (x: any) => { q.op = 'update'; q.payload = x; escritas.push({ tabela, op: 'update', payload: x }); return q; },
        upsert: async (x: any) => { escritas.push({ tabela, op: 'upsert', payload: x }); return { error: null }; },
        maybeSingle: async () => {
          if (q.op === 'insert') return { data: { id: 'pend-1' }, error: null };
          if (tabela === 'ig_contas_secrets') return { data: p.chave === null ? null : { manychat_api_key: p.chave ?? '4491507:abc' }, error: null };
          if (tabela === 'ig_manychat_contatos') return { data: p.cache ? { subscriber_id: p.cache } : null, error: null };
          return { data: null, error: null };
        },
        then: (ok: any) => Promise.resolve({ data: null, error: null }).then(ok),
      };
      return q;
    },
  };
  return { db, escritas };
}

describe('casaSubscriber: o contato certo no ManyChat', () => {
  const lista = [
    { id: 1, name: 'Ana Souza', ig_id: 111, ig_username: 'outra.ana' },
    { id: 2, name: 'Ana Souza', ig_id: 1404604485122474, ig_username: 'ana.vet' },
  ];
  it('pelo ig_id (= IGSID); senão pelo @, sem caixa nem arroba', () => {
    expect(casaSubscriber(lista, '1404604485122474', null)?.id).toBe(2);
    expect(casaSubscriber([{ id: 3, ig_username: 'Ana.Vet' }], '999', '@ana.vet')?.id).toBe(3);
    expect(casaSubscriber(lista, '999', 'ninguem')).toBeNull();
  });
});

describe('enviarPeloManychat', () => {
  it('conteúdo dinâmico v2, canal instagram, texto puro', async () => {
    const { f, chamadas } = rede({});
    expect(await enviarPeloManychat('k', 42, 'Oi!', f)).toEqual({ ok: true });
    expect(chamadas[0].url).toBe('https://api.manychat.com/fb/sending/sendContent');
    expect(chamadas[0].corpo).toEqual({
      subscriber_id: 42,
      data: { version: 'v2', content: { type: 'instagram', messages: [{ type: 'text', text: 'Oi!' }] } },
    });
  });

  it('chave errada vira erro legível', async () => {
    const { f } = rede({ envio: { status: 'error', message: 'Wrong token' }, envioStatus: 401 });
    const r = await enviarPeloManychat('k', 42, 'Oi!', f);
    expect(r).toMatchObject({ ok: false, erro: { status: 401, message: 'ManyChat: Wrong token' } });
  });
});

describe('enviarComDonoDaConversa (28/09/2026)', () => {
  it('Instagram aceitou: via instagram, o ManyChat nem é consultado', async () => {
    const { f, chamadas } = rede({});
    const { db, escritas } = banco();
    const r = await enviarComDonoDaConversa(db, ALVO, 'oi', { origem: 'ia' }, f);
    expect(r).toMatchObject({ ok: true, mid: 'mid-ig', via: 'instagram' });
    expect(chamadas).toHaveLength(1);
    expect(escritas).toEqual([]);
  });

  it('outro erro do Instagram (token morto): devolve o erro, sem ManyChat', async () => {
    const { f, chamadas } = rede({ ig: { error: { code: 190, message: 'expired' } }, igStatus: 400 });
    const r = await enviarComDonoDaConversa(banco().db, ALVO, 'oi', { origem: 'ia' }, f);
    expect(r).toMatchObject({ ok: false, via: 'instagram', erro: { code: 190 } });
    expect(chamadas).toHaveLength(1);
  });

  it('conversa do ManyChat sem a chave dele: devolve o 2534037', async () => {
    const { f } = rede({ ig: DONO_OUTRO, igStatus: 400 });
    const r = await enviarComDonoDaConversa(banco({ chave: null }).db, ALVO, 'oi', { origem: 'ia' }, f);
    expect(r).toMatchObject({ ok: false, via: 'instagram', erro: { subcode: 2534037 } });
  });

  it('conversa do ManyChat: acha o contato, guarda no cache, marca o envio pendente ANTES e manda por ele', async () => {
    const { f, chamadas } = rede({
      ig: DONO_OUTRO, igStatus: 400,
      busca: { status: 'success', data: [{ id: 77, name: 'Ana Souza', ig_id: 1404604485122474, ig_username: 'ana.vet' }] },
    });
    const { db, escritas } = banco();
    const r = await enviarComDonoDaConversa(db, ALVO, 'Tudo ótimo!', { origem: 'humano', enviadoPorId: 'u1', enviadoPorNome: 'Ana Atendente' }, f);
    expect(r).toEqual({ ok: true, mid: '', via: 'manychat' });
    expect(chamadas.map((c) => c.url.replace(/\?.*/, ''))).toEqual([
      'https://graph.instagram.com/v23.0/me/messages',
      'https://api.manychat.com/fb/subscriber/findByName',
      'https://api.manychat.com/fb/sending/sendContent',
    ]);
    expect(chamadas[1].url).toContain('name=Ana%20Souza');
    expect(chamadas[2].corpo.subscriber_id).toBe(77);
    expect(escritas).toEqual([
      { tabela: 'ig_manychat_contatos', op: 'upsert', payload: expect.objectContaining({ conta_id: 'conta-1', igsid: ALVO.igsid, subscriber_id: 77 }) },
      { tabela: 'ig_envios_manychat', op: 'insert', payload: expect.objectContaining({
        texto: 'Tudo ótimo!', origem: 'humano', enviado_por_id: 'u1', enviado_por_nome: 'Ana Atendente' }) },
    ]);
  });

  it('contato já no cache: não procura de novo', async () => {
    const { f, chamadas } = rede({ ig: DONO_OUTRO, igStatus: 400 });
    const r = await enviarComDonoDaConversa(banco({ cache: 77 }).db, ALVO, 'oi', { origem: 'ia' }, f);
    expect(r.via).toBe('manychat');
    expect(chamadas.some((c) => c.url.includes('findByName'))).toBe(false);
  });

  it('não achou a pessoa no ManyChat: erro claro, nada pendente', async () => {
    const { f } = rede({ ig: DONO_OUTRO, igStatus: 400 });
    const { db, escritas } = banco();
    const r = await enviarComDonoDaConversa(db, ALVO, 'oi', { origem: 'ia' }, f);
    expect(r).toMatchObject({ ok: false, via: 'manychat', erro: { status: 404 } });
    expect(escritas).toEqual([]);
  });

  it('o ManyChat recusou: o pendente vira "falhou" (o eco não vai casar com nada)', async () => {
    const { f } = rede({ ig: DONO_OUTRO, igStatus: 400, envio: { status: 'error', message: 'Wrong token' }, envioStatus: 401 });
    const { db, escritas } = banco({ cache: 77 });
    const r = await enviarComDonoDaConversa(db, ALVO, 'oi', { origem: 'ia' }, f);
    expect(r).toMatchObject({ ok: false, via: 'manychat' });
    expect(escritas.at(-1)).toMatchObject({ tabela: 'ig_envios_manychat', op: 'update', payload: { status: 'falhou' } });
  });
});
