import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const cliente = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.49.4', () => ({ createClient: () => cliente }));

type Integracao = {
  id: string; slug: string; secret: string; ativa: boolean;
  processador: string | null; config: Record<string, unknown>; regras_importacao?: Record<string, unknown>;
};
let atender: (req: Request) => Promise<Response>;
let integracao: Integracao;
let escutaAtiva: boolean;
let logs: Array<Record<string, unknown>>;
let rede: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (nome: string) => nome === 'SUPABASE_URL' ? 'https://supabase.invalid' : 'chave-sintetica' },
    serve: (handler: typeof atender) => { atender = handler; },
  });
  // Importa o entrypoint real e captura Deno.serve; nenhum servidor/rede é aberto.
  await import('./index.ts');
});

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  escutaAtiva = false;
  integracao = { id: 'integracao-1', slug: 'teste', secret: 'segredo-de-teste', ativa: true, processador: 'modulos_praticos', config: {} };
  rede = vi.fn(() => { throw new Error('O teste não permite rede externa/n8n.'); });
  vi.stubGlobal('fetch', rede);
  cliente.from.mockImplementation((tabela: string) => {
    if (tabela === 'crm_webhook_integrations' || tabela === 'crm_webhook_escutas') {
      const consulta = {
        select: () => consulta,
        eq: () => consulta,
        gt: () => consulta,
        maybeSingle: async () => ({
          data: tabela === 'crm_webhook_integrations' ? integracao : escutaAtiva ? { token: 'escuta-teste' } : null,
          error: null,
        }),
      };
      return consulta;
    }
    if (tabela === 'crm_webhook_logs') return { insert: async (linha: Record<string, unknown>) => {
      logs.push(linha);
      return { error: null };
    } };
    throw new Error(`Consulta fora do caminho autorizado pelo teste: ${tabela}`);
  });
  cliente.rpc.mockImplementation(async (nome: string) => {
    if (nome !== 'crm_modulos_praticos_catalogo') throw new Error(`RPC comercial indevida: ${nome}`);
    return { data: { ok: true, modulos: [{ codigo: 'modulo', nome: 'Módulo de teste', ano: null, funil_id: 'funil', etapa_id: 'etapa' }] }, error: null };
  });
});

afterAll(() => vi.unstubAllGlobals());

const requisicao = (body = JSON.stringify({ evento: 'catalogo' }), secret: string | null = 'segredo-de-teste', tipo = 'application/json') => new Request(
  'https://edge.invalid/crm-lead-webhook?int=teste',
  { method: 'POST', headers: { 'Content-Type': tipo, ...(secret === null ? {} : { 'X-Webhook-Secret': secret }) }, body },
);

