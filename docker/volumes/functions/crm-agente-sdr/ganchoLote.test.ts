import { describe, expect, it } from 'vitest';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from './prompts';
import { AGENTE_CAMPANHA_DIRETA } from './prompts-campanha-direta';
import { renderPrompt } from './contexto';
import { comGanchoDoLote, secaoGanchoLote } from './ganchoLote';

const vars = { nome: 'Gustavo', curso_interesse_original: 'MBA GESTÃO DA PECUÁRIA LEITERA', pergunta_formacao: 'qual é a sua graduação?' };
const ocorrencias = (texto: string, re: RegExp) => (texto.match(re) ?? []).length;
const naSecao = (re: RegExp) => ocorrencias(secaoGanchoLote({ nome: 'Gustavo', curso: vars.curso_interesse_original }), re);

describe('gancho do primeiro lote no João de vendas (canário)', () => {
  it('validação: abertura, exemplo e todas as menções à secretaria/condição especial são trocadas', () => {
    const r = comGanchoDoLote(renderPrompt(AGENTE_VALIDACAO, vars), { nome: 'Gustavo', curso: vars.curso_interesse_original });
    expect(r.trocas.abertura).toBe(1);
    expect(r.trocas.exemplo).toBe(1);
    expect(r.trocas.gancho).toBeGreaterThan(5);
    // O que sobra de "condição especial"/"secretaria" é só a regra que as proíbe.
    expect(ocorrencias(r.prompt, /secretaria/gi)).toBe(naSecao(/secretaria/gi));
    expect(ocorrencias(r.prompt, /condição especial/gi)).toBe(naSecao(/condição especial/gi));
    expect(r.prompt).toContain('estamos no fechamento do primeiro lote promocional da pós em **MBA GESTÃO DA PECUÁRIA LEITERA**');
    expect(r.prompt).toContain('> estamos no fechamento do primeiro lote promocional da pós em MBA GESTÃO DA PECUÁRIA LEITERA, e eu gostaria de te apresentar a condição, a metodologia, o cronograma das aulas, os professores e tirar suas dúvidas.');
    expect(r.prompt).toContain('"Gustavo, vamos marcar sua conversa pra garantir essa condição promocional?"');
    expect(r.prompt).not.toContain('me confirma seu interesse que já procuro um encaixe pra ainda hoje');
  });
  it('qualificador e campanha direta: as menções herdadas também são trocadas', () => {
    for (const base of [AGENTE_QUALIFICADOR, AGENTE_CAMPANHA_DIRETA]) {
      const r = comGanchoDoLote(renderPrompt(base, vars), { nome: 'Gustavo', curso: vars.curso_interesse_original });
      expect(ocorrencias(r.prompt, /secretaria/gi)).toBe(naSecao(/secretaria/gi));
      expect(ocorrencias(r.prompt, /condição especial/gi)).toBe(naSecao(/condição especial/gi));
      expect(r.prompt).not.toContain('Feche puxando a confirmação');
    }
    const campanha = comGanchoDoLote(renderPrompt(AGENTE_CAMPANHA_DIRETA, vars), { nome: 'Gustavo', curso: vars.curso_interesse_original });
    expect(campanha.trocas.fecho).toBeGreaterThanOrEqual(1);
  });
  it('é idempotente', () => {
    const uma = comGanchoDoLote(renderPrompt(AGENTE_VALIDACAO, vars), { nome: 'Gustavo', curso: vars.curso_interesse_original });
    const duas = comGanchoDoLote(uma.prompt, { nome: 'Gustavo', curso: vars.curso_interesse_original });
    expect(duas.prompt).toBe(uma.prompt);
    expect(duas.trocas.gancho).toBe(0);
  });
});
