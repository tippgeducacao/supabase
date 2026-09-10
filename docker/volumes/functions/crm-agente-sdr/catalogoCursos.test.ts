import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consultarCatalogo, type ConsultaCatalogo } from './catalogoCursos';
import { descreverToolsSdr } from './descricoesTools';

const fronteiras = vi.hoisted(() => ({ atualizar: vi.fn(), fetch: vi.fn() }));
vi.mock('./historico.ts', () => ({ atualizarLead: fronteiras.atualizar, buscarLead: vi.fn() }));
vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn() }));
const bovinos = { id: '482013e3-7634-4b7d-8e5e-73416548ca5c', nome: 'PÓS | CLÍNICA MÉDICA E CIRÚRGICA DE BOVINOS' };
const tresEmUm = { id: 'd391cef0-f4d6-4b1d-a32d-2238427fbe9c', nome: 'PÓS | REPRODUÇÃO, NUTRIÇÃO E GESTÃO DE BOVINOS (3EM1)' };
const avicola = { id: '3dfea82f-d1e1-4c6a-bcbb-5ed39d9042e8', nome: 'PÓS | SANIDADE AVÍCOLA' };
const nutricao = { id: '1ab710b6-aa2b-4cad-811a-2fba794fe7f8', nome: 'PÓS | NUTRIÇÃO E GESTÃO DE BOVINOS' };
const novo = { id: 'curso-novo', nome: 'PÓS | CURSO NOVO' };
function banco(opcoes: { erro?: boolean; resolvido?: unknown; rag?: unknown[] } = {}) {
  const query = {
    select: vi.fn<ConsultaCatalogo['select']>(), eq: vi.fn<ConsultaCatalogo['eq']>(),
    order: vi.fn(async () => ({ data: [bovinos, tresEmUm, avicola, nutricao, novo], error: opcoes.erro ? { message: 'falha' } : null })),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return {
    from: vi.fn((tabela: string) => { expect(tabela).toBe('cursos'); return query; }), query,
    rpc: vi.fn(async (nome: string) => nome === 'match_ppg_voyage'
      ? { data: opcoes.rag ?? [], error: null } : { data: opcoes.resolvido ?? null, error: null }),
  };
}
let executarTool: typeof import('./tools').executarTool;
const contexto = { remotejid: '5500000000000@s.whatsapp.net', telefone: '5500000000000', waAccountId: null, leadId: null, oportunidadeId: null };
const executar = (db: ReturnType<typeof banco>, name: string, input: Record<string, unknown>, teste = false) => executarTool(db, { id: 'teste', name, input }, { ...contexto, modoTeste: teste });
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  vi.stubGlobal('fetch', fronteiras.fetch);
  ({ executarTool } = await import('./tools'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  fronteiras.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })));
});

