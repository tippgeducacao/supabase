// Leitura da tabela cursos_pos_graduacao (a "matriz" de formação × pós), compartilhada pela
// verificação de uma pós (verificar_compatibilidade_curso, tools.ts) e pelo catálogo filtrado
// pela formação (catalogoPorFormacao.ts). Saiu de tools.ts em 26/10/2026 sem mudar nada.

export type LinhaDaMatriz = { pos_graduacao: string; pode_fazer?: string | null; parcialmente_aceitas?: string | null };

export const chaveFormacao = (s: unknown) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
export const formacoesDaLista = (lista: unknown) => String(lista ?? '').split(';').map(chaveFormacao).filter((x) => x && x !== '—' && x !== '-');
export const aceitaQualquerFormacao = (linha: LinhaDaMatriz) => /qualquer forma[cç][aã]o/i.test(String(linha.pode_fazer ?? ''));
/** A tabela só lista Medicina Veterinária para esta pós (nem "parcialmente aceitas"). */
export const soParaVeterinario = (linha: LinhaDaMatriz) => {
  const inteiras = formacoesDaLista(linha.pode_fazer);
  return inteiras.length === 1 && inteiras[0] === 'medicina veterinaria' && formacoesDaLista(linha.parcialmente_aceitas).length === 0;
};
export const semPontuacao = (s: unknown) => chaveFormacao(String(s ?? '').replace(/^\s*(?:P[ÓO]S|MBA)\s*\|\s*/i, ''))
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/**
 * A linha da tabela para o curso pedido. O catálogo e a tabela escrevem o nome diferente ("Cannabis
 * Medicinal Veterinária" × "Cannabis Medicinal"): vale a linha de nome mais longo contida no pedido,
 * ou que o contém. O nome igual (sem contar espaços: "3EM1" = "3 em 1") ganha antes: sem isso
 * "Nutrição e Gestão de Bovinos" caía na linha do 3em1 (só de veterinário), que a contém e é mais longa.
 */
export const linhaDoCurso = (cursos: LinhaDaMatriz[] | null | undefined, curso: unknown): LinhaDaMatriz | undefined => {
  const pedido = semPontuacao(curso);
  if (!pedido) return undefined;
  const compacto = (s: string) => s.replace(/ /g, '');
  const igual = (cursos ?? []).find((c) => compacto(semPontuacao(c.pos_graduacao)) === compacto(pedido));
  if (igual) return igual;
  return (cursos ?? [])
    .map((c) => ({ c, nome: semPontuacao(c.pos_graduacao) }))
    .filter((x) => x.nome && (pedido === x.nome || pedido.includes(x.nome) || x.nome.includes(pedido)))
    .sort((a, b) => b.nome.length - a.nome.length)[0]?.c;
};
