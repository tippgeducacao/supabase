import { describe, expect, it } from 'vitest';
import { respostaDoEncerramento, toolConcluida } from './encerramento';

describe('resposta do encerramento confirmado', () => {
  it.each([
    ['nao_perturbe', '', 'agradeço sua preferência'],
    ['sem_graduacao', '', 'graduação completa'],
    ['pausa', 'pediu atendimento humano', 'alguém do time'],
    ['pausa', 'pediu ligação', 'já vou te ligar'],
    ['pausa', 'já é aluno', 'alguém do suporte'],
    ['pausa', 'quer remarcar a reunião', 'verificar isso'],
  ])('despedida específica de %s/%s', (tipo, motivo, trecho) => {
    expect(respostaDoEncerramento({ tool: 'pausa_ia', input: { tipo, motivo } })).toContain(trecho);
  });
  it('formatura desfaz a expectativa de reunião e não inventa data', () => {
    const texto = respostaDoEncerramento({ tool: 'agendar_retorno', input: { tipo: 'formatura', meses: 14 } });
    expect(texto).toContain('não vou marcar a reunião agora');
    expect(texto).toContain('lato sensu');
    expect(texto).toContain('quando estiver mais perto de se formar');
    expect(texto).not.toMatch(/14|2026/);
  });
  it('retorno para análise e motivo desconhecido exigem resposta própria, sem chutar desinteresse', () => {
    expect(respostaDoEncerramento({ tool: 'agendar_retorno', input: { tipo: 'analise', dias: 2 } })).toBeNull();
    expect(respostaDoEncerramento({ tool: 'pausa_ia', input: { motivo: 'não classificado' } })).toBeNull();
    expect(respostaDoEncerramento(null)).toBeNull();
  });
  it.each([
    undefined, { status: 'bloqueado' }, { status: 'erro' }, { ok: false },
    { resultado: 'Erro ao executar pausa_ia: conexão recusada' },
    { resultado: 'Não consegui agendar o retorno (falhou)' },
  ])('não confirma encerramento com falha %j', (output) => {
    expect(toolConcluida(output)).toBe(false);
  });
});

// Caso Regislaine (13/10/2026): formada em Gestão da Qualidade, com duas pós, pediu Sanidade Avícola,
// recusou a alternativa e recebeu "pede graduação completa compatível", como se não tivesse formação.
describe('despedida quando a pós pedida é exclusiva de médico veterinário', () => {
  const resultado = (extra: Record<string, unknown>) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({
    output: 'A pós de Sanidade Avícola é exclusiva para Médicos Veterinários', compativel: false, pode_cursar: false,
    curso_solicitado: 'Sanidade Avícola', curso_alternativo: 'Gestão e Produção Avícola', curso_exclusivo_veterinario: true, ...extra }) }] });
  const pausa = { tool: 'pausa_ia', input: { tipo: 'pausa', motivo: 'Lead formada em Gestão da Qualidade, incompatível com Sanidade Avícola, e recusou a alternativa.' } };

  it('lê a pós exclusiva do último resultado da conferência', async () => {
    const { posExclusivaDaConversa } = await import('./encerramento');
    const historico = [
      { role: 'assistant', content: 'a pós de sanidade avícola é exclusiva para médicos veterinários.' },
      resultado({}),
      { role: 'user', content: 'Não gestão não' },
    ];
    expect(posExclusivaDaConversa(historico)).toBe('Sanidade Avícola');
    expect(posExclusivaDaConversa([resultado({ curso_solicitado: 'PÓS | SANIDADE AVÍCOLA' })])).toBe('SANIDADE AVÍCOLA');
    // A conferência mais recente decide: aprovado depois, ou reprovado numa pós aberta, não é este caso.
    expect(posExclusivaDaConversa([resultado({}), resultado({ pode_cursar: true, curso_exclusivo_veterinario: true })])).toBeNull();
    expect(posExclusivaDaConversa([resultado({}), resultado({ curso_exclusivo_veterinario: false, curso_solicitado: 'Produção de Suínos' })])).toBeNull();
    expect(posExclusivaDaConversa([{ role: 'user', content: [{ type: 'tool_result', content: 'texto solto' }] }])).toBeNull();
    expect(posExclusivaDaConversa(null)).toBeNull();
  });

  it('a despedida diz que a pós é exclusiva, sem falar em "graduação completa"', () => {
    const texto = respostaDoEncerramento(pausa, { posExclusiva: 'Sanidade Avícola' });
    expect(texto).toBe('a pós de sanidade avícola é exclusiva para médicos veterinários. fica à vontade pra nos procurar futuramente, vai ser um prazer te ajudar.');
  });

  it('sem pós exclusiva, ou em outro tipo de encerramento, nada muda', () => {
    expect(respostaDoEncerramento(pausa)).toContain('aceita algumas formações específicas, e a sua graduação não está entre elas');
    // 16/10/2026: pós reprovada que não é exclusiva de vet vai pelo nome.
    expect(respostaDoEncerramento(pausa, { posReprovada: 'Comportamento e Bem-estar Animal' }))
      .toBe('a pós de comportamento e bem-estar animal aceita algumas formações específicas, e a sua graduação não está entre elas. fica à vontade pra nos procurar futuramente, vai ser um prazer te ajudar.');
    expect(respostaDoEncerramento({ tool: 'pausa_ia', input: { tipo: 'nao_perturbe' } }, { posExclusiva: 'Sanidade Avícola' })).toContain('agradeço sua preferência');
    expect(respostaDoEncerramento({ tool: 'pausa_ia', input: { tipo: 'sem_graduacao' } }, { posExclusiva: 'Sanidade Avícola' })).toContain('quando concluir');
  });
});
