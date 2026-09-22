// 22/09/2026: candidato local ao fracionador por LLM. Divide por posições no texto,
// sem reconstruir frases nem usar placeholders: vírgulas, links e anexos não somem.
// 240 é alvo de leitura, não corte cego. Uma frase pode ir até 300; uma unidade
// indivisível (link, palavra, formatação, item de lista) pode ultrapassar esse teto.
export const ALVO_BALAO = 240;
export const MARGEM_BALAO = 300;
const MINIMO_BALAO = 45;
const RE_MIDIA = /<(audio|imagem|video|documento)>[^<]*<\/\1>/gi;
const RE_PROTEGIDO = /<(audio|imagem|video|documento)>[^<]*<\/\1>|```[\s\S]*?```|`[^`\n]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|R\$\s*\d[\d.,]*/gi;
const RE_LINK_REUNIAO = /https?:\/\/(?:meet\.google\.com|[\w.-]*\bzoom\.us|teams\.(?:live|microsoft)\.com)\/\S+/i;
const RE_LINK_ESCOLA = /escoladeespecializacao\.ppgvet\.com\.br/i;

export function contemLinkReuniao(texto: string): boolean {
  return RE_LINK_REUNIAO.test(texto ?? '');
}

// Uma confirmação com data/monitor/link e o presente final da Escola precisam
// chegar juntos. Guarda histórica do SDR, também preservada no candidato local.
export function contemLinkCritico(texto: string): boolean {
  return contemLinkReuniao(texto) || RE_LINK_ESCOLA.test(texto ?? '');
}

type Faixa = { inicio: number; fim: number };
function faixasProtegidas(texto: string): Faixa[] {
  const faixas = Array.from(texto.matchAll(RE_PROTEGIDO), (m) => ({ inicio: m.index!, fim: m.index! + m[0].length }));
  // Não deixe a numeração de uma opção ou parte de um horário em outro balão.
  for (const m of texto.matchAll(/^[ \t]*(?:\d+[.)]|[-*•])[ \t]+[^\n]+/gm)) {
    faixas.push({ inicio: m.index!, fim: m.index! + m[0].length });
  }
  return faixas;
}

const dentro = (posicao: number, faixas: Faixa[]) => faixas.some((f) => posicao > f.inicio && posicao < f.fim);

/** <break> é controle de apresentação; dentro de código/mídia não se interpreta. */
export function prepararQuebras(texto: string): string {
  const faixas = faixasProtegidas(texto);
  return texto.replace(/<break\s*\/?>/gi, (tag, indice: number) => dentro(indice, faixas) ? tag : '\n\n').trim();
}

function dividirParagrafos(texto: string): string[] {
  const faixas = faixasProtegidas(texto);
  const partes: string[] = [];
  let inicio = 0;
  for (const m of texto.matchAll(/(?:\r?\n)[ \t]*(?:\r?\n)+/g)) {
    if (dentro(m.index!, faixas)) continue;
    partes.push(texto.slice(inicio, m.index).trim());
    inicio = m.index! + m[0].length;
  }
  partes.push(texto.slice(inicio).trim());
  return partes.filter(Boolean);
}

// O ponto em "Dr. Silva" não termina uma frase; número decimal nem entra na
// lista porque não tem espaço depois do ponto. Pontuação nunca é descartada.
function ehAbreviacao(texto: string, fim: number): boolean {
  return /\b(?:dr|dra|sr|sra|srta|prof|profa|av|pág|art|etc)\.$/i.test(texto.slice(0, fim))
    || /\b[A-Z]\.$/.test(texto.slice(0, fim));
}

function dividirTrecho(texto: string): string[] {
  const partes: string[] = [];
  let restante = texto.trim();
  while (restante) {
    if (restante.length <= ALVO_BALAO) { partes.push(restante); break; }
    const faixas = faixasProtegidas(restante);
    const frases = Array.from(restante.matchAll(/[.!?]+["'”’)]*\s+/g))
      .map((m) => m.index! + m[0].trimEnd().length)
      .filter((fim) => !dentro(fim, faixas) && !ehAbreviacao(restante, fim));
    const clausulas = Array.from(restante.matchAll(/[,;:]\s+|\n/g))
      .map((m) => m.index! + m[0].trimEnd().length)
      .filter((fim) => !dentro(fim, faixas));
    const espacos = Array.from(restante.matchAll(/\s+/g)).map((m) => m.index!)
      .filter((fim) => !dentro(fim, faixas));
    const ultimoAteAlvo = (pontos: number[]) => pontos.filter((p) => p >= MINIMO_BALAO && p <= ALVO_BALAO).at(-1);
    const corte = ultimoAteAlvo(frases)
      ?? frases.find((p) => p > ALVO_BALAO && p <= MARGEM_BALAO)
      ?? ultimoAteAlvo(clausulas)
      ?? ultimoAteAlvo(espacos)
      ?? espacos.find((p) => p > ALVO_BALAO)
      ?? restante.length;
    partes.push(restante.slice(0, corte).trim());
    restante = restante.slice(corte).trim();
  }
  // Pergunta curta e reação não ficam órfãs. Só reúne dentro do mesmo parágrafo;
  // <break>, parágrafo explícito e mídia continuam delimitando balões.
  const juntas: string[] = [];
  for (const atual of partes) {
    const anterior = juntas.at(-1);
    if (anterior && (atual.length < MINIMO_BALAO || anterior.length < MINIMO_BALAO)
      && anterior.length + 1 + atual.length <= MARGEM_BALAO) {
      juntas[juntas.length - 1] = `${anterior} ${atual}`;
    } else juntas.push(atual);
  }
  return juntas;
}

/** Recebe a fala já aprovada pelas guardas. Sem fetch, modelo, envio ou sorteio. */
export function fracionarTextoDeterministico(texto: string): string[] {
  const preparado = prepararQuebras(texto);
  if (!preparado) return [];
  if (contemLinkCritico(preparado)) return [preparado];
  const baloes: string[] = [];
  const adicionarTexto = (trecho: string) => {
    for (const paragrafo of dividirParagrafos(trecho)) baloes.push(...dividirTrecho(paragrafo));
  };
  const protegidos = faixasProtegidas(preparado);
  let inicio = 0;
  for (const m of preparado.matchAll(RE_MIDIA)) {
    // Uma tag citada dentro de bloco de código não é um anexo.
    if (protegidos.some((f) => f.inicio < m.index! && f.fim >= m.index! + m[0].length)) continue;
    adicionarTexto(preparado.slice(inicio, m.index));
    baloes.push(m[0]);
    inicio = m.index! + m[0].length;
  }
  adicionarTexto(preparado.slice(inicio));
  // Toda parte é um recorte da entrada. Apenas espaços nas fronteiras e a tag
  // de controle podem mudar; se essa propriedade falhar, preserva a fala inteira.
  const semEspacos = (t: string) => t.replace(/\s/g, '');
  return baloes.length && semEspacos(baloes.join('')) === semEspacos(preparado) ? baloes : [preparado];
}
