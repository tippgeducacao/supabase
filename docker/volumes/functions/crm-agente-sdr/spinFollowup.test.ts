import { describe, expect, it, vi } from 'vitest';
vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn(), MODELO_AGENTE: 'modelo-teste' }));
import { CATALOGOS_SPIN } from './spinCatalogos';
import { gerarFollowupSpin, classificarEstadoSpin, memoriaSpin, perguntaRepetidaSpin, reservarAbordagemSpin, validarMensagemSpin } from './spinFollowup';
import { decodificarVetorSpin, recuperarScoresSpin, selecionarSpin, similaridadeSpin } from './spinRecuperacao';

const curso = CATALOGOS_SPIN.find(c => c.slug === 'sanidade-avicola')!;
const lead = { remotejid: '5511999990001@s.whatsapp.net', curso_interesse_original: 'Sanidade Avícola' };
function banco(opcoes: { ativo?: boolean; usadas?: string[]; erroTabela?: string; cache?: number[]; reserva?: boolean } = {}) {
  const gravacoes: { tabela: string; tipo: string; dados: unknown }[] = [];
  const filtros: unknown[][] = [];
  const rpc = vi.fn(async () => ({ data: opcoes.reserva ?? true, error: null }));
  const from = vi.fn((tabela: string) => {
    const dados = tabela === 'crm_sdr_spin_config' ? { ativo: opcoes.ativo ?? true }
      : tabela === 'crm_sdr_spin_voyage_cache' ? (opcoes.cache ? { vetor: opcoes.cache, criado_em: new Date().toISOString() } : null)
      : tabela === 'cursos' ? CATALOGOS_SPIN.map(c => ({ id: c.curso_id }))
      : (opcoes.usadas ?? []).map(abordagem_id => ({ abordagem_id, mensagem: 'mensagem anterior' }));
    const resultado = { data: dados, error: tabela === opcoes.erroTabela ? { message: 'falha sintética' } : null };
    const q = {
      select: () => q, eq: (...args: unknown[]) => { filtros.push([tabela, ...args]); return q; },
      maybeSingle: async () => resultado,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resultado).then(resolve),
      insert: async (d: unknown) => { gravacoes.push({ tabela, tipo: 'insert', dados: d }); return { error: opcoes.erroTabela === tabela ? {} : null }; },
      upsert: async (d: unknown) => { gravacoes.push({ tabela, tipo: 'upsert', dados: d }); return { error: null }; },
    }; return q;
  });
  return { from, rpc, gravacoes, filtros };
}
function modelo(fase = 'abertura', slug: string | null = curso.slug, mensagem = curso.abordagens[0].pergunta) {
  return vi.fn()
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', name: 'registrar_estado', input: { fase, curso_slug: slug, assunto: '', pendencia: '' } }] })
    .mockResolvedValueOnce({ model: 'modelo-teste', content: [{ type: 'text', text: JSON.stringify({ message: mensagem }) }] });
}
const tel = () => ({ rodadaId: 'teste', registrar: vi.fn() });
const semBusca = vi.fn(async () => ({ scores: {}, motivo: 'sem_assunto' }));

