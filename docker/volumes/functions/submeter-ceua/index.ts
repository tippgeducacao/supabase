// Edge function pública: recebe submissão de protocolo à CEUA/FAMPER vinda do
// formulário público (projeto Lovable `ceua`, página /submeter). Valida os dados
// do pesquisador, faz upload dos anexos e cria uma tarefa em
// PEDAGÓGICO → ACADÊMICO → CEUA - PROTOCOLOS (etapa "A Fazer"), além de avisar
// tcc@ppgeducacao.com por e-mail.
//
// Mesmo esquema de anexos do `submeter-tcc`: bucket público `gt-doc-assets`,
// pasta `gt-task-attachments/ceua/...`, embutidos como HTML na descrição
// (<a data-attachment-kind="file">) para o painel "Anexos" da tarefa reconhecer,
// preservando o arquivo EXATAMENTE como o pesquisador enviou.
//
// Endpoint público:
//   https://api.ppgeducacao.site/functions/v1/submeter-ceua
//
// Aceita multipart/form-data:
//   - dados: JSON.stringify({
//       nomeAluno, cpf, contato, email, docenteResponsavel, lattesDocente,
//       curso, usaAnimaisVivos: boolean, usaCadaveres: boolean
//     })
//   - formularioSubmissao, termoResponsabilidade, declaracaoConcea, tcle: File (obrigatórios)
//   - declaracoesLocais: File[] (1..5) — obrigatório SE usaAnimaisVivos
//   - termoDoacaoCadaver: File — obrigatório SE usaCadaveres
//
// Retorna: { ok: true, referencia, taskId, enviadoEm, prazoParecer }
//   ou { ok: false, error, details? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0'
import { z } from 'https://esm.sh/zod@3.23.8'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, cache-control, pragma',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// IDs fixos da estrutura PPGVET (PEDAGÓGICO → ACADÊMICO → CEUA - PROTOCOLOS)
const LIST_ID = 'cf48668b-44b4-4ddd-a2b2-94b29631924a'
const STATUS_ID_A_FAZER = '9824cb55-31c2-4671-a389-c9fcabe0b0f8'

// Responsável fixo — é quem já responde por TODOS os cards existentes da lista.
const ADRIANE_ID = 'e90867b4-01a7-4b68-9ac1-7ac7b497d0a2'

// Caixa que recebe o aviso por e-mail (remetente = a própria caixa, provider gmail).
const EMAIL_DESTINO = 'tcc@ppgeducacao.com'
const REMETENTE_ID = 'b86af855-7a2c-499b-a05e-528e98dbd18e'

const BUCKET = 'gt-doc-assets'
const STORAGE_FOLDER = 'gt-task-attachments/ceua'
// SUPABASE_URL interno no self-hosted é http://kong:8000 — reescrevemos para o
// domínio público (mesmo padrão de submeter-tcc/whatsapp-send-media).
const PUBLIC_SUPABASE_URL =
  Deno.env.get('PUBLIC_SUPABASE_URL') || 'https://api.ppgeducacao.site'
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/kong:8000/i, PUBLIC_SUPABASE_URL)

const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB
const MAX_DECLARACOES = 5
// Prazo de parecer publicado na página da CEUA: até 60 dias corridos.
const PRAZO_PARECER_DIAS = 60
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const ALLOWED_EXT = new Set(['pdf', 'doc', 'docx'])

const dadosSchema = z.object({
  nomeAluno: z.string().trim().min(3).max(160),
  cpf: z.string().trim().min(11).max(20),
  contato: z.string().trim().min(8).max(25),
  email: z.string().trim().email().max(160),
  docenteResponsavel: z.string().trim().min(3).max(160),
  lattesDocente: z.string().trim().url('Informe a URL completa do Lattes').max(300),
  curso: z.string().trim().min(2).max(200),
  usaAnimaisVivos: z.boolean(),
  usaCadaveres: z.boolean(),
})

type Dados = z.infer<typeof dadosSchema>

// Anexos sempre obrigatórios.
const FILE_FIELDS_BASE = [
  'formularioSubmissao',
  'termoResponsabilidade',
  'declaracaoConcea',
  'tcle',
] as const

