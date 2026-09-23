import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => {
  (globalThis as any).Deno = { env: { get: () => '' } };
  return { buscar: vi.fn(), atualizar: vi.fn(), historico: vi.fn(), gravar: vi.fn(), gerar: vi.fn(), enviar: vi.fn(),
    estado: vi.fn(), provedor: vi.fn(), config: vi.fn(), registrar: vi.fn(), criarTel: vi.fn() };
});
vi.mock('./historico.ts', () => ({ buscarLead: m.buscar, atualizarLead: m.atualizar, carregarHistorico: m.historico,
  gravarMensagem: m.gravar, MARCADOR_FOLLOWUP: '[MARCADOR_TESTE]' }));
vi.mock('./followup.ts', () => ({ gerarFollowup: m.gerar }));
vi.mock('./saida.ts', () => ({ enviarResposta: m.enviar }));
vi.mock('./envioVoz.ts', () => ({ configurarVoz: m.config, conferirEstadoVoz: m.estado }));
vi.mock('./pilotoOpenai.ts', () => ({ selecionarProvedorDoLead: m.provedor }));
vi.mock('./contextoAulaPiloto.ts', () => ({ carregarAulaParaFollowup: vi.fn(), contextoAulaPiloto: vi.fn(), INSTRUCAO_AULA_PILOTO: '' }));
vi.mock('./envioMateriais.ts', () => ({ carregarStatusMateriais: vi.fn(async () => '') }));
vi.mock('./conta.ts', () => ({ contaDoLead: vi.fn(async () => 'conta-piloto') }));
vi.mock('./eventos.ts', () => ({ criarTelemetria: m.criarTel }));
vi.mock('./fichaAtendimento.ts', () => ({ registrarNaJornada: m.registrar }));
import { executarTesteFollowup, validarPedidoTesteFollowup } from './testeFollowup';

const pedido = { telefone: '46988166051', teste_id: '00000000-0000-4000-8000-000000000001' };
let lead: any;
let anterior: unknown[];
const insert = vi.fn(async () => ({ error: null }));
const banco = { rpc: vi.fn(async () => ({ data: true, error: null })), from: vi.fn(() => {
  const q: any = { select: () => q, eq: () => q, delete: () => q, limit: async () => ({ data: anterior }),
    insert, then: (ok: any) => Promise.resolve({ error: null }).then(ok) };
  return q;
}) };
beforeEach(() => {
  vi.clearAllMocks();
  anterior = [];
  lead = { followup_ativado: false, iniciar_atendimento: true, timestamp_mensagem: '2026-09-23T12:00:00Z', jornada: {} };
  m.buscar.mockImplementation(async () => lead);
  m.atualizar.mockImplementation(async (_s, _r, patch) => { lead = { ...lead, ...patch }; });
  m.historico.mockResolvedValue([]);
  m.provedor.mockResolvedValue({ nome: 'openai' });
  m.config.mockReturnValue({});
  m.estado.mockResolvedValue({ permitido: true });
  m.criarTel.mockImplementation(() => ({ rodadaId: crypto.randomUUID(), registrar: vi.fn() }));
  m.gerar.mockImplementation(async () => ({ provedorResposta: 'openai', message: 'qual assunto quer conhecer?', final_answer: 'teste' }));
  m.enviar.mockResolvedValue({ aceitos: 1, canal: 'texto', estado: 'aceito' });
});
describe('sequência real de teste restrita ao dono do piloto', () => {
  it('normaliza apenas variantes do telefone autorizado', () => {
    expect(validarPedidoTesteFollowup(pedido).telefone).toBe('5546988166051');
    expect(() => validarPedidoTesteFollowup({ ...pedido, telefone: '5547988166051' })).toThrow('fora_do_telefone');
    expect(() => validarPedidoTesteFollowup({ ...pedido, quantidade: 100 })).toThrow('pedido_invalido');
    expect(() => validarPedidoTesteFollowup({ ...pedido, teste_id: '' })).toThrow('teste_id_invalido');
  });
  it('recusa outro destino antes de qualquer acesso ao banco', async () => {
    await expect(executarTesteFollowup(banco, { ...pedido, telefone: '5511999990001' })).rejects.toThrow();
    expect(banco.rpc).not.toHaveBeenCalled();
    expect(m.enviar).not.toHaveBeenCalled();
  });
  it('envia no máximo sete passos ao mesmo destino e restaura automático desligado', async () => {
    const r = await executarTesteFollowup(banco, pedido);
    expect(r.resultados).toHaveLength(7);
    expect(m.enviar).toHaveBeenCalledTimes(7);
    for (const [ctx, , , , , voz] of m.enviar.mock.calls) {
      expect(ctx.telefone).toBe('5546988166051');
      expect(ctx.waAccountId).toBe('conta-piloto');
      expect(voz.origem).toBe('followup');
      expect(voz.provedorResposta).toBe('openai');
    }
    expect(lead.followup_ativado).toBe(false);
  });
  it('nonce já registrado não repete envios', async () => {
    anterior = [{ id: 1 }];
    expect((await executarTesteFollowup(banco, pedido)).ja_executado).toBe(true);
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.atualizar).not.toHaveBeenCalled();
  });
  it('transporte incerto encerra a sequência sem retry e desliga o automático', async () => {
    m.enviar.mockResolvedValueOnce({ aceitos: 0, canal: 'audio', estado: 'desconhecido' });
    expect((await executarTesteFollowup(banco, pedido)).resultados).toHaveLength(1);
    expect(m.enviar).toHaveBeenCalledOnce();
    expect(lead.followup_ativado).toBe(false);
  });
  it('fallback de conteúdo para Anthropic não é enviado no teste OpenAI', async () => {
    m.gerar.mockResolvedValueOnce({ provedorResposta: 'anthropic', message: 'teste' });
    await expect(executarTesteFollowup(banco, pedido)).rejects.toThrow('geracao_fora_do_openai');
    expect(m.enviar).not.toHaveBeenCalled();
    expect(lead.followup_ativado).toBe(false);
  });
  it('nova entrada durante a geração cancela o envio', async () => {
    m.gerar.mockImplementationOnce(async () => {
      lead.timestamp_mensagem = '2026-09-23T12:01:00Z';
      return { provedorResposta: 'openai', message: 'teste' };
    });
    // Preserva a fotografia que uma consulta real ao banco devolve.
    m.buscar.mockImplementation(async () => structuredClone(lead));
    await executarTesteFollowup(banco, pedido);
    expect(m.enviar).not.toHaveBeenCalled();
    expect(lead.followup_ativado).toBe(false);
  });
});