describe('integração do repertório no gerador', () => {
  it.each(CATALOGOS_SPIN.map(c => [c.slug, c] as const))('ativa conteúdo específico de %s sem escrever ao lead', async (_slug, c) => {
    const db = banco(), gerar = modelo('abertura', c.slug, c.abordagens[0].pergunta);
    const r = await gerarFollowupSpin(db, lead, [{ role: 'user', content: 'oi' }], '', tel(), { modelo: gerar, recuperar: semBusca });
    expect(r.ativo).toBe(true);
    expect(r.meta?.curso_slug).toBe(c.slug);
    expect(r.meta?.abordagem_id).toBe(c.abordagens[0].id);
    expect(r.message).toBe(c.abordagens[0].pergunta);
    expect(db.gravacoes).toEqual([]);
    const request = gerar.mock.calls[1][0];
    expect(request.system[2].text).toContain(c.abordagens[0].tema);
    expect(request.system[2].text).not.toContain('Condição promocional');
  });
  it('chave desligada mantém o gerador anterior sem chamar modelos', async () => {
    const gerar = modelo();
    expect((await gerarFollowupSpin(banco({ ativo: false }), lead, [], '', tel(), { modelo: gerar })).ativo).toBe(false);
    expect(gerar).not.toHaveBeenCalled();
  });
  it('memória persistente impede repetir uma abordagem em outra execução', async () => {
    const db = banco({ usadas: [curso.abordagens[0].id] });
    const r = await gerarFollowupSpin(db, lead, [], '', tel(), { modelo: modelo('abertura', curso.slug, curso.abordagens[1].pergunta), recuperar: semBusca });
    expect(r.meta?.abordagem_id).toBe(curso.abordagens[1].id);
    expect(db.filtros).toContainEqual(['crm_sdr_spin_memoria', 'remotejid', lead.remotejid]);
    expect(db.filtros).toContainEqual(['crm_sdr_spin_memoria', 'curso_slug', curso.slug]);
  });
  it('esgotar temas não abre um follow-up genérico', async () => {
    const gerar = modelo();
    const r = await gerarFollowupSpin(banco({ usadas: curso.abordagens.map(a => a.id) }), lead, [], '', tel(), { modelo: gerar, recuperar: semBusca });
    expect(r.message).toBe('');
    expect(r.final_answer).toBe('repertorio_esgotado');
    expect(gerar).toHaveBeenCalledOnce();
  });
  it.each(['encerrado', 'material_pendente'])('%s não gera mensagem nem usa Voyage', async fase => {
    const recuperar = vi.fn();
    const gerar = modelo(fase);
    expect((await gerarFollowupSpin(banco(), lead, [], 'preferiu esperar', tel(), { modelo: gerar, recuperar })).message).toBe('');
    expect(gerar).toHaveBeenCalledOnce(); expect(recuperar).not.toHaveBeenCalled();
  });
  it.each([
    ['formacao', 'qual curso de graduação você está fazendo?', 'qual é a sua graduação?'],
    ['conclusao', 'você já concluiu a graduação?', 'sua graduação já está concluída ou você ainda está cursando?'],
    ['horario', 'qual período funciona melhor pra nossa conversa?', 'qual período funciona melhor pra nossa conversa?'],
    ['objecao', 'podemos conversar com o monitor para esclarecer o valor total?', 'podemos conversar com o monitor para esclarecer o valor total?'],
  ])('respeita %s sem introduzir conteúdo SPIN', async (fase, mensagem, esperada) => {
    const recuperar = vi.fn(), gerar = modelo(fase, curso.slug, mensagem);
    const r = await gerarFollowupSpin(banco(), lead, [], '', tel(), { modelo: gerar, recuperar });
    expect(r.message).toBe(esperada); expect(r.meta?.abordagem_id).toBeNull();
    expect(recuperar).not.toHaveBeenCalled();
  });
  it('cadastro agendado bloqueia antes do classificador', async () => {
    const gerar = modelo();
    expect((await gerarFollowupSpin(banco(), { ...lead, agendado: true }, [], '', tel(), { modelo: gerar })).message).toBe('');
    expect(gerar).not.toHaveBeenCalled();
  });
  it('falha na memória não permite repetir perguntas', async () => {
    const r = await gerarFollowupSpin(banco({ erroTabela: 'crm_sdr_spin_memoria' }), lead, [], '', tel(), { modelo: modelo() });
    expect(r.message).toBe(''); expect(r.final_answer).toBe('memoria_indisponivel');
  });
  it('curso inventado no classificador não chega ao gerador', async () => {
    const gerar = modelo('abertura', 'clinica-pequenos');
    expect((await gerarFollowupSpin(banco(), lead, [], '', tel(), { modelo: gerar })).message).toBe('');
    expect(gerar).toHaveBeenCalledOnce();
  });
  it('texto com falsa reserva usa somente a referência revisada', async () => {
    const r = await gerarFollowupSpin(banco(), lead, [], '', tel(), { modelo: modelo('abertura', curso.slug, 'reservei amanhã às 13h, pode ser?'), recuperar: semBusca });
    expect(r.message).toBe(curso.abordagens[0].pergunta);
  });
  it('silêncio escolhido pelo modelo não vira mensagem por fallback', async () => {
    expect((await gerarFollowupSpin(banco(), lead, [], '', tel(), { modelo: modelo('abertura', curso.slug, ''), recuperar: semBusca })).message).toBe('');
  });
  it('reserva tem unicidade por lead, curso e abordagem e falha fechada', async () => {
    const r = await gerarFollowupSpin(banco(), lead, [], '', tel(), { modelo: modelo(), recuperar: semBusca });
    const db = banco();
    expect(await reservarAbordagemSpin(db, lead.remotejid, r)).toBe(true);
    expect(db.gravacoes[0].dados).toMatchObject({ remotejid: lead.remotejid, curso_slug: curso.slug, abordagem_id: curso.abordagens[0].id, estado: 'reservado' });
    expect(await reservarAbordagemSpin(banco({ erroTabela: 'crm_sdr_spin_memoria' }), lead.remotejid, r)).toBe(false);
  });
});

describe('contratos de contexto e saída', () => {
  it('retira raciocínio e mantém autoria humana, resposta e resultado de tool', () => {
    expect(JSON.stringify(memoriaSpin([
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Qual sua graduação?' },
      { role: 'user', content: 'Sou veterinária formada.' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'segredo de raciocínio' }, { type: 'text', text: 'certo' }] },
    ]))).not.toContain('raciocínio');
  });
  it('reserva estado somente dentre os cursos ativos passados', async () => {
    await expect(classificarEstadoSpin(lead, [], '', [], modelo())).rejects.toThrow('Estado SPIN inválido');
  });
  it.each(['Fechado, às 14h então?', 'já enviei o cronograma, conseguiu abrir?', 'reservei sua reunião, pode ser?',
    'consigo um encaixe hoje?', 'vc ainda tem interesse?', 'você se formou em quê?', 'sabia que essa pós garante emprego?',
    'qual sua graduação? qual seu objetivo?', 'Nossa pós é a melhor. quer conhecer?'])('barra %s', texto => {
    expect(validarMensagemSpin(texto).message).toBe('');
  });
  it('detecta pergunta igual e variação quase literal', () => {
    expect(perguntaRepetidaSpin('vc quer aprofundar vacinação em matrizes?', ['você gostaria de aprofundar vacinação em matrizes?'])).toBe(true);
    expect(perguntaRepetidaSpin('como analisar qualidade de pintainhos?', ['como analisar vacinas em matrizes?'])).toBe(false);
  });
});

