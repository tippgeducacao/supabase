import { describe, expect, it } from 'vitest';
import { cpfDigitos, paraItem, separarContato } from './mapear';

describe('EDUQ — consulta 7 (alunos bloqueados por inadimplência)', () => {
  it('lê as colunas da varredura de 05/11/2026', () => {
    const i = paraItem({
      id_aluno: 3621, nome_aluno: 'RAFAEL AUGUSTO CRUZ SALES', cpf: '033.454.035-60',
      contato: '(71) 99876-5432', curso: 'Cannabis Medicinal', turma: '02/26 #01',
      dias_em_atraso: 8, quantidade_parcelas_atraso: 1, valor_em_aberto: '492,50',
      motivo_bloqueio: 'Inadimplência', data_bloqueio_sugerida: '20/11/2026',
    });
    expect(i).toMatchObject({
      id_aluno: 3621, nome: 'RAFAEL AUGUSTO CRUZ SALES', cpf: '03345403560',
      telefone: '(71) 99876-5432', email: null, curso: 'Cannabis Medicinal', turma: '02/26 #01',
      dias_em_atraso: 8, parcelas_em_atraso: 1, valor_em_aberto: 492.5,
    });
  });

  it('aceita PascalCase', () => {
    expect(paraItem({ IdAluno: '12', NomeAluno: 'Ana', Curso: 'Bovinos' })).toMatchObject({
      id_aluno: 12, nome: 'Ana', curso: 'Bovinos',
    });
  });

  it('descarta linha sem id do aluno', () => {
    expect(paraItem({ nome_aluno: 'Sem id' })).toBeNull();
    expect(paraItem({ id_aluno: 'abc' })).toBeNull();
  });

  it('CPF só com 11 dígitos', () => {
    expect(cpfDigitos('150.743.497-96')).toBe('15074349796');
    expect(cpfDigitos('1')).toBeNull();
    expect(cpfDigitos(null)).toBeNull();
  });
});

describe('separarContato', () => {
  it('telefone e e-mail juntos', () => {
    expect(separarContato('(85) 99999-1234 / Ana@Gmail.com')).toEqual({
      telefone: '(85) 99999-1234', email: 'ana@gmail.com', mascarado: false,
    });
  });

  it('MASCARADO nunca vira contato (é o formato da consulta 4)', () => {
    expect(separarContato('(85)*****-***4')).toEqual({ telefone: null, email: null, mascarado: true });
    expect(separarContato('r********t@gmail.com')).toEqual({ telefone: null, email: null, mascarado: true });
  });

  it('parte mascarada não leva a outra junto', () => {
    expect(separarContato('(85)*****-***4 / ana@x.com')).toEqual({
      telefone: null, email: 'ana@x.com', mascarado: true,
    });
  });

  it('número curto não é telefone', () => {
    expect(separarContato('1234')).toEqual({ telefone: null, email: null, mascarado: false });
  });

  it('vazio', () => {
    expect(separarContato('')).toEqual({ telefone: null, email: null, mascarado: false });
    expect(separarContato(null)).toEqual({ telefone: null, email: null, mascarado: false });
  });
});