describe('catálogo e modalidades do SDR', () => {
  it.each([[bovinos, ['online', 'semipresencial']], [tresEmUm, ['online', 'semipresencial']],
    [avicola, ['online']], [nutricao, ['online']], [novo, []]] as const)('modalidade específica: %o', async (curso, modos) => {
    const db = banco();
    const retorno = await consultarCatalogo(db, curso.nome);
    expect(retorno).toMatchObject({ status: 'curso_confirmado', curso: { id: curso.id, modalidades: modos } });
    expect(db.query.eq.mock.calls).toEqual([['ativo', true], ['modalidade', 'Pós-Graduação']]);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('normaliza cirurgia/cirúrgica de bovinos sem exigir busca aproximada', async () => {
    const db = banco();
    expect(await consultarCatalogo(db, 'Clínica Médica e Cirurgia de Bovinos')).toMatchObject({ curso: { id: bovinos.id } });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('não transforma o caso do print em Bovinos nem grava interesse', async () => {
    const db = banco({ resolvido: { ...bovinos, via: 'fuzzy' } });
    const retorno = await executar(db, 'consulta_pos_disponiveis', { trocar_para: 'clínica médica e cirúrgica de pequenos animais' });
    expect(retorno.status).toBe('curso_nao_confirmado');
    expect(retorno.curso).toBeUndefined();
    expect(retorno.alternativas_disponiveis).not.toContainEqual(expect.objectContaining({ id: bovinos.id }));
    expect(fronteiras.atualizar).not.toHaveBeenCalled();
  });
  it('não aceita curso desativado apontado pelo resolver', async () => {
    const retorno = await consultarCatalogo(banco({ resolvido: { id: 'inativo', nome: 'Pós inativa', via: 'alias' } }), 'apelido antigo');
    expect(retorno.status).toBe('curso_nao_encontrado');
  });
  it('nome aproximado da mesma área pede confirmação em vez de trocar ou negar a oferta', async () => {
    const retorno = await executar(banco({ resolvido: { ...avicola, via: 'fuzzy' } }), 'consulta_pos_disponiveis', { trocar_para: 'sanidade avicolaa' });
    expect(retorno).toMatchObject({ status: 'curso_nao_confirmado', possivel_correspondencia: 'SANIDADE AVÍCOLA' });
    expect(fronteiras.atualizar).not.toHaveBeenCalled();
  });
  it('consulta sobre outra pós não troca o interesse', async () => {
    expect(await executar(banco(), 'consulta_pos_disponiveis', { curso_consulta: avicola.nome })).toMatchObject({ status: 'curso_confirmado' });
    expect(fronteiras.atualizar).not.toHaveBeenCalled();
  });
  it('troca explicitamente escolhida aceita alias 3em1 e grava nome oficial', async () => {
    const retorno = await executar(banco({ resolvido: { ...tresEmUm, via: 'alias' } }), 'consulta_pos_disponiveis', { trocar_para: '3em1' });
    expect(retorno.status).toBe('interesse_atualizado');
    expect(fronteiras.atualizar).toHaveBeenCalledWith(expect.anything(), contexto.remotejid, { curso_interesse_original: 'REPRODUÇÃO, NUTRIÇÃO E GESTÃO DE BOVINOS (3EM1)' });
  });
  it('não informa atualização quando persistência falha', async () => {
    fronteiras.atualizar.mockRejectedValueOnce(new Error('indisponível'));
    expect(await executar(banco(), 'consulta_pos_disponiveis', { trocar_para: avicola.nome })).toMatchObject({ status: 'erro_atualizar_interesse' });
  });
  it('não grava em modo de teste', async () => {
    expect(await executar(banco(), 'consulta_pos_disponiveis', { trocar_para: avicola.nome }, true)).toMatchObject({ simulado: true });
    expect(fronteiras.atualizar).not.toHaveBeenCalled();
  });
  it('recusa consulta e troca simultâneas', async () => {
    const db = banco();
    expect(await executar(db, 'consulta_pos_disponiveis', { curso_consulta: avicola.nome, trocar_para: bovinos.nome })).toMatchObject({ status: 'entrada_ambigua' });
    expect(db.from).not.toHaveBeenCalled();
  });
  it('falha de catálogo não equivale a curso inexistente', async () => {
    expect(await consultarCatalogo(banco({ erro: true }), avicola.nome)).toMatchObject({ status: 'catalogo_indisponivel' });
  });
  it('exceção de transporte conserva o contrato de falha', async () => {
    const db = banco();
    db.query.order.mockRejectedValueOnce(new Error('falha de rede'));
    expect(await consultarCatalogo(db, avicola.nome)).toMatchObject({ status: 'catalogo_indisponivel', existencia_confirmada: false });
  });
});

describe('roteamento factual e objeções', () => {
  it('modalidade ignora a resposta genérica da base, inclusive com negação de falta de dinheiro', async () => {
    const db = banco({ rag: [{ metadata: { tipo_objecao: 'pergunta_modalidade', resposta: 'A maioria tem semi.' } }] });
    expect(await executar(db, 'consulta_objecoes', { mensagem_lead: 'Não estou sem dinheiro, só quero saber se Sanidade Avícola é online', tipo_objecao: 'pergunta_modalidade', curso_consulta: avicola.nome }))
      .toMatchObject({ status: 'curso_confirmado', curso: { modalidades: ['online'] } });
    expect(fronteiras.fetch).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(['pergunta_preco', 'pergunta_conteudo', 'pergunta_duracao'])('dados de material não vêm de objeção genérica: %s', async tipo => {
    expect(await executar(banco(), 'consulta_objecoes', { mensagem_lead: 'Pode me informar?', tipo_objecao: tipo })).toMatchObject({ resposta_objecao: 'CONSULTAR_MATERIAL' });
    expect(fronteiras.fetch).not.toHaveBeenCalled();
  });
  it.each([{ rag: [] }, { rag: [{ metadata: { tipo_objecao: 'pergunta_modalidade', resposta: 'Todos têm semi' } }] }])('não busca outra categoria quando falta evidência pertinente: %o', async ({ rag }) => {
    const db = banco({ rag });
    expect(await executar(db, 'consulta_objecoes', { mensagem_lead: 'Não consigo pagar', tipo_objecao: 'objecao_financeira' })).toMatchObject({ resposta_objecao: 'CONFIANCA_BAIXA' });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('match_ppg_voyage', expect.objectContaining({ filter: { tipo_objecao: 'pergunta_condicao' } }));
  });
  it('categoria desconhecida não faz busca global', async () => {
    const db = banco();
    expect(await executar(db, 'consulta_objecoes', { mensagem_lead: 'Dúvida', tipo_objecao: 'inventada' })).toMatchObject({ resposta_objecao: 'CONFIANCA_BAIXA' });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fronteiras.fetch).not.toHaveBeenCalled();
  });
  it('falha no provedor não autoriza inventar resposta', async () => {
    fronteiras.fetch.mockRejectedValueOnce(new Error('rede indisponível'));
    expect(await executar(banco(), 'consulta_objecoes', { mensagem_lead: 'Estou sem tempo', tipo_objecao: 'objecao_tempo' })).toMatchObject({ resposta_objecao: 'INDISPONIVEL' });
  });
});

it('descrições preservam ferramentas autorizadas, schemas e regras de reenvio', () => {
  const originais = [{ name: 'consulta_pos_disponiveis', input_schema: {} },
    { name: 'envia_informacoes', description: 'Reenvie se o lead solicitar; confirme pelo status.', input_schema: { required: ['curso_escolhido', 'conteudo'], properties: { curso_escolhido: { type: 'string' }, conteudo: { enum: ['cronograma', 'valor'] } } } }];
  const copia = structuredClone(originais);
  const resultado = descreverToolsSdr(originais);
  expect(originais).toEqual(copia);
  expect(resultado.map(t => t.name)).toEqual(originais.map(t => t.name));
  expect(resultado[1].description).toContain(originais[1].description);
  expect(resultado[1].input_schema.required).toEqual(['curso_escolhido', 'conteudo']);
  expect(resultado[1].input_schema.properties.conteudo.enum).toEqual(['cronograma', 'valor']);
});
