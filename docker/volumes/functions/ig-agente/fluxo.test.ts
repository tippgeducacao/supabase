import { describe, expect, it } from 'vitest';
import {
  type Classificacao, decidirPasso, type EtapaFluxo, etapaCrmInstagram, extrairTelefoneBR, LINK_ESCOLA,
  primeiroNomeConfiavel, TEXTOS,
} from './fluxo';

// Relógio fixo: o corte de "Na graduação" é a régua do João (hoje 31/01/2027) e muda com o tempo.
const AGORA = new Date('2026-09-25T12:00:00Z');

const cls = (p: Partial<Classificacao> = {}): Classificacao => ({
  intencao: 'outro', situacao: 'nao_informou', area: null, telefone: null, conclusao: null, resposta_pergunta: null, ...p,
});
const ctx = (p: { nomePerfil?: string | null; textoNovo?: string; tentativas?: number } = {}) => ({
  nomePerfil: 'Gustavo Sutil', textoNovo: '', tentativas: 0, agora: AGORA, ...p,
});
const passo = (etapa: EtapaFluxo, c: Partial<Classificacao>, x: Parameters<typeof ctx>[0] = {}) =>
  decidirPasso(etapa, cls(c), ctx(x));

describe('caminho feliz do diretor comercial (25/09/2026)', () => {
  it('"tudo sim" → formação → "sou vet" → portfólio? → "sim" → WhatsApp → número', () => {
    const p1 = passo('boas_vindas', { intencao: 'outro' });
    expect(p1).toMatchObject({ mensagens: ['Gustavo, você já se formou e tá trabalhando, ou ainda tá na graduação?'], proximaEtapa: 'pergunta_formacao' });

    const p2 = passo('pergunta_formacao', { situacao: 'formado', area: 'medicina veterinária' });
    expect(p2).toMatchObject({
      mensagens: ['Você tem interesse em conhecer as nossas pós-graduações? Te encaminho o nosso portfólio pra você olhar com calma?'],
      proximaEtapa: 'pergunta_interesse', situacao: 'formado', area: 'medicina veterinária',
    });

    const p3 = passo('pergunta_interesse', { intencao: 'aceita' });
    expect(p3).toMatchObject({
      mensagens: ['Não consigo encaminhar o PDF pelo Insta. Me passa seu WhatsApp com DDD que te mando por lá?'],
      proximaEtapa: 'pergunta_whatsapp',
    });

    const p4 = passo('pergunta_whatsapp', {}, { textoNovo: '46 9 9988-2268' });
    expect(p4).toMatchObject({
      // 25/09: no WhatsApp sai o RECIBO; o PDF vai quando a pessoa responde lá.
      mensagens: ['Prontinho! Acabei de te mandar uma mensagem no WhatsApp, do número (46) 9 9901-2001. É só responder qualquer coisa lá que eu te envio o portfólio em PDF 😉'],
      proximaEtapa: 'whatsapp_enviado', telefone: '5546999882268', enviarWhatsapp: true,
    });
  });
});

describe('boas_vindas: a pessoa respondeu o "Oii, tudo bem?"', () => {
  it('nome que não é de gente fica de fora', () => {
    expect(passo('boas_vindas', {}, { nomePerfil: 'JS MIMOS' }).mensagens)
      .toEqual(['Você já se formou e tá trabalhando, ou ainda tá na graduação?']);
  });

  it('já disse que é estudante → pergunta quando se forma', () => {
    expect(passo('boas_vindas', { situacao: 'estudante' })).toMatchObject({
      mensagens: [TEXTOS.perguntaDataFormacao], proximaEtapa: 'pergunta_data_formacao', situacao: 'estudante',
    });
  });

  it('já disse que é formado → pula direto para a pergunta do portfólio', () => {
    expect(passo('boas_vindas', { situacao: 'formado' })).toMatchObject({
      mensagens: [TEXTOS.perguntaInteresse], proximaEtapa: 'pergunta_interesse', situacao: 'formado',
    });
  });

  it('pergunta antes de tudo → responde e faz a pergunta da formação', () => {
    expect(passo('boas_vindas', { intencao: 'pergunta', resposta_pergunta: 'Somos a PPGVET!' }).mensagens)
      .toEqual(['Somos a PPGVET!', TEXTOS.perguntaFormacao('Gustavo')]);
  });

  it('não quer papo → despedida e encerra', () => {
    expect(passo('boas_vindas', { intencao: 'recusa' })).toMatchObject({ mensagens: [TEXTOS.recusa], proximaEtapa: 'encerrada' });
  });
});

