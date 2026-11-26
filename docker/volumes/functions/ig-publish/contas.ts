/**
 * As contas de "Marcar Perfis" e "Colaboradores (Collab)" de um post do Instagram, e o que fazer quando
 * a Meta recusa uma delas.
 *
 * Regra pura (sem Deno, sem rede): o vitest roda os testes ao lado (`contas.test.ts`).
 */

/** Vírgula, ponto e vírgula, espaço e quebra de linha — o mesmo separador da tela (`analisarContas`). */
const SEPARADOR = /[\s,;]+/;

/**
 * Os nomes do texto gravado, sem "@" e sem repetição (vale a 1ª grafia), na ordem em que foram digitados.
 *
 * ⚠️ Até 26/11/2026 a edge separava SÓ por vírgula, e a tela aceita espaço: `@laura_camilotti @analiceftelles`
 * virava UM nome ("laura_camilotti @analiceftelles"), que nenhuma conta tem.
 */
export function separarContas(texto: string | null | undefined): string[] {
  const vistos = new Set<string>();
  const contas: string[] = [];
  for (const bruto of (texto ?? "").split(SEPARADOR)) {
    const conta = bruto.replace(/^@+/, "");
    if (!conta) continue;
    const chave = conta.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    contas.push(conta);
  }
  return contas;
}

/**
 * Subcode da Graph API para "Não é possível carregar um usuário com um perfil privado ou nome de usuário
 * inválido". Vem igual para marcação (`user_tags`) e para collab (`collaborators`), e derruba o post inteiro.
 */
export const SUBCODE_CONTA_INACESSIVEL = 2207018;

const escaparRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Quais contas do post a Meta recusou.
 *
 * A mensagem traz os nomes ("Os seguintes usuários não podem ser acessados: fulano"), no idioma da conta
 * que publica. Por isso não se interpreta a frase: procura-se cada conta NOSSA dentro dela, como palavra
 * inteira (`ander.bedin12` não casa com `ander.bedin123`; ponto final de frase não atrapalha, porque nome
 * do Instagram não termina em ponto).
 *
 * Nenhuma conta achada no texto (a frase mudou, veio cortada) ⇒ devolve TODAS: publicar sem marcação é
 * melhor do que o post não sair, e o aviso diz quem ficou de fora.
 */
export function contasRecusadas(textoDoErro: string, contas: string[]): string[] {
  const texto = (textoDoErro ?? "").toLowerCase();
  const achadas = contas.filter((conta) => {
    const alvo = escaparRegex(conta.toLowerCase());
    return new RegExp(`(?<![a-z0-9._])${alvo}(?![a-z0-9_])(?!\\.[a-z0-9_])`).test(texto);
  });
  return achadas.length ? achadas : [...contas];
}

/** Tira de `lista` as contas de `fora`, sem olhar maiúscula. */
export function semAsContas(lista: string[], fora: string[]): string[] {
  const tirar = new Set(fora.map((c) => c.toLowerCase()));
  return lista.filter((c) => !tirar.has(c.toLowerCase()));
}

/** "@a", "@a e @b", "@a, @b e @c". */
function listaDeContas(contas: string[]): string {
  const comArroba = contas.map((c) => `@${c}`);
  if (comArroba.length <= 1) return comArroba.join("");
  return `${comArroba.slice(0, -1).join(", ")} e ${comArroba[comArroba.length - 1]}`;
}

/**
 * O aviso gravado no post publicado (`ig_scheduled_posts.aviso_publicacao`) e mandado ao sino.
 * Diz QUEM ficou de fora, DE ONDE (marcação, collab ou os dois) e o que a pessoa ainda pode fazer.
 */
export function avisoDeContasDeFora(
  deFora: string[],
  marcacoesPedidas: string[],
  colaboradoresPedidos: string[],
): string | null {
  if (!deFora.length) return null;
  const fora = new Set(deFora.map((c) => c.toLowerCase()));
  const naMarcacao = marcacoesPedidas.some((c) => fora.has(c.toLowerCase()));
  const noCollab = colaboradoresPedidos.some((c) => fora.has(c.toLowerCase()));
  const onde = naMarcacao && noCollab ? "nas marcações e no collab"
    : noCollab ? "no collab"
    : "nas marcações";
  return `Publicado sem ${listaDeContas(deFora)} ${onde}: o Instagram não aceita, pela integração, `
    + `perfil privado ou que não existe. Se ${deFora.length === 1 ? "o perfil existe" : "os perfis existem"}, `
    + `dá para marcar à mão no app do Instagram, editando o post.`;
}
