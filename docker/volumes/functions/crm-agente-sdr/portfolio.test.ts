import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bloqueioCronograma, SCRIPT_ANTES_DO_PORTFOLIO, type AvaliacaoFicha } from './fichaAtendimento';
import { AGENTE_AULA } from './prompts-aula';

// portfolio.ts lê Deno.env no import (mesmo padrão de saida.ts): importa depois do stub.
let enviarPortfolio: typeof import('./portfolio').enviarPortfolio;
let resultadoPortfolio: typeof import('./portfolio').resultadoPortfolio;
let pedidoDePortfolio: typeof import('./portfolio').pedidoDePortfolio;
let passoAulaSemPos: typeof import('./portfolio').passoAulaSemPos;
let FALA_DEPOIS_DO_PORTFOLIO: string;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => undefined } });
  ({ enviarPortfolio, resultadoPortfolio, FALA_DEPOIS_DO_PORTFOLIO, pedidoDePortfolio, passoAulaSemPos } = await import('./portfolio'));
});

// Aula MVP (28/09/2026): o portfólio sai de verdade pelo WhatsApp e a formação vem antes.
const ctx = { remotejid: '5546988166051@s.whatsapp.net', telefone: '5546988166051', waAccountId: 'conta-1', leadId: 'lead-1', oportunidadeId: null };

describe('envio do portfólio', () => {
  it('manda o PDF como documento pela conta da conversa e devolve a frase exata', async () => {
    const enviar = vi.fn(async () => new Response(JSON.stringify({ success: true, wa_message_id: 'wamid.1' }), { status: 200 }));
    const r = await enviarPortfolio(ctx as any, 'tu_1', enviar as any);
    const corpo = JSON.parse((enviar.mock.calls[0] as any[])[1].body);
    expect(corpo).toMatchObject({ telefone: '5546988166051', tipo: 'document', mime_type: 'application/pdf', wa_account_id: 'conta-1' });
    expect(String(corpo.anexo_url)).toMatch(/Portifolio_2026\.pdf$/);
    expect(r).toMatchObject({ id: 'tu_1', portfolio_enviado: true });
    expect(String(r.resultado)).toContain(FALA_DEPOIS_DO_PORTFOLIO);
  });

  it('falha no envio não vira "te enviei"', async () => {
    const enviar = vi.fn(async () => new Response('erro', { status: 500 }));
    const r = await enviarPortfolio(ctx as any, 'tu_2', enviar as any);
    expect(r).toMatchObject({ portfolio_enviado: false, status: 'falhou' });
    expect(String(r.resultado)).toContain('NÃO foi enviado');
  });

  it('no webchat não tenta mandar PDF', async () => {
    const enviar = vi.fn();
    const r = await enviarPortfolio({ ...ctx, canal: 'webchat' } as any, 'tu_3', enviar as any);
    expect(enviar).not.toHaveBeenCalled();
    expect(r.portfolio_enviado).toBe(false);
  });
});

describe('formação antes do portfólio', () => {
  const falta = { semGraduacao: false, faltaParaCronograma: ['qual é a graduação dele'] } as unknown as AvaliacaoFicha;
  it('a trava do portfólio fala de portfólio e usa a frase aprovada', () => {
    const r = bloqueioCronograma('x', falta, 'portfolio');
    expect(r.resultado).toContain('o portfólio NÃO foi enviado');
    expect(r.instrucao).toContain(SCRIPT_ANTES_DO_PORTFOLIO);
    expect(r.instrucao).not.toContain('cronograma completo');
  });
  it('a trava do cronograma continua como antes', () => {
    expect(bloqueioCronograma('x', falta).resultado).toContain('o cronograma NÃO foi enviado');
  });
});

describe('roteiro da aula MVP', () => {
  it('traz as frases aprovadas', () => {
    expect(AGENTE_AULA).toContain('sobre o tema dessa aula a gente ainda não tem uma pós específica, mas temos o nosso catálogo com todas as pós e mbas da ppgvet. quer que eu te mande pra vc dar uma olhada?');
    expect(AGENTE_AULA).toContain(SCRIPT_ANTES_DO_PORTFOLIO);
    expect(AGENTE_AULA).toContain(FALA_DEPOIS_DO_PORTFOLIO);
    expect(resultadoPortfolio('i', { ok: true }).resultado).toContain('consulta_pos_disponiveis');
  });
});

// Simulador (28/09): Claude trocou os campos; Luna listou as pós em texto em vez de mandar o PDF.
describe('aula MVP: portfólio no ponto de uso', () => {
  it('curso_escolhido="portfolio" conta como pedido de portfólio, mesmo com conteudo="cronograma"', () => {
    expect(pedidoDePortfolio({ conteudo: 'cronograma', curso_escolhido: 'portfolio' })).toBe(true);
    expect(pedidoDePortfolio({ conteudo: 'portfolio', curso_escolhido: 'x' })).toBe(true);
    expect(pedidoDePortfolio({ conteudo: 'cronograma', curso_escolhido: 'Nutrição e Gestão de Bovinos' })).toBe(false);
  });
  it('com a formação registrada, o retorno manda chamar o portfólio agora', () => {
    const passo = passoAulaSemPos({ formacao: 'Agronomia', graduacao_concluida: 'sim' });
    expect(passo).toContain('conteudo="portfolio"');
    expect(passo).toContain('não liste as pós em texto');
  });
  it('sem graduação, ou só nome, não empurra portfólio', () => {
    expect(passoAulaSemPos({ graduacao_concluida: 'nao' })).toBe('');
    expect(passoAulaSemPos({ nome: 'Carla' })).toBe('');
  });
});