describe('pergunta_formacao', () => {
  it('formado de área fora do catálogo também segue (tem MBA e extensão)', () => {
    expect(passo('pergunta_formacao', { situacao: 'formado', area: 'direito' }).proximaEtapa).toBe('pergunta_interesse');
  });

  it('nem formado nem estudante → link da Escola, sem CRM', () => {
    const p = passo('pergunta_formacao', { situacao: 'nenhum' });
    expect(p).toMatchObject({ mensagens: [TEXTOS.escola], proximaEtapa: 'escola_enviada' });
    expect(p.mensagens[0]).toContain(LINK_ESCOLA);
    expect(p.mensagens[0]).toContain('mais de 10 cursos');
    expect(p.enviarWhatsapp).toBeUndefined();
  });

  it('resposta vaga → repergunta UMA vez; na segunda, manda a Escola', () => {
    expect(passo('pergunta_formacao', {}, { tentativas: 0 })).toMatchObject({
      mensagens: [TEXTOS.reperguntarFormacao], proximaEtapa: 'pergunta_formacao', tentativas: 1,
    });
    expect(passo('pergunta_formacao', {}, { tentativas: 1 })).toMatchObject({
      mensagens: [TEXTOS.escola], proximaEtapa: 'escola_enviada',
    });
  });
});

describe('pergunta_data_formacao (estudante)', () => {
  it('estudante → "E você se forma quando? Me fala o mês e o ano 😊"', () => {
    expect(passo('pergunta_formacao', { situacao: 'estudante' })).toMatchObject({
      mensagens: ['E você se forma quando? Me fala o mês e o ano 😊'], proximaEtapa: 'pergunta_data_formacao', situacao: 'estudante',
    });
  });

  it('estudante que já diz a data junto não é perguntado de novo', () => {
    expect(passo('pergunta_formacao', { situacao: 'estudante' }, { textoNovo: 'faço vet, me formo em julho de 2027' })).toMatchObject({
      mensagens: [TEXTOS.perguntaInteresse], proximaEtapa: 'pergunta_interesse', situacao: 'estudante', dataFormacao: '2027-07-31',
    });
  });

  it.each([
    ['julho de 2027', '2027-07-31'],
    ['12/2026', '2026-12-31'],
    ['termino em 2028', '2028-12-31'],
    ['dezembro', '2026-12-31'],
  ])('"%s" → grava o último dia do mês (%s) e pergunta do portfólio', (texto, data) => {
    expect(passo('pergunta_data_formacao', {}, { textoNovo: texto })).toMatchObject({
      mensagens: [TEXTOS.perguntaInteresse], proximaEtapa: 'pergunta_interesse', dataFormacao: data,
    });
  });

  it('"tô no 7º período" é posição no curso, não data → pergunta mês e ano UMA vez', () => {
    expect(passo('pergunta_data_formacao', {}, { textoNovo: 'tô no 7º período' })).toMatchObject({
      mensagens: [TEXTOS.reperguntarDataFormacao], proximaEtapa: 'pergunta_data_formacao', tentativas: 1,
    });
  });

  it('posição no curso ganha do que o modelo "achou" (caso Edinara do João)', () => {
    expect(passo('pergunta_data_formacao', { conclusao: '12/2026' }, { textoNovo: '2 semestre' }).dataFormacao).toBeUndefined();
  });

  it('o que o modelo entendeu vale quando o texto não fecha data', () => {
    expect(passo('pergunta_data_formacao', { conclusao: '07/2027' }, { textoNovo: 'no meio do ano que vem' }).dataFormacao)
      .toBe('2027-07-31');
  });

  it('depois de uma repergunta sem data, segue para o portfólio sem travar', () => {
    const p = passo('pergunta_data_formacao', {}, { textoNovo: 'não sei ainda', tentativas: 1 });
    expect(p).toMatchObject({ mensagens: [TEXTOS.perguntaInteresse], proximaEtapa: 'pergunta_interesse' });
    expect(p.dataFormacao).toBeUndefined();
  });
});

describe('etapaCrmInstagram: em qual etapa do 1.5 INSTAGRAM', () => {
  it.each([
    ['formado', null, 'Formados'],
    ['estudante', '2026-12-31', 'Na graduação'],
    ['estudante', '2027-01-31', 'Na graduação'],
    ['estudante', '2027-02-28', 'Forma em 2027/06'],
    ['estudante', '2027-07-31', 'Forma em 2027/06'],
    ['estudante', '2027-08-31', 'Forma em 2028/01'],
    ['estudante', '2027-12-31', 'Forma em 2028/01'],
    ['estudante', '2028-01-31', 'Forma em 2028/01'],
    ['estudante', '2028-06-30', 'Forma em 2028/06'],
    ['estudante', '2028-12-31', 'Forma em 2029/01'],
    ['estudante', '2031-06-30', 'Forma em 2031/06'],
    ['estudante', '2031-12-31', 'Forma depois de 2031/06'],
    ['estudante', '2033-06-30', 'Forma depois de 2031/06'],
    ['estudante', null, 'Na graduação'],
  ])('%s, %s → %s', (situacao, data, esperada) => {
    expect(etapaCrmInstagram(situacao, data, AGORA)).toBe(esperada);
  });
});

