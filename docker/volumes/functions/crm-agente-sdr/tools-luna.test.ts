// tools-luna.ts é editado pelo Markdown para ser enxugado. Estes testes NÃO travam os textos de
// descrição: travam o CONTRATO com o código (tools.ts executa pelo nome e lê os parâmetros pelo nome,
// tipo e valores). Mudou a forma de propósito, junto com o código? Atualize o snapshot: vitest -u.
import { describe, expect, it } from 'vitest';
import { FERRAMENTAS, FERRAMENTAS_POR_AGENTE } from './tools-luna';

/** A ferramenta sem nenhum texto de descrição: o que o código depende. */
function forma(t: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(t, (chave, valor) => (chave === 'description' ? undefined : valor)));
}

describe('ferramentas da Luna: contrato com o código', () => {
  // 29/09/2026: travado POR AGENTE (o que a API recebe), não pelo apelido: cada agente tem a sua cópia.
  it('nome, parâmetros, tipos, valores permitidos e obrigatórios não mudam pelo Markdown', () => {
    const formas = Object.fromEntries(Object.entries(FERRAMENTAS_POR_AGENTE).sort(([a], [b]) => a.localeCompare(b))
      .map(([agente, apelidos]) => [agente, apelidos.map((a) => forma(FERRAMENTAS[a]))]));
    expect(formas).toMatchSnapshot();
  });

  it('cada cópia pertence a UM agente só (editar a da aula não mexe na da abertura)', () => {
    const donos = new Map<string, string[]>();
    for (const [agente, apelidos] of Object.entries(FERRAMENTAS_POR_AGENTE)) {
      for (const a of apelidos) donos.set(a, [...(donos.get(a) ?? []), agente]);
    }
    for (const [apelido, agentes] of donos) expect(agentes, apelido).toHaveLength(1);
  });

  it('cada persona recebe ferramentas que existem, sem nome repetido', () => {
    for (const [agente, apelidos] of Object.entries(FERRAMENTAS_POR_AGENTE)) {
      expect(apelidos.length, agente).toBeGreaterThan(0);
      for (const a of apelidos) expect(FERRAMENTAS[a], `${agente} → ${a}`).toBeDefined();
      const nomes = apelidos.map((a) => FERRAMENTAS[a].name);
      expect(new Set(nomes).size, `${agente}: nome repetido`).toBe(nomes.length);
    }
  });

  it('as 5 personas da Luna continuam com ferramentas, e toda versão é usada por alguém', () => {
    expect(Object.keys(FERRAMENTAS_POR_AGENTE).sort()).toEqual(
      ['agente_aula', 'agente_campanha_direta', 'agente_qualificador', 'agente_recontato', 'agente_validacao']);
    const usadas = new Set(Object.values(FERRAMENTAS_POR_AGENTE).flat());
    for (const a of Object.keys(FERRAMENTAS)) expect(usadas.has(a), `${a} não é usada por nenhuma persona`).toBe(true);
  });

  it('toda ferramenta tem descrição (a IA precisa saber quando usar)', () => {
    for (const [a, t] of Object.entries(FERRAMENTAS)) expect(t.description.trim().length, a).toBeGreaterThan(0);
  });
});
