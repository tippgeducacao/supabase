import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { (globalThis as any).Deno = { env: { get: () => '' } }; });
vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn(), MODELO_AGENTE: 'claude-teste' }));
vi.mock('./pilotoOpenai.ts', () => ({ selecionarProvedorDoLead: vi.fn() }));
vi.mock('./fichaAtendimento.ts', async (original) => ({ ...await original<any>(), registrarNaJornada: vi.fn() }));
vi.mock('./saida.ts', () => ({ enviarResposta: vi.fn() }));
vi.mock('./conta.ts', () => ({ contaDoLead: vi.fn(async () => 'conta-atual'), dadosDaConta: vi.fn(), phoneVariants: (t: string) => [t] }));
vi.mock('./trocaDeNumero.ts', () => ({ carregarModoTrocaNumero: vi.fn(async () => 'off'), carregarSinalTrocaDeNumero: vi.fn(), notaTrocaDeNumero: vi.fn(), resumoDoSinal: vi.fn() }));
vi.mock('./contextoAulaPiloto.ts', async (original) => ({ ...await original<any>(), carregarAulaParaFollowup: vi.fn() }));
vi.mock('./historico.ts', async (original) => ({ ...await original<any>(), buscarLead: vi.fn(), carregarHistorico: vi.fn(), atualizarLead: vi.fn(), gravarMensagem: vi.fn() }));
vi.mock('./envioMateriais.ts', async (original) => ({ ...await original<any>(), carregarStatusMateriais: vi.fn(async () => '') }));
vi.mock('./eventos.ts', () => ({ criarTelemetria: () => ({ rodadaId: 'rodada-teste', registrar: vi.fn() }), resumir: (s: string) => s }));
import { gerarFollowup, processarFollowupLead } from './followup';
import { chamarAnthropic } from './agente';
import { selecionarProvedorDoLead } from './pilotoOpenai';
import { buscarLead, carregarHistorico } from './historico';
import { enviarResposta } from './saida';
import { carregarAulaParaFollowup } from './contextoAulaPiloto';
import { FOLLOWUP_SYSTEM } from './prompts-followup';
import { FOLLOWUP_PILOTO_SYSTEM } from './followupPiloto';
import { registrarNaJornada } from './fichaAtendimento';

const provedor = { nome: 'openai', formato: 'openai' as const, modelo: 'gpt-5.6-luna', esforco: 'high', base: 'https://api.openai.com', chave: 'simulada' };
const fala = { content: [{ type: 'text', text: '{"message":"quer que eu confira o último horário para hoje?","final_answer":"horario","pergunta_id":"pendencia"}' }], stop_reason: 'end_turn' };
const tel = { rodadaId: 'rodada', registrar: vi.fn() };
const banco = { rpc: vi.fn(async () => ({ data: true })), from: () => {
  const q: any = { then: (ok: any) => Promise.resolve({ data: [], error: null }).then(ok) };
  for (const m of ['select', 'eq', 'limit', 'delete']) q[m] = () => q;
  return q;
} };
let lead: any;
beforeEach(() => {
  vi.clearAllMocks();
  lead = { remotejid: '5546988166051@s.whatsapp.net', nome: 'Gustavo', curso_interesse_original: 'Pós antiga',
    iniciar_atendimento: true, followup_ativado: true, timestamp_mensagem: new Date(Date.now() - 20 * 60_000).toISOString(),
    jornada: { coleta: { graduacao: 'Medicina Veterinária', graduacao_concluida: 'sim' } } };
  vi.mocked(buscarLead).mockImplementation(async () => lead);
  vi.mocked(carregarHistorico).mockResolvedValue([{ role: 'user', content: 'qual o último horário?' }, { role: 'assistant', content: 'vou consultar os horários' }]);
  vi.mocked(chamarAnthropic).mockReset().mockResolvedValue(fala);
  vi.mocked(selecionarProvedorDoLead).mockResolvedValue(provedor);
  vi.mocked(registrarNaJornada).mockImplementation(async (_banco, _telefone, mutar) => mutar(lead.jornada));
  vi.mocked(enviarResposta).mockImplementation(async (_ctx, _texto, _renovar, telemetria) => {
    telemetria?.registrar('chunk_enviado', { ok: true });
    return { aceitos: 1, canal: 'texto', estado: 'aceito' };
  });
});

