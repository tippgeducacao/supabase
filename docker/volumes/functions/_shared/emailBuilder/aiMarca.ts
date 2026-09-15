/** Preferências visuais do usuário, compartilhadas pelo formulário e pela edge.
 * O kit não é uma fonte de preços, prazos ou promessas sobre os cursos. */
export const FONTES_KIT_EMAIL_IA = [
  { nome: "Arial", valor: "Arial, Helvetica, sans-serif" },
  { nome: "Helvetica", valor: "Helvetica, Arial, sans-serif" },
  { nome: "Verdana", valor: "Verdana, Geneva, sans-serif" },
  { nome: "Tahoma", valor: "Tahoma, Verdana, sans-serif" },
  { nome: "Trebuchet MS", valor: "'Trebuchet MS', Helvetica, sans-serif" },
  { nome: "Georgia", valor: "Georgia, 'Times New Roman', serif" },
  { nome: "Times New Roman", valor: "'Times New Roman', Times, serif" },
  { nome: "Courier New", valor: "'Courier New', Courier, monospace" },
] as const;
export const LOGOS_KIT_EMAIL_IA = ["ppgvet", "ppg-educacao", "ppg-educacao-branca"] as const;
export interface KitMarcaEmailIA {
  nome: string;
  logoId?: typeof LOGOS_KIT_EMAIL_IA[number];
  logoUrl?: string;
  cores: { fundoPagina: string; fundo: string; texto: string; destaque: string };
  fonte: string;
  email: string;
  tom: string;
  rodape: string;
  ctaTexto: string;
  ctaUrl: string;
}
export class ErroKitMarcaEmailIA extends Error {
  constructor(mensagem: string) { super(mensagem); this.name = "ErroKitMarcaEmailIA"; }
}
const falha = (mensagem: string): never => { throw new ErroKitMarcaEmailIA(mensagem); };
const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const EMAIL = /^[a-z0-9.!#$%&*+/=?^_~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
function texto(v: unknown, nome: string, max: number): string {
  if (v === undefined) return "";
  if (typeof v !== "string" || v.length > max || [...v].some(c => {
    const codigo = c.charCodeAt(0);
    return codigo < 32 && ![9, 10, 13].includes(codigo) || codigo === 127;
  })) return falha(`Confira o campo ${nome} do kit de marca.`);
  return v.trim();
}
function cor(v: unknown): string {
  if (typeof v !== "string" || !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(v)) return falha("Use cores hexadecimais válidas no kit de marca.");
  return (v.length === 4 ? `#${[...v.slice(1)].map(c => c + c).join("")}` : v).toLowerCase();
}
export function kitMarcaEmailIAVazio(nome = "Meu kit de e-mail"): KitMarcaEmailIA {
  return { nome, cores: { fundoPagina: "#f3f4f6", fundo: "#ffffff", texto: "#1f2937", destaque: "#7c3aed" },
    fonte: FONTES_KIT_EMAIL_IA[0].valor, email: "", tom: "", rodape: "", ctaTexto: "Saiba mais", ctaUrl: "" };
}
export function validarLogoKitEmailIA(valor: unknown, urlPublica: string): string {
  const entrada = texto(valor, "logo", 2048);
  try {
    const url = new URL(entrada);
    const origem = new URL(urlPublica);
    const caminho = decodeURIComponent(url.pathname);
    if (url.protocol !== "https:" || url.origin !== origem.origin || url.username || url.password || url.search || url.hash
      || !caminho.startsWith("/storage/v1/object/public/email-imagens/") || caminho.includes("/../") || caminho.includes("/./")
      || !/\.(png|jpe?g|webp)$/i.test(caminho)) return falha("Escolha um logo institucional ou uma imagem publicada na biblioteca de e-mails.");
    return url.href;
  } catch { return falha("Escolha um logo institucional ou uma imagem publicada na biblioteca de e-mails."); }
}
export function validarKitMarcaEmailIA(valor: unknown, urlPublica: string): KitMarcaEmailIA {
  if (!objeto(valor) || Object.keys(valor).some(k => !["nome", "logoId", "logoUrl", "cores", "fonte", "email", "tom", "rodape", "ctaTexto", "ctaUrl"].includes(k))) return falha("O kit de marca contém campos inválidos.");
  if (!objeto(valor.cores) || Object.keys(valor.cores).some(k => !["fundoPagina", "fundo", "texto", "destaque"].includes(k))) return falha("Confira as cores do kit de marca.");
  const fonte = FONTES_KIT_EMAIL_IA.find(f => f.valor === valor.fonte || f.nome === valor.fonte);
  if (!fonte) return falha("Escolha uma fonte compatível com e-mail.");
  const email = texto(valor.email, "e-mail", 254);
  if (email && !EMAIL.test(email)) return falha("Preencha um e-mail de contato válido no kit de marca.");
  let ctaUrl = texto(valor.ctaUrl, "destino do botão", 2048);
  if (ctaUrl) {
    try {
      const url = new URL(ctaUrl);
      if (url.username || url.password || /[\s<>"'`\\{}]/.test(ctaUrl) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(ctaUrl)
        || (!["https:", "http:"].includes(url.protocol) && !(url.protocol === "mailto:" && EMAIL.test(url.pathname) && !url.search && !url.hash) && !(url.protocol === "tel:" && /^\+?[\d().-]{3,24}$/.test(url.pathname) && !url.search && !url.hash))) return falha("Use um link, e-mail ou telefone válido como destino do botão.");
      ctaUrl = url.href;
    } catch { return falha("Use um link, e-mail ou telefone válido como destino do botão."); }
  }
  const kit: KitMarcaEmailIA = { nome: texto(valor.nome, "nome", 120) || "Meu kit de e-mail", fonte: fonte.valor,
    cores: { fundoPagina: cor(valor.cores.fundoPagina), fundo: cor(valor.cores.fundo), texto: cor(valor.cores.texto), destaque: cor(valor.cores.destaque) },
    email, tom: texto(valor.tom, "tom de voz", 1600), rodape: texto(valor.rodape, "rodapé", 2000), ctaTexto: texto(valor.ctaTexto, "texto do botão", 120), ctaUrl };
  if (valor.logoId && valor.logoUrl) return falha("Escolha somente um logo padrão para o kit.");
  if (valor.logoId !== undefined && valor.logoId !== "") {
    if (!LOGOS_KIT_EMAIL_IA.includes(valor.logoId as NonNullable<KitMarcaEmailIA["logoId"]>)) return falha("O logo institucional selecionado é inválido.");
    kit.logoId = valor.logoId as KitMarcaEmailIA["logoId"];
  }
  if (valor.logoUrl !== undefined && valor.logoUrl !== "") kit.logoUrl = validarLogoKitEmailIA(valor.logoUrl, urlPublica);
  return kit;
}
