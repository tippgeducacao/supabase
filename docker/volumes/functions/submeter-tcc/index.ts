// Edge function pública: recebe submissão de TCC do formulário público
// (projeto tccmanual / página /enviar-tcc), valida os dados do(s) aluno(s)
// + endereço, faz upload dos 4 documentos e cria uma tarefa em
// PEDAGÓGICO → TCC → etapa RECEPÇÃO, atribuída a Adriane e Ana Paula.
//
// Os anexos são gravados no MESMO esquema dos anexos nativos do gestor de
// tarefas: bucket público `gt-doc-assets`, pasta `gt-task-attachments/tcc/...`,
// e embutidos como HTML na descrição (<a data-attachment-kind="file">). Assim o
// painel "Anexos" da tarefa os reconhece automaticamente, preservando o arquivo
// EXATAMENTE como o aluno enviou (PDF ou Word, nome original).
//
// Endpoint público:
//   https://api.ppgeducacao.site/functions/v1/submeter-tcc
//
// Aceita multipart/form-data:
//   - dados: JSON.stringify({ alunos[1..2], curso, turma, orientador, tituloTcc })
//     cada aluno: { nome, email, cpf, telefone, cep, rua, numero,
//                   complemento?, bairro, cidade, uf }
//   - termoAceite, declaracaoRevisor, fichaOrientador, arquivoTcc: File (PDF/DOC/DOCX, <=25MB)
//
// Retorna: { ok: true, protocolo, taskId, prazoRetorno, enviadoEm }
//   ou { ok: false, error, details? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0'
import { z } from 'https://esm.sh/zod@3.23.8'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, cache-control, pragma',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// IDs fixos da estrutura PPGVET (PEDAGÓGICO → TCC → RECEPÇÃO)
const LIST_ID = 'b530b0ca-3a0e-40d3-93d7-c013a91a6dbf'
const STATUS_ID_RECEPCAO = 'e04bf494-5e59-4385-9600-0723863d892a'

// Responsáveis fixos
const ADRIANE_ID = 'e90867b4-01a7-4b68-9ac1-7ac7b497d0a2'
const ANAPAULA_ID = '9591e3b5-a061-411b-a1d9-229aef9e4645'

// Bucket público dos anexos nativos do gestor de tarefas (o painel "Anexos" só
// reconhece links que contenham gt-doc-assets/gt-task-attachments/documentos-vendas).
const BUCKET = 'gt-doc-assets'
const STORAGE_FOLDER = 'gt-task-attachments/tcc'
// SUPABASE_URL interno no self-hosted é http://kong:8000 — reescrevemos para o
// domínio público (mesmo padrão de whatsapp-send-media/whatsapp-webhook).
const PUBLIC_SUPABASE_URL =
  Deno.env.get('PUBLIC_SUPABASE_URL') || 'https://api.ppgeducacao.site'
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/kong:8000/i, PUBLIC_SUPABASE_URL)

const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB
const PRAZO_DIAS = 7 // dias corridos
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
  telefone: z.string().trim().min(8).max(25),
  cep: z.string().trim().min(8).max(12),
  rua: z.string().trim().min(2).max(160),
  numero: z.string().trim().min(1).max(20),
  complemento: z.string().trim().max(120).optional().default(''),
  bairro: z.string().trim().min(2).max(120),
  cidade: z.string().trim().min(2).max(120),
  uf: z
    .string()
    .trim()
    .length(2, 'UF deve ter 2 letras')
    .transform((s) => s.toUpperCase()),
})

const dadosSchema = z.object({
  alunos: z.array(studentSchema).min(1).max(2),
  curso: z.string().trim().min(2).max(160),
  turma: z.string().trim().min(1).max(60),
  orientador: z.string().trim().min(3).max(160),
  tituloTcc: z.string().trim().min(5).max(240),
})

type Aluno = z.infer<typeof studentSchema>

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

