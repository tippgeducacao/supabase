// Edge function pública: recebe a inscrição do EDITAL DE APOIO a eventos
// (Semanas Acadêmicas etc. — "apoiador", nunca "patrocínio", p/ não soar
// marketing) do formulário público (Lovable) e cria uma tarefa em PROJETOS
// INTERSETORIAIS → PATROCÍNIOS (nome interno do projeto) → lista "Tarefas",
// etapa "A Fazer", atribuída a Adriane + Laura. Espelha `submeter-tcc`.
//
// >>> TOLERANTE A CAMPOS NOVOS <<<
// O formulário ainda vai ganhar campos. Esta função NÃO tem um schema fixo do
// formulário: ela lê TODOS os campos que chegarem e:
//   - usa aliases p/ achar o que precisa de tratamento especial
//     (nome do evento -> título; nome/telefone/email -> cabeçalho "Contato");
//   - renderiza TODO o resto como "Rótulo: valor" na descrição, na ordem
//     recebida (campo novo aparece sozinho, sem mudar o código);
//   - anexa QUALQUER arquivo enviado (upload) na tarefa.
// Só há retrabalho se um campo NOVO precisar de tratamento ESPECIAL (virar o
// título, virar prazo, etc.). Campo informativo novo entra automaticamente.
//
// Endpoint público:
//   https://api.ppgeducacao.site/functions/v1/submeter-patrocinio
//
// Aceita:
//   (a) multipart/form-data — campos de texto avulsos + arquivos (File). Pode
//       também mandar um campo `dados` = JSON.stringify({...}) com os campos.
//   (b) application/json — { ...campos } (sem arquivos).
//
// Retorna: { ok: true, protocolo, taskId, enviadoEm }
//   ou { ok: false, error, details? }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, cache-control, pragma',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── Destino no Gestor de Tarefas (PROJETOS INTERSETORIAIS → PATROCÍNIOS → Tarefas)
const LIST_ID = '2a7f4ce2-24a6-4e80-a3df-1d9b3b960d8b'
const STATUS_A_FAZER = '76fd4507-fc43-4b42-a2a1-5e3a803e1f79' // etapa default "A Fazer"

// ── Responsáveis (o card exibe o assignee_id; gt_task_assignees lista todos)
const ADRIANE_ID = 'e90867b4-01a7-4b68-9ac1-7ac7b497d0a2'
const LAURA_ID = '61dc434c-2d87-43a4-8a26-ac5f4008cc5f' // 2º responsável (membro do projeto PATROCÍNIOS)
const ASSIGNEES = [ADRIANE_ID, LAURA_ID]
const ASSIGNEE_PRINCIPAL = ADRIANE_ID

const PRAZO_DIAS = 7 // due_date = recebimento + 7 dias corridos

// ── Anexos: mesmo esquema dos anexos nativos do gestor de tarefas
const BUCKET = 'gt-doc-assets'
const STORAGE_FOLDER = 'gt-task-attachments/apoio'
const PUBLIC_SUPABASE_URL =
  Deno.env.get('PUBLIC_SUPABASE_URL') || 'https://api.ppgeducacao.site'
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/kong:8000/i, PUBLIC_SUPABASE_URL)

