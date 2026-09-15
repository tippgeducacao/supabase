import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const estado = vi.hoisted(() => ({ permitido: true, erroRegistro: false, ultima: {} as Record<string, unknown>, inserida: {} as Record<string, unknown>, atualizadas: [] as Record<string, unknown>[] }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.45.0', () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: 'usuario' } } }) },
  rpc: async () => ({ data: estado.permitido }),
  from: (tabela: string) => {
    const consulta: Record<string, unknown> = {};
    for (const nome of ['select', 'eq', 'order', 'limit']) consulta[nome] = () => consulta;
    consulta.maybeSingle = async () => ({ data: tabela === 'email_threads' ? {
      id: 'thread', caixa_id: 'caixa', gmail_thread_id: 'gmail-thread', assunto: 'Cadastro',
      caixa: { id: 'caixa', email_caixa: 'equipe@example.com', nome_exibicao: 'Equipe', integ: {} },
    } : estado.ultima });
    consulta.update = (dados: Record<string, unknown>) => { estado.atualizadas.push(dados); return consulta; };
    consulta.insert = async (dados: Record<string, unknown>) => { estado.inserida = dados; return { error: estado.erroRegistro ? { message: 'segredo nao deve ser logado' } : null }; };
    consulta.then = (resolver: (valor: unknown) => void) => resolver({ error: null });
    return consulta;
  },
}) }));
vi.mock('../_shared/gmail.ts', () => ({
  ensureToken: async () => 'token-teste', base64UrlEncode: (v: string) => Buffer.from(v).toString('base64url'),
  validateEmailList: (v: string[]) => ({ ok: v, invalid: [] }), friendlyGmailError: (e: unknown) => String(e),
  isTokenRevokedError: () => false, markCaixaTokenRevoked: vi.fn(), isScopeInsufficientError: () => false,
  markCaixaEscopoInsuficiente: vi.fn(), encodeHeaderUtf8: (v: string) => v, encodeDisplayName: (v: string) => v,
}));

let handler: (req: Request) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let tarefas: Promise<unknown>[];
const metadata = (id: string) => Response.json({ payload: { headers: [
  { name: 'Message-ID', value: id }, { name: 'References', value: '<raiz@example.com>' },
] } });
const chamar = () => handler(new Request('https://local.invalid', { method: 'POST', headers: { Authorization: 'Bearer user' },
  body: JSON.stringify({ thread_id: 'thread', body_html: '<p>Resposta</p>' }) }));

beforeEach(async () => {
  vi.resetModules(); estado.permitido = true; estado.erroRegistro = false; estado.inserida = {}; estado.atualizadas = []; tarefas = [];
  estado.ultima = { id: 'mensagem-local', gmail_message_id: 'gmail-real', message_id: null,
    references_header: '<raiz@example.com>', is_outgoing: false, from_email: 'contato@example.com' };
  fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ id: 'gmail-enviada', threadId: 'gmail-thread' })
    : metadata(_url.includes('gmail-enviada') ? '<enviada@example.com>' : '<recebida@example.com>'));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Deno', { env: { get: () => 'teste' }, serve: (fn: typeof handler) => { handler = fn; } });
  vi.stubGlobal('EdgeRuntime', { waitUntil: (tarefa: Promise<unknown>) => { tarefas.push(tarefa); } });
  await import('./index');
});
afterEach(async () => {
  try { await Promise.all(tarefas); }
  finally { vi.unstubAllGlobals(); }
});

