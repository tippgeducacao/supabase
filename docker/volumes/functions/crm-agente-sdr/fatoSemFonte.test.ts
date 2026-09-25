import { describe, expect, it } from 'vitest';
import { alertaFatoSemFonte } from './fatoSemFonte';

describe('alertaFatoSemFonte', () => {
  it.each([
    'É que para que a Pós Graduação valer para o título de especialista deve chamar Medicina Endocanabinoide.',
    'essa pós é reconhecida pelo MEC?',
    'o certificado é válido no CRMV?',
    'vale como título pro edital do concurso?',
  ])('alerta: %s', (fala) => {
    expect(alertaFatoSemFonte(fala)).toContain('pergunta_instituicao');
  });

  it.each(['quanto custa?', 'pode ser amanhã às 10h', 'sou médica veterinária', undefined])('não alerta: %s', (fala) => {
    expect(alertaFatoSemFonte(fala as string | undefined)).toBeNull();
  });
});
