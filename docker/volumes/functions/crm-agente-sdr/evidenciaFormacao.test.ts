import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Msg } from './historico.ts';
import type { CtxConversa } from './tools.ts';
import { avaliarEvidenciaSemGraduacao } from './evidenciaFormacao.ts';

const lead = (content: Msg['content']): Msg => ({ role: 'user', content });
const atendente = (content: Msg['content']): Msg => ({ role: 'assistant', content });
const ANGELICA: Msg[] = [
  atendente('[ATENDIMENTO_HUMANO] Sua participação na aula está confirmada! Você já trabalha na área da Qualidade e segurança de Alimentos de Origem Animal?'),
  lead('Não'),
  atendente('certo, e você atua em qual área hoje então?'),
  lead('[Em resposta à mensagem: "certo, e você atua em qual área hoje então?"] Nenhuma.'),
  lead('Pretendo atuar na area de Qualidade e segurança alimentar'),
];

describe('evidência própria de ausência de graduação', () => {
  it('não inventa escolaridade a partir da atuação da Angélica', () => {
    expect(avaliarEvidenciaSemGraduacao(ANGELICA).autorizada).toBe(false);
  });

  it.each(['Só fiz curso técnico.', 'Só concluí ensino médio.'])('curso feito em um período não comprova a única formação: %s', (resposta) => {
    expect(avaliarEvidenciaSemGraduacao([
      atendente('Que cursos você fez este ano?'), lead(resposta),
    ]).autorizada).toBe(false);
  });

  it.each([
    'Não', 'Nenhuma.', 'Pretendo atuar na área.', 'Não trabalho em nenhuma área.',
    'Não tenho graduação.', 'Ainda não concluí a faculdade.', 'Não estou cursando faculdade.',
    'Nunca fiz pós-graduação.', 'Tenho ensino médio.', 'Sou técnica em alimentos.',
    'Se eu nunca fiz faculdade, posso participar?', 'Meu filho nunca fez faculdade.',
    'Ela disse: nunca cursei faculdade.', 'Eu diria: nunca cursei faculdade.',
    'Nunca cursei faculdade?', 'Nunca cursei faculdade, mas tenho uma graduação no exterior.',
    'Só tenho ensino médio e estou cursando veterinária.',
    'Só tenho ensino médio. Sou estudante de veterinária.',
    'Nunca cursei faculdade. Me formei em medicina.',
    'Não tenho graduação completa, estou no 8º semestre.',
    '"Nunca cursei faculdade"', '“Só tenho ensino médio”',
    '> Nunca cursei faculdade.', '```Nunca cursei faculdade```',
    '[Em resposta à mensagem: "Nunca cursei faculdade"] Não foi isso que eu disse.',
    'Nunca cursei "nenhuma" faculdade.',
  ])('bloqueia ausência/ambiguidade: %s', (texto) => {
    expect(avaliarEvidenciaSemGraduacao([lead(texto)]).autorizada).toBe(false);
  });

  it.each([
    'Nunca cursei faculdade.', 'Eu nunca fiz graduação.', 'Nunca iniciei um curso superior.',
    'Só tenho ensino médio.', 'Minha única formação é curso técnico.',
    'Tenho apenas ensino médio completo.',
    'Não tenho graduação e não estou cursando faculdade.',
    'Não possuo ensino superior. Não curso faculdade.',
    'Só tenho ensino médio. Nunca cursei faculdade.',
  ])('aceita declaração inequívoca: %s', (texto) => {
    expect(avaliarEvidenciaSemGraduacao([lead(texto)])).toMatchObject({
      autorizada: true, motivo: 'declaracao_explicita', indiceMensagem: 0,
    });
  });

  it('lê blocos de texto reais, sem aceitar resultado de ferramenta', () => {
    expect(avaliarEvidenciaSemGraduacao([lead([
      { type: 'tool_result', content: 'Sou formada.', tool_use_id: 'consulta' },
      { type: 'text', text: 'Nunca cursei faculdade.' },
    ])]).autorizada).toBe(true);
    expect(avaliarEvidenciaSemGraduacao([lead([
      { type: 'tool_result', content: 'Nunca cursei faculdade.', tool_use_id: 'consulta' },
    ])]).autorizada).toBe(false);
  });

  it('ignora opinião do atendente e marcadores técnicos como prova', () => {
    expect(avaliarEvidenciaSemGraduacao([
      atendente('Nunca cursei faculdade.'), lead('[ATENDIMENTO_HUMANO] Nunca cursei faculdade.'),
      lead('[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE]'),
    ]).autorizada).toBe(false);
  });

  it('aceita fala própria preservada durante a pausa, inclusive áudio transcrito', () => {
    expect(avaliarEvidenciaSemGraduacao([lead('[MENSAGEM_LEAD_PAUSA] · 2026-09-12 15:00:00 UTC\n[Transcrição do áudio recebido do lead]\nNunca cursei faculdade.')]).autorizada).toBe(true);
  });

  it('retira a pergunta citada, mantendo somente a resposta própria', () => {
    expect(avaliarEvidenciaSemGraduacao([lead('[Em resposta à mensagem: "Você é formada ou cursa faculdade?"] Só tenho ensino médio.')]).autorizada).toBe(true);
  });

  it.each([
    'Sou formada e já tenho pós na área e pós complementar.', 'Estou cursando veterinária.',
    'Tenho pós-graduação.', 'Sou bacharel em medicina veterinária.', 'Me formei em 2020.',
    'Estou no quinto semestre.', 'Sou médica veterinária.',
    'Sou zootecnista.', 'Eu trabalho como zootecnista há 2 anos.',
    'Chefe de Veterinária.', 'Sou subchefe de veterinária.',
    'Sub chefe de veterinária e auxiliar de zootecnista e auxiliar de veterinária.',
    'Eu sou sub-chefe de veterinária.',
  ])('uma formação informada impede saída: %s', (formacao) => {
    expect(avaliarEvidenciaSemGraduacao([lead('Nunca cursei faculdade.'), lead(formacao)]).autorizada).toBe(false);
    expect(avaliarEvidenciaSemGraduacao([lead(formacao), lead('Nunca cursei faculdade.')]).autorizada).toBe(false);
  });

  it.each([
    'Meu chefe é zootecnista.', 'Minha mãe é chefe de veterinária.',
    'Não sou zootecnista.', 'Não sou chefe de veterinária.',
    'Sou auxiliar de zootecnista.', 'Sou auxiliar de veterinária.',
    'Quero ser zootecnista.', 'Quero ser chefe de veterinária.',
    '“Sou zootecnista”', 'Ela disse: sou chefe de veterinária.',
    'Você é zootecnista?',
  ])('não transforma menção ao título em conflito de formação própria: %s', (texto) => {
    expect(avaliarEvidenciaSemGraduacao([lead(texto), lead('Só tenho ensino médio.')]))
      .toMatchObject({ autorizada: true, motivo: 'declaracao_explicita', indiceMensagem: 1 });
  });

  it('não reaproveita uma declaração antiga depois de resposta ambígua', () => {
    expect(avaliarEvidenciaSemGraduacao([lead('Nunca cursei faculdade.'), lead('Não foi isso que eu disse.')]).autorizada).toBe(false);
    expect(avaliarEvidenciaSemGraduacao([lead('Nunca cursei faculdade.'), lead('"Nunca cursei faculdade"')]).autorizada).toBe(false);
  });

  it('falha fechada quando o chamador esquece o histórico', () => {
    expect(avaliarEvidenciaSemGraduacao().autorizada).toBe(false);
    expect(avaliarEvidenciaSemGraduacao([]).autorizada).toBe(false);
  });
});

