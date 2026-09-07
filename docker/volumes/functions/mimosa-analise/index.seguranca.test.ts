import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as seguranca from './seguranca';

const USUARIO_AUTH = '11111111-1111-4111-8111-111111111111';
const OUTRO_USUARIO = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const ANALISE = '44444444-4444-4444-8444-444444444444';
const AGENDAMENTO = '55555555-5555-4555-8555-555555555555';
const GERAR = { acao: 'gerar', lead_id: LEAD, tipo: 'pre_reuniao' };

// Executa o handler publicado com os helpers reais. Somente as fronteiras Deno,
// Supabase e HTTP são injetadas: nenhum teste chega à rede ou consome tokens.
const fonte = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const codigo = ts.transpileModule(fonte, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

type RetornoRpc = { data: unknown; error: { message: string } | null };
type Opcoes = {
  usuario?: { id: string; is_anonymous?: boolean } | null;
  erroAuth?: { message: string } | null;
  autorizacao?: RetornoRpc;
  cota?: RetornoRpc;
};
type Escrita = { tabela: string; operacao: 'insert' | 'update'; valores: Record<string, unknown> };

function cenario(opcoes: Opcoes = {}) {
  const eventos: string[] = [];
  const escritas: Escrita[] = [];
  const filtros: Array<{ tabela: string; campo: string; valor: unknown }> = [];
  const getUser = vi.fn(async (_token: string) => {
    eventos.push('auth');
    return {
      data: { user: opcoes.usuario === undefined ? { id: USUARIO_AUTH } : opcoes.usuario },
      error: opcoes.erroAuth ?? null,
    };
  });
  const rpc = vi.fn(async (nome: string, _argumentos: Record<string, unknown>): Promise<RetornoRpc> => {
    eventos.push(nome);
    if (nome === 'mimosa_autorizar_acao') return opcoes.autorizacao ?? { data: { permitido: true }, error: null };
    if (nome === 'mimosa_consumir_cota') return opcoes.cota ?? { data: { permitido: true, retry_after: 0 }, error: null };
    throw new Error(`RPC inesperada no teste: ${nome}`);
  });
  const from = vi.fn((tabela: string) => {
    eventos.push(`from:${tabela}`);
    let escrita: Escrita | undefined;
    const resultado = (): RetornoRpc => {
      if (tabela === 'ped_configuracoes') return { data: { valor: { provider: 'anthropic', model: 'modelo-simulado', prompts: { pre: 'Olá {{primeiro_nome}}' } } }, error: null };
      if (tabela === 'ai_api_keys') return { data: { api_key: 'chave-provedor-simulada' }, error: null };
      if (tabela === 'leads') return { data: { id: LEAD, nome: 'Pessoa de teste' }, error: null };
      if (tabela === 'agendamentos') return { data: { id: AGENDAMENTO, lead_id: LEAD }, error: null };
      if (tabela === 'mimosa_analises') return { data: { id: ANALISE, ...escrita?.valores }, error: null };
      throw new Error(`Tabela inesperada no teste: ${tabela}`);
    };
    const builder = {
      select: vi.fn((_colunas: string) => builder),
      eq: vi.fn((campo: string, valor: unknown) => { filtros.push({ tabela, campo, valor }); return builder; }),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => resultado()),
      single: vi.fn(async () => resultado()),
      insert: vi.fn((valores: Record<string, unknown>) => {
        escrita = { tabela, operacao: 'insert', valores };
        escritas.push(escrita);
        eventos.push('insert');
        return builder;
      }),
      update: vi.fn((valores: Record<string, unknown>) => {
        escrita = { tabela, operacao: 'update', valores };
        escritas.push(escrita);
        eventos.push('update');
        return builder;
      }),
      then: (resolve: (valor: RetornoRpc) => unknown) => Promise.resolve(resultado()).then(resolve),
    };
    return builder;
  });
  const fetch = vi.fn(async () => {
    eventos.push('ia');
    return Response.json({ content: [{ text: '# Análise simulada' }] });
  });
  const env = vi.fn((nome: string) => ({
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_ANON_KEY: 'anon-simulada',
    SUPABASE_SERVICE_ROLE_KEY: 'service-simulada',
  }[nome]));
  const createClient = vi.fn((_url: string, chave: string) => {
    if (chave === 'anon-simulada') return { auth: { getUser } };
    if (chave === 'service-simulada') return { rpc, from };
    throw new Error('Cliente inesperado no teste');
  });
  let handler: (req: Request) => Promise<Response>;
  runInNewContext(codigo, {
    ...seguranca,
    serve: (callback: typeof handler) => { handler = callback; },
    createClient,
    Deno: { env: { get: env } },
    fetch,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { warn: vi.fn(), error: vi.fn() },
  });
  const chamar = (payload: unknown = GERAR, opcoesRequest: { authorization?: string | null; raw?: string; contentLength?: string; method?: string } = {}) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (opcoesRequest.authorization !== null) headers.set('Authorization', opcoesRequest.authorization ?? 'Bearer sessao-simulada');
    if (opcoesRequest.contentLength) headers.set('Content-Length', opcoesRequest.contentLength);
    const method = opcoesRequest.method ?? 'POST';
    return handler(new Request('https://edge.test/mimosa-analise', {
      method,
      headers,
      ...(method === 'POST' ? { body: opcoesRequest.raw ?? JSON.stringify(payload) } : {}),
    }));
  };
  return { chamar, eventos, escritas, filtros, getUser, rpc, from, fetch, env, createClient };
}

