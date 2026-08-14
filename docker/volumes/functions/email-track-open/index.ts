// Edge Function: email-track-open
// Pixel 1x1 — registra abertura.
//
// Aceita DOIS parâmetros porque existem dois tipos de envio:
//   ?id=<emails_enviados.id>          → envio de template/campanha (o que o email-send emite)
//   ?envio_id=<email_campanhas_envios.id> → linha da fila de campanha (formato antigo)
//
// ⚠️ Até 2026-08-14 esta função só lia `envio_id` enquanto o email-send emitia `id`,
// então NENHUMA abertura de template era contada. Some-se a isso o pixel apontar para
// SUPABASE_URL (http://kong:8000, inalcançável de fora) e o número de "abertos" era
// estruturalmente zero. Ver docs/E-mail e Caixas.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));

async function contarAberturaCampanha(supabase: any, envioId: string) {
  const { data: envio } = await supabase
    .from("email_campanhas_envios")
    .select("id, campanha_id, aberto_em")
    .eq("id", envioId).maybeSingle();
  if (envio && !envio.aberto_em) {
    await supabase.from("email_campanhas_envios").update({
      status: "aberto", aberto_em: new Date().toISOString(),
    }).eq("id", envio.id);
    const { data: c } = await supabase.from("email_campanhas").select("abertos").eq("id", envio.campanha_id).single();
    await supabase.from("email_campanhas").update({ abertos: (c?.abertos ?? 0) + 1 }).eq("id", envio.campanha_id);
  }
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const logId = url.searchParams.get("id");
    const envioId = url.searchParams.get("envio_id");

    if (logId || envioId) {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

      if (logId) {
        const { data: log } = await supabase
          .from("emails_enviados")
          .select("id, status, aberto_em, aberto_count, contexto_tipo, contexto_id")
          .eq("id", logId).maybeSingle();
        if (log) {
          const primeira = !log.aberto_em;
          await supabase.from("emails_enviados").update({
            // Não regride status: um e-mail já 'clicado' não volta pra 'aberto'.
            status: log.status === "clicado" ? log.status : "aberto",
            aberto_em: log.aberto_em ?? new Date().toISOString(),
            aberto_count: (log.aberto_count ?? 0) + 1,
          }).eq("id", log.id);

          // Envio de campanha: propaga para a linha da fila e para o contador.
          if (primeira && log.contexto_tipo === "campanha" && log.contexto_id) {
            const { data: envio } = await supabase
              .from("email_campanhas_envios")
              .select("id")
              .eq("email_enviado_id", log.id)
              .maybeSingle();
            if (envio) await contarAberturaCampanha(supabase, envio.id);
          }
        }
      }

      if (envioId) await contarAberturaCampanha(supabase, envioId);
    }
  } catch { /* pixel nunca pode falhar para o leitor */ }

  return new Response(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-cache, no-store, must-revalidate" },
  });
});
