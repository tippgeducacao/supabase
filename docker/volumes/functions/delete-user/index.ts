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

    // Tudo ou nada (25/11/2026): apagar o usuário da autenticação é UM comando no banco, que leva o
    // perfil junto (profiles.id → auth.users ON DELETE CASCADE). Se o perfil tem histórico (reuniões,
    // pontos, recontatos, feedbacks, SAC…), as FKs sem cascade barram e nada é apagado. Antes o
    // perfil saía primeiro e a falha seguinte deixava a conta pela metade.
    const VINCULOS =
      'Este usuário tem registros ligados a ele (reuniões, pontos, recontatos, feedbacks, atendimentos…) e não pode ser excluído. Mantenha-o desativado.'
    console.log('🔄 Deletando auth user (leva o perfil junto)...')
    const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId)

    if (deleteAuthError) {
      console.error('❌ Erro ao deletar auth user:', deleteAuthError)
      if (deleteAuthError.status !== 404) {
        // O Auth devolve só "Database error deleting user"; com o perfil existindo, a causa é FK.
        return new Response(
          JSON.stringify({ error: VINCULOS, detalhe: deleteAuthError.message }),
          { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      // Perfil sem conta no Auth (sobra de exclusão antiga): apaga só o perfil, um comando só.
      const { error: deleteProfileError } = await adminClient.from('profiles').delete().eq('id', userId)
      if (deleteProfileError) {
        console.error('❌ Erro ao deletar profile:', deleteProfileError)
        const fk = deleteProfileError.code === '23503'
        return new Response(
          JSON.stringify({ error: fk ? VINCULOS : `Erro ao deletar perfil: ${deleteProfileError.message}` }),
          { status: fk ? 409 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // user_roles não tem FK: só depois de a conta sair (se falhar, o papel sobra sem dono, sem efeito).
    console.log('🔄 Deletando user_roles...')
    await adminClient.from('user_roles').delete().eq('user_id', userId)

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