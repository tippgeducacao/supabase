import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { consultarCatalogo } from './catalogoCursos';
import { consultarCursosLivresVenda, CURSOS_LIVRES_VENDA, INSTRUCAO_CURSOS_LIVRES_VENDA, ultimoCursoLivreDeclarado } from './cursosLivresVenda';
import { valoresInventados } from './travasDeterministicas';

beforeAll(() => vi.stubGlobal('Deno', { env: { get: () => '' } }));
afterAll(() => vi.unstubAllGlobals());

describe('três cursos livres confirmados pela gestão', () => {
  it('lista os três cursos sem aplicar filtro de pós para quem pergunta por opções sem graduação', async () => {
    const db = { from: vi.fn(), rpc: vi.fn() };
    const r = await consultarCatalogo(db as any, 'cursos livres');
    expect(r).toMatchObject({ status: 'cursos_livres_disponiveis', cursos: expect.arrayContaining(CURSOS_LIVRES_VENDA.map(c => expect.objectContaining({ id: c.id, exige_graduacao: false }))) });
    expect(db.from).not.toHaveBeenCalled();
  });

  it('catálogo de pós fora do ar não apaga a oferta de livres confirmada pela gestão', async () => {
    const db = { from: vi.fn(() => { throw new Error('indisponível'); }), rpc: vi.fn() };
    const r = await consultarCatalogo(db as any);
    expect(r).toMatchObject({ status: 'catalogo_indisponivel', cursos_livres: expect.arrayContaining(CURSOS_LIVRES_VENDA.map(c => expect.objectContaining({ id: c.id }))) });
  });

  it('falha da matriz de pós não bloqueia a informação de curso livre', async () => {
    const { executarTool } = await import('./tools');
    const db = { from: vi.fn(), rpc: vi.fn() };
    const r = await executarTool(db, { id: 't', name: 'verificar_compatibilidade_curso', input: { curso_interesse: 'Curso de Cannabis Medicinal', formacao_academica: 'Sem formação superior' } }, { remotejid: 'teste', telefone: 'teste', waAccountId: null, leadId: null, oportunidadeId: null, ficha: { inicioRodada: '2026-11-16T12:00:00Z' }, compatibilidadeIndisponivel: true });
    expect(r).toMatchObject({ status: 'curso_livre_confirmado', pode_cursar: true });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(CURSOS_LIVRES_VENDA)('responde catálogo, preço e acesso sem consultar somente pós: $nome', async curso => {
    const db = { from: vi.fn(), rpc: vi.fn() };
    const r = await consultarCatalogo(db as any, curso.nome);
    expect(r).toMatchObject({ status: 'curso_livre_confirmado', curso: { tipo: 'curso_livre', exige_graduacao: false, valor_informado: 'R$ 492,50', checkout: null } });
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(['CURSO | GESTÃO EXTRATÉGICA DE FAZENDAS LEITEIRAS', 'CURSO | DESENVOLVIMENTO EM AMBIÊNCIA, MANEJO E SANIDADE DE FRANGOS DE CORTE', 'CURSO | CANNABIS', 'Curso de Desenvolvimento | Cannabis Medicinal'])('reconhece os nomes legados: %s', nome => {
    expect(consultarCursosLivresVenda(nome)).toMatchObject({ status: 'curso_livre_confirmado' });
  });

  it.each(['Cannabis', 'Cannabis Medicinal'])('esclarece produto ambíguo antes de aplicar preço/requisito: %s', nome => {
    expect(consultarCursosLivresVenda(nome)).toMatchObject({ status: 'produto_ambiguo' });
  });

  it.each(['PÓS | CANNABIS MEDICINAL VETERINÁRIA', 'Pós em Cannabis Medicinal', 'Especialização em Gestão Estratégica de Fazendas Leiteiras', 'Curso de Nutrição de Frangos', 'Curso inventado'])('não estende preço ou dispensa de formação a outro produto: %s', nome => {
    expect(consultarCursosLivresVenda(nome)).toBeNull();
  });

  it.each(CURSOS_LIVRES_VENDA)('compatibilidade não chama matriz nem grava aprovação de pós: $nome', async curso => {
    const { executarTool } = await import('./tools');
    const db = { from: vi.fn(), rpc: vi.fn() };
    const r = await executarTool(db, { id: 't', name: 'verificar_compatibilidade_curso', input: { curso_interesse: curso.nome, formacao_academica: 'Sem formação superior' } }, { remotejid: 'teste', telefone: 'teste', waAccountId: null, leadId: null, oportunidadeId: null });
    expect(r).toMatchObject({ status: 'curso_livre_confirmado', pode_cursar: true });
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it.each(CURSOS_LIVRES_VENDA)('informações dispensam ficha acadêmica, sem alegar PDF enviado: $nome', async curso => {
    const { executarTool } = await import('./tools');
    const db = { from: vi.fn(), rpc: vi.fn() };
    const r = await executarTool(db, { id: 't', name: 'envia_informacoes', input: { curso_escolhido: curso.nome, conteudo: 'cronograma_e_valor' } }, { remotejid: 'teste', telefone: 'teste', waAccountId: null, leadId: null, oportunidadeId: null, ficha: { inicioRodada: '2026-11-16T12:00:00Z' } });
    expect(r).toMatchObject({ status: 'curso_livre_confirmado', material_enviado: false });
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(valoresInventados('o curso tem valor informado de R$ 492,50', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: JSON.stringify(r) }] }])).toEqual([]);
  });

  it.each(CURSOS_LIVRES_VENDA)('bloqueia arquivamento por falta de graduação no curso aberto: $nome', async curso => {
    const { executarTool } = await import('./tools');
    const db = { from: vi.fn(), rpc: vi.fn() };
    const historicoConversa = [{ role: 'user' as const, content: `Quero o curso de ${curso.nome}. Não tenho graduação.` }];
    const r = await executarTool(db, { id: 't', name: 'pausa_ia', input: { tipo: 'sem_graduacao', motivo: 'Sem graduação' } }, { remotejid: 'teste', telefone: 'teste', waAccountId: null, leadId: null, oportunidadeId: null, historicoConversa });
    expect(r).toMatchObject({ status: 'pausa_bloqueada_curso_livre' });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('interesse recente na pós ou recusa impede herdar o curso livre antigo', () => {
    expect(ultimoCursoLivreDeclarado(['Quero o curso de Cannabis Medicinal', 'Agora quero a pós em Cannabis Medicinal Veterinária'])).toBeNull();
    expect(ultimoCursoLivreDeclarado(['Quero Gestão Estratégica de Fazendas Leiteiras', 'Não quero mais esse curso'])).toBeNull();
  });

  it('contexto de produtos chega ao pedido principal e router; ensaio substituto preserva suas regras', async () => {
    const { montarPedidoPrincipal, pedidoRouter } = await import('./agente');
    const base = { promptAgente: 'Persona', tools: [], comFicha: true, messages: [{ role: 'user' as const, content: 'Quais cursos aceitam quem não tem graduação?' }] };
    const r = montarPedidoPrincipal(base);
    expect(r.pedido.system.filter((b: any) => b.text === INSTRUCAO_CURSOS_LIVRES_VENDA)).toHaveLength(1);
    expect((pedidoRouter(base.messages).system as any[]).some(b => b.text === INSTRUCAO_CURSOS_LIVRES_VENDA)).toBe(true);
    expect(montarPedidoPrincipal({ ...base, regrasSubstitutas: 'ensaio independente' }).pedido.system.some((b: any) => b.text === INSTRUCAO_CURSOS_LIVRES_VENDA)).toBe(false);
  });
});
