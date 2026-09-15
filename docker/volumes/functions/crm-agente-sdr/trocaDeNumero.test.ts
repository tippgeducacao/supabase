import { describe, expect, it, vi } from 'vitest';

// saida.ts lê Deno.env ao carregar; o stub precisa existir antes do grafo de imports.
vi.hoisted(() => {
  (globalThis as { Deno?: unknown }).Deno = { env: { get: () => '' } };
});

import {
  carregarModoTrocaNumero,
  carregarSinalTrocaDeNumero,
  comNotaNoContexto,
  comNotaParaRouter,
  detectarTrocaDeNumero,
  type LinhaMensagemCrm,
  notaTrocaDeNumero,
  PREFIXO_NOTA_INTERNA,
  resumoDoSinal,
  sinalInerte,
} from './trocaDeNumero';
import { limparParaRouter, type Msg } from './historico';
import { humanizarTexto } from './saida';
import { limparCacheContas } from './conta';

const A = 'conta-a-joao';
const B = 'conta-b-amanda';
const T0 = Date.parse('2026-09-13T12:00:00.000Z');
const em = (minAtras: number) => new Date(T0 - minAtras * 60_000).toISOString();
const linha = (p: Partial<LinhaMensagemCrm> & { conta: string; min: number }): LinhaMensagemCrm => ({
  wa_account_id: p.conta,
  direcao: p.direcao ?? 'inbound',
  tipo: p.tipo ?? 'text',
  template_name: p.template_name ?? null,
  conteudo: p.conteudo ?? null,
  created_at: em(p.min),
  wa_message_id: p.wa_message_id ?? null,
  status_entrega: p.status_entrega ?? 'delivered',
});
// Conversa em A até o lead escolher horário; template de B depois; lead responde em B (no lote).
const conversaEmA = [
  linha({ conta: A, min: 200, direcao: 'outbound', conteudo: 'tenho 10h, 14h ou 15h30, qual funciona?' }),
  linha({ conta: A, min: 190, direcao: 'inbound', conteudo: '15h30 pode ser' }),
];
const templateDeB = linha({ conta: B, min: 120, direcao: 'outbound', tipo: 'template', template_name: 'escola_prorrogacao', conteudo: 'Oi Marta. Foi prorrogado o acesso da Escola por mais 30 dias.' });
const respostaEmB = linha({ conta: B, min: 1, direcao: 'inbound', conteudo: 'Oi, quero saber mais', wa_message_id: 'wamid.lote-1' });

