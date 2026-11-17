/**
 * UTM dos links que o SISTEMA manda sozinho (e-mail e WhatsApp), no padrão v4 de `src/lib/marketing/utmPadrao.ts`
 * (17/11/2026): ninguém precisa marcar link à mão em modelo, disparo, régua ou mensagem.
 *
 * Só link de site nosso (ppgvet.com.br, ppgeducacao.com.br) e só quando ele ainda não tem `utm_source`: o link que já
 * veio marcado (do gerador, de um grupo, do agente) tinha um motivo e fica como está.
 */
import { aplicarUtm, NOSSO_SITE, utmNomeDoEnvio } from "./emailBuilder/links.ts";

export interface UtmDoEnvio {
  source: string;
  medium: string;
  campaign?: string | null;
  content?: string | null;
}

/** Marca um link: só site nosso e só se ainda não tem utm_source. */
export function marcarLink(href: string, utm: UtmDoEnvio): string {
  const h = href.trim();
  if (!NOSSO_SITE.test(h) || /[?&]utm_source=/i.test(h)) return href;
  return aplicarUtm(h, { source: utm.source, medium: utm.medium, campaign: utm.campaign || null, content: utm.content || null });
}

/** A pontuação colada no fim da URL num texto ("veja: site.com/x." ou "*site.com/x*") não é da URL. */
const URL_NO_TEXTO = /https?:\/\/[^\s<>"'`]+/gi;

/** Marca os links de um texto corrido (WhatsApp, parte em texto do e-mail). */
export function marcarLinksNoTexto(texto: string, utm: UtmDoEnvio): string {
  if (!texto) return texto;
  return texto.replace(URL_NO_TEXTO, (achado) => {
    const fim = achado.match(/[.,;:!?)\]}*_~]+$/)?.[0] ?? "";
    const url = fim ? achado.slice(0, -fim.length) : achado;
    return marcarLink(url, utm) + fim;
  });
}

/** O WhatsApp que o sistema manda: whatsapp / social / <modelo ou disparo>. */
export const utmDoWhatsapp = (campanha?: string | null): UtmDoEnvio => ({
  source: "whatsapp",
  medium: "social",
  campaign: utmNomeDoEnvio(campanha) || null,
});

/** Os parâmetros de texto do corpo de um modelo da Meta (o texto fixo do modelo mora na Meta e não muda aqui). */
export function marcarComponentsDoModelo<T>(components: T[], utm: UtmDoEnvio): T[] {
  return components.map((c) => {
    const comp = c as { type?: unknown; parameters?: unknown };
    if (comp?.type !== "body" || !Array.isArray(comp.parameters)) return c;
    const parameters = comp.parameters.map((p: { type?: unknown; text?: unknown }) =>
      p?.type === "text" && typeof p.text === "string" ? { ...p, text: marcarLinksNoTexto(p.text, utm) } : p);
    return { ...comp, parameters } as T;
  });
}
