import { describe, expect, it } from 'vitest';
import { areaDoRecibo, componentesDoRecibo, dataDoRecibo, instrucaoForaDoPrazo, nomeDoRecibo, notaParaOAgente } from './igWhatsapp';

describe('recibo do Instagram: os três espaços do comprovante_cadastro_utility', () => {
  it('{{1}}: primeiro nome; perfil de marca vira o @; nunca vazio', () => {
    expect(nomeDoRecibo('Carla', 'carla.vet', 'Carla Souza')).toBe('Carla');
    expect(nomeDoRecibo(null, 'jsmimos', 'JS MIMOS')).toBe('@jsmimos');
    expect(nomeDoRecibo(null, '@jsmimos', 'JS MIMOS')).toBe('@jsmimos');
    expect(nomeDoRecibo(null, null, 'JS MIMOS')).toBe('JS MIMOS');
    expect(nomeDoRecibo(null, null, null)).not.toBe('');
  });

  it('{{2}}: veterinária → Medicina Veterinária; o resto (ou sem área) → Veterinária e Agro', () => {
    expect(areaDoRecibo('medicina veterinária')).toBe('Medicina Veterinária');
    expect(areaDoRecibo('Vet')).toBe('Medicina Veterinária');
    expect(areaDoRecibo('zootecnia')).toBe('Veterinária e Agro');
    expect(areaDoRecibo('agronomia')).toBe('Veterinária e Agro');
    expect(areaDoRecibo(null)).toBe('Veterinária e Agro');
  });

  it('{{3}}: data de Brasília + "pelo Instagram" (23h30 de Brasília ainda é o mesmo dia)', () => {
    expect(dataDoRecibo(new Date('2026-09-25T15:00:00Z'))).toBe('25/09/2026, pelo Instagram');
    expect(dataDoRecibo(new Date('2026-09-26T02:30:00Z'))).toBe('25/09/2026, pelo Instagram');
  });

  it('componentes no formato do crm-whatsapp-send', () => {
    expect(componentesDoRecibo('Carla', 'Medicina Veterinária', '25/09/2026, pelo Instagram')).toEqual([{
      type: 'body',
      parameters: [
        { type: 'text', text: 'Carla' },
        { type: 'text', text: 'Medicina Veterinária' },
        { type: 'text', text: '25/09/2026, pelo Instagram' },
      ],
    }]);
  });
});

describe('nota para o agente do WhatsApp', () => {
  it('diz de onde veio, o que já foi e a formação', () => {
    expect(notaParaOAgente('formado', null)).toMatch(/^\[INSTAGRAM\].*já concluiu a graduação\..*Não reenvie o portfólio/);
    expect(notaParaOAgente('estudante', '2027-07-31')).toContain('se forma em 07/2027');
    expect(notaParaOAgente(null, null)).not.toContain('Disse');
  });

  it('a graduação dita no direct entra na nota; o texto do recibo não é curso (28/09)', () => {
    expect(notaParaOAgente('formado', null, new Date(), 'agronomia')).toContain('concluiu a graduação em agronomia.');
    expect(notaParaOAgente('estudante', '2027-07-31', new Date(), 'zootecnia')).toContain('na graduação em zootecnia e se forma em 07/2027');
    expect(notaParaOAgente('formado', null)).toContain('não procure curso por ele');
  });

  // Relógio fixo: a régua do João (limiteFormatura) em 26/09/2026 é 31/01/2027.
  const AGORA = new Date('2026-09-26T12:00:00Z');

  it('forma DEPOIS de janeiro (28/09): a nota diz que o sistema já avisou e PAUSOU a IA', () => {
    const nota = notaParaOAgente('estudante', '2027-07-31', AGORA);
    expect(nota).toContain('se forma em 07/2027');
    expect(nota).toContain('não pode ir para a reunião');
    expect(nota).toContain('PAUSOU a IA');
    // O LINK não pode estar na nota: a guarda do presente do João acharia e não anexaria.
    expect(nota).not.toContain('escoladeespecializacao');
    expect(nota).toContain('Não ofereça reunião');
  });

  it('forma até janeiro, formado ou sem data: nota de sempre, sem o aviso', () => {
    expect(instrucaoForaDoPrazo('estudante', '2027-01-31', AGORA)).toBe('');
    expect(instrucaoForaDoPrazo('formado', '2028-07-31', AGORA)).toBe('');
    expect(instrucaoForaDoPrazo('estudante', null, AGORA)).toBe('');
    expect(instrucaoForaDoPrazo('estudante', 'lixo', AGORA)).toBe('');
    expect(notaParaOAgente('estudante', '2027-01-31', AGORA)).not.toContain('escoladeespecializacao');
  });
});
