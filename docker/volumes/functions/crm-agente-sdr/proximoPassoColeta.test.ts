import { describe, expect, it } from 'vitest';
import { proximoPassoDaColeta } from './proximoPassoColeta';

// Casos do duelo cego Luna × Sonnet 5 (25/09/2026): a Luna registrava a conclusão e não checava.
describe('proximoPassoDaColeta', () => {
  const agora = new Date('2026-09-25T13:00:00Z');

  it('"2031 em janeiro" ⇒ manda checar como fora do prazo, sem perguntar mais nada', () => {
    const t = proximoPassoDaColeta({ formacao: 'Medicina Veterinária', tempo_formacao: 'cursando, conclui em janeiro de 2031', graduacao_concluida: 'cursando' }, agora);
    expect(t).toContain('01/2031');
    expect(t).toContain('contexto_qualificacao="estudante_fora_do_prazo"');
    expect(t).toContain('Não pergunte o mês');
  });

  it('só o ano ("2029") já basta para fora do prazo', () => {
    const t = proximoPassoDaColeta({ tempo_formacao: 'cursando, conclui em 2029', graduacao_concluida: 'cursando' }, agora);
    expect(t).toContain('estudante_fora_do_prazo');
    expect(t).toContain('12/2029');
  });

  it('"me formo no fim do ano" ⇒ dentro do prazo, checa antes de convidar', () => {
    const t = proximoPassoDaColeta({ formacao: 'Medicina Veterinária', tempo_formacao: 'cursando, me formo no fim do ano', graduacao_concluida: 'cursando' }, agora);
    expect(t).toContain('contexto_qualificacao="estudante_apto"');
    expect(t).toContain('12/2026');
  });

  it('posição no curso ⇒ pergunta mês e ano, sem horário', () => {
    const t = proximoPassoDaColeta({ tempo_formacao: '5 semestre' }, agora);
    expect(t).toContain('posição no curso');
    expect(t).not.toContain('verificar_compatibilidade_curso');
  });

  it('formada ⇒ checa a compatibilidade com a graduação antes de convidar', () => {
    const t = proximoPassoDaColeta({ formacao: 'Engenharia de Pesca', tempo_formacao: 'recém formada', graduacao_concluida: 'sim' }, agora);
    expect(t).toContain('formacao_academica="Engenharia de Pesca"');
    expect(t).not.toContain('estudante');
  });

  it('formado há anos (data no passado) não vira estudante', () => {
    expect(proximoPassoDaColeta({ formacao: 'Zootecnia', tempo_formacao: 'formado em 2019' }, agora)).toContain('formacao_academica="Zootecnia"');
  });

  it('sem graduação, ou só nome/área: nada a acrescentar', () => {
    expect(proximoPassoDaColeta({ graduacao_concluida: 'nao' }, agora)).toBe('');
    expect(proximoPassoDaColeta({ nome: 'Ana' }, agora)).toBe('');
    expect(proximoPassoDaColeta({ area_atuacao: 'clínica' }, agora)).toBe('');
  });
});
