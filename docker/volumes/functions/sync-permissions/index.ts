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
  /** Categoria da tela no painel do diretor (nome novo de `section`). */
  category?: string;
  /** Compat com bundles anteriores a 24/08/2026, que mandavam `section`. */
  section?: string;
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

    const body = (await req.json().catch(() => ({}))) as {
      permissions?: PermissionDef[];
      permitirAposentar?: boolean;
    };
    const incoming = Array.isArray(body.permissions) ? body.permissions : [];

    // 🛡️ APOSENTAR SÓ QUANDO PEDIDO EXPLICITAMENTE (25/08/2026).
    //
    // Incidente real do mesmo dia: um bundle DESATUALIZADO chamou o sync e
    // desativou 8 telas que tinham acabado de ser catalogadas. Ninguém perdeu
    // acesso (a tabela `permissions` é registro, não gate), mas com a limpeza
    // automática já no ar o próximo caso apagaria CONCESSÕES de telas vivas.
    //
    // A trava de tamanho (60%) não pega isso: um catálogo velho tem quase o
    // mesmo tamanho do novo. O que distingue não é o tamanho — é a INTENÇÃO.
    // Por isso: acrescentar e renomear seguem automáticos (são seguros e
    // idempotentes); APOSENTAR virou ação deliberada, do botão do painel.
    const permitirAposentar = body.permitirAposentar === true;

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
      section: p.category ?? p.section ?? 'Outros',
      description: p.description ?? null,
      is_active: true,
    }));
    const { error: upErr } = await supabase
      .from('permissions')
      .upsert(upsertPayload, { onConflict: 'key' });
    if (upErr) throw upErr;

    // 2) Desativar removidas + LIMPAR as concessões que sobrariam órfãs.
    //
    // Até 24/08/2026 o sync só virava a flag `is_active`, e as concessões da
    // tela aposentada ficavam para trás em departamentos/cargos/overrides —
    // foi assim que 65 concessões mortas se acumularam. Agora a aposentadoria
    // se limpa sozinha, no mesmo passo.
    const toDeactivate = (existingRows ?? [])
      .filter((r) => !incomingKeys.has(r.key) && r.is_active)
      .map((r) => r.key);

    // 🛡️ TRAVA ANTI-DEPLOY-QUEBRADO. Um bundle truncado (build parcial, catálogo
    // pela metade) mandaria poucas chaves e faria o sync "aposentar" o resto —
    // e aí a limpeza automática apagaria concessões de telas VIVAS. Se o
    // catálogo recebido for drasticamente menor que o que já existe ativo, o
    // sync ainda atualiza rótulos (inofensivo) mas se recusa a aposentar nada.
    const ativasNoBanco = (existingRows ?? []).filter((r) => r.is_active).length;
    const encolhimentoSuspeito =
      ativasNoBanco > 0 && incoming.length < Math.floor(ativasNoBanco * 0.6);

    let limpeza: unknown = null;
    if (!permitirAposentar) {
      if (toDeactivate.length > 0) {
        console.log(
          `sync-permissions: ${toDeactivate.length} tela(s) ausentes do catalogo recebido, ` +
          `mas aposentadoria NAO foi pedida — mantidas ativas: ${toDeactivate.join(', ')}`
        );
      }
    } else if (encolhimentoSuspeito) {
      console.warn(
        `sync-permissions: catalogo recebido tem ${incoming.length} telas contra ${ativasNoBanco} ` +
        `ativas no banco. Encolhimento suspeito — NAO vou aposentar nem limpar nada.`
      );
    } else if (toDeactivate.length > 0) {
      const { error: deacErr } = await supabase
        .from('permissions')
        .update({ is_active: false })
        .in('key', toDeactivate);
      if (deacErr) throw deacErr;

      // Snapshot + remoção nas 3 camadas. Mesma RPC que o botão manual do
      // painel usa, para os dois caminhos nunca divergirem.
      const { data: res, error: limpErr } = await supabase.rpc('limpar_concessoes_orfas', {
        p_chaves: toDeactivate,
        p_motivo: 'sync-permissions: telas aposentadas no deploy',
      });
      if (limpErr) console.warn('limpeza automatica falhou:', limpErr.message);
      else limpeza = res;
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
        deactivated: (!permitirAposentar || encolhimentoSuspeito) ? 0 : toDeactivate.length,
        newKeys: newKeys.length,
        limpeza,
        ...(!permitirAposentar && toDeactivate.length > 0
          ? { aviso: `${toDeactivate.length} tela(s) ausentes do catalogo foram MANTIDAS ativas (aposentadoria nao pedida)` }
          : {}),
        ...(permitirAposentar && encolhimentoSuspeito
          ? { aviso: `catalogo suspeito (${incoming.length} telas vs ${ativasNoBanco} ativas) — aposentadoria bloqueada` }
          : {}),
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
