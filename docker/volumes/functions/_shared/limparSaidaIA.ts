// ============================================================================
// limparSaidaIA — tira da resposta do modelo tudo que não é a mensagem.
// ----------------------------------------------------------------------------
// O texto gerado vai para uma pessoa copiar e colar num grupo de WhatsApp ou
// num e-mail. Chegava assim:
//
//     Aqui está a mensagem gerada seguindo todas as regras:
//     ---
//     Pessoal, uma pergunta rápida pra quem trabalha com suinocultura 👇
//
// As duas primeiras linhas são conversa com o operador, não conteúdo. Instruir
// o modelo a não escrevê-las resolve quase sempre — "quase" não serve para algo
// que vai colado num grupo, então esta função é a segunda trava, determinística.
//
// O que ela NÃO faz: reescrever a mensagem. Só remove moldura (preâmbulo,
// separador, cerca de markdown, pergunta final ao operador) e desfaz o cacoete
// tipográfico do travessão. Conteúdo é do modelo; forma é daqui.
// ============================================================================

/** Linha que é só um separador visual (---, ***, ___, ou ─────). */
const EH_SEPARADOR = /^\s*(?:-{3,}|\*{3,}|_{3,}|─{3,}|—{3,})\s*$/;

/**
 * Abertura típica de quem está falando COM o operador, não com o leitor.
 *
 * Estreita de propósito, e a prova de que precisa ser: "Segue o link da aula
 * de hoje:" é MENSAGEM, não moldura. Por isso não basta a abertura — a linha
 * precisa também falar da própria mensagem ("segue A MENSAGEM", "aqui está O
 * TEXTO"). Interjeição pura ("Claro!", "Perfeito!") é inequívoca e passa
 * sozinha.
 */
const ABERTURA_AO_OPERADOR =
  /^\s*(aqui est[áa]|segue(m)?\b|abaixo\b|vou gerar|gerando|com base n|conforme solicitado|prontinho)/i;

const FALA_DA_PROPRIA_MENSAGEM =
  /\b(mensagem|texto|copy|conte[úu]do|vers[ãa]o|sugest[ãa]o|regras|solicitado|pedido)\b/i;

const EH_INTERJEICAO = /^\s*(claro|perfeito|entendi|certo|beleza|show)\s*[!,.:]/i;

function ehPreambulo(linha: string): boolean {
  return (
    EH_INTERJEICAO.test(linha) ||
    (ABERTURA_AO_OPERADOR.test(linha) && FALA_DA_PROPRIA_MENSAGEM.test(linha))
  );
}

/** Fecho típico de quem pergunta ao operador se está bom. */
const EH_PERGUNTA_AO_OPERADOR =
  /^\s*(quer que|posso |se quiser|deseja |precisa de|quer alguma|alguma altera|caso queira|ficou bom|se preferir)/i;

/** Remove cerca de markdown que envolva o texto inteiro. */
function tirarCerca(texto: string): string {
  const t = texto.trim();
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

/**
 * Corta o preâmbulo. Duas heurísticas, nesta ordem:
 *  1. Existe separador nas primeiras linhas e o que vem antes dele é preâmbulo
 *     ou linha terminada em ":" → tudo antes do separador vai fora.
 *  2. A primeira linha é preâmbulo (e não é a mensagem inteira) → vai fora.
 */
function tirarPreambulo(texto: string): string {
  const linhas = texto.split("\n");

  const idxSep = linhas.findIndex((l, i) => i < 6 && EH_SEPARADOR.test(l));
  if (idxSep > 0) {
    const antes = linhas.slice(0, idxSep).filter((l) => l.trim() !== "");
    const pareceMoldura =
      antes.length > 0 &&
      antes.length <= 2 &&
      antes.every((l) => ehPreambulo(l) || /:\s*$/.test(l.trim()));
    if (pareceMoldura) return linhas.slice(idxSep + 1).join("\n").trim();
  }

  const primeira = linhas.find((l) => l.trim() !== "");
  if (primeira && ehPreambulo(primeira) && linhas.filter((l) => l.trim() !== "").length > 1) {
    const i = linhas.indexOf(primeira);
    return linhas.slice(i + 1).join("\n").trim();
  }

  return texto;
}

/** Tira separadores soltos no topo e no fim (o miolo pode querer um). */
function tirarSeparadoresDasPontas(texto: string): string {
  const linhas = texto.split("\n");
  while (linhas.length && (linhas[0].trim() === "" || EH_SEPARADOR.test(linhas[0]))) linhas.shift();
  while (linhas.length && (linhas[linhas.length - 1].trim() === "" || EH_SEPARADOR.test(linhas[linhas.length - 1])))
    linhas.pop();
  return linhas.join("\n");
}

/** Tira a pergunta final ao operador ("Quer que eu ajuste o tom?"). */
function tirarFechoAoOperador(texto: string): string {
  const linhas = texto.split("\n");
  for (let i = linhas.length - 1; i >= 0; i--) {
    const l = linhas[i];
    if (l.trim() === "") continue;
    if (EH_PERGUNTA_AO_OPERADOR.test(l) && l.trim().endsWith("?")) {
      return linhas.slice(0, i).join("\n").trim();
    }
    break;
  }
  return texto;
}

/**
 * Desfaz o travessão, que é a marca registrada de texto de IA.
 * - No começo da linha (lista): vira nada.
 * - Cercado de espaços no meio da frase: vira vírgula.
 * - Colado entre números (intervalo, "19h—20h"): vira hífen, que é o certo ali.
 */
export function tirarTravessao(texto: string): string {
  return texto
    .replace(/^[ \t]*[—–][ \t]*/gm, "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,\s*([.!?])/g, "$1");
}

/** Passe completo: moldura fora, travessão fora. */
export function limparSaidaIA(bruto: string): string {
  if (!bruto) return "";
  let t = tirarCerca(bruto);
  t = tirarPreambulo(t);
  t = tirarFechoAoOperador(t);
  t = tirarSeparadoresDasPontas(t);
  t = tirarTravessao(t);
  return t.trim();
}
