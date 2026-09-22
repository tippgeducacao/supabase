// Edge Function: email-track-click
// Redirecionador de cliques — registra e devolve 302 para o destino real.
//
// Par do `email-track-open` (pixel de abertura). O envio embrulha cada link
// navegável em `…/email-track-click?e=<emails_enviados.id>&t=<hmac>&u=<destino>`.
//
// ⚠️ A ASSINATURA NÃO É OPCIONAL. Sem ela isto é um open redirect com o nosso
// domínio: `?u=https://site-de-golpe` viraria link de phishing saindo da nossa
// reputação, e o e-mail legítimo iria junto para o spam. Destino sem assinatura
// válida NÃO redireciona — devolve 400 e não registra nada.
//
// O que o clique alimenta (tudo já existia e estava zerado por falta desta ponta):
//   emails_enviados.clicado_count / clicado_em / status  → relatório de e-mail
//   email_campanhas_envios.clicado_em                   → detalhe da campanha
//   email_campanhas.clicados                             → card e teste A/B
//   email_cliques                                        → QUAL link foi clicado
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { conferirCliqueEmail } from "../_shared/envioComum.ts";

const HTML_ERRO = `<!doctype html><html lang="pt-BR"><meta charset="utf-8">`
  + `<title>Link inválido</title><body style="font-family:Arial,Helvetica,sans-serif;padding:32px;color:#1f2937">`
  + `<h1 style="font-size:18px">Link inválido</h1>`
  + `<p style="font-size:14px;color:#4b5563">Este endereço não confere com o e-mail que o gerou. `
  + `Abra o link direto da mensagem que você recebeu.</p></body></html>`;

const erro = (status: number) => new Response(HTML_ERRO, {
  status,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
});

/** Só http(s). Bloqueia `javascript:`, `data:` e afins mesmo que assinados. */
function destinoValido(bruto: string): string | null {
  try {
    const url = new URL(bruto);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? bruto : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const envioId = url.searchParams.get("e") ?? "";
  const token = url.searchParams.get("t") ?? "";
  const destinoBruto = url.searchParams.get("u") ?? "";

  const destino = destinoValido(destinoBruto);
  if (!envioId || !token || !destino) return erro(400);
  if (!await conferirCliqueEmail(envioId, destino, token)) return erro(400);

  // Redireciona ANTES de qualquer escrita falhar: quem clicou não pode ficar numa
  // tela de erro porque o banco piscou. O registro é o efeito colateral, não o fim.
  const resposta = Response.redirect(destino, 302);
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: log } = await supabase
      .from("emails_enviados")
      .select("id, status, clicado_em, clicado_count, contexto_tipo, contexto_id")
      .eq("id", envioId).maybeSingle();
    if (!log) return resposta;

    const primeiro = !log.clicado_em;
    const agora = new Date().toISOString();
    await supabase.from("emails_enviados").update({
      status: "clicado", // clique é o estágio mais avançado: nunca regride.
      clicado_em: log.clicado_em ?? agora,
      clicado_count: (log.clicado_count ?? 0) + 1,
    }).eq("id", log.id);

    const campanhaId = log.contexto_tipo === "campanha" ? log.contexto_id : null;
    await supabase.from("email_cliques").insert({
      email_enviado_id: log.id, campanha_id: campanhaId, url: destino.slice(0, 2048),
    });

    // Campanha: propaga para a linha da fila e para o contador do card, do mesmo
    // jeito que a abertura faz. Só no PRIMEIRO clique — o contador é de pessoas
    // que clicaram, não de cliques (quem clica três vezes não vira três pessoas).
    if (primeiro && campanhaId) {
      const { data: envio } = await supabase
        .from("email_campanhas_envios")
        .select("id, clicado_em")
        .eq("email_enviado_id", log.id).maybeSingle();
      if (envio && !envio.clicado_em) {
        // Só o carimbo: o enum `email_campanha_envio_status` NÃO tem 'clicado'
        // (vai até 'aberto'), e inventar valor de enum aqui derrubaria o update
        // inteiro — junto com o contador da campanha, que vem depois.
        await supabase.from("email_campanhas_envios")
          .update({ clicado_em: agora }).eq("id", envio.id);
        const { data: c } = await supabase.from("email_campanhas").select("clicados").eq("id", campanhaId).single();
        await supabase.from("email_campanhas").update({ clicados: (c?.clicados ?? 0) + 1 }).eq("id", campanhaId);
      }
    }
  } catch { /* o clique já está a caminho do destino; registro é o que se perde */ }

  return resposta;
});
