import { describe, expect, it } from 'vitest';
import { conferirContratoInstrucoes } from './contratoInstrucoes';
import { blocosDoPrompt } from './conjuntoPrompt';
import { AGENTE_AULA } from './prompts-aula';
import { AGENTE_RECONTATO } from './prompts-recontato';
import { AGENTE_CAMPANHA_DIRETA } from './prompts-campanha-direta';
import { FERRAMENTAS, FERRAMENTAS_POR_AGENTE } from './tools-luna';

const b = blocosDoPrompt('luna');
const personas = { agente_validacao: b.validacao, agente_qualificador: b.qualificador, agente_aula: AGENTE_AULA, agente_recontato: AGENTE_RECONTATO, agente_campanha_direta: AGENTE_CAMPANHA_DIRETA };
const nomes = [...Object.values(FERRAMENTAS).map(t => t.name), 'responder_ao_cliente'];
describe('contrato das instruções efetivas por persona', () => {
  it.each(Object.entries(personas))('%s não pede função ausente nem duplica uma função', (agente, persona) => {
    const textos = [persona, b.memoriaHumana, b.fatosDoLead, b.disponibilidade, b.eventos, b.ficha, b.voz, b.canalResposta];
    const tools = [...FERRAMENTAS_POR_AGENTE[agente].map(k => FERRAMENTAS[k]), { name: 'responder_ao_cliente' }];
    const contrato = conferirContratoInstrucoes(textos, tools, nomes);
    expect(contrato.referenciasAusentes).toEqual([]);
    expect(contrato.ferramentasDuplicadas).toEqual([]);
    expect(contrato.paragrafosDuplicados).toEqual([]);
    expect(textos.join('\n')).not.toMatch(/Agendamentos para janeiro, fevereiro, março.*ano de 2026|informe somente o valor integral retornado|trate como não marcada/i);
  });
  it('detecta chamada indisponível e duplicação no catálogo de entrada', () => {
    const r = conferirContratoInstrucoes(['Chame confirmar_agendamento.'], [{ name: 'consulta_disponibilidade' }, { name: 'consulta_disponibilidade' }], nomes);
    expect(r.referenciasAusentes).toEqual(['confirmar_agendamento']);
    expect(r.ferramentasDuplicadas).toEqual(['consulta_disponibilidade']);
  });
});
