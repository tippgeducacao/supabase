// Edge function pública: recebe submissão de TCC do projeto tccmanual,
// faz upload dos 4 documentos no bucket privado `tcc-docs` e cria uma
// tarefa em PEDAGÓGICO → (Sem Pasta) → TCC → etapa TESTE PAGINA, atribuída
// a Adriane e Ana Paula.
//
// Endpoint público:
//   https://lrpyxyhhqfzozrkklxwu.supabase.co/functions/v1/submeter-tcc
//
// Aceita multipart/form-data:
//   - dados: JSON.stringify({ alunos[1..2], curso, turma, orientador, tituloTcc })
//   - termoAceite, declaracaoRevisor, fichaOrientador, arquivoTcc: File
//
// Retorna: { ok: true, protocolo, prazoRetorno, taskId } ou { ok: false, error }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0'
import { z } from 'https://esm.sh/zod@3.23.8'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, cache-control, pragma',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// IDs fixos da estrutura PPGVET (PEDAGÓGICO → (Sem Pasta) → TCC → TESTE PAGINA)
const LIST_ID = 'b530b0ca-3a0e-40d3-93d7-c013a91a6dbf'
const STATUS_ID_TESTE_PAGINA = 'e04bf494-5e59-4385-9600-0723863d892a'

// Responsáveis fixos
const ADRIANE_ID = 'e90867b4-01a7-4b68-9ac1-7ac7b497d0a2'
const ANAPAULA_ID = '9591e3b5-a061-411b-a1d9-229aef9e4645'

const BUCKET = 'tcc-docs'
const SIGNED_URL_TTL_SECONDS = 90 * 24 * 60 * 60 // 90 dias
const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const ALLOWED_EXT = new Set(['pdf', 'doc', 'docx'])

const studentSchema = z.object({
  nome: z.string().trim().min(3).max(120),
  email: z.string().trim().email().max(160),
  cpf: z.string().trim().min(11).max(20),
})

const dadosSchema = z.object({
  alunos: z.array(studentSchema).min(1).max(2),
  curso: z.string().trim().min(2).max(160),
  turma: z.string().trim().min(1).max(60),
  orientador: z.string().trim().min(3).max(160),
  tituloTcc: z.string().trim().min(5).max(240),
})

const FILE_FIELDS = [
  'termoAceite',
  'declaracaoRevisor',
  'fichaOrientador',
  'arquivoTcc',
] as const
type FileField = (typeof FILE_FIELDS)[number]