describe('resposta Gmail com identidade RFC', () => {
  it('repara o pai, envia na thread real e persiste os cabeçalhos da saída', async () => {
    expect(await (await chamar()).json()).toMatchObject({ success: true, gmail_id: 'gmail-enviada' });
    const chamada = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const payload = JSON.parse(chamada[1].body);
    const mime = Buffer.from(payload.raw, 'base64url').toString();
    expect(payload.threadId).toBe('gmail-thread');
    expect(mime).toContain('In-Reply-To: <recebida@example.com>');
    expect(mime).toContain('References: <raiz@example.com>\r\n <recebida@example.com>');
    expect(mime).toContain('To: contato@example.com');
    expect(mime).not.toContain('gmail-real@mail.gmail.com');
    expect(estado.inserida).toMatchObject({ message_id: null, in_reply_to: 'recebida@example.com',
      references_header: '<raiz@example.com> <recebida@example.com>' });
    await Promise.all(tarefas);
    expect(estado.atualizadas).toContainEqual({ message_id: '<enviada@example.com>' });
  });
  it('mantém os destinatários quando a última mensagem já é nossa', async () => {
    estado.ultima = { ...estado.ultima, message_id: '<nossa@example.com>', is_outgoing: true, to_emails: [{ email: 'destino@example.com' }] };
    expect(await (await chamar()).json()).toMatchObject({ success: true });
    expect(estado.inserida.to_emails).toEqual([{ email: 'destino@example.com', name: '' }]);
    const chamada = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const mime = Buffer.from(JSON.parse(chamada[1].body).raw, 'base64url').toString();
    expect(mime).toContain('To: destino@example.com\r\n');
    expect(mime).not.toContain('To: equipe@example.com');
    expect(mime).toContain('In-Reply-To: <nossa@example.com>');
  });
  it('sem permissão da caixa não consulta metadata nem envia', async () => {
    estado.permitido = false;
    expect(await (await chamar()).json()).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('não envia quando o provedor não identifica a mensagem original', async () => {
    fetchMock.mockResolvedValue(Response.json({ payload: { headers: [] } }));
    expect(await (await chamar()).json()).toMatchObject({ success: false });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it.each([401, 503])('falha HTTP %i ao consultar o pai legado interrompe antes do envio', async (status) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    expect(await (await chamar()).json()).toMatchObject({ success: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/messages/gmail-real?');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(estado.inserida).toEqual({});
  });
  it('falha de transporte ao consultar o pai legado não dispara envio', async () => {
    fetchMock.mockRejectedValue(new TypeError('falha de transporte simulada'));
    expect(await (await chamar()).json()).toMatchObject({ success: false });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(estado.inserida).toEqual({});
  });
  it('metadata de saída indisponível não transforma envio aceito em falha reenviável', async () => {
    estado.ultima.message_id = '<recebida@example.com>';
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ id: 'gmail-enviada', threadId: 'gmail-thread' }) : new Response('', { status: 503 }));
    expect(await (await chamar()).json()).toMatchObject({ success: true });
    expect(estado.inserida.message_id).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('exceção de transporte em segundo plano preserva o aceite e não repete o POST', async () => {
    estado.ultima.message_id = '<recebida@example.com>';
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ id: 'gmail-enviada', threadId: 'gmail-thread' });
      throw new TypeError('metadata indisponível');
    });
    const resposta = await chamar();
    expect(await resposta.json()).toMatchObject({ success: true, gmail_id: 'gmail-enviada' });
    await Promise.all(tarefas);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(estado.inserida.gmail_message_id).toBe('gmail-enviada');
  });
  it('retorna o aceite enquanto a consulta dos cabeçalhos de saída continua pendente', async () => {
    estado.ultima.message_id = '<recebida@example.com>';
    let resolver!: (r: Response) => void;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ id: 'gmail-enviada', threadId: 'gmail-thread' }) : new Promise<Response>((r) => { resolver = r; }));
    const resposta = await chamar();
    expect(await resposta.json()).toMatchObject({ success: true });
    expect(estado.inserida.gmail_message_id).toBe('gmail-enviada');
    resolver(metadata('<enviada@example.com>'));
  });
  it('falha de registro local informa sincronização pendente sem oferecer reenvio', async () => {
    estado.erroRegistro = true;
    expect(await (await chamar()).json()).toMatchObject({ success: true, sincronizacao_pendente: true });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});
