import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  lead: {} as Record<string, unknown>, buffer: false, erroBuffer: false, ativo: true, reserva: true, ok: true,
  gerar: vi.fn(), enviar: vi.fn(), gravar: vi.fn(), atualizar: vi.fn(), registrar: vi.fn(), reservar: vi.fn(),
}));
vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn(), MODELO_AGENTE: 'teste' }));
vi.mock('./historico.ts', async original => ({
  ...await original<typeof import('./historico')>(),
  buscarLead: async () => ({ ...f.lead }), carregarHistorico: async () => [{ role: 'user', content: 'oi' }],
  atualizarLead: f.atualizar, gravarMensagem: f.gravar,
}));
vi.mock('./spinFollowup.ts', () => ({ gerarFollowupSpin: f.gerar, reservarAbordagemSpin: f.reservar }));
vi.mock('./conta.ts', () => ({ contaDoLead: async () => 'conta-teste' }));
vi.mock('./envioMateriais.ts', () => ({ carregarStatusMateriais: async () => '' }));
vi.mock('./saida.ts', () => ({ enviarResposta: f.enviar }));
vi.mock('./eventos.ts', () => ({ criarTelemetria: () => ({ rodadaId: 'teste', registrar: f.registrar }), resumir: (v: unknown) => v }));
import { processarFollowupLead, selecionarCandidatos } from './followup';

function banco() {
  const alteracoes: unknown[] = [];
  return {
    alteracoes, rpc: vi.fn(async () => ({ data: true, error: null })),
    from(tabela: string) {
      const q = {
        select: () => q, eq: () => q, delete: () => q,
        update: (dados: unknown) => { alteracoes.push(dados); return q; },
        limit: async () => ({ data: f.buffer ? [{ id: 1 }] : [], error: f.erroBuffer ? { message: 'indisponível' } : null }),
        maybeSingle: async () => ({ data: { ativo: f.ativo }, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      if (!['crm_agente_sdr_buffer', 'crm_agente_sdr_lock', 'crm_sdr_spin_config', 'crm_sdr_spin_memoria'].includes(tabela))
        throw new Error('Tabela inesperada: ' + tabela);
      return q;
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks(); f.buffer = false; f.erroBuffer = false; f.ativo = true; f.reserva = true; f.ok = true;
  f.lead = { remotejid: '5511999990001@s.whatsapp.net', iniciar_atendimento: true,
    followup_ativado: true, pausa_ia: false, timestamp_mensagem: new Date(Date.now() - 20 * 60000).toISOString() };
  f.gerar.mockResolvedValue({ ativo: true, message: 'como você gostaria de aprofundar biosseguridade na avicultura?', final_answer: 'abertura',
    meta: { versao: 'teste', fase: 'abertura', curso_slug: 'sanidade-avicola', abordagem_id: 'sanidade-avicola:biosseguridade' } });
  f.reservar.mockImplementation(async () => f.reserva);
  f.enviar.mockImplementation(async (_ctx, _msg, _renovar, tel, interrompido) => {
    if (await interrompido()) return;
    tel.registrar('chunk_enviado', { ok: f.ok });
  });
});
describe('worker SPIN preserva gates e registra somente envio aceito', () => {
  it('produtor consulta candidatos elegíveis antes do limite do lote, preservando a janela', async () => {
    const rpc = vi.fn(async () => ({ data: [{ remotejid: 'elegivel' }], error: null }));
    expect(await selecionarCandidatos({ rpc })).toEqual([{ remotejid: 'elegivel' }]);
    const [nome, parametros] = rpc.mock.calls[0] as unknown as [string, Record<string, string | number>];
    expect(nome).toBe('crm_sdr_followup_candidatos'); expect(parametros.p_limite).toBe(300);
    expect(Date.parse(String(parametros.p_mais_velho_que)) - Date.parse(String(parametros.p_mais_novo_que))).toBe(1425 * 60000);
  });
  it('erro na seleção não recorre a uma lista sem a guarda do CRM V2', async () => {
    await expect(selecionarCandidatos({ rpc: async () => ({ error: { message: 'falha sintética' } }) })).rejects.toThrow('selecionarCandidatos');
  });
  it('falha na leitura do buffer bloqueia envio e consumo do toque', async () => {
    f.erroBuffer = true;
    expect(await processarFollowupLead(banco(), f.lead, 1)).toBe(false);
    expect(f.enviar).not.toHaveBeenCalled(); expect(f.atualizar).not.toHaveBeenCalled();
  });
  it('silêncio gerado não avança o toque se o lead respondeu durante a classificação', async () => {
    f.gerar.mockImplementation(async () => {
      f.lead.timestamp_mensagem = new Date().toISOString();
      return { ativo: true, message: '', final_answer: 'encerrado' };
    });
    expect(await processarFollowupLead(banco(), f.lead, 1)).toBe(false);
    expect(f.atualizar).not.toHaveBeenCalled();
  });
  it('envia pela esteira existente, grava abordagem e mantém o marcador de follow-up', async () => {
    const db = banco();
    expect(await processarFollowupLead(db, f.lead, 1)).toBe(true);
    expect(f.reservar).toHaveBeenCalledOnce(); expect(f.enviar).toHaveBeenCalledOnce();
    expect(f.gravar).toHaveBeenCalledTimes(2);
    expect(db.alteracoes).toContainEqual({ estado: 'enviado' });
    expect(f.registrar).toHaveBeenCalledWith('followup_enviado', expect.objectContaining({ spin: expect.objectContaining({ curso_slug: 'sanidade-avicola' }) }));
  });
  it.each(['pausa', 'respondeu', 'agendou', 'buffer'])('cancela quando %s durante a geração', async acao => {
    const retorno = await f.gerar();
    f.gerar.mockImplementation(async () => {
      if (acao === 'pausa') f.lead.pausa_ia = true;
      if (acao === 'respondeu') f.lead.timestamp_mensagem = new Date().toISOString();
      if (acao === 'agendou') f.lead.agendado = true;
      if (acao === 'buffer') f.buffer = true;
      return retorno;
    });
    expect(await processarFollowupLead(banco(), f.lead, 1)).toBe(false);
    expect(f.enviar).not.toHaveBeenCalled(); expect(f.atualizar).not.toHaveBeenCalled();
  });
  it('reserva duplicada não consome o toque nem envia', async () => {
    f.reserva = false;
    expect(await processarFollowupLead(banco(), f.lead, 1)).toBe(false);
    expect(f.enviar).not.toHaveBeenCalled(); expect(f.atualizar).not.toHaveBeenCalled();
  });
  it('desativação enquanto gera não envia uma mensagem SPIN pendente', async () => {
    f.ativo = false;
    expect(await processarFollowupLead(banco(), f.lead, 1)).toBe(false);
    expect(f.enviar).not.toHaveBeenCalled();
  });
  it('falha de envio não grava fala do assistente nem evento followup_enviado', async () => {
    f.ok = false;
    const db = banco();
    expect(await processarFollowupLead(db, f.lead, 1)).toBe(false);
    expect(f.gravar).toHaveBeenCalledOnce(); // somente o marcador da tentativa.
    expect(db.alteracoes).toContainEqual({ estado: 'falhou' });
    expect(f.registrar.mock.calls.some(([tipo]) => tipo === 'followup_enviado')).toBe(false);
  });
});