describe('dispatch autenticado do webhook de módulos no entrypoint real', () => {
  it('ignora teste antes de validar telefone, sem RPC de gravação nem log de dados pessoais', async () => {
    integracao.regras_importacao = { ignorar_testes: true };
    const resposta = await atender(requisicao(JSON.stringify({
      evento: 'inscricao.retroativa', inscricao_id: 'externa-teste',
      contato: { nome: 'Inscrição de teste', telefone: '+5513712837128', email: 'teste@example.com' },
    })));
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ ok: false, erro: 'inscricao_ignorada', repetir: false });
    expect(cliente.rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).not.toContain('Inscrição de teste');
    expect(logs[0]).toMatchObject({ erro: 'inscricao_ignorada' });
    expect(rede).not.toHaveBeenCalled();
  });

  it('ignora identidade administrativa configurada e mantém o catálogo disponível', async () => {
    integracao.regras_importacao = { nomes: ['Pessoa Bloqueada'] };
    const resposta = await atender(requisicao(JSON.stringify({
      evento: 'inscricao.retroativa', contato: { nome: 'PESSOA-BLOQUEADA' },
    })));
    expect(resposta.status).toBe(422);
    expect(cliente.rpc).not.toHaveBeenCalled();
    const catalogo = await atender(requisicao());
    expect(catalogo.status).toBe(200);
  });

  it.each(['inscricao.criada', 'validar'])('cadastro novo e simulação seguem a RPC mesmo coincidindo com todas as exclusões (%s)', async (evento) => {
    integracao.regras_importacao = {
      ignorar_testes: true, nomes: ['Pessoa Teste'], emails: ['teste@example.com'],
      telefones: ['46999999999'], inscricoes_ids: ['externa-nova'],
    };
    const status = evento === 'validar' ? 'validado' : 'criado';
    cliente.rpc.mockResolvedValue({ data: { ok: true, status, inscricao_id: 'externa-nova' }, error: null });
    const resposta = await atender(requisicao(JSON.stringify({
      evento, inscricao_id: 'externa-nova', modulo_codigo: 'modulo', inscrito_em: '2026-09-09T17:00:00Z',
      contato: { nome: 'Pessoa Teste', email: 'teste@example.com', telefone: '46999999999' },
    })));
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ ok: true, status });
    expect(cliente.rpc).toHaveBeenCalledExactlyOnceWith('crm_modulos_praticos_receber', expect.objectContaining({ p_validar: evento === 'validar' }));
    expect(rede).not.toHaveBeenCalled();
  });

  it.each(['inscricao.criada', 'validar'])('telefone inválido com e-mail válido chega normalizado à RPC sem ampliar exclusões para %s', async evento => {
    integracao.regras_importacao = {
      ignorar_testes: true, nomes: ['Pessoa Teste'], emails: ['pessoa@example.com'],
      telefones: ['+5513712837128'], inscricoes_ids: ['externa-telefone'],
    };
    const status = evento === 'validar' ? 'validado' : 'criado';
    cliente.rpc.mockResolvedValue({ data: { ok: true, status, inscricao_id: 'externa-telefone', telefone_invalido: true }, error: null });
    const resposta = await atender(requisicao(JSON.stringify({
      evento, inscricao_id: 'externa-telefone', modulo_codigo: 'modulo', inscrito_em: '2026-09-09T17:00:00Z',
      contato: { nome: 'Pessoa Teste', email: 'Pessoa@Example.com', telefone: ' +5513712837128 ' },
    })));
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ ok: true, status, telefone_invalido: true });
    expect(cliente.rpc).toHaveBeenCalledExactlyOnceWith('crm_modulos_praticos_receber', {
      p_integracao_id: 'integracao-1', p_validar: evento === 'validar',
      p_payload: {
        evento, inscricao_id: 'externa-telefone', modulo_codigo: 'modulo', inscrito_em: '2026-09-09T17:00:00Z',
        contato: { nome: 'Pessoa Teste', email: 'pessoa@example.com', telefone_original: '+5513712837128' },
      },
    });
    expect(JSON.stringify(logs)).not.toContain('+5513712837128');
    expect(JSON.stringify(logs)).not.toContain('pessoa@example.com');
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(['crm_webhook_integrations', 'crm_webhook_logs']);
    expect(rede).not.toHaveBeenCalled();
  });

  it('campo interno telefone_original enviado por HTTP é recusado antes da RPC', async () => {
    const resposta = await atender(requisicao(JSON.stringify({
      evento: 'inscricao.criada', inscricao_id: 'externa-telefone', modulo_codigo: 'modulo', inscrito_em: '2026-09-09T17:00:00Z',
      contato: { nome: 'Contato', email: 'contato@example.com', telefone_original: '+5513712837128' },
    })));
    expect(resposta.status).toBe(400);
    expect(await resposta.json()).toMatchObject({ ok: false, erro: 'campo_nao_permitido', repetir: false });
    expect(cliente.rpc).not.toHaveBeenCalled();
    expect(rede).not.toHaveBeenCalled();
  });

  it.each([
    ['modulos_praticos', null], ['modulos_praticos', 'secret-incorreto'],
    ['padrao', null], ['padrao', 'secret-incorreto'],
  ])('exige autenticação no processador %s antes de catálogo/RPC (%s)', async (processador, secret) => {
    integracao.processador = processador;
    const resposta = await atender(requisicao(undefined, secret));
    expect(resposta.status).toBe(401);
    expect(await resposta.json()).toEqual({ error: 'invalid_secret' });
    expect(cliente.rpc).not.toHaveBeenCalled();
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(['crm_webhook_integrations', 'crm_webhook_logs']);
    expect(rede).not.toHaveBeenCalled();
  });

  it('integração desativada não chama processador dedicado mesmo com secret válido', async () => {
    integracao.ativa = false;
    const resposta = await atender(requisicao());
    expect(resposta.status).toBe(403);
    expect(await resposta.json()).toEqual({ error: 'integration_inactive' });
    expect(cliente.rpc).not.toHaveBeenCalled();
    expect(rede).not.toHaveBeenCalled();
  });

  it('catálogo dedicado usa só RPC de catálogo e não toca leads, escuta, logs de inscrição ou n8n', async () => {
    escutaAtiva = true;
    const resposta = await atender(requisicao());
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ ok: true, status: 'catalogo', modulos: [{ codigo: 'modulo' }] });
    expect(cliente.rpc).toHaveBeenCalledExactlyOnceWith('crm_modulos_praticos_catalogo', { p_integracao_id: 'integracao-1' });
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(['crm_webhook_integrations']);
    expect(logs).toHaveLength(0);
    expect(rede).not.toHaveBeenCalled();
  });

  it('processador dedicado rejeita form-urlencoded antes de qualquer RPC ou fluxo comercial', async () => {
    const resposta = await atender(requisicao('evento=catalogo', undefined, 'application/x-www-form-urlencoded'));
    expect(resposta.status).toBe(415);
    expect(await resposta.json()).toMatchObject({ ok: false, erro: 'content_type_invalido' });
    expect(cliente.rpc).not.toHaveBeenCalled();
    expect(rede).not.toHaveBeenCalled();
  });

  it('inscrição dedicada passa só pela RPC e log sanitizado, sem criação comercial direta ou n8n', async () => {
    cliente.rpc.mockResolvedValue({ data: { ok: true, status: 'criado', inscricao_id: 'externa-1', lead_id: 'lead-1', oportunidade_id: 'card-1', lead_criado: true, op_criada: true }, error: null });
    const resposta = await atender(requisicao(JSON.stringify({
      evento: 'inscricao.criada', inscricao_id: 'externa-1', modulo_codigo: 'modulo',
      inscrito_em: '2026-09-09T09:00:00-03:00', contato: { nome: 'Pessoa Teste', email: 'pessoa@example.com' },
    })));
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ ok: true, status: 'criado', inscricao_id: 'externa-1' });
    expect(cliente.rpc).toHaveBeenCalledExactlyOnceWith('crm_modulos_praticos_receber', expect.objectContaining({ p_integracao_id: 'integracao-1', p_validar: false }));
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(['crm_webhook_integrations', 'crm_webhook_logs']);
    expect(logs[0]).toMatchObject({ status: 'ok', resultado: { lead_criado: true, op_criada: true } });
    expect(logs[0]).not.toHaveProperty('payload');
    expect(JSON.stringify(logs)).not.toContain('pessoa@example.com');
    expect(JSON.stringify(logs)).not.toContain('Pessoa Teste');
    expect(rede).not.toHaveBeenCalled();
  });

  it('processador padrão conserva invalid_body e não interpreta evento do novo contrato', async () => {
    integracao.processador = null;
    const resposta = await atender(requisicao('[]'));
    expect(resposta.status).toBe(400);
    expect(await resposta.json()).toEqual({ error: 'invalid_body' });
    expect(cliente.rpc).not.toHaveBeenCalled();
    expect(rede).not.toHaveBeenCalled();
  });

  it('config editável não ativa modo dedicado; padrão mantém escuta e form-urlencoded', async () => {
    integracao.processador = null;
    integracao.config = { processador: 'modulos_praticos' };
    escutaAtiva = true;
    const resposta = await atender(requisicao('evento=catalogo&nome=Teste', undefined, 'application/x-www-form-urlencoded'));
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ ok: true, modo: 'mapeamento', processado: false });
    expect(cliente.rpc).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ status: 'escuta', payload: { evento: 'catalogo', nome: 'Teste' } });
    expect(cliente.from.mock.calls.map(([tabela]) => tabela)).toEqual(['crm_webhook_integrations', 'crm_webhook_escutas', 'crm_webhook_logs']);
    expect(rede).not.toHaveBeenCalled();
  });
});