describe('follow-up do piloto chega ao mesmo pipeline de voz', () => {
  it('persiste a pergunta de carreira só depois do áudio aceito', async () => {
    lead.curso_interesse_original = 'Reprodução, Nutrição e Gestão de Bovinos (3em1)';
    vi.mocked(chamarAnthropic).mockResolvedValue({ ...fala, content: [{ type: 'text', text: JSON.stringify({ message: 'como você imagina seu trabalho com bovinos no futuro?', final_answer: 'futuro', pergunta_id: 'bovinos_3em1:futuro' }) }] });
    vi.mocked(enviarResposta).mockImplementation(async (_ctx, _texto, _renovar, telemetria) => {
      expect(registrarNaJornada).not.toHaveBeenCalled();
      telemetria?.registrar('chunk_enviado', { ok: true, canal: 'audio' });
      return { aceitos: 1, canal: 'audio', estado: 'aceito' };
    });
    expect(await processarFollowupLead(banco, lead, 1)).toBe(true);
    const mutar = vi.mocked(registrarNaJornada).mock.calls[0][2];
    expect(mutar(lead.jornada).followup_carreira).toEqual([expect.objectContaining({ escopo: 'bovinos_3em1', pergunta_id: 'bovinos_3em1:futuro' })]);
    expect(mutar(lead.jornada).coleta).toEqual(lead.jornada.coleta);
  });
  it('envio recusado não marca pergunta de carreira como entregue', async () => {
    lead.curso_interesse_original = 'Sanidade Avícola';
    vi.mocked(chamarAnthropic).mockResolvedValue({ ...fala, content: [{ type: 'text', text: JSON.stringify({ message: 'como se imagina trabalhando com sanidade avícola no futuro?', final_answer: 'futuro', pergunta_id: 'sanidade_avicola:futuro' }) }] });
    vi.mocked(enviarResposta).mockResolvedValue({ aceitos: 0, canal: 'texto', estado: 'cancelado' });
    expect(await processarFollowupLead(banco, lead, 1)).toBe(false);
    expect(registrarNaJornada).not.toHaveBeenCalled();
  });
  it('usa Luna e transmite o provedor efetivo para permitir áudio pela cadência', async () => {
    expect(await processarFollowupLead(banco, lead, 1)).toBe(true);
    expect(chamarAnthropic).toHaveBeenCalledWith(expect.objectContaining({ system: expect.arrayContaining([{ type: 'text', text: FOLLOWUP_PILOTO_SYSTEM }]) }), {}, provedor);
    expect(vi.mocked(enviarResposta).mock.calls[0][5]).toMatchObject({ origem: 'followup', provedorResposta: 'openai', interacaoId: 'rodada-teste' });
    expect(vi.mocked(enviarResposta).mock.calls[0][6]).toBe('codigo');
    expect(JSON.stringify(vi.mocked(chamarAnthropic).mock.calls[0][0])).toContain('Medicina Veterinária');
  });
  it('fora do piloto permanece o gerador Anthropic e sem permissão de voz OpenAI', async () => {
    vi.mocked(selecionarProvedorDoLead).mockResolvedValue(null);
    expect(await processarFollowupLead(banco, lead, 1)).toBe(true);
    expect(vi.mocked(chamarAnthropic).mock.calls[0][0].system).toContainEqual({ type: 'text', text: FOLLOWUP_SYSTEM });
    expect(vi.mocked(enviarResposta).mock.calls[0][5]).toMatchObject({ provedorResposta: 'anthropic' });
  });
  it('fallback de conteúdo para Claude não é falsamente identificado como OpenAI', async () => {
    vi.mocked(chamarAnthropic).mockRejectedValueOnce(new Error('falha simulada'));
    expect(await processarFollowupLead(banco, lead, 1)).toBe(true);
    expect(vi.mocked(chamarAnthropic).mock.calls[1][2]).toBeNull();
    expect(vi.mocked(chamarAnthropic).mock.calls[1][3]).toBe(45_000);
    expect(vi.mocked(enviarResposta).mock.calls[0][5]).toMatchObject({ provedorResposta: 'anthropic' });
  });
  it('leva aula e pós vinculada sem carregar o assunto antigo do lead', async () => {
    lead.contexto_campanha = { persona: 'aula', aula_id: 'aula-nova' };
    vi.mocked(carregarAulaParaFollowup).mockResolvedValue({ titulo: 'Dor em animais', inicio_em: '2099-09-28T22:00:00Z', link: 'https://youtube.com/watch?v=teste', curso_nome: 'Cannabis Medicinal Veterinária' });
    expect(await processarFollowupLead(banco, lead, 1)).toBe(true);
    const pedido = JSON.stringify(vi.mocked(chamarAnthropic).mock.calls[0][0]);
    expect(pedido).toContain('Dor em animais');
    expect(pedido).toContain('Cannabis Medicinal Veterinária');
    expect(pedido).toContain('Prescrição Veterinária, Titulação e Acompanhamento Clínico');
    expect(pedido).not.toContain('Pós antiga');
  });
  it('aula sem cadastro e resposta incompleta não geram retomada inventada', async () => {
    lead.contexto_campanha = { persona: 'aula' };
    vi.mocked(carregarAulaParaFollowup).mockResolvedValue(null);
    expect(await processarFollowupLead(banco, lead, 1)).toBe(false);
    expect(chamarAnthropic).not.toHaveBeenCalled();
    vi.mocked(chamarAnthropic).mockResolvedValueOnce({ ...fala, stop_reason: 'max_tokens' });
    expect((await gerarFollowup(banco, lead, 1, tel as any, [])).message).toBe('');
  });
  it('nova entrada durante a geração cancela o envio', async () => {
    vi.mocked(chamarAnthropic).mockImplementationOnce(async () => { lead = { ...lead, timestamp_mensagem: new Date().toISOString() }; return fala; });
    expect(await processarFollowupLead(banco, lead, 1)).toBe(false);
    expect(enviarResposta).not.toHaveBeenCalled();
  });
});
