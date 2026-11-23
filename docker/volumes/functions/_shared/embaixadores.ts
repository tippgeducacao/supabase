// Peças compartilhadas do Programa de Embaixadores (23/11/2026) — usadas por emb-acessos (a PPGVET
// convida e cria links) e emb-cadastro-publico (o embaixador se cadastra, confirma o e-mail e cria a
// senha). Token, hash e origem são os mesmos do Portal da IES (iesPortal.ts). Ver docs/Embaixadores.md.
export { emailValido, hashToken, novoToken, origemDoPortal } from "./iesPortal.ts";

/** Convite pessoal 7 dias; nova senha 1 hora; confirmar e-mail 7 dias. */
export const VALIDADE_CONVITE_MS = 7 * 24 * 60 * 60 * 1000;
export const VALIDADE_NOVA_SENHA_MS = 60 * 60 * 1000;
export const VALIDADE_CONFIRMAR_EMAIL_MS = 7 * 24 * 60 * 60 * 1000;

export type MotivoEmail = "convite" | "nova_senha" | "confirmar_email";

export const CAMINHO_DO_LINK: Record<MotivoEmail | "cadastro", string> = {
  cadastro: "/embaixador/cadastro",
  convite: "/embaixador/cadastro",
  nova_senha: "/embaixador/criar-senha",
  confirmar_email: "/embaixador/confirmar-email",
};

export const linkDoToken = (origem: string, motivo: MotivoEmail | "cadastro", token: string) =>
  `${origem}${CAMINHO_DO_LINK[motivo]}?c=${encodeURIComponent(token)}`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function emailDoEmbaixador(p: { nome: string; link: string; motivo: MotivoEmail }) {
  const textos: Record<MotivoEmail, { assunto: string; corpo: string; botao: string; validade: string }> = {
    convite: {
      assunto: "Seu convite para o Programa de Embaixadores PPGVET",
      corpo: "A PPGVET Educação convidou você para o <strong>Programa de Embaixadores</strong>. Pelo link abaixo você preenche o seu cadastro, com a foto e a história que vão para a sua página, e cria a senha do seu painel.",
      botao: "Fazer meu cadastro",
      validade: "O link vale por 7 dias.",
    },
    nova_senha: {
      assunto: "Crie uma nova senha do Painel do Embaixador",
      corpo: "Recebemos um pedido para criar uma nova senha do Painel do Embaixador PPGVET.",
      botao: "Criar nova senha",
      validade: "O link vale por 1 hora.",
    },
    confirmar_email: {
      assunto: "Confirme o seu e-mail — Programa de Embaixadores PPGVET",
      corpo: "Recebemos o seu cadastro no <strong>Programa de Embaixadores PPGVET</strong>. Confirme o seu e-mail pelo link abaixo. Depois a equipe do programa segue com o contrato e a sua página.",
      botao: "Confirmar meu e-mail",
      validade: "O link vale por 7 dias.",
    },
  };
  const t = textos[p.motivo];
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.55;max-width:520px">
  <p style="margin:0 0 12px">Olá, ${esc(p.nome)}.</p>
  <p style="margin:0 0 12px">${t.corpo}</p>
  <p style="margin:0 0 18px"><a href="${esc(p.link)}" style="display:inline-block;padding:10px 18px;background:#7B2D7E;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${t.botao}</a></p>
  <p style="margin:0 0 6px;font-size:13px;color:#4b5563">${t.validade} Se não foi você, ignore este e-mail.</p>
  <p style="margin:0;font-size:12px;color:#6b7280">PPGVET Educação · Programa de Embaixadores</p>
</div>`;
  return { assunto: t.assunto, html, texto: `${t.assunto}\n\n${p.link}\n\n${t.validade}` };
}

/** Remetente: `EMB_REMETENTE_ID` (secret) → caixa `comercial@` → `secretaria@` → o primeiro ativo. */
// deno-lint-ignore no-explicit-any
export async function remetenteDoPrograma(admin: any): Promise<string | null> {
  const fixo = Deno.env.get("EMB_REMETENTE_ID");
  if (fixo) return fixo;
  const { data } = await admin.from("email_remetentes").select("id, email_completo, criado_em")
    .eq("ativo", true).order("criado_em", { ascending: true });
  const lista = (data ?? []) as Array<{ id: string; email_completo: string | null }>;
  const comeca = (p: string) => lista.find((r) => (r.email_completo ?? "").toLowerCase().startsWith(p));
  return (comeca("comercial@") ?? comeca("secretaria@") ?? lista[0])?.id ?? null;
}

/** Manda o e-mail pelo email-send (chave de serviço). Devolve se foi aceito; nunca lança. */
// deno-lint-ignore no-explicit-any
export async function enviarEmailDoEmbaixador(admin: any, p: {
  para: string; nome: string; link: string; motivo: MotivoEmail; chave: string;
}): Promise<boolean> {
  try {
    const remetente = await remetenteDoPrograma(admin);
    if (!remetente) return false;
    const { assunto, html, texto } = emailDoEmbaixador(p);
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
        contexto_tipo: "emb_link",
        idempotencia_key: `emb_link:${p.chave}`,
      }),
    });
    if (!r.ok) console.error("[embaixadores] email-send", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("[embaixadores] email-send falhou", e);
    return false;
  }
}

/** IP de quem chamou (aceite do termo e da LGPD). Cloudflare na frente: cf-connecting-ip primeiro. */
export function ipDoPedido(req: Request): string | null {
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  return /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : null;
}