const FILE_LABELS: Record<string, string> = {
  formularioSubmissao: 'Formulário de submissão',
  termoResponsabilidade: 'Termo de responsabilidade do pesquisador/professor responsável',
  declaracaoConcea: 'Declaração CONCEA',
  tcle: 'Termo de consentimento livre e esclarecido para uso em pesquisa',
  declaracoesLocais: 'Declarações dos locais e responsáveis pela atividade',
  termoDoacaoCadaver: 'Termo de doação de cadáver animal',
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
// original (PDF/DOC/DOCX) — o anexo fica "conforme enviado pelo pesquisador".
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
  const ext =
    (dot > 0 ? name.slice(dot + 1) : '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'bin'
  return `${base}.${ext}`
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Valida um arquivo do multipart; devolve string de erro ou null. */
function validarArquivo(f: unknown, label: string): string | null {
  if (!(f instanceof File)) return `Anexo ausente: ${label}`
  if (f.size === 0) return `Anexo vazio: ${label}`
  if (f.size > MAX_FILE_BYTES) return `${label} excede 25 MB`
  const ext = getExt(f.name)
  if (!ALLOWED_EXT.has(ext) && !ALLOWED_MIME.has(f.type)) {
    return `${label}: formato não permitido (use PDF, DOC ou DOCX)`
  }
  return null
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
    console.error('[submeter-ceua] credenciais ausentes no runtime')
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
    let dados: Dados
    try {
      dados = dadosSchema.parse(JSON.parse(rawDados))
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
      return jsonResponse({ ok: false, error: 'Dados inválidos', details: String(e) }, 400)
    }

    // 3) Monta a lista de anexos esperados (os condicionais entram conforme as
    //    respostas de "animais vivos" e "cadáveres").
    type Anexo = { field: string; label: string; file: File }
    const anexos: Anexo[] = []

    for (const field of FILE_FIELDS_BASE) {
      const f = form.get(field)
      const erro = validarArquivo(f, FILE_LABELS[field])
      if (erro) return jsonResponse({ ok: false, error: erro }, 400)
      anexos.push({ field, label: FILE_LABELS[field], file: f as File })
    }

    if (dados.usaAnimaisVivos) {
      const lista = form.getAll('declaracoesLocais').filter((f) => f instanceof File) as File[]
      if (lista.length === 0) {
        return jsonResponse(
          { ok: false, error: `Anexo ausente: ${FILE_LABELS['declaracoesLocais']}` },
          400,
        )
      }
      if (lista.length > MAX_DECLARACOES) {
        return jsonResponse(
          {
            ok: false,
            error: `${FILE_LABELS['declaracoesLocais']}: no máximo ${MAX_DECLARACOES} arquivos`,
          },
          400,
        )
      }
      for (const f of lista) {
        const erro = validarArquivo(f, FILE_LABELS['declaracoesLocais'])
        if (erro) return jsonResponse({ ok: false, error: erro }, 400)
        anexos.push({ field: 'declaracoesLocais', label: FILE_LABELS['declaracoesLocais'], file: f })
      }
    }

    if (dados.usaCadaveres) {
      const f = form.get('termoDoacaoCadaver')
      const erro = validarArquivo(f, FILE_LABELS['termoDoacaoCadaver'])
      if (erro) return jsonResponse({ ok: false, error: erro }, 400)
      anexos.push({
        field: 'termoDoacaoCadaver',
        label: FILE_LABELS['termoDoacaoCadaver'],
        file: f as File,
      })
    }

    // 4) Referência interna (usada como pasta no Storage e no rastreio da submissão).
    //    NÃO é o "Protocolo n° NNN/AAAA" da CEUA — esse é atribuído pela comissão.
    const agora = new Date()
    const referencia = `CEUA-${agora.getTime().toString(36).toUpperCase()}`
    const prazoParecer = new Date(
      agora.getTime() + PRAZO_PARECER_DIAS * 24 * 60 * 60 * 1000,
    )

    // 5) Upload dos anexos (bucket público, nome/extensão originais)
    const enviados: Array<{
      field: string
      label: string
      path: string
      url: string
      fileName: string
      type: string
      size: number
    }> = []

    for (const [i, anexo] of anexos.entries()) {
      const original = anexo.file.name || `${anexo.field}.pdf`
      const path = `${STORAGE_FOLDER}/${referencia}/${i + 1}-${anexo.field}-${sanitizeName(original)}`
      const buf = new Uint8Array(await anexo.file.arrayBuffer())

      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, {
        contentType: anexo.file.type || 'application/octet-stream',
        upsert: true,
      })
      if (upErr) {
        console.error('[submeter-ceua] upload error:', anexo.field, upErr.message)
        return jsonResponse(
          { ok: false, error: `Falha no upload: ${anexo.label}`, details: upErr.message },
          500,
        )
      }

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
      enviados.push({
        field: anexo.field,
        label: anexo.label,
        path,
        url: toPublicUrl(pub.publicUrl),
        fileName: original,
        type: anexo.file.type || 'application/octet-stream',
        size: anexo.file.size,
      })
    }

    // 6) Descrição em HTML — mesmo padrão dos cards que já existem na lista.
    const recebidoEm = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const prazoBR = prazoParecer.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const sim = (v: boolean) => (v ? 'Sim' : 'Não')

    const anexosHtml = enviados
      .map((a) => {
        const display = `${a.label} — ${a.fileName}`
        return (
          `<p><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" ` +
          `data-attachment-kind="file" data-attachment-name="${escapeHtml(display)}">📎 ${escapeHtml(display)}</a></p>`
        )
      })
      .join('\n')

    const descricao = [
      `<p>🐾 <strong>Submissão de protocolo — CEUA/FAMPER</strong></p>`,
      `<p><strong>Referência:</strong> ${escapeHtml(referencia)} · <strong>Recebido em:</strong> ${escapeHtml(recebidoEm)} · <strong>Prazo de parecer:</strong> até ${escapeHtml(prazoBR)} (${PRAZO_PARECER_DIAS} dias)</p>`,
      `<p><strong>Identificação</strong></p>`,
      `<ul>` +
        `<li><strong>Nome do aluno:</strong> ${escapeHtml(dados.nomeAluno)}</li>` +
        `<li><strong>CPF:</strong> ${escapeHtml(dados.cpf)}</li>` +
        `<li><strong>Contato:</strong> ${escapeHtml(dados.contato)}</li>` +
        `<li><strong>E-mail:</strong> ${escapeHtml(dados.email)}</li>` +
        `<li><strong>Curso de pós-graduação:</strong> ${escapeHtml(dados.curso)}</li>` +
        `</ul>`,
      `<p><strong>Docente responsável</strong></p>`,
      `<ul>` +
        `<li><strong>Nome:</strong> ${escapeHtml(dados.docenteResponsavel)}</li>` +
        `<li><strong>Currículo Lattes:</strong> <a href="${escapeHtml(dados.lattesDocente)}" target="_blank" rel="noopener">${escapeHtml(dados.lattesDocente)}</a></li>` +
        `</ul>`,
      `<p><strong>Natureza da pesquisa</strong></p>`,
      `<ul>` +
        `<li><strong>Utilizará animais vivos?</strong> ${sim(dados.usaAnimaisVivos)}</li>` +
        `<li><strong>Utilizará cadáveres?</strong> ${sim(dados.usaCadaveres)}</li>` +
        `</ul>`,
      `<p><strong>Anexos enviados pelo pesquisador</strong></p>`,
      anexosHtml,
      `<p><em>Status inicial: A Fazer — protocolo recebido, aguardando conferência da comissão.</em></p>`,
    ].join('\n')

    // 7) Cria a tarefa — título no padrão já usado na lista: "CEUA — {tema} ({curso})"
    const tituloTarefa = `CEUA — ${dados.nomeAluno} (${dados.curso})`

    const { data: task, error: taskErr } = await supabase
      .from('gt_tasks')
      .insert({
        list_id: LIST_ID,
        status_id: STATUS_ID_A_FAZER,
        title: tituloTarefa,
        description: descricao,
        priority: 'normal',
        progress: 0,
        sort_order: 0,
        due_date: prazoParecer.toISOString().slice(0, 10),
        due_at: prazoParecer.toISOString(),
        tags: ['ceua', 'protocolo'],
      })
      .select('id')
      .single()

    if (taskErr || !task) {
      console.error('[submeter-ceua] erro criando tarefa:', taskErr?.message)
      return jsonResponse(
        { ok: false, error: 'Falha ao criar tarefa', details: taskErr?.message },
        500,
      )
    }

    // 8) Responsável
    const { error: assignErr } = await supabase
      .from('gt_task_assignees')
      .insert([{ task_id: task.id, user_id: ADRIANE_ID }])
    if (assignErr) {
      console.error('[submeter-ceua] erro atribuindo responsável:', assignErr.message)
    }

    // 9) Registro estruturado dos anexos (alimenta a contagem/badge da tarefa)
    const { error: attErr } = await supabase.from('gt_task_attachments').insert(
      enviados.map((a) => ({
        task_id: task.id,
        file_url: a.url,
        file_name: `${a.label} — ${a.fileName}`,
        file_type: a.type,
        file_size: a.size,
      })),
    )
    if (attErr) {
      console.error('[submeter-ceua] erro anexos:', attErr.message)
    }

    // 10) Payload estruturado da submissão
    const { error: subErr } = await supabase.from('gt_form_submissions').insert({
      list_id: LIST_ID,
      task_id: task.id,
      submitter_name: dados.nomeAluno,
      submitter_email: dados.email.trim().toLowerCase(),
      payload: {
        referencia,
        recebidoEm: agora.toISOString(),
        prazoParecer: prazoParecer.toISOString(),
        ...dados,
        arquivos: enviados.map((a) => ({
          campo: a.field,
          label: a.label,
          path: a.path,
          url: a.url,
          fileName: a.fileName,
        })),
      },
    })
    if (subErr) {
      console.error('[submeter-ceua] erro persistindo submissão:', subErr.message)
    }

    // 11) Avisa a caixa da CEUA por e-mail (não bloqueia o retorno se falhar —
    //     a tarefa já está criada e é a fonte da verdade).
    try {
      const anexosEmail = enviados
        .map(
          (a) =>
            `<li><a href="${escapeHtml(a.url)}">${escapeHtml(a.label)} — ${escapeHtml(a.fileName)}</a></li>`,
        )
        .join('')

      const corpoHtml = [
        `<p>Uma nova submissão de protocolo chegou pelo site da CEUA/FAMPER.</p>`,
        `<p><strong>Referência:</strong> ${escapeHtml(referencia)}<br/>`,
        `<strong>Recebido em:</strong> ${escapeHtml(recebidoEm)}<br/>`,
        `<strong>Prazo de parecer:</strong> até ${escapeHtml(prazoBR)}</p>`,
        `<h3>Identificação</h3>`,
        `<ul>`,
        `<li><strong>Nome do aluno:</strong> ${escapeHtml(dados.nomeAluno)}</li>`,
        `<li><strong>CPF:</strong> ${escapeHtml(dados.cpf)}</li>`,
        `<li><strong>Contato:</strong> ${escapeHtml(dados.contato)}</li>`,
        `<li><strong>E-mail:</strong> ${escapeHtml(dados.email)}</li>`,
        `<li><strong>Curso de pós-graduação:</strong> ${escapeHtml(dados.curso)}</li>`,
        `<li><strong>Docente responsável:</strong> ${escapeHtml(dados.docenteResponsavel)}</li>`,
        `<li><strong>Lattes do docente:</strong> <a href="${escapeHtml(dados.lattesDocente)}">${escapeHtml(dados.lattesDocente)}</a></li>`,
        `<li><strong>Utilizará animais vivos?</strong> ${sim(dados.usaAnimaisVivos)}</li>`,
        `<li><strong>Utilizará cadáveres?</strong> ${sim(dados.usaCadaveres)}</li>`,
        `</ul>`,
        `<h3>Anexos</h3>`,
        `<ul>${anexosEmail}</ul>`,
        `<p>A tarefa correspondente já foi criada em <strong>PEDAGÓGICO → ACADÊMICO → CEUA - PROTOCOLOS</strong>.</p>`,
      ].join('')

      const mailRes = await fetch(`${supabaseUrl}/functions/v1/email-send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          remetente_id: REMETENTE_ID,
          destinatario_email: EMAIL_DESTINO,
          destinatario_nome: 'CEUA/FAMPER',
          assunto: `[CEUA] Nova submissão — ${dados.nomeAluno} (${dados.curso})`,
          corpo_html: corpoHtml,
          contexto_tipo: 'ceua_submissao',
          contexto_id: task.id,
          idempotencia_key: `ceua-submissao-${referencia}`,
        }),
      })
      if (!mailRes.ok) {
        console.error('[submeter-ceua] email-send status', mailRes.status, await mailRes.text())
      }
    } catch (e) {
      console.error('[submeter-ceua] falha ao enviar e-mail:', (e as Error).message)
    }

    console.log(`[submeter-ceua] ok ${referencia} -> task ${task.id}`)

    return jsonResponse({
      ok: true,
      referencia,
      taskId: task.id,
      enviadoEm: agora.toISOString(),
      prazoParecer: prazoParecer.toISOString(),
    })
  } catch (e) {
    const err = e as { message?: string }
    console.error('[submeter-ceua] erro inesperado:', err?.message ?? e)
    return jsonResponse(
      { ok: false, error: 'Erro interno', details: String(err?.message ?? e) },
      500,
    )
  }
})
