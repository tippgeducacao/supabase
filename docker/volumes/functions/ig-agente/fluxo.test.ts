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

describe('boas_vindas: a pessoa respondeu a oferta do ManyChat', () => {
  it('quero → "Te envio sim!" + pergunta da formação, com o nome', () => {
    const p = passo('boas_vindas', { intencao: 'aceita' });
    expect(p.mensagens).toEqual([TEXTOS.perguntaFormacaoAceite('Gustavo')]);
    expect(p.mensagens[0]).toBe('Te envio sim! Só me confirma, Gustavo: você já se formou e tá trabalhando, ou ainda tá na graduação?');
    expect(p.proximaEtapa).toBe('pergunta_formacao');
  });

  it('oi solto → pergunta da formação sem o "te envio sim"', () => {
    expect(passo('boas_vindas', { intencao: 'outro' }).mensagens).toEqual([TEXTOS.perguntaFormacao('Gustavo')]);
  });

  it('nome que não é de gente fica de fora', () => {
    expect(passo('boas_vindas', { intencao: 'aceita' }, { nomePerfil: 'JS MIMOS' }).mensagens[0])
      .toBe('Te envio sim! Só me confirma: você já se formou e tá trabalhando, ou ainda tá na graduação?');
  });

  it('já disse que é formado (resposta à pergunta antiga do ManyChat) → pula direto para o WhatsApp', () => {
    const p = passo('boas_vindas', { intencao: 'outro', situacao: 'formado', area: 'medicina veterinária' });
    expect(p.mensagens).toEqual([TEXTOS.pedirWhatsapp]);
    expect(p).toMatchObject({ proximaEtapa: 'pergunta_whatsapp', situacao: 'formado', area: 'medicina veterinária' });
  });

  it('não quer → despedida e encerra', () => {
    expect(passo('boas_vindas', { intencao: 'recusa' })).toMatchObject({ mensagens: [TEXTOS.recusa], proximaEtapa: 'encerrada' });
  });

  it('pergunta antes de tudo → responde e faz a pergunta da formação', () => {
    const p = passo('boas_vindas', { intencao: 'pergunta', resposta_pergunta: 'É gratuita, sim!' });
    expect(p.mensagens).toEqual(['É gratuita, sim!', TEXTOS.perguntaFormacao('Gustavo')]);
  });
});

describe('pergunta_formacao', () => {
  it.each(['formado', 'estudante'] as const)('%s → pede o WhatsApp e guarda a situação', (situacao) => {
    expect(passo('pergunta_formacao', { situacao })).toMatchObject({
      mensagens: [TEXTOS.pedirWhatsapp], proximaEtapa: 'pergunta_whatsapp', situacao,
    });
  });

  it('formado de área fora do catálogo também vai para o WhatsApp (tem MBA e extensão)', () => {
    expect(passo('pergunta_formacao', { situacao: 'formado', area: 'direito' }).proximaEtapa).toBe('pergunta_whatsapp');
  });

  it('nem formado nem estudante → link da Escola com a mensagem padrão, sem CRM', () => {
    const p = passo('pergunta_formacao', { situacao: 'nenhum' });
    expect(p).toMatchObject({ mensagens: [TEXTOS.escola], proximaEtapa: 'escola_enviada' });
    expect(p.mensagens[0]).toContain(LINK_ESCOLA);
    expect(p.mensagens[0]).toContain('mais de 10 cursos');
    expect(p.enviarWhatsapp).toBeUndefined();
  });

  it('já mandou o número junto com a formação → captura na hora', () => {
    const p = passo('pergunta_formacao', { situacao: 'formado' }, { textoNovo: 'sou vet, meu zap é (46) 99988-2268' });
    expect(p).toMatchObject({
      mensagens: [TEXTOS.confirmacaoWhatsapp], proximaEtapa: 'whatsapp_enviado',
      situacao: 'formado', telefone: '5546999882268', enviarWhatsapp: true,
    });
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

describe('pergunta_whatsapp', () => {
  it('número válido → confirma e manda para o WhatsApp', () => {
    expect(passo('pergunta_whatsapp', {}, { textoNovo: '46 9 9988-2268' })).toMatchObject({
      mensagens: [TEXTOS.confirmacaoWhatsapp], proximaEtapa: 'whatsapp_enviado',
      telefone: '5546999882268', enviarWhatsapp: true,
    });
  });

  it('número incompleto → pede de novo', () => {
    expect(passo('pergunta_whatsapp', {}, { textoNovo: '99988-2268' })).toMatchObject({
      mensagens: [TEXTOS.telefoneInvalido], proximaEtapa: 'pergunta_whatsapp',
    });
  });

  it('o número escrito por extenso que só o classificador entendeu também vale', () => {
    expect(passo('pergunta_whatsapp', { telefone: '46999882268' }, { textoNovo: 'quarenta e seis...' }).telefone)
      .toBe('5546999882268');
  });

  it('não quer passar → resposta provisória e encerra (decisão do comercial em aberto)', () => {
    expect(passo('pergunta_whatsapp', { intencao: 'recusa' })).toMatchObject({
      mensagens: [TEXTOS.recusaWhatsapp], proximaEtapa: 'encerrada',
    });
  });

  it('conversa solta → relembra UMA vez, depois espera calado', () => {
    expect(passo('pergunta_whatsapp', {}, { tentativas: 0 }).mensagens).toEqual([TEXTOS.relembrarWhatsapp]);
    expect(passo('pergunta_whatsapp', {}, { tentativas: 1 }).mensagens).toEqual([]);
  });

  it('pergunta → responde e relembra', () => {
    expect(passo('pergunta_whatsapp', { intencao: 'pergunta', resposta_pergunta: 'O time te passa os valores lá.' }, { tentativas: 3 }).mensagens)
      .toEqual(['O time te passa os valores lá.', TEXTOS.relembrarWhatsapp]);
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
