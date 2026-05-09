import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log('🚀 delete-user: Requisição recebida', req.method)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      console.log('❌ Sem header de autorização')
      return new Response(JSON.stringify({ error: 'Não autorizado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // Verify caller identity using their token
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user: callerUser }, error: userError } = await userClient.auth.getUser()
    if (userError || !callerUser) {
      console.log('❌ Token inválido:', userError?.message)
      return new Response(JSON.stringify({ error: 'Token inválido' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const callerId = callerUser.id
    console.log('✅ Caller autenticado:', callerId)

    // Use service role client for admin operations
    const adminClient = createClient(supabaseUrl, supabaseServiceKey)

    // Check if caller is diretor
    const { data: callerProfile } = await adminClient
      .from('profiles')
      .select('user_type')
      .eq('id', callerId)
      .single()

    const { data: callerRoles } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', callerId)

    const isDiretor =
      callerProfile?.user_type === 'diretor' ||
      callerRoles?.some((r: any) => r.role === 'diretor')

    console.log('🔍 Checagem diretor:', { userType: callerProfile?.user_type, roles: callerRoles, isDiretor })

    if (!isDiretor) {
      return new Response(
        JSON.stringify({ error: 'Apenas diretores podem excluir usuários' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get userId from request body
    const { userId } = await req.json()
    console.log('🎯 userId a excluir:', userId)

    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId é obrigatório' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Verify target user is inactive
    const { data: targetProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('ativo, name')
      .eq('id', userId)
      .single()

    if (profileError || !targetProfile) {
      console.log('❌ Usuário não encontrado:', profileError?.message)
      return new Response(JSON.stringify({ error: 'Usuário não encontrado' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (targetProfile.ativo) {
      return new Response(
        JSON.stringify({ error: 'Só é possível excluir usuários inativos' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Prevent self-deletion
    if (userId === callerId) {
      return new Response(
        JSON.stringify({ error: 'Você não pode excluir a si mesmo' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`🗑️ Excluindo usuário: ${targetProfile.name} (${userId})`)

    // Delete user_roles
    console.log('🔄 Deletando user_roles...')
    await adminClient.from('user_roles').delete().eq('user_id', userId)

    // Delete profile (cascades should handle most related records)
    console.log('🔄 Deletando profile...')
    const { error: deleteProfileError } = await adminClient
      .from('profiles')
      .delete()
      .eq('id', userId)

    if (deleteProfileError) {
      console.error('❌ Erro ao deletar profile:', deleteProfileError)
      return new Response(
        JSON.stringify({ error: `Erro ao deletar perfil: ${deleteProfileError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Delete auth user
    console.log('🔄 Deletando auth user...')
    const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId)

    if (deleteAuthError) {
      console.error('❌ Erro ao deletar auth user:', deleteAuthError)
      return new Response(
        JSON.stringify({ error: `Erro ao deletar usuário da autenticação: ${deleteAuthError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`✅ Usuário ${targetProfile.name} excluído com sucesso`)

    return new Response(
      JSON.stringify({ success: true, message: `Usuário ${targetProfile.name} excluído com sucesso` }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('❌ Erro inesperado:', error)
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'Erro interno do servidor' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})