describe('recuperação sem dependência obrigatória da Voyage', () => {
  it('sem perfil usa uma referência específica e varia com memória', () => {
    expect(selecionarSpin(curso.abordagens, []).abordagem?.id).toBe(curso.abordagens[0].id);
    expect(selecionarSpin(curso.abordagens, [curso.abordagens[0].id]).abordagem?.id).toBe(curso.abordagens[1].id);
  });
  it('interesse explícito prioriza conteúdo pertinente por busca lexical', () => {
    const selecionada = selecionarSpin(curso.abordagens, [], 'quero aprender sobre vacinação nas matrizes').abordagem;
    expect(selecionada?.fonte.aulas.join(' ')).toMatch(/vacin/i);
  });
  it('não consulta API para silêncio sem assunto', async () => {
    const transporte = vi.fn();
    expect((await recuperarScoresSpin(banco(), '', curso.abordagens, { chave: 'sintetica', transporte })).scores).toEqual({});
    expect(transporte).not.toHaveBeenCalled();
  });
  it('reserva negada em outro worker retorna sem esperar nem chamar API', async () => {
    const transporte = vi.fn();
    expect((await recuperarScoresSpin(banco({ reserva: false }), 'laudos e investigação sanitária', curso.abordagens, { chave: 'sintetica', transporte })).motivo).toBe('limite_compartilhado');
    expect(transporte).not.toHaveBeenCalled();
  });
  it('429 e exceção preservam a alternativa lexical sem gravar falha como vetor', async () => {
    for (const transporte of [vi.fn(async () => new Response('', { status: 429 })), vi.fn(async () => { throw new Error('timeout'); })]) {
      const db = banco();
      expect((await recuperarScoresSpin(db, 'laudos e investigação sanitária', curso.abordagens, { chave: 'sintetica', transporte })).scores).toEqual({});
      expect(db.gravacoes).toEqual([]);
    }
  });
  it('cache válido evita consumir uma nova chamada', async () => {
    const { VETORES_SPIN } = await import('./spinVetores');
    const vetor = decodificarVetorSpin(VETORES_SPIN[curso.abordagens[0].id]);
    const db = banco({ cache: vetor }), transporte = vi.fn();
    const r = await recuperarScoresSpin(db, 'laudos e investigação sanitária', curso.abordagens, { chave: 'sintetica', transporte });
    expect(r.motivo).toBe('cache');
    expect(r.scores[curso.abordagens[0].id]).toBeCloseTo(1, 5);
    expect(db.rpc).not.toHaveBeenCalled(); expect(transporte).not.toHaveBeenCalled();
  });
  it('consulta aceita usa o modelo e dimensão do índice e grava somente vetor e hash no cache', async () => {
    const { VETORES_SPIN } = await import('./spinVetores');
    const vetor = decodificarVetorSpin(VETORES_SPIN[curso.abordagens[0].id]);
    const transporte = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: vetor }] })));
    const db = banco();
    const r = await recuperarScoresSpin(db, 'laudos de aves contato teste@example.com 5511999990000', curso.abordagens, { chave: 'sintetica', transporte });
    expect(r.motivo).toBe('voyage'); expect(db.rpc).toHaveBeenCalledOnce();
    const body = JSON.parse((transporte.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: 'voyage-4-large', output_dimension: 1024, input_type: 'query' });
    expect(body.input[0]).not.toMatch(/example|551199999/);
    expect(r.scores[curso.abordagens[0].id]).toBeCloseTo(1, 5);
    expect(db.gravacoes).toEqual([{ tabela: 'crm_sdr_spin_voyage_cache', tipo: 'upsert',
      dados: { chave: expect.stringMatching(/^[a-f0-9]{64}$/), vetor, criado_em: expect.any(String) } }]);
  });
  it('todos os 131 vetores pertencem exatamente ao catálogo empacotado', async () => {
    const { VETORES_SPIN } = await import('./spinVetores');
    const ids = CATALOGOS_SPIN.flatMap(c => c.abordagens.map(a => a.id));
    expect(CATALOGOS_SPIN).toHaveLength(18); expect(ids).toHaveLength(131);
    expect(Object.keys(VETORES_SPIN).sort()).toEqual(ids.sort());
    for (const id of ids) {
      const v = decodificarVetorSpin(VETORES_SPIN[id]); expect(v).toHaveLength(1024);
      expect(similaridadeSpin(v, v)).toBeCloseTo(1, 5);
    }
  });
});
