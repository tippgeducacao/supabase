// Peças compartilhadas do Portal da Unidade Certificadora (IES) — 03/11/2026.
// Usadas por ies-portal-acessos (a PPGVET convida) e ies-portal-primeiro-acesso (a pessoa da IES
// cria a senha pelo link). Ver docs/Portal da IES.md.
//
// O link é nosso (token de uso único com hash no banco), não o "recovery" do Auth: não depende de
// lista de redirecionamento nem do e-mail do Auth, e o token vale só para AQUELA conta da IES.

/** Site do sistema quando a origem do pedido não é conhecida. */
export const SITE_PADRAO = "https://sistemappgvet.ppgeducacao.site";

/** Validade do link: convite 7 dias; "esqueci a senha" 1 hora. */
export const VALIDADE_CONVITE_MS = 7 * 24 * 60 * 60 * 1000;
export const VALIDADE_NOVA_SENHA_MS = 60 * 60 * 1000;

/**
 * Origem do link: o link é uma credencial de uso único, então só vai para o endereço do sistema.
 * Nunca a origem que o pedido inventar (outro subdomínio de ppgeducacao.site pode ter script de
 * terceiro — revisão de acesso de 03/11/2026). Localhost só com IES_PORTAL_PERMITE_LOCALHOST=1.
 */
export function origemDoPortal(origin: string | null | undefined): string {
  const o = (origin ?? "").trim().replace(/\/$/, "");
  if (o === SITE_PADRAO) return o;
  if (Deno.env.get("IES_PORTAL_PERMITE_LOCALHOST") === "1" && /^http:\/\/localhost:\d{2,5}$/i.test(o)) return o;
  return SITE_PADRAO;
}

/** 32 bytes aleatórios em base64url — o que vai no link. */
export function novoToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 em hex — o que fica no banco. */
export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function emailValido(email: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(email);
}

export const PAPEIS_IES = ["secretaria", "coordenacao", "consulta"] as const;
export type PapelIes = (typeof PAPEIS_IES)[number];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Corpo do e-mail com o link (convite ou nova senha). */
export function emailDoLink(p: { nome: string; sigla: string; link: string; motivo: "convite" | "nova_senha" }) {
  const convite = p.motivo === "convite";
  const assunto = convite
    ? `Seu acesso ao Portal da Unidade Certificadora (${p.sigla} · PPGVET)`
    : "Crie uma nova senha do Portal da Unidade Certificadora";
  const validade = convite ? "O link vale por 7 dias." : "O link vale por 1 hora.";
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.55;max-width:520px">
  <p style="margin:0 0 12px">Olá, ${esc(p.nome)}.</p>
  <p style="margin:0 0 12px">${convite
    ? `A PPGVET Educação liberou o seu acesso ao <strong>Portal da Unidade Certificadora</strong>, onde a ${esc(p.sigla)} acompanha os alunos que certifica: turma, aulas, TCC e documentos.`
    : "Recebemos um pedido para criar uma nova senha do Portal da Unidade Certificadora."}</p>
  <p style="margin:0 0 18px"><a href="${esc(p.link)}" style="display:inline-block;padding:10px 18px;background:#9C56B8;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${convite ? "Criar minha senha" : "Criar nova senha"}</a></p>
  <p style="margin:0 0 6px;font-size:13px;color:#4b5563">${validade} Se não foi você, ignore este e-mail.</p>
  <p style="margin:0;font-size:12px;color:#6b7280">PPGVET Educação · Portal da Unidade Certificadora</p>
</div>`;
  const texto = `${convite ? "Seu acesso ao Portal da Unidade Certificadora" : "Nova senha do Portal da Unidade Certificadora"}\n\n${p.link}\n\n${validade}`;
  return { assunto, html, texto };
}

/**
 * Remetente do e-mail: `IES_PORTAL_REMETENTE_ID` (secret) → caixa `secretaria@` → o primeiro ativo.
 * Mesma ordem de crm-mencao-email, sem o "comercial": quem fala com a IES é a secretaria acadêmica.
 */
// deno-lint-ignore no-explicit-any
export async function remetenteDoPortal(admin: any): Promise<string | null> {
  const fixo = Deno.env.get("IES_PORTAL_REMETENTE_ID");
  if (fixo) return fixo;
  const { data } = await admin
    .from("email_remetentes")
    .select("id, email_completo, criado_em")
    .eq("ativo", true)
    .order("criado_em", { ascending: true });
  const lista = (data ?? []) as Array<{ id: string; email_completo: string | null }>;
  const secretaria = lista.find((r) => (r.email_completo ?? "").toLowerCase().startsWith("secretaria@"));
  return (secretaria ?? lista[0])?.id ?? null;
}

/** Manda o e-mail pelo email-send (chave de serviço). Devolve se foi aceito; nunca lança. */
// deno-lint-ignore no-explicit-any
export async function enviarEmailDoLink(admin: any, p: {
  para: string; nome: string; sigla: string; link: string; motivo: "convite" | "nova_senha"; chave: string;
}): Promise<boolean> {
  try {
    const remetente = await remetenteDoPortal(admin);
    if (!remetente) return false;
    const { assunto, html, texto } = emailDoLink(p);
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/email-send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        remetente_id: remetente,
        destinatario_email: p.para,
        destinatario_nome: p.nome,
        assunto,
        corpo_html: html,
        corpo_texto: texto,
        contexto_tipo: "ies_portal_link",
        idempotencia_key: `ies_portal_link:${p.chave}`,
      }),
    });
    if (!r.ok) console.error("[ies-portal] email-send", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("[ies-portal] email-send falhou", e);
    return false;
  }
}