const fronteiras = vi.hoisted(() => ({ modelo: vi.fn(), fetch: vi.fn() }));
vi.mock('./agente.ts', () => ({ chamarAnthropic: fronteiras.modelo }));
let executarTool: typeof import('./tools.ts').executarTool;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', fronteiras.fetch);
  ({ executarTool } = await import('./tools.ts'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());

const contexto = (historicoConversa?: Msg[]): CtxConversa => ({
  telefone: '5500000000000', remotejid: '5500000000000@s.whatsapp.net',
  waAccountId: null, leadId: null, oportunidadeId: null, historicoConversa,
});
const pedido = (tipo = 'sem_graduacao') => ({
  id: 'pausa-sintetica', name: 'pausa_ia', input: {
    tipo, motivo: 'Lead não possui graduação nenhuma, apenas pretende atuar na área',
    // Deliberadamente inventada: campo enviado pelo modelo não é prova.
    evidencia: 'Nunca cursei faculdade.',
  },
});

function bancoIsolado() {
  const escrita = vi.fn().mockResolvedValue({ error: null });
  const atualizar = vi.fn(() => ({ in: escrita }));
  return {
    escrita, atualizar,
    from: vi.fn(() => ({ update: atualizar })),
    rpc: vi.fn().mockResolvedValue({ data: { arquivados: 1, nao_perturbe_marcados: 1 }, error: null }),
  };
}

describe('pausa_ia no executor real, com banco e rede isolados', () => {
  it.each([
    ['Angélica', ANGELICA], ['histórico ausente', undefined], ['cadastro sem formação', []],
    ['estudante', [lead('Não tenho graduação. Estou cursando veterinária.')]],
    ['correção posterior', [lead('Nunca cursei faculdade.'), lead('Sou formada e já tenho pós.')]],
    ['zootecnista com histórico conflitante', [lead('Sou zootecnista.'), lead('Só tenho ensino médio.')]],
    ['chefia com histórico conflitante', [lead('Sub chefe de veterinária e auxiliar de zootecnista e auxiliar de veterinária.'), lead('Nunca cursei faculdade.')]],
    ['resposta da tool', [lead([{ type: 'tool_result', tool_use_id: 'x', content: 'Nunca cursei faculdade.' }])]],
  ] as [string, Msg[] | undefined][])('rejeita %s antes de qualquer RPC/escrita', async (_nome, historico) => {
    const banco = bancoIsolado();
    const resultado = await executarTool(banco, pedido(), contexto(historico));
    expect(resultado).toMatchObject({ id: 'pausa-sintetica', status: 'bloqueado', codigo: 'SEM_EVIDENCIA_SEM_GRADUACAO' });
    expect(resultado.resultado).toContain('não o desqualifique nem encerre');
    expect(banco.rpc).not.toHaveBeenCalled();
    expect(banco.from).not.toHaveBeenCalled();
    expect(banco.atualizar).not.toHaveBeenCalled();
    expect(banco.escrita).not.toHaveBeenCalled();
    expect(fronteiras.fetch).not.toHaveBeenCalled();
    expect(fronteiras.modelo).not.toHaveBeenCalled();
  });

  it('declaração explícita permite o caminho existente de pausa e arquivo', async () => {
    const banco = bancoIsolado();
    const resultado = await executarTool(banco, pedido(), contexto([lead('Nunca cursei faculdade.')]));
    expect(resultado).toMatchObject({ status: 'pausado', motivo_saida: 'sem_graduacao', arquivado: true });
    expect(banco.rpc.mock.calls.map(([nome]) => nome)).toEqual(['crm_set_pausa_ia', 'crm_agente_arquivar_desinteresse']);
    expect(banco.atualizar).toHaveBeenCalledWith({ followup_ativado: false });
    expect(banco.escrita).toHaveBeenCalledTimes(1);
  });

  it('mantém opt-out independente da escolaridade', async () => {
    const banco = bancoIsolado();
    const resultado = await executarTool(banco, pedido('nao_perturbe'), contexto([lead('Não quero mais mensagens.')]));
    expect(resultado).toMatchObject({ status: 'pausado', motivo_saida: 'opt_out', opt_out: true });
    expect(banco.rpc).toHaveBeenCalledTimes(2);
  });
});