describe('detectarTrocaDeNumero — regra pura', () => {
  it('sem conta atual não decide nada', () => {
    const s = detectarTrocaDeNumero(conversaEmA, null);
    expect(s).toMatchObject({ trocou: false, motivo: 'sem_conta', contaAtual: null });
  });

  it('sem linhas no CRM não decide nada', () => {
    expect(detectarTrocaDeNumero([], B).motivo).toBe('sem_historico_crm');
  });

  it('conversa só nesta conta: não há troca', () => {
    const s = detectarTrocaDeNumero([...conversaEmA, linha({ conta: A, min: 1, wa_message_id: 'wamid.lote-1' })], A, { idsDoLote: ['wamid.lote-1'] });
    expect(s).toMatchObject({ trocou: false, motivo: 'sem_conversa_em_outro_numero', contaAtual: A });
  });

  it('lead respondeu ao template de B depois de conversar em A: trocou, com o template e o gap', () => {
    const s = detectarTrocaDeNumero([...conversaEmA, templateDeB, respostaEmB], B, { idsDoLote: ['wamid.lote-1'], agora: T0 });
    expect(s).toMatchObject({
      trocou: true, motivo: 'trocou', contaAtual: B, contaAnterior: A, gapMin: 190,
      ultimaFalaAnteriorEm: em(190), ultimaFalaAquiEm: null,
      templateAtual: { nome: 'escola_prorrogacao', conteudo: 'Oi Marta. Foi prorrogado o acesso da Escola por mais 30 dias.', em: em(120) },
    });
  });

  it('a mensagem do próprio lote não conta como "conversa aqui" (sem o id ela mascararia a troca)', () => {
    const comId = detectarTrocaDeNumero([...conversaEmA, templateDeB, respostaEmB], B, { idsDoLote: ['wamid.lote-1'] });
    const semId = detectarTrocaDeNumero([...conversaEmA, templateDeB, respostaEmB], B, { idsDoLote: [] });
    expect(comId.trocou).toBe(true);
    expect(semId).toMatchObject({ trocou: false, motivo: 'conversa_continua_aqui' });
  });

  it('João já respondeu em B: a conversa continua aqui, sem nota de novo', () => {
    const respostaDoJoaoEmB = linha({ conta: B, min: 60, direcao: 'outbound', conteudo: 'oi Marta! vi que a gente já se falou...' });
    const s = detectarTrocaDeNumero([...conversaEmA, templateDeB, respostaDoJoaoEmB, respostaEmB], B, { idsDoLote: ['wamid.lote-1'] });
    expect(s).toMatchObject({ trocou: false, motivo: 'conversa_continua_aqui', contaAnterior: A, ultimaFalaAquiEm: em(60) });
  });

  it('lead escreveu em B por conta própria (sem template): trocou, sem templateAtual', () => {
    const s = detectarTrocaDeNumero([...conversaEmA, respostaEmB], B, { idsDoLote: ['wamid.lote-1'] });
    expect(s).toMatchObject({ trocou: true, templateAtual: null, contaAnterior: A });
  });

  it('template que falhou ou saiu antes da última fala aqui não é "o template respondido"', () => {
    const falhado = linha({ conta: B, min: 100, direcao: 'outbound', tipo: 'template', template_name: 'falhou', status_entrega: 'failed' });
    const antigo = linha({ conta: B, min: 900, direcao: 'outbound', tipo: 'template', template_name: 'antigo' });
    const falaAntigaEmB = linha({ conta: B, min: 800, direcao: 'inbound', conteudo: 'ok' });
    const s = detectarTrocaDeNumero([antigo, falaAntigaEmB, ...conversaEmA, falhado, respostaEmB], B, { idsDoLote: ['wamid.lote-1'] });
    expect(s.trocou).toBe(true);
    expect(s.templateAtual).toBeNull();
    expect(s.ultimaFalaAquiEm).toBe(em(800));
  });

  it('saída de texto que falhou não é fala; template não é fala', () => {
    const textoFalhou = linha({ conta: A, min: 50, direcao: 'outbound', conteudo: 'x', status_entrega: 'failed' });
    const soTemplateEmA = linha({ conta: A, min: 40, direcao: 'outbound', tipo: 'template', template_name: 't' });
    const falaEmB = linha({ conta: B, min: 300, direcao: 'inbound', conteudo: 'oi' });
    const s = detectarTrocaDeNumero([textoFalhou, soTemplateEmA, falaEmB, respostaEmB], B, { idsDoLote: ['wamid.lote-1'] });
    // A só tem template e uma saída falhada: ninguém conversou lá → não é troca.
    expect(s).toMatchObject({ trocou: false, motivo: 'sem_conversa_em_outro_numero' });
  });

  it('conta de outro agente (aluno/rh) não conta como conversa anterior', () => {
    const personas = new Map<string, string | null>([['conta-3250', 'aluno'], [B, 'qualificador']]);
    const conversaNoAluno = linha({ conta: 'conta-3250', min: 30, direcao: 'inbound', conteudo: 'cadê minha aula?' });
    const s = detectarTrocaDeNumero([conversaNoAluno, templateDeB, respostaEmB], B, { idsDoLote: ['wamid.lote-1'], personas });
    expect(s).toMatchObject({ trocou: false, motivo: 'sem_conversa_em_outro_numero' });
  });

  it('linhas fora de ordem são reordenadas e contasNoLote é repassado', () => {
    const s = detectarTrocaDeNumero([respostaEmB, templateDeB, ...conversaEmA].reverse(), B, { idsDoLote: ['wamid.lote-1'], contasNoLote: 2 });
    expect(s.trocou).toBe(true);
    expect(s.contasNoLote).toBe(2);
    expect(resumoDoSinal(s)).toMatchObject({ trocou: true, conta_anterior: A, template_na_troca: 'escola_prorrogacao', contas_no_lote: 2 });
  });
});