function semAcessoAosDadosOuIA(ctx: ReturnType<typeof cenario>) {
  expect(ctx.from).not.toHaveBeenCalled();
  expect(ctx.fetch).not.toHaveBeenCalled();
  expect(ctx.escritas).toEqual([]);
  expect(ctx.env.mock.calls.flat()).not.toContain('ANTHROPIC_API_KEY');
  expect(ctx.env.mock.calls.flat()).not.toContain('GOOGLE_API_KEY');
}

describe('mimosa-analise: proteção do handler real', () => {
  it.each([null, 'Basic credencial', 'Bearer ', 'Bearer duas palavras'])('recusa cabeçalho inválido %s antes de criar qualquer cliente', async (authorization) => {
    const ctx = cenario();
    const res = await ctx.chamar(GERAR, { authorization });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(ctx.createClient).not.toHaveBeenCalled();
    expect(ctx.rpc).not.toHaveBeenCalled();
    semAcessoAosDadosOuIA(ctx);
  });

  it.each([
    { nome: 'token rejeitado pelo Auth', erroAuth: { message: 'JWT inválido' } },
    { nome: 'sessão sem usuário', usuario: null },
    { nome: 'usuário sem identificação', usuario: { id: '' } },
    { nome: 'usuário anônimo do Supabase', usuario: { id: USUARIO_AUTH, is_anonymous: true } },
  ])('recusa $nome antes de configuração, chaves e autorização', async ({ nome: _nome, ...opcoes }) => {
    const ctx = cenario(opcoes);
    const res = await ctx.chamar();
    expect(res.status).toBe(401);
    expect(ctx.getUser).toHaveBeenCalledWith('sessao-simulada');
    expect(ctx.rpc).not.toHaveBeenCalled();
    expect(ctx.createClient).toHaveBeenCalledTimes(1);
    semAcessoAosDadosOuIA(ctx);
  });

  it.each([
    GERAR,
    { acao: 'aprovar', analise_id: ANALISE },
    { acao: 'vincular_agendamento', analise_id: ANALISE, agendamento_id: AGENDAMENTO },
  ])('nega recurso sem autorização na ação $acao', async (payload) => {
    const ctx = cenario({ autorizacao: { data: { permitido: false }, error: null } });
    const res = await ctx.chamar(payload);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    expect(ctx.rpc).toHaveBeenCalledWith('mimosa_autorizar_acao', expect.objectContaining({ p_usuario_id: USUARIO_AUTH, p_acao: payload.acao }));
    semAcessoAosDadosOuIA(ctx);
  });

  it('responde 429 com Retry-After antes de consultar chaves, contexto ou IA', async () => {
    const ctx = cenario({ cota: { data: { permitido: false, retry_after: 42 }, error: null } });
    const res = await ctx.chamar();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMIT' });
    expect(ctx.eventos).toEqual(['auth', 'mimosa_autorizar_acao', 'mimosa_consumir_cota']);
    semAcessoAosDadosOuIA(ctx);
  });

  it.each([
    { nome: 'autorização indisponível', opcoes: { autorizacao: { data: null, error: { message: 'detalhe SQL privado' } } }, codigo: 'ACCESS_UNAVAILABLE' },
    { nome: 'contador indisponível', opcoes: { cota: { data: null, error: { message: 'detalhe SQL privado' } } }, codigo: 'LIMIT_UNAVAILABLE' },
    { nome: 'retorno inválido do contador', opcoes: { cota: { data: { permitido: 'true' }, error: null } }, codigo: 'LIMIT_UNAVAILABLE' },
    { nome: 'contador sem retorno', opcoes: { cota: { data: null, error: null } }, codigo: 'LIMIT_UNAVAILABLE' },
  ])('bloqueia com 503 quando $nome', async ({ opcoes, codigo }) => {
    const ctx = cenario(opcoes);
    const res = await ctx.chamar();
    expect(res.status).toBe(503);
    const resposta = await res.json();
    expect(resposta.code).toBe(codigo);
    expect(JSON.stringify(resposta)).not.toContain('detalhe SQL privado');
    semAcessoAosDadosOuIA(ctx);
  });

  it.each([
    { nome: 'JSON malformado', raw: '{', payload: GERAR },
    { nome: 'UUID inválido', payload: { ...GERAR, lead_id: 'nao-e-uuid' } },
    { nome: 'lead ausente', payload: { acao: 'gerar' } },
    { nome: 'análise ausente', payload: { acao: 'aprovar' } },
    { nome: 'reunião ausente', payload: { acao: 'vincular_agendamento', analise_id: ANALISE } },
    { nome: 'ação desconhecida', payload: { acao: 'excluir', analise_id: ANALISE } },
    { nome: 'tipo desconhecido', payload: { ...GERAR, tipo: 'inventado' } },
    { nome: 'snapshot aninhado', payload: { ...GERAR, lead_snapshot: { nome: { valor: 'Pessoa' } } } },
    { nome: 'conteúdo com tipo incorreto', payload: { acao: 'aprovar', analise_id: ANALISE, conteudo_final: {} } },
  ])('recusa $nome antes das RPCs', async ({ payload, raw }) => {
    const ctx = cenario();
    const res = await ctx.chamar(payload, { raw });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect(ctx.rpc).not.toHaveBeenCalled();
    semAcessoAosDadosOuIA(ctx);
  });

  it.each([
    { nome: 'sem Content-Length', contentLength: undefined },
    { nome: 'Content-Length forjado abaixo do limite', contentLength: '10' },
    { nome: 'Content-Length acima do limite', contentLength: '50000' },
  ])('limita bytes reais do corpo: $nome', async ({ contentLength }) => {
    const ctx = cenario();
    const res = await ctx.chamar({ ...GERAR, dados: { texto: 'á'.repeat(17000) } }, { contentLength });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(ctx.rpc).not.toHaveBeenCalled();
    semAcessoAosDadosOuIA(ctx);
  });

  it('gera e atribui autoria somente ao usuário verificado, ignorando IDs forjados no payload', async () => {
    const ctx = cenario();
    const res = await ctx.chamar({ ...GERAR, agendamento_id: AGENDAMENTO, usuario_id: OUTRO_USUARIO, user_id: OUTRO_USUARIO, gerada_por: OUTRO_USUARIO, lead_snapshot: null, dados: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: ANALISE, conteudo_markdown: '# Análise simulada' });
    expect(ctx.rpc).toHaveBeenNthCalledWith(1, 'mimosa_autorizar_acao', {
      p_usuario_id: USUARIO_AUTH, p_acao: 'gerar', p_lead_id: LEAD, p_agendamento_id: AGENDAMENTO, p_analise_id: null,
    });
    expect(ctx.rpc).toHaveBeenNthCalledWith(2, 'mimosa_consumir_cota', { p_usuario_id: USUARIO_AUTH, p_acao: 'gerar' });
    expect(ctx.escritas).toEqual([expect.objectContaining({ tabela: 'mimosa_analises', operacao: 'insert', valores: expect.objectContaining({ lead_id: LEAD, agendamento_id: AGENDAMENTO, gerada_por: USUARIO_AUTH, input_snapshot: { lead_snapshot: {}, dados: {} } }) })]);
    expect(ctx.eventos.slice(0, 3)).toEqual(['auth', 'mimosa_autorizar_acao', 'mimosa_consumir_cota']);
    expect(ctx.eventos.indexOf('ia')).toBeGreaterThan(ctx.eventos.indexOf('mimosa_consumir_cota'));
    expect(ctx.eventos.indexOf('insert')).toBeGreaterThan(ctx.eventos.indexOf('ia'));
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it('salva aprovação autorizada depois de reservar cota, sem chamar IA', async () => {
    const ctx = cenario();
    const res = await ctx.chamar({ acao: 'aprovar', analise_id: ANALISE, agendamento_id: AGENDAMENTO, conteudo_final: '  Texto revisado  ', editado: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: ANALISE, status: 'editada', conteudo_markdown: 'Texto revisado' });
    expect(ctx.rpc).toHaveBeenNthCalledWith(1, 'mimosa_autorizar_acao', { p_usuario_id: USUARIO_AUTH, p_acao: 'aprovar', p_lead_id: null, p_agendamento_id: AGENDAMENTO, p_analise_id: ANALISE });
    expect(ctx.rpc).toHaveBeenNthCalledWith(2, 'mimosa_consumir_cota', { p_usuario_id: USUARIO_AUTH, p_acao: 'aprovar' });
    expect(ctx.escritas).toEqual([expect.objectContaining({ operacao: 'update', valores: expect.objectContaining({ status: 'editada', editada_pelo_usuario: true, agendamento_id: AGENDAMENTO }) })]);
    expect(ctx.filtros).toContainEqual({ tabela: 'mimosa_analises', campo: 'id', valor: ANALISE });
    expect(ctx.eventos.slice(0, 3)).toEqual(['auth', 'mimosa_autorizar_acao', 'mimosa_consumir_cota']);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('vincula reunião somente depois de validar análise, destino e cota', async () => {
    const ctx = cenario();
    const res = await ctx.chamar({ acao: 'vincular_agendamento', analise_id: ANALISE, agendamento_id: AGENDAMENTO });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ctx.rpc).toHaveBeenNthCalledWith(1, 'mimosa_autorizar_acao', { p_usuario_id: USUARIO_AUTH, p_acao: 'vincular_agendamento', p_lead_id: null, p_agendamento_id: AGENDAMENTO, p_analise_id: ANALISE });
    expect(ctx.rpc).toHaveBeenNthCalledWith(2, 'mimosa_consumir_cota', { p_usuario_id: USUARIO_AUTH, p_acao: 'vincular_agendamento' });
    expect(ctx.escritas).toEqual([{ tabela: 'mimosa_analises', operacao: 'update', valores: { agendamento_id: AGENDAMENTO } }]);
    expect(ctx.filtros).toContainEqual({ tabela: 'mimosa_analises', campo: 'id', valor: ANALISE });
    expect(ctx.eventos.slice(0, 3)).toEqual(['auth', 'mimosa_autorizar_acao', 'mimosa_consumir_cota']);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('responde ao preflight sem processar análise e rejeita métodos diferentes de POST', async () => {
    const ctx = cenario();
    const preflight = await ctx.chamar(undefined, { method: 'OPTIONS', authorization: null });
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    const get = await ctx.chamar(undefined, { method: 'GET', authorization: null });
    expect(get.status).toBe(405);
    expect(ctx.createClient).not.toHaveBeenCalled();
    semAcessoAosDadosOuIA(ctx);
  });
});
