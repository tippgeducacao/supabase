import { describe, expect, it } from 'vitest';
import { assuntoDoCadastroLigado, notaDoAssunto } from './assuntoDaPos';

describe('assunto em que o lead quer se especializar', () => {
  it('a nota lembra a pós do cadastro e deixa o "não temos" só para outra pós pedida pelo nome', () => {
    const n = notaDoAssunto('pós-graduação em bovinocultura leiteira', 'NUTRIÇÃO E GESTÃO DE BOVINOS');
    expect(n).toContain('"pós-graduação em bovinocultura leiteira" não é o nome de uma pós do catálogo');
    expect(n).toContain('interesse na pós do cadastro dele, NUTRIÇÃO E GESTÃO DE BOVINOS');
    expect(n).toContain('sem "não temos"');
    expect(n).toContain('Só se ele perguntou por outra pós pelo nome');
  });

  it('a chave: desligada por padrão; liga para todos ou só para o telefone de ensaio', async () => {
    const banco = (data: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
    expect(await assuntoDoCadastroLigado(banco({ catalogo_assunto_cadastro: false, catalogo_assunto_cadastro_telefones: [] }), '5546988166051')).toBe(false);
    expect(await assuntoDoCadastroLigado(banco({ catalogo_assunto_cadastro: true, catalogo_assunto_cadastro_telefones: [] }), '5511999990000')).toBe(true);
    expect(await assuntoDoCadastroLigado(banco({ catalogo_assunto_cadastro: false, catalogo_assunto_cadastro_telefones: ['5546988166051'] }), '554688166051')).toBe(true);
    expect(await assuntoDoCadastroLigado(banco(null, { message: 'x' }), '5546988166051')).toBe(false);
  });
});
