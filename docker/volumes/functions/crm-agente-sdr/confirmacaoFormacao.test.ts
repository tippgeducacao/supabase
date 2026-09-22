import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { avaliarFicha, montarBlocoFicha, type Jornada } from './fichaAtendimento';
import type { CtxConversa } from './tools';

const mocks = vi.hoisted(() => ({ modelo: vi.fn(), ficha: vi.fn() }));
vi.mock('./agente.ts', () => ({ chamarAnthropic: mocks.modelo }));
vi.mock('./fichaAtendimento.ts', async (original) => ({
  ...await original<typeof import('./fichaAtendimento')>(), carregarFicha: mocks.ficha,
}));
let executar: typeof import('./tools').executarTool;
const contexto = (): CtxConversa => ({ telefone: '5511999990001', remotejid: '5511999990001@s.whatsapp.net',
  waAccountId: null, leadId: null, oportunidadeId: null, ficha: { inicioRodada: '2026-09-22T18:11:00Z' } });
const pedido = (id: string) => ({ id, name: 'verificar_compatibilidade_curso', input: {
  formacao_academica: 'Medicina Veterinária', curso_interesse: 'Sanidade Avícola', contexto_qualificacao: 'normal',
  conclusao_graduacao_bruta: 'Médico Veterinário (a)',
} });
function carregar(coleta: Jornada['coleta'] = { area_atuacao: 'formulação de dietas', atua_na_area: 'sim' }) {
  const entrada = { cadastro: 'Médico Veterinário (a)', jornada: { coleta } };
  const avaliacao = avaliarFicha(entrada);
  mocks.ficha.mockResolvedValue({ entrada, avaliacao, texto: montarBlocoFicha(entrada, avaliacao) });
}
function banco() {
  return {
    rpc: vi.fn(async (nome: string, p: Record<string, unknown>) => {
      if (nome === 'crm_agente_elegibilidade_iniciar') return { data: { success: true,
        avaliacao_id: '10000000-0000-4000-8000-000000000001', curso_id: '20000000-0000-4000-8000-000000000001' }, error: null };
      if (nome === 'crm_agente_elegibilidade_finalizar') return { data: { success: true, decisao: p.p_decisao }, error: null };
      throw new Error(`RPC inesperada: ${nome}`);
    }),
    from: vi.fn((tabela: string) => {
      if (tabela !== 'cursos_pos_graduacao') throw new Error(`Tabela inesperada: ${tabela}`);
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [{ pos_graduacao: 'Sanidade Avícola',
        pode_fazer: 'Medicina Veterinária', parcialmente_aceitas: '', status: 'ativo' }], error: null }) }) }) };
    }),
  };
}
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => undefined } });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa não permitida neste teste'); }));
  ({ executarTool: executar } = await import('./tools'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => { vi.resetAllMocks(); carregar(); });

describe('confirmação antes da matriz no piloto', () => {
  it('cadastro nomeado e atuação genérica devolvem pergunta direta, sem avaliar nem salvar aprovação', async () => {
    const b = banco(); const ctx = contexto();
    const r = await executar(b, pedido('confirmar'), ctx);
    expect(r).toMatchObject({ output: 'CONFIRMAR_CONCLUSAO', pergunta: 'vc já é formado em Medicina Veterinária?', compativel: null });
    expect(ctx.perguntaFormacaoPendente).toBe('vc já é formado em Medicina Veterinária?');
    expect(b.rpc).not.toHaveBeenCalled();
    expect(mocks.modelo).not.toHaveBeenCalled();
  });

  it('conclusão registrada permite a matriz Anthropic e mantém a validação da aprovação', async () => {
    carregar({ graduacao_concluida: 'sim' });
    mocks.modelo.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({
      formacao_identificada: 'Medicina Veterinária', e_medico_veterinario: true,
      curso_solicitado: 'Sanidade Avícola', pode_cursar: true, compativel: true,
      curso_exclusivo_veterinario: true, curso_alternativo_recomendado: false,
      curso_alternativo: null, mensagem_para_lead: 'Formação compatível.', output: 'APROVADO',
    }) }] });
    const b = banco(); const ctx = contexto();
    expect(await executar(b, pedido('avaliar'), ctx)).toMatchObject({ output: 'APROVADO', elegibilidade_status: 'aprovado' });
    expect(mocks.modelo).toHaveBeenCalledOnce();
    expect(ctx.perguntaFormacaoPendente).toBeUndefined();
    expect(b.rpc).toHaveBeenCalledWith('crm_agente_elegibilidade_finalizar', expect.objectContaining({ p_decisao: 'aprovado' }));
  });

  it('falta de saldo faz uma tentativa por rodada; próxima entrada pode tentar de novo', async () => {
    carregar({ graduacao_concluida: 'sim' });
    mocks.modelo.mockRejectedValue(new Error('Anthropic: saldo insuficiente no teste'));
    const b = banco(); const ctx = contexto();
    const primeira = await executar(b, pedido('primeira'), ctx);
    const repetida = await executar(b, pedido('repetida'), ctx);
    expect(primeira.output).toBe('FALHA_TECNICA');
    expect(repetida).toMatchObject({ id: 'repetida', output: 'FALHA_TECNICA', reutilizado_nesta_rodada: true });
    expect(ctx.compatibilidadeIndisponivel).toBe(true);
    expect(mocks.modelo).toHaveBeenCalledOnce();
    expect(b.rpc.mock.calls.filter(([nome]) => nome === 'crm_agente_elegibilidade_iniciar')).toHaveLength(1);
    await executar(b, pedido('nova-entrada'), contexto());
    expect(mocks.modelo).toHaveBeenCalledTimes(2);
  });

  it('guardas adicionais não alteram a checagem fora do piloto', async () => {
    const ctx = contexto(); delete ctx.ficha;
    mocks.modelo.mockRejectedValue(new Error('Indisponível no teste'));
    const r = await executar(banco(), pedido('legado'), ctx);
    expect(r.output).toBe('FALHA_TECNICA');
    expect(mocks.ficha).not.toHaveBeenCalled();
    expect(mocks.modelo).toHaveBeenCalledOnce();
    expect(ctx.compatibilidadeIndisponivel).toBeUndefined();
  });
});
