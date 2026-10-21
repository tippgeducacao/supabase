// Página HTML das telas PÚBLICAS do fluxo de conexão do LinkedIn (link de autorização e retorno).
//
// ⚠️ `titulo` é TEXTO e é escapado aqui. `msg` é HTML NOSSO de propósito (blocos de layout), então
// NÃO é escapado no molde: quem monta a msg escapa cada pedaço que vem de fora com `escaparHtml`.
// Estas páginas não exigem login — o callback do TikTok já refletiu injeção (12/10/2026).
import { escaparHtml } from "./escaparHtml.ts";

export function paginaLinkedIn(tituloCru: string, msg: string, ok: boolean, status?: number): Response {
  const titulo = escaparHtml(tituloCru);
  const cor = ok ? "#0A66C2" : "#dc2626";
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${titulo}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f2ef;color:#1d2226;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;box-sizing:border-box}
.card{max-width:460px;width:100%;text-align:center;background:#fff;border:1px solid #e0dfdc;border-radius:16px;padding:32px 24px;box-sizing:border-box}
.dot{width:56px;height:56px;border-radius:14px;background:${cor};margin:0 auto 18px;display:flex;align-items:center;justify-content:center;font-size:28px;color:#fff}
h1{font-size:20px;margin:0 0 10px}p{color:#56687a;font-size:14px;line-height:1.55;margin:0}
.quem{display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0;font-size:17px;color:#1d2226;font-weight:600}
.quem img{width:44px;height:44px;border-radius:50%;object-fit:cover}
.alerta{display:block;margin-top:16px;padding:12px;border-radius:10px;background:#fff7e6;border:1px solid #f0c36d;color:#7a4b00;font-size:13px;text-align:left;line-height:1.5}
.info{display:block;margin-top:14px;padding:12px;border-radius:10px;background:#eef3f8;color:#1d2226;font-size:13px;text-align:left;line-height:1.5}</style></head>
<body><div class="card"><div class="dot">${ok ? "✓" : "✕"}</div><h1>${titulo}</h1><p>${msg}</p></div></body></html>`;
  return new Response(html, {
    status: status ?? (ok ? 200 : 400),
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * O nome que o LinkedIn devolveu "parece" o perfil de marca? Basta uma palavra de 3+ letras em
 * comum, sem acento e sem caixa ("RAFAEL COSTA" × "Rafael Costa"). Não é trava — é o aviso
 * "confira se é a conta certa", porque vale a conta logada no navegador de quem abriu o link.
 */
export function nomeCombina(nomeLinkedIn: string | null | undefined, rotuloDoPerfil: string | null | undefined): boolean {
  const palavras = (s: string | null | undefined) =>
    String(s ?? "")
      .normalize("NFD").replace(/\p{M}/gu, "")
      .toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
  const a = new Set(palavras(nomeLinkedIn));
  return palavras(rotuloDoPerfil).some((p) => a.has(p));
}
