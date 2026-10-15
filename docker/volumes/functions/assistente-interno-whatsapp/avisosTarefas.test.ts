import { describe, expect, it } from 'vitest';
import { linkTarefa, textoAvisoTarefa } from './avisosTarefas';

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('textoAvisoTarefa', () => {
  it('tarefa criada: nome, quem criou e o link', () => {
    const t = textoAvisoTarefa({ evento: 'criada', taskId: ID, titulo: 'Erro no login do banco de talentos', etapa: 'nova demanda', autor: 'Gabriel Betiolo' });
    expect(t).toBe([
      '🆕 *Nova demanda no TI*',
      '',
      '📌 *Erro no login do banco de talentos*',
      '👤 Criada por *Gabriel Betiolo*',
      `🔗 https://sistemappgvet.ppgeducacao.site/gestao-de-tarefas/tarefa/${ID}`,
    ].join('\n'));
  });
  it('tarefa arrastada: diz quem arrastou e para qual etapa', () => {
    const t = textoAvisoTarefa({ evento: 'movida', taskId: ID, titulo: 'Ajuste no dashboard', etapa: 'nova demanda', autor: 'José' });
    expect(t).toContain('➡️ *Demanda movida para a fila do TI*');
    expect(t).toContain('👤 *José* arrastou para *nova demanda*');
  });
  it('nome longo vira primeiro + último; sem autor = automação', () => {
    expect(textoAvisoTarefa({ evento: 'criada', taskId: ID, titulo: 'x', etapa: null, autor: 'Maria da Silva Pereira Souza' }))
      .toContain('Criada por *Maria Souza*');
    expect(textoAvisoTarefa({ evento: 'movida', taskId: ID, titulo: 'x', etapa: null, autor: null }))
      .toContain('*uma automação* arrastou para *nova demanda*');
  });
  it('título vazio não vira linha em branco', () => {
    expect(textoAvisoTarefa({ evento: 'criada', taskId: ID, titulo: '   ', etapa: 'nova demanda', autor: 'José' }))
      .toContain('📌 *(sem título)*');
  });
});

describe('linkTarefa', () => {
  it('é a rota da tarefa aberta no Gestor', () => {
    expect(linkTarefa(ID)).toBe(`https://sistemappgvet.ppgeducacao.site/gestao-de-tarefas/tarefa/${ID}`);
  });
});
