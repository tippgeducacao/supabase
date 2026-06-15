// ============================================================================
// Gestão das chaves da API SDR (criar / listar / revogar). SÓ DIRETOR.
//
// Espelha o padrão de autorização de `create-user`: valida o JWT do usuário
// logado e confirma que ele é diretor. O segredo da chave é gerado aqui,
// devolvido UMA única vez, e só o hash (sha256) é persistido em sdr_api_keys.
// O frontend (aba "Chaves de API" em Gerenciar Vendedores) chama via
// supabase.functions.invoke('sdr-api-keys', { body: { action, ... } }).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
import { corsHeaders } from '../_shared/cors.ts'

const SDR_USER_TYPES = ['sdr', 'sdr_coordenador', 'sdr_vendas_diretas', 'sdr_inbound', 'sdr_outbound']

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function generateSecret(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `sdrk_live_${hex}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json(401, { error: 'Não autorizado' })

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // cliente do usuário logado (para validar quem está chamando)
    const userClient = createClient(SUPABASE_URL, ANON, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json(401, { error: 'Usuário não autenticado' })

    const { data: profile } = await userClient.from('profiles').select('user_type').eq('id', user.id).single()
    const { data: roles } = await userClient.from('user_roles').select('role').eq('user_id', user.id)
    const isDiretor = profile?.user_type === 'diretor' || (roles || []).some((r: any) => r.role === 'diretor')
    if (!isDiretor) return json(403, { error: 'Apenas diretores podem gerenciar chaves de API SDR' })

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const body = await req.json().catch(() => ({}))
    const action = body?.action as string

    // ---- LISTAR ----
    if (action === 'list') {
      const { data, error } = await admin
        .from('sdr_api_keys')
        .select('id, label, key_prefix, ativo, last_used_at, revoked_at, created_at, sdr:profiles!sdr_api_keys_sdr_id_fkey(id, name, email, user_type)')
        .order('created_at', { ascending: false })
      if (error) return json(500, { error: error.message })
      return json(200, { data })
    }

    // ---- CRIAR ----
    if (action === 'create') {
      const sdrId = body?.sdr_id as string
      const label = (body?.label as string)?.trim()
      if (!sdrId || !label) return json(400, { error: 'sdr_id e label são obrigatórios' })

      const { data: sdr } = await admin.from('profiles').select('id, user_type, ativo').eq('id', sdrId).maybeSingle()
      if (!sdr) return json(404, { error: 'SDR não encontrado' })
      if (!SDR_USER_TYPES.includes(sdr.user_type)) {
        return json(422, { error: 'A chave só pode ser criada para um colaborador SDR' })
      }

      const secret = generateSecret()
      const keyHash = await sha256hex(secret)
      const keyPrefix = secret.slice(0, 16) // ex.: sdrk_live_a1b2c3

      const { data: inserted, error } = await admin
        .from('sdr_api_keys')
        .insert({
          sdr_id: sdrId,
          label,
          key_prefix: keyPrefix,
          key_hash: keyHash,
          created_by: user.id,
        })
        .select('id, label, key_prefix, ativo, created_at')
        .single()
      if (error) return json(500, { error: error.message })

      // O segredo completo é retornado UMA única vez.
      return json(201, { data: { ...inserted, secret } })
    }

    // ---- REVOGAR ----
    if (action === 'revoke') {
      const id = body?.id as string
      if (!id) return json(400, { error: 'id é obrigatório' })
      const { error } = await admin
        .from('sdr_api_keys')
        .update({ ativo: false, revoked_at: new Date().toISOString() })
        .eq('id', id)
      if (error) return json(500, { error: error.message })
      return json(200, { data: { id, revoked: true } })
    }

    return json(400, { error: `Ação inválida: ${action}` })
  } catch (err) {
    console.error('[sdr-api-keys] erro', err)
    return json(500, { error: 'Erro interno do servidor' })
  }
})