describe('nota interna e encaixe no router/contexto', () => {
  const sinal = { ...sinalInerte(B, 1, 'trocou'), trocou: true, contaAnterior: A, gapMin: 3 * 24 * 60,
    templateAtual: { nome: 'escola_prorrogacao', conteudo: 'Oi Marta.\n\nFoi prorrogado o acesso da Escola por mais 30 dias.', em: em(120) } };
  const contas = {
    atual: { id: B, persona: 'qualificador', nome: 'Amanda PPGVET', numero_display: '46 9 9901-3539' },
    anterior: { id: A, persona: 'qualificador', nome: 'IA SDR', numero_display: '+55 46 9970-8477' },
  };

  it('a nota nomeia as contas, o template respondido, o gap e a postura transparente', () => {
    const nota = notaTrocaDeNumero(sinal, contas, { agendado: false });
    expect(nota.startsWith(PREFIXO_NOTA_INTERNA)).toBe(true);
    expect(nota).toContain('chegou pelo número «Amanda PPGVET» (final 3539), e é por ele');
    expect(nota).toContain('por OUTRO número da PPGVET, «IA SDR» (final 8477), há 3 dias.');
    expect(nota).toContain('há 3 dias');
    expect(nota).toContain('Foi prorrogado o acesso da Escola por mais 30 dias.');
    expect(nota).toContain('já tinha conversado com ele por outro número');
    expect(nota).toContain('NÃO estão pendentes aqui');
    expect(nota).toContain('Não há reunião confirmada');
    expect(nota).not.toContain('\n\n');
  });

  it('reunião confirmada e lead espontâneo mudam as frases certas', () => {
    const nota = notaTrocaDeNumero({ ...sinal, templateAtual: null, gapMin: 40 }, { atual: null, anterior: null }, { agendado: true });
    expect(nota).toContain('reunião CONFIRMADA');
    expect(nota).toContain('escreveu aqui por conta própria');
    expect(nota).toContain('há 40 minutos');
    // Contas desconhecidas: a frase muda de forma em vez de repetir "outro número".
    expect(nota).toContain('Esta mensagem chegou por este número, e é por ele');
    expect(nota).toContain('aconteceu por OUTRO número da PPGVET, há 40 minutos.');
  });

  it('comNotaParaRouter insere a nota depois do último assistant e limparParaRouter funde com a fala do lead', () => {
    const historico: Msg[] = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: [{ type: 'text', text: 'tenho 15h30, funciona?' }] },
      { role: 'user', content: 'Oi, quero saber mais' },
    ];
    const nota = notaTrocaDeNumero(sinal, contas, { agendado: false });
    const comNota = comNotaParaRouter(historico, nota);
    expect(comNota).toHaveLength(4);
    expect(comNota[2]).toEqual({ role: 'user', content: nota });
    expect(historico).toHaveLength(3); // não muta o original
    const limpo = limparParaRouter(comNota);
    expect(limpo[0].role).toBe('user');
    expect(limpo.at(-1)).toEqual({ role: 'user', content: `${nota}\nOi, quero saber mais` });
    expect(comNotaParaRouter(historico, null)).toEqual(historico);
    // Sem assistant nenhum: a nota abre a conversa, antes da fala do lead.
    expect(comNotaParaRouter([{ role: 'user', content: 'oi' }], 'N')[0]).toEqual({ role: 'user', content: 'N' });
  });

  it('comNotaNoContexto só apensa quando há nota', () => {
    expect(comNotaNoContexto('ctx', null)).toBe('ctx');
    expect(comNotaNoContexto('ctx', 'N')).toBe('ctx\n\nN');
  });

  it('se o modelo ecoar a nota, o humanizador descarta o balão', () => {
    const nota = notaTrocaDeNumero(sinal, contas, { agendado: false });
    const saida = humanizarTexto(`${nota}\n\noi Marta, tudo bem?`);
    expect(saida).not.toContain('NOTA INTERNA');
    expect(saida).toContain('oi Marta, tudo bem?');
  });
});

