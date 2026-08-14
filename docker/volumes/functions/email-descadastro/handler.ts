/**
 * Miolo do descadastro. Fora do `Deno.serve` para ser testável — ver o mesmo padrão
 * em `webhooks-ses-events/handler.ts`.
 */
import { conferirDescadastro } from "../_shared/resend.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function pagina(titulo: string, mensagem: string, sucesso: boolean): Response {
  const cor = sucesso ? "#059669" : "#b45309";
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f9fafb;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;
max-width:420px;text-align:center">
<div style="font-size:40px;line-height:1;margin-bottom:12px">${sucesso ? "&#10003;" : "!"}</div>
<h1 style="margin:0 0 8px;font-size:18px;color:${cor}">${titulo}</h1>
<p style="margin:0;font-size:14px;color:#4b5563;line-height:1.5">${mensagem}</p>
</div></body></html>`,
    { status: sucesso ? 200 : 400, headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" } },
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteSupabase = any;

export interface DepsDescadastro {
  supabase: ClienteSupabase;
  /** Injetada nos testes; em produção confere o HMAC de verdade. */
  conferirToken?: (email: string, token: string) => Promise<boolean>;
}

export async function tratarDescadastro(req: Request, deps: DepsDescadastro): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const conferir = deps.conferirToken ?? conferirDescadastro;
  const url = new URL(req.url);
  let email = url.searchParams.get("e") ?? "";
  let token = url.searchParams.get("t") ?? "";

  // O one-click do Gmail manda POST; alguns clientes repetem os campos no corpo.
  if (req.method === "POST" && (!email || !token)) {
    try {
      const form = await req.formData();
      email = email || String(form.get("e") ?? "");
      token = token || String(form.get("t") ?? "");
    } catch {
      // corpo vazio é o normal no one-click
    }
  }

  if (!email || !token) {
    return pagina("Link inválido", "Faltam dados no link de descadastro.", false);
  }
  if (!(await conferir(email, token))) {
    return pagina(
      "Link inválido",
      "Este link de descadastro não confere. Peça um novo e-mail ou fale com a Secretaria.",
      false,
    );
  }

  // Idempotente: clicar duas vezes não gera erro nem linha duplicada.
  await deps.supabase.from("email_supressoes").upsert(
    {
      email: email.toLowerCase().trim(),
      motivo: "descadastro",
      detalhe: "clique no link de descadastro",
    },
    { onConflict: "email", ignoreDuplicates: true },
  );

  return pagina(
    "Pronto, você foi descadastrado",
    `Não enviaremos mais disparos para <strong>${email}</strong>. ` +
      "E-mails sobre assuntos que você já tem em andamento continuam chegando normalmente.",
    true,
  );
}
