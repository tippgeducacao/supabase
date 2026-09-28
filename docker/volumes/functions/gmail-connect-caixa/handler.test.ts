import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { criarHandlerConectarCaixa } from './handler';

const ATOR = '11111111-1111-4111-8111-111111111111';
const DONO = '22222222-2222-4222-8222-222222222222';
const PASTA = '33333333-3333-4333-8333-333333333333';
const PEDIDO = { account_email: ' Pessoa@Example.invalid ', nome_exibicao: ' Pessoa ' };
const GMAIL = { id: 'integracao', scopes: 'openid https://www.googleapis.com/auth/gmail.modify', oauth_refresh_token: 'simulado', scope: 'personal', owner_user_id: ATOR };
type Perfil = { ativo: boolean; departamento_id: string | null };
type Caixa = { id: string; created_by: string; ativo: boolean; privado: boolean; pasta_id: string | null };
type Opcoes = {
  cargo?: string; autenticado?: boolean; ator?: Perfil | null; dono?: Perfil | null;
  pasta?: { id: string; departamento_id: string } | null; pastaVisivel?: boolean;
  existente?: Caixa; integracoes?: Record<string, unknown>[]; falhaTabela?: string;
  concorrencia?: boolean;
};

function ambiente(opcoes: Opcoes = {}) {
  const consultas: string[] = [];
  const escritas: { tabela: string; operacao: string; dados: Record<string, unknown>; filtros: Record<string, unknown> }[] = [];
  const autenticar = vi.fn().mockResolvedValue(opcoes.autenticado === false ? null : { id: ATOR });
  const iniciarSync = vi.fn();
  const rpc = vi.fn().mockResolvedValue({ data: opcoes.pastaVisivel !== false, error: null });
  const admin = {
    rpc,
    from(tabela: string) {
      consultas.push(tabela);
      const filtros: Record<string, unknown> = {};
      let operacao = 'leitura';
      let dados: Record<string, unknown> = {};
      const resolver = () => {
        const error = opcoes.falhaTabela === tabela ? { message: 'falha simulada' } : null;
        if (operacao !== 'leitura') {
          escritas.push({ tabela, operacao, dados, filtros });
          return { data: opcoes.concorrencia && operacao === 'update' ? null : { id: 'caixa', ...dados }, error };
        }
        const resultados: Record<string, unknown> = {
          user_roles: [{ role: opcoes.cargo ?? 'vendedor' }],
          profiles: filtros.id === ATOR
            ? ('ator' in opcoes ? opcoes.ator : { ativo: true, departamento_id: 'comercial' })
            : ('dono' in opcoes ? opcoes.dono : { ativo: true, departamento_id: 'comercial' }),
          email_caixa_pastas: 'pasta' in opcoes ? opcoes.pasta : { id: PASTA, departamento_id: 'comercial' },
          email_caixas_conectadas: opcoes.existente ?? null,
          calendar_integrations: opcoes.integracoes ?? [GMAIL],
        };
        return { data: resultados[tabela], error };
      };
      const q = {
        select: () => q,
        eq: (campo: string, valor: unknown) => { filtros[campo] = valor; return q; },
        order: () => q,
        insert: (valor: Record<string, unknown>) => { operacao = 'insert'; dados = valor; return q; },
        update: (valor: Record<string, unknown>) => { operacao = 'update'; dados = valor; return q; },
        maybeSingle: async () => resolver(),
        single: async () => resolver(),
        then: (resolve: (valor: unknown) => unknown) => Promise.resolve(resolver()).then(resolve),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  const handler = criarHandlerConectarCaixa({ admin, autenticar, iniciarSync });
  const chamar = (corpo: unknown = PEDIDO, auth = true, method = 'POST') => handler(new Request('https://local.invalid', {
    method, headers: { ...(auth ? { Authorization: 'autorizacao-simulada' } : {}), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(corpo) } : {}),
  }));
  return { chamar, consultas, escritas, iniciarSync, autenticar, rpc };
}

const caixa = (mudanca: Partial<Caixa> = {}): Caixa => ({ id: 'caixa', created_by: DONO, ativo: false, privado: false, pasta_id: null, ...mudanca });
async function negar(a: ReturnType<typeof ambiente>, pedido: unknown, mensagem: string) {
  expect(await (await a.chamar(pedido)).json()).toMatchObject({ success: false, error: expect.stringContaining(mensagem) });
  expect(a.escritas).toEqual([]);
  expect(a.iniciarSync).not.toHaveBeenCalled();
}

describe('cadastro de caixa Gmail por responsável e equipe', () => {
  it('OPTIONS e métodos indevidos não acessam o banco', async () => {
    const a = ambiente();
    expect((await a.chamar(undefined, false, 'OPTIONS')).status).toBe(200);
    expect((await a.chamar(undefined, false, 'GET')).status).toBe(405);
    expect(a.autenticar).not.toHaveBeenCalled(); expect(a.consultas).toEqual([]);
  });
  it('sem sessão validada não consulta dados', async () => {
    const a = ambiente({ autenticado: false });
    expect(await (await a.chamar(PEDIDO, false)).json()).toMatchObject({ success: false, error: 'not_authenticated' });
    await negar(a, PEDIDO, 'not_authenticated'); expect(a.consultas).toEqual([]);
  });
  it('preserva o cadastro pessoal legado sem pasta', async () => {
    const a = ambiente(); expect(await (await a.chamar()).json()).toMatchObject({ success: true });
    expect(a.escritas).toHaveLength(1);
    expect(a.escritas[0].dados).toMatchObject({ created_by: ATOR, email_caixa: 'pessoa@example.invalid', nome_exibicao: 'Pessoa', pasta_id: null, privado: false });
    expect(a.iniciarSync).toHaveBeenCalledOnce();
  });
  it.each(['admin', 'diretor'])('%s cadastra usuário ativo da equipe sem tomar a propriedade', async cargo => {
    const a = ambiente({ cargo });
    expect(await (await a.chamar({ ...PEDIDO, responsavel_user_id: DONO, pasta_id: PASTA, departamento_id: 'setor-legado' })).json()).toMatchObject({ success: true });
    expect(a.escritas[0].dados).toMatchObject({ created_by: DONO, pasta_id: PASTA, departamento_id: null });
  });
  it.each(['vendedor', 'sdr', 'secretaria', 'supervisor'])('%s não pode atribuir caixa a terceiro', async cargo => {
    const a = ambiente({ cargo }); await negar(a, { ...PEDIDO, responsavel_user_id: DONO, pasta_id: PASTA }, 'Somente admin ou diretor');
  });
  it('usuário conecta sua caixa pessoal na pasta visível de sua equipe', async () => {
    const a = ambiente(); expect(await (await a.chamar({ ...PEDIDO, responsavel_user_id: ATOR, pasta_id: PASTA })).json()).toMatchObject({ success: true });
    expect(a.rpc).toHaveBeenCalledWith('email_pasta_visible', { _pasta_id: PASTA, _user_id: ATOR });
  });
  it('pasta invisível não vira compartilhamento por acesso ao service_role', async () => {
    await negar(ambiente({ pastaVisivel: false }), { ...PEDIDO, pasta_id: PASTA }, 'não tem acesso');
  });
  it('gestão não coloca responsável de outra equipe na pasta', async () => {
    await negar(ambiente({ cargo: 'admin', dono: { ativo: true, departamento_id: 'b2b' } }), { ...PEDIDO, responsavel_user_id: DONO, pasta_id: PASTA }, 'mesma equipe');
  });
  it.each([null, { ativo: false, departamento_id: 'comercial' }])('responsável ausente ou inativo não recebe caixa: %j', async dono => {
    await negar(ambiente({ cargo: 'admin', dono }), { ...PEDIDO, responsavel_user_id: DONO }, 'usuário ativo');
  });
  it('solicitante inativo não usa a permissão antiga de gestão', async () => {
    await negar(ambiente({ cargo: 'admin', ator: { ativo: false, departamento_id: 'comercial' } }), PEDIDO, 'usuários ativos');
  });
  it('recusa pasta inexistente, privacidade e cargos que abririam a equipe', async () => {
    await negar(ambiente({ pasta: null }), { ...PEDIDO, pasta_id: PASTA }, 'não encontrada');
    await negar(ambiente(), { ...PEDIDO, pasta_id: PASTA, privado: true }, 'caixa privada');
    await negar(ambiente(), { ...PEDIDO, pasta_id: PASTA, extra_roles: ['vendedor'] }, 'permissões extras');
  });
  it.each([{ pasta_id: '' }, { pasta_id: 42 }, { responsavel_user_id: 'outra-pessoa' }, { privado: 'false' }, { extra_roles: 'admin' }])('recusa contrato inválido %j', async mudanca => {
    const a = ambiente(); expect(await (await a.chamar({ ...PEDIDO, ...mudanca })).json()).toMatchObject({ success: false });
    expect(a.escritas).toEqual([]); expect(a.iniciarSync).not.toHaveBeenCalled();
  });
  it('uma caixa ativa não é alterada pelo administrador', async () => {
    await negar(ambiente({ cargo: 'admin', existente: caixa({ ativo: true }) }), { ...PEDIDO, responsavel_user_id: DONO, pasta_id: PASTA }, 'já está conectada');
  });
  it.each(['admin', 'diretor'])('%s não reativa nem torna pública caixa privada alheia', async cargo => {
    await negar(ambiente({ cargo, existente: caixa({ privado: true }) }), { ...PEDIDO, privado: false }, 'Somente o proprietário');
  });
  it('usuário comum não reativa caixa compartilhada alheia', async () => {
    await negar(ambiente({ existente: caixa() }), PEDIDO, 'outra pessoa');
  });
  it('responsável explícito não transfere propriedade na reconexão', async () => {
    await negar(ambiente({ cargo: 'admin', existente: caixa() }), { ...PEDIDO, responsavel_user_id: ATOR }, 'responsável original');
  });
  it('admin reativa compartilhada com o dono preservado e pasta validada', async () => {
    const a = ambiente({ cargo: 'admin', existente: caixa() });
    expect(await (await a.chamar({ ...PEDIDO, pasta_id: PASTA })).json()).toMatchObject({ success: true });
    expect(a.escritas[0].dados).toMatchObject({ ativo: true, pasta_id: PASTA });
    expect(a.escritas[0].dados).not.toHaveProperty('created_by');
    expect(a.escritas[0].filtros).toMatchObject({ ativo: false, created_by: DONO, privado: false });
  });
  it('admin não privatiza compartilhada de terceiro na reconexão', async () => {
    await negar(ambiente({ cargo: 'admin', existente: caixa() }), { ...PEDIDO, privado: true }, 'alterar a privacidade');
  });
  it('o próprio dono pode reconectar sua caixa privada sem pasta', async () => {
    const a = ambiente({ existente: caixa({ created_by: ATOR, privado: true }) });
    expect(await (await a.chamar()).json()).toMatchObject({ success: true });
    expect(a.escritas[0].dados).not.toHaveProperty('privado');
  });
  it('reativação conserva a pasta quando o campo é omitido e valida os cargos', async () => {
    const opcoes = { existente: caixa({ created_by: ATOR, pasta_id: PASTA }) };
    const a = ambiente(opcoes); expect(await (await a.chamar()).json()).toMatchObject({ success: true });
    expect(a.escritas[0].dados.pasta_id).toBe(PASTA);
    await negar(ambiente(opcoes), { ...PEDIDO, extra_roles: ['sdr'] }, 'permissões extras');
  });
  it('alteração concorrente não é confirmada nem dispara sincronização', async () => {
    const a = ambiente({ existente: caixa({ created_by: ATOR }), concorrencia: true });
    expect(await (await a.chamar()).json()).toMatchObject({ success: false, error: expect.stringContaining('alterada durante') });
    expect(a.iniciarSync).not.toHaveBeenCalled();
  });
  it.each([
    { integracoes: [], erro: 'Conta não autorizada' },
    { integracoes: [{ ...GMAIL, oauth_refresh_token: null }], erro: 'sem refresh token' },
    { integracoes: [{ ...GMAIL, scopes: 'openid https://www.googleapis.com/auth/calendar' }], erro: 'sem permissão de Gmail' },
    { integracoes: [{ ...GMAIL, scope: 'global' }], erro: 'autorizada por você' },
    { integracoes: [{ ...GMAIL, owner_user_id: DONO }], erro: 'autorizada por você' },
  ])('pasta não substitui a autorização Google: $erro', async ({ integracoes, erro }) => {
    await negar(ambiente({ integracoes }), { ...PEDIDO, pasta_id: PASTA }, erro);
  });
  it('seleciona integração autorizada com escopo Gmail e refresh antes da só calendário', async () => {
    const a = ambiente({ integracoes: [{ ...GMAIL, id: 'calendar', scopes: 'calendar' }, GMAIL] });
    expect(await (await a.chamar()).json()).toMatchObject({ success: true });
    expect(a.escritas[0].dados.calendar_integration_id).toBe(GMAIL.id);
  });
  it('gestão ainda pode usar integração global já autorizada', async () => {
    const a = ambiente({ cargo: 'diretor', integracoes: [{ ...GMAIL, scope: 'global', owner_user_id: null }] });
    expect(await (await a.chamar({ ...PEDIDO, responsavel_user_id: DONO, pasta_id: PASTA })).json()).toMatchObject({ success: true });
  });
  it.each(['user_roles', 'profiles', 'email_caixas_conectadas', 'calendar_integrations'])('falha ao consultar %s não permite gravação', async falhaTabela => {
    const a = ambiente({ falhaTabela }); expect(await (await a.chamar()).json()).toMatchObject({ success: false });
    expect(a.escritas).toEqual([]); expect(a.iniciarSync).not.toHaveBeenCalled();
  });
});
