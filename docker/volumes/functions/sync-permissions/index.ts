// Edge Function: sync-permissions
// Recebe a lista PERMISSIONS do bundle do frontend e sincroniza com o catálogo.
// - Upsert por `key` (atualiza label/section/description, reativa se necessário).
// - Marca como is_active=false qualquer registro cuja key não veio na lista.
// - Para cada permissão NOVA criada agora, insere em role_permissions com
//   granted=true APENAS para o cargo 'diretor' (default deny para os demais).
//   Isso garante que telas novas nunca vazam por descuido.
//
// Para preservar permissões EXISTENTES (Fase 2 fará backfill a partir de
// permissoes_cargo + departamentos.acessos_por_tipo), esta função só cria
// entradas default-deny para keys que NÃO existiam antes.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PermissionDef = {
  key: string;
  label: string;
  section: string;
  description?: string | null;
};

const ROLES = ['vendedor', 'sdr', 'admin', 'coordenador', 'supervisor', 'secretaria', 'diretor', 'comum'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      throw new Error('Missing Supabase env vars');
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    // Validar caller: precisa ser autenticado E diretor (ou chamada interna sem auth)
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    let callerIsDiretor = false;
    if (jwt) {
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '');
      const { data: userData } = await userClient.auth.getUser(jwt);
      const userId = userData?.user?.id;
      if (userId) {
        const { data: rolesRows } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', userId);
        callerIsDiretor = (rolesRows ?? []).some((r: { role: string }) => r.role === 'diretor');
      }
    } else {
      // Chamada sem JWT (build hook / boot inicial) — permite, mas sem auditoria de actor
      callerIsDiretor = true;
    }

    if (!callerIsDiretor) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = (await req.json().catch(() => ({}))) as { permissions?: PermissionDef[] };
    const incoming = Array.isArray(body.permissions) ? body.permissions : [];

    if (incoming.length === 0) {
      return new Response(JSON.stringify({ error: 'permissions array required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Pega keys existentes ANTES do upsert para detectar quais são novas
    const { data: existingRows, error: existingErr } = await supabase
      .from('permissions')
      .select('key, is_active');
    if (existingErr) throw existingErr;
    const existingMap = new Map<string, { is_active: boolean }>();
    (existingRows ?? []).forEach((r) => existingMap.set(r.key, { is_active: r.is_active }));

    const incomingKeys = new Set(incoming.map((p) => p.key));

    // 1) Upsert
    const upsertPayload = incoming.map((p) => ({
      key: p.key,
      label: p.label,
      section: p.section,
      description: p.description ?? null,
      is_active: true,
    }));
    const { error: upErr } = await supabase
      .from('permissions')
      .upsert(upsertPayload, { onConflict: 'key' });
    if (upErr) throw upErr;

    // 2) Desativar removidas
    const toDeactivate = (existingRows ?? [])
      .filter((r) => !incomingKeys.has(r.key) && r.is_active)
      .map((r) => r.key);
    if (toDeactivate.length > 0) {
      await supabase.from('permissions').update({ is_active: false }).in('key', toDeactivate);
    }

    // 3) Para keys NOVAS (não existiam antes), criar default-deny global +
    //    granted=true para diretor
    const newKeys = incoming.filter((p) => !existingMap.has(p.key)).map((p) => p.key);
    if (newKeys.length > 0) {
      const seedRows: Array<Record<string, unknown>> = [];
      for (const key of newKeys) {
        for (const role of ROLES) {
          seedRows.push({
            department_id: null,
            role,
            permission_key: key,
            granted: role === 'diretor',
            granted_at: role === 'diretor' ? new Date().toISOString() : null,
          });
        }
      }
      // upsert para evitar conflito com índice único parcial (department_id IS NULL)
      const { error: seedErr } = await supabase
        .from('role_permissions')
        .upsert(seedRows, { onConflict: 'role,permission_key', ignoreDuplicates: true });
      if (seedErr) {
        // Conflito esperado em algumas linhas; logar e continuar
        console.warn('seed warn:', seedErr.message);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        upserted: incoming.length,
        deactivated: toDeactivate.length,
        newKeys: newKeys.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('sync-permissions error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
