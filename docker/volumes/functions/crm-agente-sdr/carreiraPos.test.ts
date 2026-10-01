import { describe, expect, it } from 'vitest';
import { blocoCarreira, carregarCarreiraPorNome } from './carreiraPos';

const linhas = [
  { perfil: 'plantonista', moeda: 'preco', pergunta_dor: 'ainda precisaria do plantão?', ponte_convite: 'como encaixa no plantão', observacao: null },
  { perfil: 'outra_area', moeda: null, pergunta_dor: null, ponte_convite: null, observacao: 'exclusiva para médico-veterinário' },
];

describe('bloco CARREIRA', () => {
  it('cada perfil com sinais, pergunta de dor e ponte; objeções da pós no fim', () => {
    const b = blocoCarreira({ linhas, objecoes: [{ objecao: 'não tenho tempo', resposta: 'quase tudo é gravado' }] }, 'Cannabis');
    expect(b).toContain('CARREIRA — Cannabis');
    expect(b).toContain('- plantonista (faz plantão) · PERGUNTA DE DOR: "ainda precisaria do plantão?" · PONTE: como encaixa no plantão');
    expect(b).toContain('- outra_area (formação fora das aceitas pela pós) · exclusiva para médico-veterinário');
    expect(b).toContain('- "não tenho tempo": quase tudo é gravado');
  });

  it('sem dados, sem bloco; falha de leitura não derruba', async () => {
    expect(blocoCarreira(null, 'x')).toBe('');
    const quebrado = { from: () => { throw new Error('fora'); } };
    expect(await carregarCarreiraPorNome(quebrado as any, 'Cannabis')).toBeNull();
    expect(await carregarCarreiraPorNome(quebrado as any, '')).toBeNull();
  });
});