describe('pergunta_interesse (o portfólio)', () => {
  it('não quer → despedida e encerra', () => {
    expect(passo('pergunta_interesse', { intencao: 'recusa' })).toMatchObject({ mensagens: [TEXTOS.recusa], proximaEtapa: 'encerrada' });
  });

  it('"quero, meu zap é …" → captura na hora, sem pedir de novo', () => {
    expect(passo('pergunta_interesse', { intencao: 'aceita' }, { textoNovo: 'quero, meu zap é (46) 99988-2268' })).toMatchObject({
      mensagens: [TEXTOS.confirmacaoWhatsapp], proximaEtapa: 'whatsapp_enviado', telefone: '5546999882268', enviarWhatsapp: true,
    });
  });

  it('pergunta → responde e refaz a pergunta do portfólio', () => {
    expect(passo('pergunta_interesse', { intencao: 'pergunta', resposta_pergunta: 'Temos especializações e MBAs.' }, { tentativas: 2 }).mensagens)
      .toEqual(['Temos especializações e MBAs.', TEXTOS.perguntaInteresse]);
  });

  it('resposta solta → refaz UMA vez, depois espera calado', () => {
    expect(passo('pergunta_interesse', {}, { tentativas: 0 }).mensagens).toEqual([TEXTOS.perguntaInteresse]);
    expect(passo('pergunta_interesse', {}, { tentativas: 1 }).mensagens).toEqual([]);
  });
});

describe('pergunta_whatsapp', () => {
  it('número incompleto → pede de novo', () => {
    expect(passo('pergunta_whatsapp', {}, { textoNovo: '99988-2268' })).toMatchObject({
      mensagens: [TEXTOS.telefoneInvalido], proximaEtapa: 'pergunta_whatsapp',
    });
  });

  it('número que só o classificador entendeu também vale', () => {
    expect(passo('pergunta_whatsapp', { telefone: '46999882268' }, { textoNovo: 'quarenta e seis...' }).telefone).toBe('5546999882268');
  });

  it('não quer passar → resposta provisória e encerra (decisão do comercial em aberto)', () => {
    expect(passo('pergunta_whatsapp', { intencao: 'recusa' })).toMatchObject({ mensagens: [TEXTOS.recusaWhatsapp], proximaEtapa: 'encerrada' });
  });

  it('conversa solta → relembra UMA vez, depois espera calado', () => {
    expect(passo('pergunta_whatsapp', {}, { tentativas: 0 }).mensagens).toEqual([TEXTOS.relembrarWhatsapp]);
    expect(passo('pergunta_whatsapp', {}, { tentativas: 1 }).mensagens).toEqual([]);
  });
});

describe('fim do roteiro', () => {
  it.each(['escola_enviada', 'whatsapp_enviado', 'encerrada'] as const)('%s: só responde pergunta', (etapa) => {
    expect(passo(etapa, { intencao: 'outro', situacao: 'formado' })).toMatchObject({ mensagens: [], proximaEtapa: etapa });
    expect(passo(etapa, { intencao: 'pergunta', resposta_pergunta: 'Claro!' }).mensagens).toEqual(['Claro!']);
  });
});

describe('primeiroNomeConfiavel', () => {
  it.each([
    ['Gustavo Sutil', 'Gustavo'],
    ['Geórgia Sampaio | Vet em formação | 10⁰ semestre 🎓', 'Geórgia'],
    ['JS MIMOS', null],
    ["JHORRAN BARBER'S SHOP", null],
    ['Dra. Ana', null],
    ['Clinica Veterinária Bicho Bom', null],
    ['sutil_gu', null],
    ['', null],
    [null, null],
  ])('%s → %s', (nome, esperado) => {
    expect(primeiroNomeConfiavel(nome)).toBe(esperado);
  });
});

describe('extrairTelefoneBR', () => {
  it.each([
    ['46 9 9988-2268', '5546999882268'],
    ['(46) 99988-2268', '5546999882268'],
    ['+55 46 99988-2268', '5546999882268'],
    ['5546999882268', '5546999882268'],
    ['meu numero é 4699882268', '554699882268'],
    ['99988-2268', null],
    ['06 99988-2268', null],
    ['sou formado em 2019', null],
    ['', null],
  ])('%s → %s', (texto, esperado) => {
    expect(extrairTelefoneBR(texto)).toBe(esperado);
  });
});