const FILE_LABELS: Record<FileField, string> = {
  termoAceite: 'Termo de aceite de orientação',
  declaracaoRevisor: 'Declaração de revisor',
  fichaOrientador: 'Ficha cadastral do orientador',
  arquivoTcc: 'Arquivo do TCC',
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function getExt(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function safeFilename(field: string, original: string): string {
  const ext = getExt(original) || 'pdf'
  return `${field}.${ext}`
}

async function ensureBucket(supabase: ReturnType<typeof createClient>) {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 30 * 1024 * 1024,
    allowedMimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  })
  if (error && !/already exists|duplicate/i.test(error.message)) {
    console.error('[submeter-tcc] erro criando bucket:', error.message)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Método não permitido' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    console.error('[submeter-tcc] credenciais ausentes no runtime')
    return jsonResponse({ ok: false, error: 'Configuração do servidor inválida' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  try {
    // 1) Parse multipart
    let form: FormData
    try {
      form = await req.formData()
    } catch (_e) {
      return jsonResponse({ ok: false, error: 'multipart/form-data inválido' }, 400)
    }

    // 2) Valida JSON `dados`
    const rawDados = form.get('dados')
    if (typeof rawDados !== 'string') {
      return jsonResponse({ ok: false, error: 'Campo `dados` ausente' }, 400)
    }
    let dadosParsed: z.infer<typeof dadosSchema>
    try {
      dadosParsed = dadosSchema.parse(JSON.parse(rawDados))
    } catch (e) {
      const err = e as { errors?: unknown; message?: string }
      return jsonResponse(
        {
          ok: false,
          error: 'Dados inválidos',
          details: err?.errors ?? err?.message ?? String(e),
        },
        400,
      )
    }

    // 3) Valida arquivos
    const files: Record<FileField, File> = {} as Record<FileField, File>
    for (const field of FILE_FIELDS) {
      const f = form.get(field)
      if (!(f instanceof File)) {
        return jsonResponse(
          { ok: false, error: `Anexo ausente: ${FILE_LABELS[field]}` },
          400,
        )
      }
      if (f.size === 0) {
        return jsonResponse(
          { ok: false, error: `Anexo vazio: ${FILE_LABELS[field]}` },
          400,
        )
      }
      if (f.size > MAX_FILE_BYTES) {
        return jsonResponse(
          { ok: false, error: `${FILE_LABELS[field]} excede 25 MB` },
          400,
        )
      }
      const ext = getExt(f.name)
      if (!ALLOWED_EXT.has(ext) && !ALLOWED_MIME.has(f.type)) {
        return jsonResponse(
          {
            ok: false,
            error: `${FILE_LABELS[field]}: formato não permitido (use PDF, DOC ou DOCX)`,
          },
          400,
        )
      }
      files[field] = f
    }

    // 4) Garante bucket (idempotente)
    await ensureBucket(supabase)

    // 5) Gera protocolo e prazo
    const agora = new Date()
    const prazo = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000)
    const protocolo = `TCC-${agora.getTime().toString(36).toUpperCase()}`

    // 6) Upload dos 4 arquivos
    const uploaded: Record<FileField, { path: string; signedUrl: string }> =
      {} as Record<FileField, { path: string; signedUrl: string }>

    for (const field of FILE_FIELDS) {
      const file = files[field]
      const path = `${protocolo}/${safeFilename(field, file.name)}`
      const buf = new Uint8Array(await file.arrayBuffer())

      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, {
        contentType: file.type || 'application/pdf',
        upsert: true,
      })
      if (upErr) {
        console.error('[submeter-tcc] upload error:', field, upErr.message)
        return jsonResponse(
          {
            ok: false,
            error: `Falha no upload: ${FILE_LABELS[field]}`,
            details: upErr.message,
          },
          500,
        )
      }

      const { data: signed, error: signErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
      if (signErr || !signed?.signedUrl) {
        console.error('[submeter-tcc] sign error:', field, signErr?.message)
        return jsonResponse(
          {
            ok: false,
            error: `Falha gerando link: ${FILE_LABELS[field]}`,
            details: signErr?.message,
          },
          500,
        )
      }

      uploaded[field] = { path, signedUrl: signed.signedUrl }
    }

    // 7) Monta título e descrição
    const alunoPrincipal = dadosParsed.alunos[0]
    const tituloTarefa = `[TCC] ${dadosParsed.tituloTcc} — ${alunoPrincipal.nome}`

    const alunosBlock = dadosParsed.alunos
      .map(
        (a, i) =>
          `**Aluno ${i + 1}:** ${a.nome}\n  - Email: ${a.email}\n  - CPF: ${a.cpf}`,
      )
      .join('\n\n')

    const linksBlock = FILE_FIELDS.map(
      (f) => `- [${FILE_LABELS[f]}](${uploaded[f].signedUrl})`,
    ).join('\n')

    const descricao = [
      `**Protocolo:** \`${protocolo}\``,
      `**Recebido em:** ${agora.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
      })}`,
      `**Prazo de retorno:** até ${prazo.toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
      })} (7 dias)`,
      '',
      '### Alunos',
      alunosBlock,
      '',
      '### Dados acadêmicos',
      `- **Curso:** ${dadosParsed.curso}`,
      `- **Turma:** ${dadosParsed.turma}`,
      `- **Orientador:** ${dadosParsed.orientador}`,
      `- **Título do TCC:** ${dadosParsed.tituloTcc}`,
      '',
      '### Documentos enviados',
      linksBlock,
      '',
      '_Os links acima expiram em 90 dias. Salve os arquivos se precisar de acesso prolongado._',
      '',
      '**Status inicial:** TCC recebido — aguardando conferência',
    ].join('\n')

    // 8) Cria tarefa
    const { data: task, error: taskErr } = await supabase
      .from('gt_tasks')
      .insert({
        list_id: LIST_ID,
        status_id: STATUS_ID_TESTE_PAGINA,
        title: tituloTarefa,
        description: descricao,
        priority: 'normal',
        progress: 0,
        sort_order: 0,
        tags: ['tcc', 'aguardando-conferencia'],
      })
      .select('id')
      .single()

    if (taskErr || !task) {
      console.error('[submeter-tcc] erro criando tarefa:', taskErr?.message)
      return jsonResponse(
        { ok: false, error: 'Falha ao criar tarefa', details: taskErr?.message },
        500,
      )
    }

    // 9) Atribuir Adriane e Ana Paula
    const { error: assignErr } = await supabase.from('gt_task_assignees').insert([
      { task_id: task.id, user_id: ADRIANE_ID },
      { task_id: task.id, user_id: ANAPAULA_ID },
    ])
    if (assignErr) {
      console.error('[submeter-tcc] erro atribuindo responsáveis:', assignErr.message)
    }

    // 10) Anexos como gt_task_attachments
    const attachmentsRows = FILE_FIELDS.map((f) => ({
      task_id: task.id,
      file_url: uploaded[f].signedUrl,
      file_name: `${FILE_LABELS[f]} — ${files[f].name}`,
      file_type: files[f].type || 'application/pdf',
      file_size: files[f].size,
    }))
    const { error: attErr } = await supabase
      .from('gt_task_attachments')
      .insert(attachmentsRows)
    if (attErr) {
      console.error('[submeter-tcc] erro anexos:', attErr.message)
    }

    console.log(`[submeter-tcc] ok ${protocolo} -> task ${task.id}`)

    return jsonResponse({
      ok: true,
      protocolo,
      taskId: task.id,
      prazoRetorno: prazo.toISOString(),
      enviadoEm: agora.toISOString(),
    })
  } catch (e) {
    const err = e as { message?: string }
    console.error('[submeter-tcc] erro inesperado:', err?.message ?? e)
    return jsonResponse(
      { ok: false, error: 'Erro interno', details: String(err?.message ?? e) },
      500,
    )
  }
})
