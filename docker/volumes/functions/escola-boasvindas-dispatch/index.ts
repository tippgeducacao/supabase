// Apresenta a Escola de Especialização a quem acabou de se inscrever numa aula.
//
// Pedido do usuário em 04/09/2026 ("deixe automático"). Varre leads novos de
// página de aula, manda o template de e-mail e anota no livro-razão
// `escola_boasvindas_envios`. Chamada por pg_cron (job `escola-boasvindas-tick`).
//
// ── AS TRÊS TRAVAS CONTRA ENVIO INDEVIDO ────────────────────────────────────
// Mandar e-mail sozinho para gente real erra em um sentido só: a mais. Por isso
// há três barreiras independentes, e nenhuma depende das outras:
//
//  1. O livro-razão nasceu com TODO o histórico marcado (4.320 e-mails em
//     04/09/2026). Quem já estava na base não recebe — por construção, não por
//     filtro de data.
//  2. A linha é RESERVADA antes do envio (claim), com o e-mail como PK. Dois
//     ticks simultâneos: o segundo bate no conflito e desiste. Nunca duplica.
//  3. `idempotencia_key` no `email-send`, que tem a própria guarda.
//
// E uma quarta, contra represamento: só olha lead criado nos últimos JANELA_DIAS.
// Se o cron ficar dias parado, ele não descarrega a fila acumulada de uma vez —
// e ninguém recebe "bem-vindo à aula" uma semana depois de a aula ter acontecido.
//
// `?dry=1` devolve exatamente quem receberia, sem mandar nada e sem gravar.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/** Template "Escola de Especialização · Apresentação a quem se inscreveu na aula". */
const TEMPLATE_ID = '0aa5cfee-0082-4f95-ab7c-bfed7c16e6d8';
/** Remetente "Secretaria Acadêmica PPG Educação" (escolha do usuário, 04/09/2026). */
const REMETENTE_ID = '87154227-5d79-4a53-ade6-95befa2a6456';
/** Lead mais velho que isso não recebe: a aula dele já passou. */
const JANELA_DIAS = 3;
/** Teto por tick. O volume real é ~22/dia, então isto é folga, não corte. */
const LOTE = 40;

/** "WILLIAM BRAZ FALCÃO" → "William". O e-mail cumprimenta, não cadastra. */
function primeiroNome(nome: string | null): string {
  const bruto = (nome ?? '').trim().split(/\s+/)[0] ?? '';
  if (!bruto) return '';
  return bruto.charAt(0).toUpperCase() + bruto.slice(1).toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const dry = url.searchParams.get('dry') === '1';

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  const desde = new Date(Date.now() - JANELA_DIAS * 86_400_000).toISOString();

  // Candidatos: lead de página de aula, com e-mail, dentro da janela. O filtro
  // de página fica em SQL (RPC) porque é a MESMA régua da migration — repetir o
  // regexp aqui em JS abriria a porta para as duas divergirem.
  const { data: candidatos, error: errBusca } = await db.rpc(
    'escola_boasvindas_candidatos',
    { p_desde: desde, p_limite: LOTE },
  );
  if (errBusca) {
    return new Response(JSON.stringify({ error: errBusca.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const lista = (candidatos ?? []) as Array<{ lead_id: string; nome: string; email: string; email_norm: string }>;
  if (dry) {
    return new Response(JSON.stringify({ dry: true, candidatos: lista.length, lista }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let enviados = 0, erros = 0, pulados = 0;

  for (const c of lista) {
    // TRAVA 2 — reserva a linha ANTES de mandar. Se outro tick já reservou, o
    // insert falha no PK e este some daqui sem enviar.
    const { error: errClaim } = await db
      .from('escola_boasvindas_envios')
      .insert({ email_norm: c.email_norm, lead_id: c.lead_id, status: 'enviando' });
    if (errClaim) { pulados++; continue; }

    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/email-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          template_id: TEMPLATE_ID,
          remetente_id: REMETENTE_ID,
          destinatario_email: c.email,
          contexto_tipo: 'lead',
          contexto_id: c.lead_id,
          idempotencia_key: `escola-boasvindas-${c.email_norm}`,
          variaveis: { nome: primeiroNome(c.nome) },
        }),
      });
      const corpo = await resp.json().catch(() => ({}));
      if (resp.ok) {
        enviados++;
        await db.from('escola_boasvindas_envios')
          .update({ status: 'enviado', email_enviado_id: corpo?.email_enviado_id ?? null })
          .eq('email_norm', c.email_norm);
      } else {
        erros++;
        // Fica como 'erro' e NÃO é retentado sozinho: uma pessoa sem boas-vindas
        // é um problema menor que um laço que reenvia. Para retentar, apague a
        // linha — o varredor volta a enxergá-la enquanto estiver na janela.
        await db.from('escola_boasvindas_envios')
          .update({ status: 'erro', erro: String(corpo?.error ?? resp.status).slice(0, 400) })
          .eq('email_norm', c.email_norm);
      }
    } catch (e) {
      erros++;
      await db.from('escola_boasvindas_envios')
        .update({ status: 'erro', erro: String(e).slice(0, 400) })
        .eq('email_norm', c.email_norm);
    }
  }

  return new Response(JSON.stringify({ ok: true, candidatos: lista.length, enviados, erros, pulados }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
