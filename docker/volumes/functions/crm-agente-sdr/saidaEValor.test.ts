import { beforeAll, describe, expect, it, vi } from 'vitest';
// regrasDaRodada puxa módulos que leem Deno.env ao carregar: o stub precisa existir antes dos imports.
vi.hoisted(() => { (globalThis as any).Deno = { env: { get: () => '' } }; });
import { RE_RETENCAO } from './regrasDaRodada';
import { LUNA_AGENTE_QUALIFICADOR, LUNA_AGENTE_VALIDACAO } from './prompts-luna';
import { AGENTE_CAMPANHA_DIRETA } from './prompts-campanha-direta';
import { FALA_CRONOGRAMA_ENVIADO, falaConviteDepoisDoCronograma } from '../_shared/resultadoEnvioMaterial';
import type { Msg } from './historico';

// 10/10/2026 (Gustavo e Wellinton), duas mudanças na conversa de venda:
// 1. Recusa: sai "vc não tem interesse mesmo, ou prefere que eu te chame na próxima turma?" (duas saídas,
//    nenhum motivo; a IA perguntava o motivo em 0,52% das saídas) e entra a pergunta do motivo.
// 2. Preço: o valor não é mais escrito na conversa; vai dentro do cronograma, depois da graduação.
const PERGUNTA = 'sem problema, não quero te incomodar à toa. só me diz: vc não está atuando mais na área ou se especializar não é prioridade pra vc?';
const PROMPTS = { abertura: LUNA_AGENTE_VALIDACAO, fechamento: LUNA_AGENTE_QUALIFICADOR, campanha: String(AGENTE_CAMPANHA_DIRETA) };

describe('pergunta de saída: o motivo no lugar das duas saídas', () => {
  it.each(Object.entries(PROMPTS))('o prompt de %s traz a pergunta nova e não a antiga', (_nome, prompt) => {
    expect(prompt).toContain(PERGUNTA);
    expect(prompt).not.toContain('vc não tem interesse mesmo');
    expect(prompt).toContain('o que pesa mais hoje, tempo ou investimento?');
    expect(prompt).toContain('temporizador_proxima_turma');
  });

  it('a guarda do follow-up reconhece a pergunta nova (e continua reconhecendo a oferta da próxima turma)', () => {
    expect(RE_RETENCAO.test(PERGUNTA)).toBe(true);
    expect(RE_RETENCAO.test('vc não tá atuando mais na área?')).toBe(true);
    expect(RE_RETENCAO.test('se especializar não é prioridade pra vc agora?')).toBe(true);
    expect(RE_RETENCAO.test('prefere que eu te chame quando abrir a próxima turma?')).toBe(true);
    // Não pode casar com conversa normal nem com o template de abertura (desligaria a esteira de lead normal).
    expect(RE_RETENCAO.test('entendi. o que pesa mais hoje, tempo ou investimento?')).toBe(true);
    expect(RE_RETENCAO.test('vc já está atuando na área de avicultura?')).toBe(false);
    // Pergunta de carreira não é pergunta de saída: desligava o follow-up do lead (revisão de 12/10).
    expect(RE_RETENCAO.test('hoje vc tá atuando mais na área de corte ou de postura?')).toBe(false);
    expect(RE_RETENCAO.test('estamos com as vagas abertas da próxima turma')).toBe(false);
    expect(RE_RETENCAO.test('se especializar é o caminho pra crescer na cooperativa')).toBe(false);
  });

  describe('retenção pendente silencia o follow-up', () => {
    let retencaoPendente: (h: Msg[]) => boolean;
    beforeAll(async () => {
      vi.stubGlobal('Deno', { env: { get: () => '' } });
      ({ retencaoPendente } = await import('./followup'));
    });
    it('pergunta nova sem resposta: pendente; com resposta do lead: liberado', () => {
      const lead: Msg = { role: 'user', content: 'não tenho interesse' };
      const pergunta: Msg = { role: 'assistant', content: PERGUNTA };
      expect(retencaoPendente([lead, pergunta])).toBe(true);
      expect(retencaoPendente([lead, pergunta, { role: 'user', content: 'tô sem tempo' }])).toBe(false);
    });
  });
});

describe('preço: o valor vai dentro do cronograma, não na conversa', () => {
  it.each(Object.entries(PROMPTS))('o prompt de %s não manda mais informar o valor', (_nome, prompt) => {
    expect(prompt).not.toContain('informe somente o valor integral retornado');
    expect(prompt).not.toContain('Informe só o valor integral retornado');
    expect(prompt).not.toMatch(/a matrícula é \[valor_matricula\]/);
    expect(prompt).not.toContain('ofereça o valor_matricula e o link');
  });

  it('os dois agentes da Luna trazem a fala do envio e o convite com as mesmas palavras da ferramenta', () => {
    const convite = falaConviteDepoisDoCronograma('a condição promocional exclusiva');
    for (const prompt of [LUNA_AGENTE_VALIDACAO, LUNA_AGENTE_QUALIFICADOR]) {
      expect(prompt).toContain(FALA_CRONOGRAMA_ENVIADO);
      expect(prompt).toContain(convite);
      expect(prompt).toContain('o valor integral tá no cronograma que te enviei, na parte de investimento.');
    }
  });

  // 16/10/2026: o convite diz POR QUE ir ao meet (texto do Gustavo).
  it('a fala do envio e o convite são os que o Gustavo aprovou', () => {
    expect(FALA_CRONOGRAMA_ENVIADO).toBe('te enviei o cronograma da pós por aqui, com os professores, os módulos e o valor integral.');
    expect(falaConviteDepoisDoCronograma('a condição promocional exclusiva'))
      .toBe('a condição promocional exclusiva, totalmente diferente desse valor que eu te passei, é somente com o monitor no meet. são 10 minutos.');
  });
});
