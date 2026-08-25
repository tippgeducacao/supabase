/**
 * Grafo semântico → Mermaid.
 *
 * O Mermaid vai no prompt AO LADO do JSON do grafo — os dois, redundantes de
 * propósito. O JSON é a fonte exata (ids, metadados, avisos); o Mermaid é a forma
 * que o modelo lê melhor, porque um fluxograma em texto linear deixa a topologia
 * óbvia de um jeito que uma lista de arestas não deixa. É redundância barata:
 * custa algumas centenas de tokens e melhora bastante a compreensão.
 *
 * Roda AQUI, na edge function, e não no front, porque é o grafo do BANCO que é
 * analisado. Gerar o Mermaid no navegador abriria a possibilidade de o desenho
 * descrito no texto não ser o mesmo do JSON — e o modelo acreditaria no texto.
 */

export interface GrafoNo {
  id: string;
  label?: string;
  kind?: string;
  kindInferido?: boolean;
  group?: string;
  meta?: Record<string, unknown>;
}
export interface GrafoAresta {
  from: string;
  to: string;
  label?: string;
  condition?: string;
  inferred?: boolean;
}
export interface Grafo {
  nodes: GrafoNo[];
  edges: GrafoAresta[];
  entryPoints?: string[];
  deadEnds?: string[];
  cycles?: string[][];
  ordem?: string[];
  warnings?: { tipo: string; ids: string[]; mensagem: string }[];
}

/** Mermaid quebra com `[`, `"`, `(` e `#` soltos dentro do rótulo. */
const escapar = (t: string) =>
  (t || '')
    .replace(/["`]/g, "'")
    .replace(/[[\]{}()|]/g, ' ')
    .replace(/#/g, 'nº')
    .replace(/\s+/g, ' ')
    .trim();

/** Cada `kind` tem a sua forma no Mermaid — a mesma convenção do canvas. */
function caixa(no: GrafoNo): string {
  const t = escapar(no.label || no.id);
  switch (no.kind) {
    case 'decision': return `${no.id}{"${t}"}`;
    case 'trigger':
    case 'state': return `${no.id}(["${t}"])`;
    case 'integration': return `${no.id}[["${t}"]]`;
    case 'manual': return `${no.id}[/"${t}"/]`;
    case 'note': return `${no.id}>"${t}"]`;
    default: return `${no.id}["${t}"]`;
  }
}

export function grafoParaMermaid(g: Grafo): string {
  const linhas: string[] = ['flowchart TD'];

  // Subprocessos viram subgraph — é o que preserva, no texto, a informação de que
  // aquelas etapas foram desenhadas dentro de um quadro.
  const semGrupo = g.nodes.filter((n) => !n.group);
  const porGrupo = new Map<string, GrafoNo[]>();
  for (const n of g.nodes) {
    if (!n.group) continue;
    const lista = porGrupo.get(n.group) ?? [];
    lista.push(n);
    porGrupo.set(n.group, lista);
  }

  for (const n of semGrupo) linhas.push(`  ${caixa(n)}`);

  let i = 0;
  for (const [grupo, nos] of porGrupo) {
    linhas.push(`  subgraph sg${i++}["${escapar(grupo)}"]`);
    for (const n of nos) linhas.push(`    ${caixa(n)}`);
    linhas.push('  end');
  }

  for (const e of g.edges) {
    const rotulo = escapar(e.condition || e.label || '');
    const seta = e.inferred ? '-.->' : '-->';
    linhas.push(rotulo ? `  ${e.from} ${seta}|"${rotulo}"| ${e.to}` : `  ${e.from} ${seta} ${e.to}`);
  }

  return linhas.join('\n');
}