describe('leituras no banco (fail-open)', () => {
  const config = (data: unknown, error: unknown = null) => ({
    from: (tabela: string) => {
      expect(tabela).toBe('crm_agente_sdr_config');
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) };
    },
  });

  it('modo: ativo/sombra valem; qualquer outra coisa (inclusive erro ou coluna ausente) vira off', async () => {
    expect(await carregarModoTrocaNumero(config({ troca_numero_modo: 'ativo' }))).toBe('ativo');
    expect(await carregarModoTrocaNumero(config({ troca_numero_modo: 'sombra' }))).toBe('sombra');
    expect(await carregarModoTrocaNumero(config({ troca_numero_modo: 'ligado' }))).toBe('off');
    expect(await carregarModoTrocaNumero(config({ teste_telefones: [] }))).toBe('off');
    expect(await carregarModoTrocaNumero(config(null, { message: 'coluna não existe' }))).toBe('off');
    expect(await carregarModoTrocaNumero({ from: () => { throw new Error('sem banco'); } })).toBe('off');
  });

  function bancoComMensagens(linhas: LinhaMensagemCrm[] | null, error: unknown = null) {
    const consulta = vi.fn();
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'not', 'order']) q[m] = (...args: unknown[]) => { consulta(m, ...args); return q; };
    q.limit = async () => ({ data: linhas, error });
    return {
      consulta,
      from: (tabela: string) => tabela === 'crm_whatsapp_messages'
        ? q
        : { select: async () => ({ data: [{ id: B, agente_ia_persona: 'qualificador', nome: 'Amanda PPGVET', numero_display: '46 9 9901-3539' }, { id: A, agente_ia_persona: 'qualificador', nome: 'IA SDR', numero_display: '8477' }], error: null }) },
    };
  }

  it('sinal: consulta por variantes do telefone, ignora o lote e devolve a troca', async () => {
    limparCacheContas();
    const banco = bancoComMensagens([...conversaEmA, templateDeB, respostaEmB]);
    const s = await carregarSinalTrocaDeNumero(banco, { telefone: '5546999013539', contaAtual: B, itens: [{ msg_id: 'wamid.lote-1' }], contasNoLote: 1 });
    expect(s).toMatchObject({ trocou: true, contaAnterior: A, templateAtual: { nome: 'escola_prorrogacao' } });
    const chamadas = banco.consulta.mock.calls.map((c) => c[0]);
    expect(chamadas).toEqual(['select', 'in', 'not', 'order']);
    const variantes = banco.consulta.mock.calls.find((c) => c[0] === 'in')![2] as string[];
    expect(variantes).toContain('5546999013539');
    expect(variantes).toContain('4699013539');
  });

  it('sinal: sem conta atual não consulta; erro na consulta é fail-open', async () => {
    const banco = bancoComMensagens(null, { message: 'timeout' });
    expect(await carregarSinalTrocaDeNumero(banco, { telefone: '5546999013539', contaAtual: null, itens: [], contasNoLote: 1 })).toMatchObject({ trocou: false, motivo: 'sem_conta' });
    expect(banco.consulta).not.toHaveBeenCalled();
    expect(await carregarSinalTrocaDeNumero(banco, { telefone: '5546999013539', contaAtual: B, itens: [], contasNoLote: 1 })).toMatchObject({ trocou: false, motivo: 'erro_consulta', contaAtual: B });
  });
});
