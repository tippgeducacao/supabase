// Filtros do token `{webhook=chave|filtro}` — transformam o valor JÁ lido do payload.
//
// POR QUE existe (2026-08-19): o formulário nativo do Meta manda o nome inteiro numa chave
// só (`dados_completos.full_name`), com frequência em CAIXA ALTA — NÃO existe `first_name`
// no payload (conferido nas 4 integrações `form-meta-*`: as chaves de `dados_completos` são
// full_name/email/whatsapp_number/campanha…). E a ação "Enviar template WhatsApp" resolve as
// variáveis {{1}},{{2}}… direto do PAYLOAD, não de um campo do lead — então não havia onde
// recortar: o template saía "Olá MARIA APARECIDA DA SILVA".
//
// Quem aplica é o `resolveWebhookVar` (index.ts), que é o resolvedor ÚNICO de token do
// builder: vale igual para template, Criação Automática, título da oportunidade, tags UTM e
// "atualizar campo do contato".
//
// ⚠️ O argumento de um filtro não pode conter `}` — o token é lido por `\{webhook=([^}]+)\}`.

/** Partícula de nome que fica em minúscula no meio ("Maria da Silva"). */
const PARTICULAS = new Set(["de", "da", "das", "do", "dos", "e", "di", "du", "del", "van", "von", "y"]);

/** 1ª palavra do nome. Ignora lixo do começo (emoji, pontuação) e pontuação colada no fim. */
export function primeiroNome(valor: string): string {
  const limpo = String(valor ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "");
  const palavra = limpo.split(/\s+/)[0] ?? "";
  return palavra.replace(/[^\p{L}\p{N}'’-]+$/u, "");
}

/** "MARIA DA SILVA" → "Maria da Silva"; "maria-clara" → "Maria-Clara". */
export function capitalizarNome(valor: string): string {
  const s = String(valor ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s
    .split(" ")
    .map((p, i) => {
      const low = p.toLocaleLowerCase("pt-BR");
      if (i > 0 && PARTICULAS.has(low)) return low;
      return low.replace(/(^|[-'’])(\p{L})/gu, (_m, sep, ch) => sep + String(ch).toLocaleUpperCase("pt-BR"));
    })
    .join(" ");
}

/** Filtros disponíveis. `arg` é o texto depois do "=" (só `padrao` usa hoje). */
const FILTROS: Record<string, (valor: string, arg: string) => string> = {
  primeiro_nome: (v) => primeiroNome(v),
  capitalizar: (v) => capitalizarNome(v),
  maiusculo: (v) => v.toLocaleUpperCase("pt-BR"),
  minusculo: (v) => v.toLocaleLowerCase("pt-BR"),
  // Rede de segurança: variável de template VAZIA faz a Meta recusar o envio inteiro.
  padrao: (v, arg) => (v.trim() ? v : arg),
};

/** Nomes aceitos (para a UI e para a doc não saírem do combinado). */
export const FILTROS_TOKEN = Object.keys(FILTROS);

function ehFiltroConhecido(nome: string): boolean {
  return Object.prototype.hasOwnProperty.call(FILTROS, nome);
}

export interface TokenWebhook {
  chave: string;
  filtros: Array<{ nome: string; arg: string }>;
}

/**
 * Separa `chave|filtro|filtro=arg` do miolo do token.
 *
 * ⚠️ Só trata como filtro quando TODOS os pedaços depois do 1º "|" são filtros conhecidos.
 * Chave que tenha "|" LITERAL no payload (o Meta aceita rótulo com barra) continua
 * resolvendo exatamente como antes — zero regressão nos 151 webhooks já configurados
 * (nenhum deles usa "|" em token hoje, conferido em 2026-08-19).
 */
export function parseTokenWebhook(miolo: string): TokenWebhook {
  const partes = String(miolo ?? "").split("|");
  const chave = (partes.shift() ?? "").trim();
  if (partes.length === 0) return { chave, filtros: [] };
  const filtros = partes.map((p) => {
    const eq = p.indexOf("=");
    return {
      nome: (eq === -1 ? p : p.slice(0, eq)).trim().toLowerCase(),
      arg: eq === -1 ? "" : p.slice(eq + 1).trim(),
    };
  });
  if (!filtros.every((f) => ehFiltroConhecido(f.nome))) return { chave: String(miolo ?? "").trim(), filtros: [] };
  return { chave, filtros };
}

/** Aplica os filtros na ordem escrita. Filtro desconhecido nunca chega aqui (parse barra). */
export function aplicarFiltrosToken(valor: string, filtros: TokenWebhook["filtros"]): string {
  let out = valor;
  for (const f of filtros) {
    const fn = ehFiltroConhecido(f.nome) ? FILTROS[f.nome] : null;
    if (fn) out = fn(out, f.arg);
  }
  return out;
}
