import { describe, expect, it } from 'vitest';
import { obterMotivoExclusaoModulosPraticos as motivo } from './modulosPraticosExclusoes.ts';

const inscricao = (contato: unknown, evento = 'inscricao.retroativa') => ({ evento, inscricao_id: 'inscricao-1', contato });

describe('exclusões administrativas das inscrições de módulos práticos', () => {
  it('compara nome inteiro sem acentos ou separadores, sem bloquear apenas um prenome/sobrenome', () => {
    const regras = { nomes: ['jose roehrs'] };
    for (const nome of ['José Roehrs', 'JoseRoehrs', ' JOSÉ-ROEHRS ', 'Jose_Roehrs', 'Jose.Roehrs']) {
      expect(motivo(inscricao({ nome }), regras), nome).toBe('nome_bloqueado');
    }
    for (const nome of ['Jose Silva', 'Maria Roehrs', 'José', 'Roehrs', 'Jose Roehrs Junior']) {
      expect(motivo(inscricao({ nome }), regras), nome).toBeNull();
    }
  });

  it('ignora tokens test/teste/testes com sufixo numérico, inclusive antes de validar telefone', () => {
    for (const nome of ['Teste', 'Testes', 'Test', 'test123', 'teste123', 'testes123', 'Pessoa de Teste', 'Teste-123', 'TÉSTE']) {
      expect(motivo(inscricao({ nome, telefone: 'telefone inválido' }), { ignorar_testes: true }), nome).toBe('cadastro_de_teste');
    }
    for (const nome of ['Testemunha', 'Conteste', 'Contest', 'Testa', 'testabc', 'José', 'Jose Silva', 'Maria Roehrs']) {
      expect(motivo(inscricao({ nome }), { ignorar_testes: true }), nome).toBeNull();
    }
  });

  it('examina somente tokens do localpart, sem bloquear domínio de teste ou fragmentos de palavra', () => {
    for (const email of ['teste@example.com', 'pessoa+teste123@example.com', 'test_123@example.com', 'testes@example.com']) {
      expect(motivo(inscricao({ email }), { ignorar_testes: true }), email).toBe('cadastro_de_teste');
    }
    for (const email of ['pessoa@teste.com', 'conteste@example.com', 'testemunha@example.com', 'pessoa@example.com']) {
      expect(motivo(inscricao({ email }), { ignorar_testes: true }), email).toBeNull();
    }
  });

  it('ignorar_testes exige boolean true e não é ativado por dados enviados pelo remetente', () => {
    const payload = { ...inscricao({ nome: 'Teste' }), regras_importacao: { ignorar_testes: true } };
    for (const regras of [{}, { ignorar_testes: false }, { ignorar_testes: 'true' }, { ignorar_testes: 1 }]) {
      expect(motivo(payload, regras)).toBeNull();
    }
  });

  it('email e identificador exigem igualdade inteira; ID conserva maiúsculas', () => {
    expect(motivo(inscricao({ email: ' Pessoa@Example.com ' }), { emails: ['pessoa@example.com'] })).toBe('email_bloqueado');
    expect(motivo(inscricao({ email: 'outra.pessoa@example.com' }), { emails: ['pessoa@example.com'] })).toBeNull();
    expect(motivo(inscricao({}), { inscricoes_ids: [' inscricao-1 '] })).toBe('inscricao_bloqueada');
    expect(motivo(inscricao({}), { inscricoes_ids: ['INSCRICAO-1', 'inscricao'] })).toBeNull();
  });

  it('telefone brasileiro casa com DDI e com/sem nono dígito, preservando DDD55', () => {
    const regras = { telefones: ['+55 (46) 99999-9999', '+55 (55) 99912-3456'] };
    for (const telefone of ['46999999999', '4699999999', '+55 46 9999-9999', '(55) 99912-3456', '5599123456']) {
      expect(motivo(inscricao({ telefone }), regras), telefone).toBe('telefone_bloqueado');
    }
    expect(motivo(inscricao({ telefone: '47999999999' }), regras)).toBeNull();
  });

  it('preserva DDI estrangeiro explícito sem colidir com número brasileiro', () => {
    const regras = { telefones: ['+39 3312 3456', '+1 999 123 4567'] };
    expect(motivo(inscricao({ telefone: '+3933123456' }), regras)).toBe('telefone_bloqueado');
    expect(motivo(inscricao({ telefone: '+1 (999) 123-4567' }), regras)).toBe('telefone_bloqueado');
    expect(motivo(inscricao({ telefone: '(39) 3312-3456' }), regras)).toBeNull();
    expect(motivo(inscricao({ telefone: '(19) 99123-4567' }), regras)).toBeNull();
  });

  it('DDD com zero usa somente dígitos exatos, como o fallback de fn_canon_ddd8', () => {
    for (const ddd of ['10', '20']) {
      const regras = { telefones: [`${ddd} 99999-9999`] };
      expect(motivo(inscricao({ telefone: `(${ddd}) 99999-9999` }), regras)).toBe('telefone_bloqueado');
      expect(motivo(inscricao({ telefone: `+55 ${ddd} 99999-9999` }), regras)).toBeNull();
      expect(motivo(inscricao({ telefone: `${ddd} 9999-9999` }), regras)).toBeNull();
    }
  });

  it('regras de exclusão valem somente para retroativa, incluindo listas explícitas', () => {
    const contato = { nome: 'Teste', email: 'teste@example.com', telefone: '46999999999' };
    const regras = { ignorar_testes: true, nomes: ['Teste'], emails: ['teste@example.com'], telefones: ['46999999999'], inscricoes_ids: ['inscricao-1'] };
    expect(motivo(inscricao(contato, 'inscricao.retroativa'), regras)).toBe('inscricao_bloqueada');
    for (const evento of ['inscricao.criada', 'validar', 'catalogo', 'outro', '']) {
      expect(motivo(inscricao(contato, evento), regras), evento).toBeNull();
    }
  });

  it('tolera campos e listas malformados sem coerção nem comparação de valores vazios', () => {
    for (const payload of [null, [], 'Teste', 123, {}, inscricao(null), inscricao([]), inscricao({ nome: 123, email: {}, telefone: true })]) {
      expect(motivo(payload, { nomes: ['', null, 123], emails: [], telefones: [''] })).toBeNull();
    }
    for (const regras of [null, [], 'Teste', { nomes: 'teste', emails: {}, telefones: false, inscricoes_ids: 123 }]) {
      expect(motivo(inscricao({ nome: 'Teste', email: 'teste@example.com', telefone: '46999999999' }), regras)).toBeNull();
    }
    expect(motivo(inscricao({ nome: null }), { inscricoes_ids: ['inscricao-1'] })).toBe('inscricao_bloqueada');
  });
});