// Sanitiza o nome do arquivo para virar key de Storage, preservando a extensão
// original (PDF/DOC/DOCX) — assim o anexo fica "conforme enviado pelo aluno".
function sanitizeName(name: string): string {
  const dot = name.lastIndexOf('.')
  const base =
    (dot > 0 ? name.slice(0, dot) : name)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'arquivo'
  const ext = (dot > 0 ? name.slice(dot + 1) : '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'bin'
  return `${base}.${ext}`
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function enderecoLinha(a: Aluno): string {
  const numComp = a.complemento ? `${a.numero} - ${a.complemento}` : a.numero
  return `${a.rua}, ${numComp} — ${a.bairro} — ${a.cidade}/${a.uf} — CEP ${a.cep}`
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
      if (e instanceof z.ZodError) {
        return jsonResponse(
          {
            ok: false,
            error: 'Dados inválidos',
            details: e.errors.map((i) => ({ path: i.path, message: i.message })),
          },
          400,
        )
      }
      return jsonResponse(
        { ok: false, error: 'Dados inválidos', details: String(e) },
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

    // 4) Gera protocolo e prazo (7 dias corridos)
    const agora = new Date()
    const prazo = new Date(agora.getTime() + PRAZO_DIAS * 24 * 60 * 60 * 1000)
    const protocolo = `TCC-${agora.getTime().toString(36).toUpperCase()}`

    // 5) Upload dos 4 arquivos (bucket público, nome/extensão originais)
    const uploaded: Record<FileField, { path: string; url: string; fileName: string }> =
      {} as Record<FileField, { path: string; url: string; fileName: string }>

    for (const field of FILE_FIELDS) {
      const file = files[field]
      const original = file.name || `${field}.pdf`
      const path = `${STORAGE_FOLDER}/${protocolo}/${field}-${sanitizeName(original)}`
      const buf = new Uint8Array(await file.arrayBuffer())

      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, {
        contentType: file.type || 'application/octet-stream',
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

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
      uploaded[field] = {
        path,
        url: toPublicUrl(pub.publicUrl),
        fileName: original,
      }
    }

    // 6) Título no padrão: "TCC - {aluno(s)} - dd/mm/aaaa"
    const dataBR = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const nomesAlunos = dadosParsed.alunos.map((a) => a.nome)
    const tituloTarefa = `TCC - ${nomesAlunos.join(' & ')} - ${dataBR}`

    const alunoPrincipal = dadosParsed.alunos[0]

    // 6.1) Vincula aluno_id: tenta achar pelo email; se não achar, cria registro mínimo
    let alunoIdVinculado: string | null = null
    try {
      const emailNorm = alunoPrincipal.email.trim().toLowerCase()
      const { data: alunoMatch } = await supabase
        .from('alunos')
        .select('id')
        .ilike('email', emailNorm)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (alunoMatch?.id) {
        alunoIdVinculado = alunoMatch.id as string
      } else {
        const { data: novoAluno, error: criarErr } = await supabase
          .from('alunos')
          .insert({ nome: alunoPrincipal.nome, email: emailNorm })
          .select('id')
          .maybeSingle()
        if (criarErr) {
          console.warn('[submeter-tcc] não criou aluno:', criarErr.message)
        } else if (novoAluno?.id) {
          alunoIdVinculado = novoAluno.id as string
        }
      }
    } catch (e) {
      console.warn('[submeter-tcc] vincular aluno falhou:', (e as Error).message)
    }

    // 6.2) Descrição em HTML (renderiza limpo + anexos no formato nativo)
    const recebidoEm = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const prazoBR = prazo.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })

    const alunosHtml = dadosParsed.alunos
      .map(
        (a, i) =>
          `<li><strong>Aluno ${i + 1} — ${escapeHtml(a.nome)}</strong><br/>` +
          `Email: ${escapeHtml(a.email)}<br/>` +
          `CPF: ${escapeHtml(a.cpf)}<br/>` +
          `Telefone: ${escapeHtml(a.telefone)}<br/>` +
          `Endereço: ${escapeHtml(enderecoLinha(a))}</li>`,
      )
      .join('')

    const anexosHtml = FILE_FIELDS.map((f) => {
      const display = `${FILE_LABELS[f]} — ${uploaded[f].fileName}`
      return (
        `<p><a href="${escapeHtml(uploaded[f].url)}" target="_blank" rel="noopener" ` +
        `data-attachment-kind="file" data-attachment-name="${escapeHtml(display)}">📎 ${escapeHtml(display)}</a></p>`
      )
    }).join('\n')

    const descricao = [
      `<p><strong>Protocolo:</strong> ${escapeHtml(protocolo)} · <strong>Recebido em:</strong> ${escapeHtml(recebidoEm)} · <strong>Prazo de retorno:</strong> até ${escapeHtml(prazoBR)} (${PRAZO_DIAS} dias)</p>`,
      `<p><strong>Dados acadêmicos</strong></p>`,
      `<ul>` +
        `<li><strong>Título do TCC:</strong> ${escapeHtml(dadosParsed.tituloTcc)}</li>` +
        `<li><strong>Curso:</strong> ${escapeHtml(dadosParsed.curso)}</li>` +
        `<li><strong>Turma:</strong> ${escapeHtml(dadosParsed.turma)}</li>` +
        `<li><strong>Orientador:</strong> ${escapeHtml(dadosParsed.orientador)}</li>` +
        `</ul>`,
      `<p><strong>Dados do(s) aluno(s)</strong></p>`,
      `<ul>${alunosHtml}</ul>`,
      `<p><strong>Anexos enviados pelo aluno</strong></p>`,
      anexosHtml,
      `<p><em>${
        alunoIdVinculado
          ? 'Aluno vinculado ✅'
          : 'Aluno não encontrado pelo email ⚠️ — vincular manualmente para liberar automações'
      } · Status inicial: RECEPÇÃO — TCC recebido, aguardando conferência.</em></p>`,
    ].join('\n')

    // 7) Cria tarefa em RECEPÇÃO com prazo = now + 7 dias
    const { data: task, error: taskErr } = await supabase
      .from('gt_tasks')
      .insert({
        list_id: LIST_ID,
        status_id: STATUS_ID_RECEPCAO,
        title: tituloTarefa,
        description: descricao,
        priority: 'normal',
        progress: 0,
        sort_order: 0,
        due_date: prazo.toISOString().slice(0, 10),
        due_at: prazo.toISOString(),
        tags: ['tcc', 'recepcao'],
        aluno_id: alunoIdVinculado,
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

    // 8) Atribuir Adriane e Ana Paula
    const { error: assignErr } = await supabase.from('gt_task_assignees').insert([
      { task_id: task.id, user_id: ADRIANE_ID },
      { task_id: task.id, user_id: ANAPAULA_ID },
    ])
    if (assignErr) {
      console.error('[submeter-tcc] erro atribuindo responsáveis:', assignErr.message)
    }

    // 9) Registro estruturado dos anexos (gt_task_attachments) — alimenta a
    //    contagem/badge da tarefa; o painel visível lê do HTML da descrição.
    const attachmentsRows = FILE_FIELDS.map((f) => ({
      task_id: task.id,
      file_url: uploaded[f].url,
      file_name: `${FILE_LABELS[f]} — ${uploaded[f].fileName}`,
      file_type: files[f].type || 'application/octet-stream',
      file_size: files[f].size,
    }))
    const { error: attErr } = await supabase
      .from('gt_task_attachments')
      .insert(attachmentsRows)
    if (attErr) {
      console.error('[submeter-tcc] erro anexos:', attErr.message)
    }

    // 10) Persiste payload estruturado (fonte para a automação de e-mails)
    const { error: subErr } = await supabase.from('gt_form_submissions').insert({
      list_id: LIST_ID,
      task_id: task.id,
      submitter_name: alunoPrincipal.nome,
      submitter_email: alunoPrincipal.email.trim().toLowerCase(),
      payload: {
        protocolo,
        recebidoEm: agora.toISOString(),
        prazoRetorno: prazo.toISOString(),
        alunos: dadosParsed.alunos,
        curso: dadosParsed.curso,
        turma: dadosParsed.turma,
        orientador: dadosParsed.orientador,
        tituloTcc: dadosParsed.tituloTcc,
        arquivos: Object.fromEntries(
          FILE_FIELDS.map((f) => [
            f,
            { path: uploaded[f].path, url: uploaded[f].url, fileName: uploaded[f].fileName },
          ]),
        ),
      },
    })
    if (subErr) {
      console.error('[submeter-tcc] erro persistindo submissão:', subErr.message)
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