const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB por arquivo
const MAX_FILES = 10
// Tipos aceitos (documentos + imagens; sem executáveis). Extensão OU mime bastam.
const ALLOWED_EXT = new Set([
  'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

// ── Aliases dos campos que precisam de tratamento especial. Comparação
//    normalizada (sem acento, minúsculo, sem separadores). Ordem = prioridade.
const EVENTO_KEYS = [
  'evento', 'nomeevento', 'nomedoevento', 'eventonome', 'nomedasemana',
  'semana', 'semanaacademica', 'nomesemana', 'sigla', 'siglaevento',
  'nomedoinstituicaoevento',
]
const NOME_KEYS = [
  'nome', 'nomecompleto', 'nomecontato', 'contato', 'responsavel',
  'solicitante', 'nomeresponsavel', 'nomesolicitante', 'nomedoresponsavel',
]
const TELEFONE_KEYS = ['telefone', 'whatsapp', 'celular', 'fone', 'phone', 'tel', 'contatotelefone']
const EMAIL_KEYS = ['email', 'emailcontato', 'emailresponsavel', 'emailsolicitante']

// Rótulos "bonitos" p/ campos comuns; qualquer outro cai na humanização da chave.
const LABELS: Record<string, string> = {
  evento: 'Evento',
  nomeevento: 'Evento',
  instituicao: 'Instituição',
  faculdade: 'Instituição',
  universidade: 'Instituição',
  curso: 'Curso',
  cidade: 'Cidade',
  uf: 'UF',
  estado: 'Estado',
  nomedoevento: 'Nome do evento',
  dataevento: 'Data do evento',
  datadoevento: 'Data do evento',
  data: 'Data',
  periodo: 'Período',
  tipoevento: 'Tipo de evento',
  tipodeevento: 'Tipo de evento',
  tipoapoio: 'Tipo de apoio',
  tipodeapoio: 'Tipo de apoio',
  tipopatrocinio: 'Tipo de apoio',
  local: 'Local',
  localizacao: 'Localização',
  endereco: 'Endereço',
  publico: 'Público estimado',
  participantes: 'Nº de participantes',
  quantidadeparticipantes: 'Nº de participantes',
  numeroparticipantes: 'Nº de participantes',
  numerodeparticipantes: 'Nº de participantes',
  folder: 'Folder para os participantes',
  folderparticipantes: 'Folder para todos os participantes',
  distribuirfolder: 'Compromete-se a distribuir o folder',
  compromissofolder: 'Compromete-se a distribuir o folder',
  valor: 'Valor solicitado',
  valorsolicitado: 'Valor solicitado',
  orcamento: 'Orçamento',
  cargo: 'Cargo',
  observacoes: 'Observações',
  mensagem: 'Mensagem',
  descricao: 'Descrição',
  cnpj: 'CNPJ',
  cpf: 'CPF',
  redessociais: 'Redes sociais',
  instagram: 'Instagram',
  site: 'Site',
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function escapeHtml(v: string): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function getExt(name: string): string {
  const m = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

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

// chave normalizada p/ casar aliases: sem acento, minúsculo, só a-z0-9
function normKey(k: string): string {
  return String(k)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

// "quantidade_participantes" / "quantidadeParticipantes" -> "Quantidade Participantes"
function humanizeKey(k: string): string {
  const s = String(k)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function labelFor(originalKey: string): string {
  const n = normKey(originalKey)
  return LABELS[n] || humanizeKey(originalKey)
}

// acha o 1º campo cujo nome (normalizado) casa um dos aliases; devolve [valor, chaveOriginal]
function pick(campos: Record<string, string>, aliases: string[]): [string, string | null] {
  const mapa = new Map<string, string>() // normKey -> chaveOriginal
  for (const k of Object.keys(campos)) mapa.set(normKey(k), k)
  for (const a of aliases) {
    const orig = mapa.get(a)
    if (orig != null) {
      const v = (campos[orig] ?? '').toString().trim()
      if (v) return [v, orig]
    }
  }
  return ['', null]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Método não permitido' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    console.error('[submeter-patrocinio] credenciais ausentes no runtime')
    return jsonResponse({ ok: false, error: 'Configuração do servidor inválida' }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  try {
    // 1) Coleta campos (texto) e arquivos, aceitando multipart OU json.
    const campos: Record<string, string> = {}
    const arquivos: { field: string; file: File }[] = []
    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      let body: unknown
      try { body = await req.json() } catch { return jsonResponse({ ok: false, error: 'JSON inválido' }, 400) }
      if (body && typeof body === 'object') {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          if (v == null) continue
          campos[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
        }
      }
    } else {
      let form: FormData
      try { form = await req.formData() } catch { return jsonResponse({ ok: false, error: 'multipart/form-data inválido' }, 400) }
      for (const [k, v] of form.entries()) {
        if (v instanceof File) {
          if (v.size > 0) arquivos.push({ field: k, file: v })
          continue
        }
        // campo `dados` = JSON com os campos do formulário (opcional)
        if (k === 'dados' && typeof v === 'string') {
          try {
            const obj = JSON.parse(v)
            if (obj && typeof obj === 'object') {
              for (const [kk, vv] of Object.entries(obj as Record<string, unknown>)) {
                if (vv == null) continue
                campos[kk] = typeof vv === 'object' ? JSON.stringify(vv) : String(vv)
              }
            }
            continue
          } catch { /* trata como campo de texto normal */ }
        }
        campos[k] = String(v)
      }
    }

    // 2) Valida o mínimo: precisa de ao menos evento OU nome de contato.
    const [evento] = pick(campos, EVENTO_KEYS)
    const [nome, nomeKey] = pick(campos, NOME_KEYS)
    const [telefone, telKey] = pick(campos, TELEFONE_KEYS)
    const [email, emailKey] = pick(campos, EMAIL_KEYS)

    if (!evento && !nome) {
      return jsonResponse(
        { ok: false, error: 'Formulário sem identificação (informe ao menos o nome do evento ou o contato).' },
        400,
      )
    }

    // 3) Valida e sobe os arquivos (opcionais).
    if (arquivos.length > MAX_FILES) {
      return jsonResponse({ ok: false, error: `Máximo de ${MAX_FILES} arquivos por envio.` }, 400)
    }
    const agora = new Date()
    const prazo = new Date(agora.getTime() + PRAZO_DIAS * 24 * 60 * 60 * 1000)
    const protocolo = `APOIO-${agora.getTime().toString(36).toUpperCase()}`

    const enviados: { field: string; url: string; fileName: string; type: string; size: number; isImage: boolean }[] = []
    for (const [i, { field, file }] of arquivos.entries()) {
      const original = file.name || `${field}.pdf`
      const ext = getExt(original)
      if (file.size > MAX_FILE_BYTES) {
        return jsonResponse({ ok: false, error: `Arquivo "${original}" excede 25 MB.` }, 400)
      }
      if (ext && !ALLOWED_EXT.has(ext)) {
        return jsonResponse(
          { ok: false, error: `Arquivo "${original}": formato não permitido (use PDF, Word, imagem, etc.).` },
          400,
        )
      }
      // Prefixo com o índice do loop garante path ÚNICO por arquivo: sem ele, dois
      // arquivos com o mesmo nome (ex.: dois "orcamento.pdf" ou fotos "image.jpg") caíam
      // no MESMO path e, com upsert:true, o 2º sobrescrevia o 1º (anexo perdido em silêncio).
      const path = `${STORAGE_FOLDER}/${protocolo}/${i}-${sanitizeName(original)}`
      const buf = new Uint8Array(await file.arrayBuffer())
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, {
        contentType: file.type || 'application/octet-stream',
        upsert: true,
      })
      if (upErr) {
        console.error('[submeter-patrocinio] upload error:', original, upErr.message)
        return jsonResponse({ ok: false, error: `Falha no upload: ${original}`, details: upErr.message }, 500)
      }
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
      enviados.push({
        field,
        url: toPublicUrl(pub.publicUrl),
        fileName: original,
        type: file.type || 'application/octet-stream',
        size: file.size,
        isImage: IMAGE_EXT.has(ext),
      })
    }

    // 4) Título: "Solicitação de Apoio - {evento}" (fallback no contato/data).
    const dataBR = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const tituloAlvo = evento || nome || `Nova solicitação (${dataBR})`
    const titulo = `Solicitação de Apoio - ${tituloAlvo}`.slice(0, 240)

    // 5) Descrição HTML. Cabeçalho "Contato: ..." (estilo das tarefas atuais),
    //    depois TODOS os demais campos (genérico) e os anexos.
    const recebidoEm = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const prazoBR = prazo.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })

    // campos já usados no cabeçalho — não repetir na lista
    const usados = new Set<string>([nomeKey, telKey, emailKey].filter(Boolean) as string[])

    const contatoLinha =
      nome
        ? `Contato: ${escapeHtml(nome)}${telefone ? ' - ' + escapeHtml(telefone) : ''}${email ? ' · ' + escapeHtml(email) : ''}`
        : ''

    const camposHtml = Object.keys(campos)
      .filter((k) => !usados.has(k))
      .map((k) => {
        const val = (campos[k] ?? '').toString().trim()
        if (!val) return ''
        return `<li><strong>${escapeHtml(labelFor(k))}:</strong> ${escapeHtml(val)}</li>`
      })
      .filter(Boolean)
      .join('')

    const anexosHtml = enviados
      .map((a) => {
        if (a.isImage) {
          return `<p><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.fileName)}" /></p>`
        }
        return (
          `<p><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" ` +
          `data-attachment-kind="file" data-attachment-name="${escapeHtml(a.fileName)}">📎 ${escapeHtml(a.fileName)}</a></p>`
        )
      })
      .join('\n')

    const descricao = [
      contatoLinha,
      `<p><strong>Protocolo:</strong> ${escapeHtml(protocolo)} · <strong>Recebido em:</strong> ${escapeHtml(recebidoEm)} · <strong>Prazo de retorno:</strong> até ${escapeHtml(prazoBR)} (${PRAZO_DIAS} dias)</p>`,
      camposHtml ? `<p><strong>Dados da solicitação</strong></p><ul>${camposHtml}</ul>` : '',
      enviados.length ? `<p><strong>Anexos enviados</strong></p>\n${anexosHtml}` : '',
      `<p><em>Origem: formulário público de apoio a eventos · Status inicial: A Fazer.</em></p>`,
    ].filter(Boolean).join('\n')

    // 6) Cria a tarefa em "A Fazer" com prazo = now + 7 dias.
    const { data: task, error: taskErr } = await supabase
      .from('gt_tasks')
      .insert({
        list_id: LIST_ID,
        status_id: STATUS_A_FAZER,
        title: titulo,
        description: descricao,
        priority: 'normal',
        progress: 0,
        sort_order: 0,
        due_date: prazo.toISOString().slice(0, 10),
        due_at: prazo.toISOString(),
        assignee_id: ASSIGNEE_PRINCIPAL,
        reporter_id: ASSIGNEE_PRINCIPAL,
        tags: ['apoio'],
      })
      .select('id')
      .single()

    if (taskErr || !task) {
      console.error('[submeter-patrocinio] erro criando tarefa:', taskErr?.message)
      return jsonResponse({ ok: false, error: 'Falha ao criar tarefa', details: taskErr?.message }, 500)
    }

    // 7) Atribui os responsáveis (Adriane + Laura).
    const { error: assignErr } = await supabase
      .from('gt_task_assignees')
      .insert(ASSIGNEES.map((user_id) => ({ task_id: task.id, user_id })))
    if (assignErr) console.error('[submeter-patrocinio] erro atribuindo responsáveis:', assignErr.message)

    // 8) Registro estruturado dos anexos (badge/contagem; o painel visível lê do HTML).
    if (enviados.length) {
      const { error: attErr } = await supabase.from('gt_task_attachments').insert(
        enviados.map((a) => ({
          task_id: task.id,
          file_url: a.url,
          file_name: a.fileName,
          file_type: a.type,
          file_size: a.size,
        })),
      )
      if (attErr) console.error('[submeter-patrocinio] erro anexos:', attErr.message)
    }

    // 9) Persiste o payload cru (fonte para automações/e-mails futuros).
    const { error: subErr } = await supabase.from('gt_form_submissions').insert({
      list_id: LIST_ID,
      task_id: task.id,
      submitter_name: nome || evento || null,
      submitter_email: email ? email.trim().toLowerCase() : null,
      payload: {
        protocolo,
        recebidoEm: agora.toISOString(),
        prazoRetorno: prazo.toISOString(),
        evento,
        contato: { nome, telefone, email },
        campos, // TODOS os campos recebidos (crus) — robusto a campos novos
        arquivos: enviados.map((a) => ({ field: a.field, url: a.url, fileName: a.fileName })),
      },
    })
    if (subErr) console.error('[submeter-patrocinio] erro persistindo submissão:', subErr.message)

    console.log(`[submeter-patrocinio] ok ${protocolo} -> task ${task.id}`)
    return jsonResponse({ ok: true, protocolo, taskId: task.id, enviadoEm: agora.toISOString() })
  } catch (e) {
    const err = e as { message?: string }
    console.error('[submeter-patrocinio] erro inesperado:', err?.message ?? e)
    return jsonResponse({ ok: false, error: 'Erro interno', details: String(err?.message ?? e) }, 500)
  }
})
