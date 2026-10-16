import { describe, expect, it } from 'vitest';
import { NOTA_SEM_POS, posDoCadastroDefinida } from './indicacaoPortfolio';

// Catálogo de mentira: só "PÓS | CANNABIS MEDICINAL VETERINÁRIA" existe.
const banco = {
  from: () => {
    const q: any = { select: () => q, eq: () => q, order: async () => ({ data: [{ id: 'c1', nome: 'PÓS | CANNABIS MEDICINAL VETERINÁRIA' }], error: null }) };
    return q;
  },
  rpc: async () => ({ data: { id: null }, error: null }),
} as any;

describe('lead de indicação sem pós no cadastro (casos Lorrayne e Luiza)', () => {
  it('a origem gravada no lugar do curso não é pós', async () => {
    expect(await posDoCadastroDefinida(banco, 'Cadastrado por:Adones')).toBe(false);
    expect(await posDoCadastroDefinida(banco, 'Captação orgânica por:Wellyngton Mateus')).toBe(false);
    expect(await posDoCadastroDefinida(banco, '')).toBe(false);
    expect(await posDoCadastroDefinida(banco, null)).toBe(false);
  });

  it('pós do catálogo é pós; nome que não existe, não', async () => {
    expect(await posDoCadastroDefinida(banco, 'PÓS | CANNABIS MEDICINAL VETERINÁRIA')).toBe(true);
    expect(await posDoCadastroDefinida(banco, 'Bovinocultura de corte avançada')).toBe(false);
  });

  it('a nota manda o portfólio sem perguntar a graduação e espera a escolha dele', () => {
    expect(NOTA_SEM_POS).toContain('conteudo="portfolio"');
    expect(NOTA_SEM_POS).toContain('sem perguntar a graduação antes');
    expect(NOTA_SEM_POS).toContain('trocar_para');
  });
});
