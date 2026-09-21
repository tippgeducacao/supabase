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
