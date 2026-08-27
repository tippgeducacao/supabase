/**
 * Passe de entrada na área administrativa da Biblioteca Didática.
 *
 * Ninguém do pedagógico precisa de senha nova: quem já está logado no sistema
 * clica em "Biblioteca didática alunos" e entra lá dentro como administrador.
 *
 * Como funciona: esta função confere quem está chamando (sessão do sistema +
 * acesso ao pedagógico) e devolve uma URL com um passe curto, assinado com o
 * mesmo segredo compartilhado da ingestão. A biblioteca confere a assinatura,
 * acha (ou cria) o usuário por e-mail e abre a sessão.
 *
 * O passe vale 2 minutos e carrega só e-mail e nome — nada de senha trafegando.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
import { corsHeaders } from '../_shared/cors.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

/** Janela curta de propósito: o passe é para ser usado no clique, não guardado. */
const VALIDADE_SEGUNDOS = 120

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function assinar(dados: string, segredo: string): Promise<string> {
  const chave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const assinatura = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(dados))
  return base64url(new Uint8Array(assinatura))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const responder = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  // 1. Quem está pedindo?
  const auth = req.headers.get('Authorization') ?? ''
  const jwt = auth.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return responder({ erro: 'Sem sessão.' }, 401)

  const { data: userData, error: userErro } = await admin.auth.getUser(jwt)
  const user = userData?.user
  if (userErro || !user?.email) return responder({ erro: 'Sessão inválida.' }, 401)

  // 2. Essa pessoa pode entrar no pedagógico?
  const { data: liberado, error: permErro } = await admin.rpc('user_can_access_pedagogico', {
    _user_id: user.id,
  })
  if (permErro) {
    console.error('[biblioteca-sso] falha ao checar permissão', permErro)
    return responder({ erro: 'Não foi possível conferir a permissão.' }, 500)
  }
  if (!liberado) return responder({ erro: 'Sem acesso ao pedagógico.' }, 403)

  // 3. Para onde e com qual segredo
  const { data: config } = await admin
    .from('ped_biblioteca_config')
    .select('ingest_url,ingest_secret')
    .maybeSingle()

  const ingestUrl = config?.ingest_url ?? Deno.env.get('BIBLIOTECA_INGEST_URL')
  const segredo = config?.ingest_secret ?? Deno.env.get('BIBLIOTECA_INGEST_SECRET')
  if (!ingestUrl || !segredo) return responder({ erro: 'Biblioteca não configurada.' }, 503)

  const base = new URL(ingestUrl).origin

  // 4. O passe
  const { data: perfil } = await admin
    .from('profiles')
    .select('name')
    .eq('id', user.id)
    .maybeSingle()

  const dados = {
    email: user.email,
    nome: (perfil as { name?: string } | null)?.name ?? user.email,
    exp: Math.floor(Date.now() / 1000) + VALIDADE_SEGUNDOS,
  }
  const corpo = base64url(new TextEncoder().encode(JSON.stringify(dados)))
  const token = `${corpo}.${await assinar(corpo, segredo)}`

  return responder({ url: `${base}/ppgvet-admin/sso?t=${encodeURIComponent(token)}` })
})
