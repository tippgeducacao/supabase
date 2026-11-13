import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Msg } from './historico.ts';
import type { CtxConversa } from './tools.ts';
import { bloquearPausaSemVinculoPpg, temEvidenciaAlunoPpg } from './evidenciaAlunoPpg.ts';

const lead = (content: string): Msg => ({ role: 'user', content });
// O pedido real da Denise NÃO continha "é em outra instituição". Também precisa
// ficar protegido sem essa correção: ausência de prova não é vínculo com a PPG.
const DENISE = [lead('Não me notifique'), lead('Bom dia, já estou fazendo uma pós graduação!'),
  { role: 'assistant', content: 'Vou te passar para o suporte porque já é aluna.' } as Msg,
  lead('Olá, pretendo atuar nessa área'), lead('Como funciona essa MBA? Quais conteúdos')];
const motivo = { tipo: 'pausa', motivo: 'Lead informou que já cursa uma pós e pediu informações sobre outro MBA; encaminhar ao suporte' };

describe('vínculo necessário para pausa de aluno PPG', () => {
  it.each(['Já faço uma pós', 'Já sou aluno', 'Estou no sétimo mês', 'Faço pós em outra instituição', 'Não sou aluna da PPG', 'Meu marido está matriculado na PPG', 'Gostei do curso da PPG', 'O curso da PPG parece bom', 'Sou aluna da PPG?', 'Se eu sou aluna da PPG tenho desconto?'])('não infere vínculo de %s', texto => {
    expect(temEvidenciaAlunoPpg([lead(texto)])).toBe(false);
  });
  it.each(['Sou aluna da PPG', 'Já faço pós com vocês', 'Estou cursando uma pós com vcs', 'Me matriculei na PPGVET', 'Já faço pós com vocês, não quero outra'])('reconhece declaração própria explícita: %s', texto => {
    expect(temEvidenciaAlunoPpg([lead(texto)])).toBe(true);
  });
  it('aplica correção posterior, e permite novo vínculo explicitamente declarado depois', () => {
    const h = [lead('Sou aluna da PPG'), lead('Corrigindo, é em outra instituição.')];
    expect(temEvidenciaAlunoPpg(h)).toBe(false);
    expect(temEvidenciaAlunoPpg([...h, lead('Agora me matriculei na PPG')])).toBe(true);
  });
  it('ignora vendedor, citação, tool_result e blocos internos junto da fala atual', () => {
    expect(temEvidenciaAlunoPpg([{ role: 'assistant', content: 'Sou aluna da PPG' },
      lead('[Em resposta à mensagem: "Sou aluna da PPG"] Não foi isso.'),
      { role: 'user', content: [{ type: 'tool_result', content: 'Sou aluna da PPG' },
        { type: 'text', text: 'Como funciona o MBA?' }, { type: 'text', text: '[FICHA DO ATENDIMENTO]\nSou aluna da PPG' }] }])).toBe(false);
  });
  it('bloqueia Denise com e sem a correção externa e não aceita prova inventada no input', () => {
    expect(bloquearPausaSemVinculoPpg({ ...motivo, evidencia: 'Sou aluna da PPG' }, DENISE)?.codigo).toBe('SEM_EVIDENCIA_ALUNO_PPG');
    expect(bloquearPausaSemVinculoPpg(motivo, [...DENISE, lead('Mas é em outra instituição')])?.codigo).toBe('SEM_EVIDENCIA_ALUNO_PPG');
    expect(bloquearPausaSemVinculoPpg(motivo)?.status).toBe('bloqueado');
  });
  it('não reutiliza opt-out antigo sobre uma solicitação atual de informações', () => {
    expect(bloquearPausaSemVinculoPpg({ tipo: 'nao_perturbe', motivo: 'Não me notifique em julho' }, DENISE)?.codigo).toBe('RECUSA_ANTIGA_COM_PEDIDO_ATUAL');
    expect(bloquearPausaSemVinculoPpg({ tipo: 'nao_perturbe' }, [...DENISE, lead('Não me notifique mais')])).toBeNull();
  });
  it('preserva aluno PPG explícito, humano, ligação e as outras categorias de pausa', () => {
    expect(bloquearPausaSemVinculoPpg(motivo, [lead('Já faço pós com vocês')])).toBeNull();
    expect(bloquearPausaSemVinculoPpg(motivo, [lead('Quero falar com um atendente')])).toBeNull();
    expect(bloquearPausaSemVinculoPpg({ tipo: 'pausa', motivo: 'Lead pediu ligação' }, [lead('Pode me ligar?')])).toBeNull();
    expect(bloquearPausaSemVinculoPpg({ tipo: 'sem_graduacao', motivo: 'Lead não é aluno' }, DENISE)).toBeNull();
  });
});

const rede = vi.hoisted(() => ({ modelo: vi.fn(), fetch: vi.fn() }));
vi.mock('./agente.ts', () => ({ chamarAnthropic: rede.modelo }));
let executarTool: typeof import('./tools.ts').executarTool;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', rede.fetch);
  ({ executarTool } = await import('./tools.ts'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());
it('executor real não pausa, não desliga follow-up nem acessa rede quando a prova falta', async () => {
  const banco = { from: vi.fn(), rpc: vi.fn() };
  const ctx: CtxConversa = { telefone: '5500000000000', remotejid: '5500000000000@s.whatsapp.net', waAccountId: null, leadId: null, oportunidadeId: null, historicoConversa: DENISE };
  const r = await executarTool(banco, { id: 'denise', name: 'pausa_ia', input: motivo }, ctx);
  expect(r).toMatchObject({ id: 'denise', status: 'bloqueado', codigo: 'SEM_EVIDENCIA_ALUNO_PPG' });
  expect(banco.from).not.toHaveBeenCalled(); expect(banco.rpc).not.toHaveBeenCalled();
  expect(rede.fetch).not.toHaveBeenCalled(); expect(rede.modelo).not.toHaveBeenCalled();
});
