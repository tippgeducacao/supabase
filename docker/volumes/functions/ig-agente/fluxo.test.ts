import { describe, expect, it } from 'vitest';
import {
  type Classificacao, decidirPasso, type EtapaFluxo, extrairTelefoneBR, LINK_ESCOLA,
  primeiroNomeConfiavel, TEXTOS,
} from './fluxo';

const cls = (p: Partial<Classificacao> = {}): Classificacao => ({
  intencao: 'outro', situacao: 'nao_informou', area: null, telefone: null, resposta_pergunta: null, ...p,
});
const ctx = (p: { nomePerfil?: string | null; textoNovo?: string; tentativas?: number } = {}) => ({
  nomePerfil: 'Gustavo Sutil', textoNovo: '', tentativas: 0, ...p,
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
      mensagens: ['Prontinho! Te mandei o portfólio lá no WhatsApp 😉'],
      proximaEtapa: 'whatsapp_enviado', telefone: '5546999882268', enviarWhatsapp: true,
    });
  });
});

describe('boas_vindas: a pessoa respondeu o "Oii, tudo bem?"', () => {
  it('nome que não é de gente fica de fora', () => {
    expect(passo('boas_vindas', {}, { nomePerfil: 'JS MIMOS' }).mensagens)
      .toEqual(['Você já se formou e tá trabalhando, ou ainda tá na graduação?']);
  });

  it('já disse que é estudante → pula direto para a pergunta do portfólio', () => {
    expect(passo('boas_vindas', { situacao: 'estudante' })).toMatchObject({
      mensagens: [TEXTOS.perguntaInteresse], proximaEtapa: 'pergunta_interesse', situacao: 'estudante',
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
