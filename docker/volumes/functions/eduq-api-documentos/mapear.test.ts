import { describe, expect, it } from 'vitest';
import { cpfDigitos, dataIso, grupoSituacao, linhasDoEnvelope, paraDocumento, semRepetir } from './mapear';

describe('EDUQ — documentos dos alunos: leitura da consulta', () => {
  it('lê os nomes pedidos no chamado', () => {
    const d = paraDocumento({
      id_aluno: 812, cpf: '412.583.907-16', nome_aluno: 'Ana Clara', id_matricula: 'M-9', curso: 'Cannabis',
      turma: '02/26 #01', tipo_documento: 'Diploma de graduação', obrigatorio: 'S', situacao: 'Aprovado',
      data_entrega: '03/11/2026', data_validacao: '2026-11-04T10:00:00', observacao: '', link_arquivo: 'https://x/y.pdf',
    });
    expect(d).toMatchObject({
      cpf: '41258390716', eduq_aluno_id: '812', eduq_matricula_id: 'M-9', tipo_documento: 'Diploma de graduação',
      obrigatorio: true, situacao_grupo: 'aprovado', data_entrega: '2026-11-03', data_validacao: '2026-11-04',
      observacao: null, arquivo_ref: 'https://x/y.pdf', chave: '41258390716|M-9|diplomadegraduacao',
    });
  });

  it('aceita PascalCase e acento nos nomes de coluna (como vieram as Ids 2 e 10)', () => {
    const d = paraDocumento({ AlunoId: 7, CPF: '41258390716', TipoDocumento: 'RG', Situação: 'Pendente', Matricula: 3 });
    expect(d).toMatchObject({ eduq_aluno_id: '7', eduq_matricula_id: '3', tipo_documento: 'RG', situacao_grupo: 'pendente' });
  });

  it('sem CPF válido ou sem tipo, a linha é descartada', () => {
    expect(paraDocumento({ cpf: '123', tipo_documento: 'RG' })).toBeNull();
    expect(paraDocumento({ cpf: '41258390716' })).toBeNull();
  });

  it('situação → grupo, com recusa e "não enviado" vencendo as palavras positivas', () => {
    expect(grupoSituacao('Aprovado', null)).toBe('aprovado');
    expect(grupoSituacao('Validado pela secretaria', null)).toBe('aprovado');
    expect(grupoSituacao('Não aprovado', null)).toBe('recusado');
    expect(grupoSituacao('Recusado - ilegível', null)).toBe('recusado');
    expect(grupoSituacao('Não enviado', null)).toBe('pendente');
    expect(grupoSituacao('Aguardando envio', null)).toBe('pendente');
    expect(grupoSituacao('Em análise', null)).toBe('entregue');
    expect(grupoSituacao('Enviado', null)).toBe('entregue');
    expect(grupoSituacao(null, '2026-11-03')).toBe('entregue');
    expect(grupoSituacao(null, null)).toBe('pendente');
    expect(grupoSituacao('Isento', null)).toBe('outro');
  });

  it('mesma chave repetida: fica a última', () => {
    const a = paraDocumento({ cpf: '41258390716', tipo_documento: 'RG', situacao: 'Pendente' })!;
    const b = paraDocumento({ cpf: '41258390716', tipo_documento: 'rg', situacao: 'Aprovado' })!;
    expect(semRepetir([a, b])).toEqual([b]);
  });

  it('envelope: lista, string com JSON dentro, e sucesso=false', () => {
    expect(linhasDoEnvelope({ sucesso: true, resultado: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(linhasDoEnvelope({ sucesso: true, resultado: '[{"a":2}]' })).toEqual([{ a: 2 }]);
    expect(linhasDoEnvelope({ sucesso: true, resultado: null })).toEqual([]);
    expect(() => linhasDoEnvelope({ sucesso: false, resultado: 'x' })).toThrow('sucesso=false');
  });

  it('datas e CPF', () => {
    expect(dataIso('31/12/2026')).toBe('2026-12-31');
    expect(dataIso('')).toBeNull();
    expect(cpfDigitos(41258390716)).toBe('41258390716');
    expect(cpfDigitos('000')).toBeNull();
  });
});
