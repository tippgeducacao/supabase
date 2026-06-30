// Verifica um host conectado no sistema "Pages" (construtor + hospedagem próprios):
// faz lookup de DNS REAL para confirmar (1) a POSSE do domínio — registro TXT
// `_ppgpages-verify.<host>` contém o token — e (2) o APONTAMENTO — o registro A (apex)
// ou CNAME (subdomínio) aponta pro nosso servidor (config em page_dns_config). Atualiza
// dns_verificado / apontamento_ok / ssl_status na linha. Gate: dono da linha (auth.uid()).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
import { corsHeaders } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

/** Resolve um tipo de registro; devolve [] quando não existe (sem estourar). */
async function resolve(name: string, tipo: 'A' | 'CNAME' | 'TXT'): Promise<string[]> {
  try {
    const r = await Deno.resolveDns(name, tipo)
    if (tipo === 'TXT') return (r as string[][]).map((parts) => parts.join(''))
    return r as string[]
  } catch {
    return []
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const { id } = await req.json().catch(() => ({}))
    if (!id) return json({ error: 'id_obrigatorio' }, 400)

    // Identifica o usuário pelo JWT e confere a posse da linha.
    const authHeader = req.headers.get('Authorization') ?? ''
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData } = await authClient.auth.getUser()
    const uid = userData?.user?.id
    if (!uid) return json({ error: 'nao_autenticado' }, 401)

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE)

    const { data: row, error: rowErr } = await admin
      .from('page_dominios')
      .select('id, owner_id, host, registro_tipo, verify_token')
      .eq('id', id)
      .single()
    if (rowErr || !row) return json({ error: 'host_nao_encontrado' }, 404)
    if (row.owner_id !== uid) return json({ error: 'sem_permissao' }, 403)

    const { data: cfg } = await admin
      .from('page_dns_config')
      .select('app_ip, app_cname')
      .eq('id', true)
      .single()
    const appIp = (cfg?.app_ip ?? '').trim()
    const appCname = (cfg?.app_cname ?? '').trim().replace(/\.$/, '').toLowerCase()

    // (1) Posse — TXT _ppgpages-verify.<host> contém o token.
    const txt = await resolve(`_ppgpages-verify.${row.host}`, 'TXT')
    const dns_verificado = txt.some((t) => t.includes(row.verify_token))

    // (2) Apontamento — A bate o IP (apex) ou CNAME bate o alvo (sub); aceita A flatten.
    let apontamento_ok = false
    if (row.registro_tipo === 'A') {
      const a = await resolve(row.host, 'A')
      apontamento_ok = !!appIp && a.includes(appIp)
    } else {
      const cname = (await resolve(row.host, 'CNAME')).map((c) => c.replace(/\.$/, '').toLowerCase())
      apontamento_ok = !!appCname && cname.includes(appCname)
      if (!apontamento_ok && appIp) {
        const a = await resolve(row.host, 'A') // provedores que "achatam" o CNAME
        apontamento_ok = a.includes(appIp)
      }
    }

    const ssl_status = apontamento_ok && dns_verificado ? 'ativo' : dns_verificado ? 'provisionando' : 'pendente'

    const { data: updated, error: upErr } = await admin
      .from('page_dominios')
      .update({
        dns_verificado,
        apontamento_ok,
        ssl_status,
        verificado_em: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, host, dns_verificado, apontamento_ok, ssl_status, verificado_em')
      .single()
    if (upErr) return json({ error: 'falha_ao_atualizar', detalhe: upErr.message }, 500)

    return json({
      ok: true,
      ...updated,
      config_faltando: !appIp && !appCname,
    })
  } catch (e) {
    return json({ error: 'erro_interno', detalhe: String(e) }, 500)
  }
})
