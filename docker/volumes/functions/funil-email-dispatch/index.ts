// Edge Function: funil-email-dispatch
// Disparado pelo trigger trg_fire_funil_email_on_task_status quando uma tarefa
// do funil TCC muda de status (ou manualmente pela aba "Comunicação"). Resolve
// template + destinatário(s) e delega para `email-send` (render + Gmail API).
//
// Envia para TODOS os alunos da tarefa (TCC individual ou em dupla). A fonte
// canônica de destinatários/variáveis é gt_form_submissions.payload (gravado
// pela submeter-tcc); com fallback para aluno_id e, por último, parse da
// descrição da tarefa.
//
// Body aceito:
//   { task_id, etapa_key, funil_tipo, funil_ref?,
//     variaveis_override?: Record<string,string>,   // ex.: docs_faltantes, observacoes
//     destinatarios_override?: Array<{nome?,email}>, // força destinatários
//     force?: boolean }                              // ignora idempotência (reenvio manual)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Recipient {
  nome: string
  email: string
}

interface DispatchBody {
  task_id: string
  etapa_key: string
  funil_tipo: string
  funil_ref?: string
  // Etapa registrada na idempotencia_key (e logo no histórico) quando difere da
  // etapa usada para resolver a automação. Ex.: e-mail personalizado reaproveita o
  // remetente da automação DOCUMENTOS_PENDENTES mas aparece como EMAIL_PERSONALIZADO.
  etapa_key_log?: string
  variaveis_override?: Record<string, string>
  destinatarios_override?: Array<{ nome?: string; email: string }>
  anexos_override?: Array<{ filename: string; content_base64: string; content_type?: string }>
  // E-mail personalizado: assunto/corpo digitados na hora (ignora o template).
  assunto_override?: string
  corpo_html_override?: string
  force?: boolean
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function logComment(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  body: string,
) {
  try {
    await supabase.from('gt_task_comments').insert({
      task_id: taskId,
      user_id: null,
      content: body,
    })
  } catch (e) {
    console.warn('[funil-email-dispatch] gt_task_comments insert falhou:', (e as Error).message)
  }
}

const normEmail = (e: string) => e.trim().toLowerCase()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  let body: DispatchBody
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400)
  }

  const {
    task_id, etapa_key, etapa_key_log, funil_tipo, funil_ref,
    variaveis_override, destinatarios_override, anexos_override,
    assunto_override, corpo_html_override, force,
  } = body
  if (!task_id || !etapa_key || !funil_tipo) {
    return json({ ok: false, error: 'task_id, etapa_key, funil_tipo obrigatórios' }, 400)
  }

  try {

  // 1) Resolve automação (1 linha por etapa — maybeSingle é seguro).
  //    A trava `ativo` governa só o disparo AUTOMÁTICO (trigger). Envio manual
  //    (force) é ação humana explícita e funciona mesmo com a automação OFF.
  let q = supabase
    .from('funil_email_automacoes')
    .select('id, template_id, idempotencia_minutos, funil_ref, ativo')
    .eq('funil_tipo', funil_tipo)
    .eq('etapa_key', etapa_key)
  if (!force) q = q.eq('ativo', true)
  if (funil_ref) q = q.eq('funil_ref', funil_ref)

  const { data: automacao, error: autErr } = await q.maybeSingle()
  if (autErr || !automacao) {
    console.log('[funil-email-dispatch] sem automação ativa para', funil_tipo, etapa_key)
    return json({ ok: true, skipped: 'no_automation' })
  }

  // 2) Resolve tarefa
  const { data: task, error: tErr } = await supabase
    .from('gt_tasks')
    .select('id, title, aluno_id, status_id, description')
    .eq('id', task_id)
    .maybeSingle()
  if (tErr || !task) return json({ ok: false, error: 'task not found' }, 404)

  // 3) Variáveis de contexto + destinatários — fonte canônica: gt_form_submissions
  let curso = ''
  let orientador = ''
  let tituloTcc = ''
  let recipients: Recipient[] = []

  const { data: sub } = await supabase
    .from('gt_form_submissions')
    .select('payload')
    .eq('task_id', task_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const payload = (sub?.payload ?? null) as
    | {
        alunos?: Array<{ nome?: string; email?: string }>
        curso?: string
        orientador?: string
        tituloTcc?: string
      }
    | null

  if (payload) {
    curso = payload.curso ?? ''
    orientador = payload.orientador ?? ''
    tituloTcc = payload.tituloTcc ?? ''
    for (const a of payload.alunos ?? []) {
      if (a?.email) recipients.push({ nome: a.nome ?? '', email: normEmail(a.email) })
    }
  }

  // Fallback: aluno_id da tarefa
  if (recipients.length === 0 && task.aluno_id) {
    const { data: aluno } = await supabase
      .from('alunos')
      .select('nome, email')
      .eq('id', task.aluno_id)
      .maybeSingle()
    if (aluno?.email) recipients.push({ nome: aluno.nome ?? '', email: normEmail(aluno.email) })
  }

  // Fallback final: parse da descrição (markdown gerado pela submeter-tcc)
  const desc = (task.description as string | null) ?? ''
  if (recipients.length === 0) {
    const emails = [...desc.matchAll(/-\s*Email:\s*([^\s\n<]+)/gi)].map((m) => normEmail(m[1]))
    for (const email of emails) recipients.push({ nome: '', email })
  }
  if (!curso) {
    const m = desc.match(/\*\*Curso:\*\*\s*([^\n]+)/i)
    if (m) curso = m[1].trim()
  }

  // Override explícito (aba Comunicação)
  if (destinatarios_override?.length) {
    recipients = destinatarios_override
      .filter((r) => r?.email)
      .map((r) => ({ nome: r.nome ?? '', email: normEmail(r.email) }))
  }

  // Dedup por email
  const seen = new Set<string>()
  recipients = recipients.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true)))

  if (recipients.length === 0) {
    await logComment(
      supabase,
      task_id,
      `⚠️ Automação de email (${etapa_key}) não disparada: nenhum email de aluno encontrado (sem submissão, sem aluno_id e descrição sem campo Email).`,
    )
    return json({ ok: true, skipped: 'no_recipients' })
  }

  // Modo "e-mail personalizado": email-send exige remetente_id quando NÃO há
  // template_id. Reaproveitamos o remetente do template da própria automação.
  let remetenteCustom: string | null = null
  if (corpo_html_override) {
    const { data: tpl } = await supabase
      .from('email_templates')
      .select('remetente_id')
      .eq('id', automacao.template_id)
      .maybeSingle()
    remetenteCustom = (tpl?.remetente_id as string | null) ?? null
    if (!remetenteCustom) {
      return json(
        { ok: false, error: 'Remetente não configurado para envio personalizado (template da etapa sem remetente).' },
        400,
      )
    }
  }

  // 4) Envia para cada aluno (idempotência por task+etapa+email)
  const logEtapa = etapa_key_log || etapa_key
  const windowMin = automacao.idempotencia_minutos ?? 1440
  const sinceIso = new Date(Date.now() - windowMin * 60 * 1000).toISOString()
  const results: Array<{ email: string; status: string }> = []

  for (const r of recipients) {
    const idempotenciaKey = `funil-tcc-${task_id}-${logEtapa}-${r.email}`

    if (!force) {
      const { data: jaEnviou } = await supabase
        .from('emails_enviados')
        .select('id')
        .eq('idempotencia_key', idempotenciaKey)
        .gte('criado_em', sinceIso)
        .limit(1)
        .maybeSingle()
      if (jaEnviou) {
        results.push({ email: r.email, status: 'idempotent' })
        continue
      }
    }

    const variaveis: Record<string, string> = {
      nome_aluno: r.nome || 'Aluno(a)',
      curso,
      modalidade: '',
      instituicao_parceira: '',
      nome_atendente: 'Secretaria Acadêmica',
      docs_faltantes: '',
      observacoes: '',
      orientador,
      titulo_tcc: tituloTcc,
      link_portal: 'https://portal.ppgeducacao.com.br',
      ...(variaveis_override ?? {}),
    }

    const idemKey = force ? `${idempotenciaKey}-${Date.now()}` : idempotenciaKey
    const sendBody = corpo_html_override
      ? {
          remetente_id: remetenteCustom,
          automacao_id: automacao.id,
          destinatario_email: r.email,
          destinatario_nome: r.nome || null,
          variaveis,
          contexto_tipo: 'gt_task',
          contexto_id: task_id,
          idempotencia_key: idemKey,
          idempotencia_janela_min: windowMin,
          assunto: assunto_override ?? '',
          corpo_html: corpo_html_override,
          ...(anexos_override?.length ? { anexos: anexos_override } : {}),
        }
      : {
          template_id: automacao.template_id,
          automacao_id: automacao.id,
          destinatario_email: r.email,
          destinatario_nome: r.nome || null,
          variaveis,
          contexto_tipo: 'gt_task',
          contexto_id: task_id,
          idempotencia_key: idemKey,
          idempotencia_janela_min: windowMin,
          ...(anexos_override?.length ? { anexos: anexos_override } : {}),
        }

    const { data: sendRes, error: sendErr } = await supabase.functions.invoke('email-send', { body: sendBody })

    if (sendErr) {
      // FunctionsHttpError esconde o motivo real ("non-2xx status code"); o corpo da
      // resposta do email-send tem o erro de verdade (Gmail desconectado, etc.).
      let detail = sendErr.message || 'erro'
      try {
        const errBody = await (sendErr as { context?: { json?: () => Promise<unknown> } }).context?.json?.()
        const realErr = (errBody as { error?: unknown })?.error
        if (realErr) detail = typeof realErr === 'string' ? realErr : JSON.stringify(realErr)
      } catch { /* corpo não-JSON */ }
      console.error('[funil-email-dispatch] email-send error:', r.email, detail)
      results.push({ email: r.email, status: `erro: ${detail}` })
    } else if (sendRes && (sendRes as { duplicado?: boolean }).duplicado) {
      // email-send deduplicou (já havia envio com essa key na janela) — não é entrega nova.
      results.push({ email: r.email, status: 'idempotent' })
    } else {
      results.push({ email: r.email, status: 'enviado' })
      void sendRes
    }
  }

  const enviados = results.filter((x) => x.status === 'enviado')
  const erros = results.filter((x) => x.status.startsWith('erro'))

  if (enviados.length) {
    await logComment(
      supabase,
      task_id,
      `📧 Email da etapa **${etapa_key}** enviado para: ${enviados.map((e) => e.email).join(', ')}.`,
    )
  }
  if (erros.length) {
    await logComment(
      supabase,
      task_id,
      `❌ Falha ao enviar email (${etapa_key}) para: ${erros.map((e) => `${e.email} (${e.status})`).join(', ')}.`,
    )
  }

    return json({
      ok: erros.length === 0,
      etapa_key,
      results,
      ...(erros.length
        ? { error: erros.map((e) => `${e.email}: ${e.status.replace(/^erro:\s*/, '')}`).join(' · ') }
        : {}),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erro desconhecido'
    console.error('[funil-email-dispatch] erro inesperado:', msg)
    return json({ ok: false, error: msg }, 500)
  }
})
