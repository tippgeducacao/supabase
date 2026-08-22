/**
 * A régua da RECONCILIAÇÃO de estado das conversas de e-mail: dado o que o
 * servidor (Gmail ou IMAP) diz que está não lido / favoritado / na caixa de
 * entrada, o que exatamente muda no banco.
 *
 * Mora aqui, fora das edges, pelos mesmos dois motivos do `imap/marcacao.ts`:
 *  1. é lógica pura — dá para testar sem socket, sem Deno e sem falar com o Google;
 *  2. é o pedaço de MAIOR consequência do sync. Um erro de sinal aqui não deixa a
 *     tela feia: marca a caixa inteira como lida e some da frente da pessoa o
 *     e-mail que ela ainda não viu. Um lugar só, com teste em cima.
 */

/** Uma linha nossa confrontada com o que o servidor diz dela. */
export interface LinhaConfrontada {
  /** Chave primária da thread no nosso banco — é por ela que o UPDATE vai. */
  id: string;
  /** Como a coluna está no banco agora. */
  atual: boolean;
  /** Como o servidor diz que deveria estar. */
  desejado: boolean;
}

export interface Diferenca {
  /** Está `false` no banco e o servidor diz `true`. */
  ligar: string[];
  /** Está `true` no banco e o servidor diz `false`. */
  desligar: string[];
}

/**
 * O que precisa mudar, e só isso.
 *
 * ⚠️ **A comparação parte das NOSSAS linhas, não do conjunto do servidor — e essa
 * direção é a correção de um desperdício real (2026-08-22).** A primeira versão
 * partia da lista do servidor e mandava um UPDATE por chave que não estivesse
 * marcada aqui. Só que o Gmail tem muito mais conversa do que a gente já
 * sincronizou: na caixa `programappgvet` ele devolvia **6.808** não lidas contra
 * **2.774** threads nossas, então sobravam ~4.000 chaves que não existem no banco
 * — 137 PATCH inúteis a cada 2 minutos, batendo no pool do PostgREST (o gargalo
 * conhecido desta VPS) para casar zero linha.
 *
 * Partindo das nossas linhas, o trabalho é limitado ao que existe aqui, e o que o
 * servidor tem a mais é simplesmente ignorado — que é o certo: não dá para marcar
 * uma conversa que ainda não foi baixada.
 *
 * Linha que já está no estado desejado NÃO entra: UPDATE à toa acorda o realtime
 * e faz a Inbox recarregar sem motivo.
 */
export function diferencaPorLinha(linhas: LinhaConfrontada[]): Diferenca {
  const ligar: string[] = [];
  const desligar: string[] = [];
  for (const linha of linhas ?? []) {
    if (linha.atual === linha.desejado) continue;
    (linha.desejado ? ligar : desligar).push(linha.id);
  }
  return { ligar, desligar };
}

/**
 * Tamanho do lote de um filtro `IN` do PostgREST.
 *
 * ⚠️ **O limite real é o tamanho da URL, não a quantidade de itens.** O filtro vai
 * na query string de um GET/PATCH, e o Kong/nginx corta em ~8 KB. Com 200 itens
 * isso estoura: 200 UUIDs ≈ 7.800 B (já no fio, antes de somar o resto da URL) e
 * 200 chaves IMAP (`imap:<uuid>:inbox:<uid>`, com `:` virando `%3A`) ≈ 12.600 B.
 *
 * Aconteceu de verdade em 2026-08-22, na primeira rodada depois do deploy: a
 * reconciliação do IMAP morria em `URI too long` a cada 2 minutos, e no Gmail as
 * caixas com MUITA coisa a corrigir (as que mais precisavam) eram justamente as
 * que falhavam — as pequenas passavam porque o lote parcial cabia na URL.
 *
 * 50 deixa a maior das listas em ~3,2 KB, com folga para o resto da URL. O custo
 * é round-trip a mais numa passada que converge: só a primeira rodada de cada
 * caixa tem lista grande.
 */
export const LOTE_FILTRO_IN = 50;

/** Fatia uma lista em lotes — PostgREST não aceita um `IN` de tamanho ilimitado. */
export function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}
