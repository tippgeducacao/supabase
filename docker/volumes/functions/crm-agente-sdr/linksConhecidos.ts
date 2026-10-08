// Link cadastrado sai exatamente como cadastrado (08/10/2026).
//
// No ensaio da aula de Micotoxinas a Luna copiou o link do YouTube trocando maiúscula por
// minúscula ("BT7D20ltjNs" virou "BT7D20ltJns"). O id do vídeo diferencia caixa: o link ia
// quebrado. Aqui, todo link da resposta que bate com um link conhecido ignorando a caixa é
// trocado pela grafia cadastrada. Link que não bate com nenhum conhecido não é tocado.

const URL = /https?:\/\/[^\s<>"')\]]+/gi;
const PONTUACAO_FINAL = /[.,;:!?]+$/;

export function corrigirLinksConhecidos(
  texto: string, conhecidos: (string | null | undefined)[],
): { texto: string; corrigidos: string[] } {
  const porCaixa = new Map<string, string>();
  for (const link of conhecidos) {
    const limpo = String(link ?? '').trim();
    if (limpo) porCaixa.set(limpo.toLowerCase(), limpo);
  }
  if (!porCaixa.size || !texto) return { texto, corrigidos: [] };
  const corrigidos: string[] = [];
  const novo = texto.replace(URL, (bruto) => {
    const pontuacao = bruto.match(PONTUACAO_FINAL)?.[0] ?? '';
    const url = pontuacao ? bruto.slice(0, -pontuacao.length) : bruto;
    const certo = porCaixa.get(url.toLowerCase());
    if (!certo || certo === url) return bruto;
    corrigidos.push(url);
    return certo + pontuacao;
  });
  return { texto: novo, corrigidos };
}
