import type { DocumentoEmail } from "./types.ts";

export const MAX_LINKS_EMAIL_IA = 12;
export type EstadoLinkEmailIA = "acessivel" | "redirecionado" | "nao_verificado" | "falha";
export interface ResultadoLinkEmailIA {
  url: string;
  estado: EstadoLinkEmailIA;
  mensagem: string;
  urlConsultada?: string;
  urlFinal?: string;
  statusHttp?: number;
}
export interface RespostaVerificacaoLinksEmailIA { versao: 1; verificadoEm: string; resultados: ResultadoLinkEmailIA[] }
export interface DestinoLinkEmailIA {
  url: string;
  blocos: Array<{ id: string; rotulo: string }>;
  verificavel: boolean;
  motivo: string;
  urlConsulta?: string;
}

const motivoAcao = "Link de ação, acesso pessoal ou rastreamento: confira o destino no cadastro de origem.";
// HEAD pode ser implementado incorretamente por um site. Por isso a régua de
// 15/09/2026 também exclui ações e identificadores antes de resolver qualquer DNS.
const ACAO = /(?:unsubscribe|unsub|descadastr|desinscr|opt[-_]?out|confirm|verifica|verify|ativar|activate|activation|cancel|delete|deletar|remove|remover|logout|signout|signin|login|auth|senha|password|reset|token|webhook|callback|dispatcher|dispatch|tracking|track|click|clique|pixel|redirect|redirecion|checkout|pagamento|payment|pay|cobranca|cobrança|aceitar|accept|approve|aprovar|reject|rejeitar|responder|reply|submit|enviar|send|download|assinatura|subscribe|optin|opt-in)/i;
const CAMINHO_SERVICO = /(?:^|\/)(?:api|functions|rest|rpc|cron|jobs?|actions?|evento|event|r|t|u|c)(?:\/|$)/i;
const DOMINIO_RASTREIO = /(?:^|\.)(?:bit\.ly|tinyurl\.com|t\.co|lnkd\.in|wa\.me|api\.whatsapp\.com|sendgrid\.net|mandrillapp\.com|list-manage\.com|mailchi\.mp|brevo\.com|rdstation\.com|rds\.land)$/i;

/** Decide apenas elegibilidade. Disponibilidade real é obtida no servidor,
 * sem resolver variáveis, clicar, seguir links de ação nem enviar cookies. */
export function analisarDestinoLinkEmailIA(valor: unknown): Pick<DestinoLinkEmailIA, "verificavel" | "motivo" | "urlConsulta"> {
  const nao = (motivo: string) => ({ verificavel: false, motivo });
  const temControle = (texto: string) => [...texto].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (typeof valor !== "string" || !valor.trim() || valor.length > 2048 || /[\s\\]/.test(valor) || temControle(valor)) return nao("Informe um endereço completo e válido.");
  let decodificado = valor;
  try { for (let i = 0; i < 3; i++) { const proximo = decodeURIComponent(decodificado); if (proximo === decodificado) break; decodificado = proximo; } }
  catch { return nao("O endereço tem caracteres codificados inválidos."); }
  if (/[{}<>\\]/.test(decodificado) || temControle(decodificado) || /%[a-f\d]{2}/i.test(decodificado)) return nao("Endereço com variável ou conteúdo dinâmico: confira depois de preencher o destino.");
  let url: URL;
  try { url = new URL(valor); } catch { return nao("Informe um endereço HTTP ou HTTPS completo."); }
  if (!["https:", "http:"].includes(url.protocol)) return nao("A conferência aceita somente páginas HTTP ou HTTPS públicas.");
  const host = url.hostname.toLowerCase();
  if (url.username || url.password || url.port || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host) || !host.includes(".") || host.includes("..")
    || /(?:^|\.)(?:localhost|local|internal|intranet|test|invalid|onion|home|lan)$/.test(host)
    || /^\d+(?:\.\d+)*$/.test(host) || host.endsWith(".arpa")) return nao("Use uma página pública, sem senha, porta alternativa ou endereço IP.");
  let destinoDecodificado: URL;
  try { destinoDecodificado = new URL(decodificado); } catch { return nao("O endereço tem caracteres codificados inválidos."); }
  const caminho = destinoDecodificado.pathname;
  if (ACAO.test(`${host}${caminho}${destinoDecodificado.hash}`) || CAMINHO_SERVICO.test(caminho) || DOMINIO_RASTREIO.test(host)
    || /(?:^|\/)[a-f\d]{24,}(?:\/|$)/i.test(caminho) || /(?:^|\/)[\w-]{32,}(?:\/|$)/.test(caminho) && /\d/.test(caminho)) return nao(motivoAcao);
  // Parâmetros desconhecidos podem identificar destinatários ou executar ações.
  // UTM é removida; a consulta identifica explicitamente a página sem campanha.
  if ([...url.searchParams].some(([nome, valorParametro]) => !/^utm_(?:source|medium|campaign|content|term|id)$/i.test(nome) || valorParametro.length > 300)) return nao(motivoAcao);
  const tinhaParametros = !!url.search;
  const tinhaFragmento = !!url.hash;
  url.search = "";
  url.hash = "";
  return { verificavel: true, urlConsulta: url.href, motivo: tinhaParametros ? "A consulta usará a página sem parâmetros UTM." : tinhaFragmento ? "A consulta confere a página; a seção após # exige revisão visual." : "Página pública candidata à conferência." };
}

