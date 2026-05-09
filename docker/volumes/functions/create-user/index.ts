import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
import { corsHeaders } from '../_shared/cors.ts'
import { createLogger } from '../_shared/logger.ts'

const logger = createLogger('create-user');

// Simple in-memory rate limiter
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const ipLimit = rateLimiter.get(ip);

  if (!ipLimit || now > ipLimit.resetAt) {
    rateLimiter.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (ipLimit.count >= MAX_ATTEMPTS) {
    logger.warn('Rate limit exceeded', { ip: ip.substring(0, 8) });
    return false;
  }

  ipLimit.count++;
  return true;
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Rate limiting by IP
    const clientIp = req.headers.get('x-forwarded-for') || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return new Response(
        JSON.stringify({ error: 'Muitas tentativas. Aguarde 1 minuto.' }),
        { 
          status: 429, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Get the authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      logger.warn('Missing authorization header');
      return new Response(
        JSON.stringify({ error: 'Não autorizado' }),
        { 
          status: 401, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Parse request body
    const { email, password, name, userType, nivel } = await req.json()

    // Validate required fields
    if (!email || !password || !name || !userType) {
      logger.warn('Missing required fields');
      return new Response(
        JSON.stringify({ error: 'Todos os campos são obrigatórios' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Create Supabase client for user verification
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: authHeader }
      }
    })

    // Verify that the current user is a director
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      logger.warn('User not authenticated');
      return new Response(
        JSON.stringify({ error: 'Usuário não autenticado' }),
        { 
          status: 401, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Check if user is director
    const { data: profile } = await supabase
      .from('profiles')
      .select('user_type')
      .eq('id', user.id)
      .single()

    const { data: roles } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)

    const isDiretor = roles?.some(r => r.role === 'diretor') || profile?.user_type === 'diretor'
    
    if (!isDiretor) {
      logger.warn('Non-director attempted user creation', { 
        requesterId: user.id.substring(0, 8) 
      });
      return new Response(
        JSON.stringify({ error: 'Apenas diretores podem criar usuários' }),
        { 
          status: 403, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Create Supabase Admin client
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })

    // Create user using Admin API
    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true, // Skip email confirmation for admin-created users
      user_metadata: {
        name: name.trim(),
        user_type: userType,
        nivel: ['admin', 'comum'].includes(userType) ? undefined : (nivel || 'junior')
      }
    })

    if (createError) {
      console.error('Erro ao criar usuário:', createError)
      let friendlyMessage = 'Erro ao criar usuário'
      
      if (createError.message.includes('User already registered')) {
        friendlyMessage = 'Este email já está cadastrado no sistema.'
      } else if (createError.message.includes('Invalid email')) {
        friendlyMessage = 'Email inválido.'
      } else {
        friendlyMessage = createError.message
      }
      
      return new Response(
        JSON.stringify({ error: friendlyMessage }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    if (!newUser.user) {
      return new Response(
        JSON.stringify({ error: 'Falha ao criar usuário' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    const userId = newUser.user.id

    // Default work schedule for vendedor/sdr
    const defaultHorarioTrabalho = ['vendedor', 'sdr'].includes(userType) ? {
      dias_trabalho: 'segunda_sabado',
      segunda_sexta: { periodo1_inicio: '09:00', periodo1_fim: '12:00', periodo2_inicio: '13:00', periodo2_fim: '18:00' },
      sabado: { periodo1_inicio: '09:00', periodo1_fim: '12:00', periodo2_inicio: '', periodo2_fim: '' }
    } : undefined;

    // Create profile directly in the database
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: userId,
        email: email.trim().toLowerCase(),
        name: name.trim(),
        user_type: userType,
        ativo: true,
        nivel: ['admin', 'comum'].includes(userType) ? undefined : 
               userType === 'supervisor' ? 'supervisor' : 
               userType === 'coordenador' ? 'coordenador' : (nivel || 'junior'),
        horario_trabalho: defaultHorarioTrabalho
      }, {
        onConflict: 'id'
      })

    if (profileError) {
      console.error('Erro ao criar perfil:', profileError)
      // Try to clean up the created user
      await supabaseAdmin.auth.admin.deleteUser(userId)
      
      return new Response(
        JSON.stringify({ error: 'Erro ao criar perfil do usuário' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Create user role if it's admin (SDR and vendedor use user_type only)
    if (userType === 'admin') {
      const { error: roleError } = await supabaseAdmin
        .from('user_roles')
        .insert({
          user_id: userId,
          role: 'admin',
          created_by: user.id
        })

      if (roleError) {
        console.error('Erro ao criar role:', roleError)
        // Role creation failed, but user and profile were created successfully
        // Log the error but don't fail the entire operation
      }
    }

    // Refresh ranking so the new user appears immediately on TV dashboards
    try {
      await supabaseAdmin.rpc('refresh_ranking_publico');
      logger.info('Ranking refreshed after user creation', { userId: userId.substring(0, 8) });
    } catch (refreshError) {
      console.error('Erro ao atualizar ranking:', refreshError);
      // Non-blocking: user was created successfully
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        userId,
        message: 'Usuário criado com sucesso' 
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error) {
    console.error('Erro geral:', error)
    return new Response(
      JSON.stringify({ error: 'Erro interno do servidor' }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})