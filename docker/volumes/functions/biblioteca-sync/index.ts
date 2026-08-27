/**
 * Entrega o material de aula na Biblioteca Didática (projeto separado).
 *
 * A trigger de `ped_aula_anexos` enfileira em `ped_biblioteca_envios`; esta
 * função drena a fila. A fila existe justamente porque a biblioteca é outro
 * sistema: se ela estiver fora do ar na hora do upload, o material espera aqui
 * em vez de se perder calado.
 *
 * Idempotente do outro lado (a biblioteca casa por origem + external_id), então
 * reenviar corrige e nunca duplica. Por isso é seguro repetir uma entrega em
 * dúvida — o risco é o oposto: deixar de entregar.
 *
 * Variáveis necessárias:
 *   BIBLIOTECA_INGEST_URL     — ex.: https://materiaispedagogico.lovable.app/api/public/ingestao-material
 *   BIBLIOTECA_INGEST_SECRET  — o mesmo segredo configurado na biblioteca
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
import { corsHeaders } from '../_shared/cors.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

/** Depois disso, para de tentar sozinho: alguém precisa olhar. */
const MAX_TENTATIVAS = 5
/** Teto por execução, para uma fila represada não estourar o tempo da função. */
const LOTE = 50

interface Envio {
  id: string
  anexo_id: string
  acao: 'upsert' | 'remover'
  payload: Record<string, unknown>
  tentativas: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = Deno.env.get('BIBLIOTECA_INGEST_URL')
  const secret = Deno.env.get('BIBLIOTECA_INGEST_SECRET')
  if (!url || !secret) {
    return new Response(
      JSON.stringify({ erro: 'BIBLIOTECA_INGEST_URL/SECRET não configurados' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const { data: fila, error } = await supabase
    .from('ped_biblioteca_envios')
    .select('id,anexo_id,acao,payload,tentativas')
    .neq('status', 'enviado')
    .lt('tentativas', MAX_TENTATIVAS)
    .order('criado_em', { ascending: true })
    .limit(LOTE)

  if (error) {
    console.error('[biblioteca-sync] falha ao ler a fila', error)
    return new Response(JSON.stringify({ erro: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const resultado = { lidos: fila?.length ?? 0, enviados: 0, erros: 0, detalhes: [] as unknown[] }

  for (const envio of (fila ?? []) as Envio[]) {
    let ok = false
    let detalhe: unknown = null

    try {
      const resposta = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(envio.payload),
      })

      const texto = await resposta.text()
      try {
        detalhe = JSON.parse(texto)
      } catch {
        detalhe = texto.slice(0, 300)
      }
      ok = resposta.ok
      if (!ok) detalhe = { status: resposta.status, resposta: detalhe }
    } catch (e) {
      detalhe = { erro: e instanceof Error ? e.message : String(e) }
    }

    await supabase
      .from('ped_biblioteca_envios')
      .update(
        ok
          ? { status: 'enviado', enviado_em: new Date().toISOString(), ultimo_erro: null,
              tentativas: envio.tentativas + 1 }
          : { status: 'erro', tentativas: envio.tentativas + 1,
              ultimo_erro: JSON.stringify(detalhe).slice(0, 800) }
      )
      .eq('id', envio.id)

    if (ok) resultado.enviados += 1
    else resultado.erros += 1
    resultado.detalhes.push({ envio: envio.id, acao: envio.acao, ok, detalhe })
  }

  return new Response(JSON.stringify(resultado), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