/** HTML legado é excluído: este painel confere os destinos dos blocos nativos. */
export function coletarDestinosEmailIA(documento: DocumentoEmail): DestinoLinkEmailIA[] {
  const destinos = new Map<string, DestinoLinkEmailIA>();
  for (const linha of documento.linhas) for (const coluna of linha.colunas) for (const bloco of coluna.blocos) {
    if (!["botao", "link", "imagem-link", "video", "link-dinamico"].includes(bloco.tipo)) continue;
    const url = typeof bloco.props.href === "string" ? bloco.props.href.trim() : "";
    const destino = destinos.get(url) ?? { url, blocos: [], ...analisarDestinoLinkEmailIA(url) };
    destino.blocos.push({ id: bloco.id, rotulo: (bloco.props.texto || bloco.nome || "Imagem ou vídeo").slice(0, 100) });
    destinos.set(url, destino);
  }
  return [...destinos.values()];
}

export function validarUrlsVerificacaoEmailIA(valor: unknown): string[] {
  if (!Array.isArray(valor) || !valor.length || valor.length > MAX_LINKS_EMAIL_IA || valor.some(u => typeof u !== "string" || u.length > 2048) || new Set(valor).size !== valor.length) {
    throw new Error(`Selecione entre 1 e ${MAX_LINKS_EMAIL_IA} destinos diferentes.`);
  }
  return [...valor];
}

/** Falha de contrato/serviço antigo não pode aparecer como todos os links OK. */
export function validarRespostaLinksEmailIA(valor: unknown, urls: string[]): RespostaVerificacaoLinksEmailIA {
  const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const falha = () => new Error("A conferência de links não retornou um resultado válido. O serviço pode precisar de atualização.");
  if (!objeto(valor) || valor.versao !== 1 || typeof valor.verificadoEm !== "string" || !Number.isFinite(Date.parse(valor.verificadoEm)) || !Array.isArray(valor.resultados) || valor.resultados.length !== urls.length) throw falha();
  const resultados = valor.resultados.map((r, i) => {
    if (!objeto(r) || r.url !== urls[i] || !["acessivel", "redirecionado", "nao_verificado", "falha"].includes(String(r.estado)) || typeof r.mensagem !== "string" || !r.mensagem || r.mensagem.length > 500
      || r.statusHttp !== undefined && (typeof r.statusHttp !== "number" || !Number.isInteger(r.statusHttp) || r.statusHttp < 100 || r.statusHttp > 599)) throw falha();
    for (const campo of ["urlConsultada", "urlFinal"] as const) if (r[campo] !== undefined && (typeof r[campo] !== "string" || r[campo].length > 2048 || !analisarDestinoLinkEmailIA(r[campo]).verificavel)) throw falha();
    if (["acessivel", "redirecionado"].includes(String(r.estado)) && (typeof r.urlFinal !== "string" || typeof r.urlConsultada !== "string" || typeof r.statusHttp !== "number" || r.statusHttp < 200 || r.statusHttp > 299)) throw falha();
    return { url: r.url as string, estado: r.estado as EstadoLinkEmailIA, mensagem: r.mensagem, ...(r.urlConsultada ? { urlConsultada: r.urlConsultada as string } : {}), ...(r.urlFinal ? { urlFinal: r.urlFinal as string } : {}), ...(r.statusHttp ? { statusHttp: r.statusHttp as number } : {}) };
  });
  return { versao: 1, verificadoEm: valor.verificadoEm, resultados };
}
