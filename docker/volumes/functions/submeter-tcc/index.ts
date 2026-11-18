// Edge function pública: recebe submissão de TCC do formulário público
// (projeto tccmanual / página /enviar-tcc), valida os dados do(s) aluno(s)
// + endereço, guarda os documentos e cria uma tarefa em
// PEDAGÓGICO → TCC → etapa RECEPÇÃO, atribuída a Adriane e Ana Paula.
//
// Os anexos são gravados no MESMO esquema dos anexos nativos do gestor de
// tarefas: bucket `gt-doc-assets` (privado desde 30/10/2026; a URL "pública"
// gravada é o identificador do arquivo e a tela assina na leitura), pasta
// `gt-task-attachments/tcc/...`, e embutidos como HTML na descrição
// (<a data-attachment-kind="file">). Assim o painel "Anexos" da tarefa os
// reconhece automaticamente, preservando o arquivo EXATAMENTE como o aluno
// enviou (PDF ou Word, nome original).
//
// Endpoint público:
//   https://api.ppgeducacao.site/functions/v1/submeter-tcc
//
// ── Modo 1 (ANTIGO): multipart/form-data, tudo num envio só ──────────────────
//   - dados: JSON.stringify({ alunos[1..2], curso, turma, orientador, tituloTcc })
//     cada aluno: { nome, email, cpf, telefone, cep, rua, numero,
//                   complemento?, bairro, cidade, uf }
//   - termoAceite, declaracaoRevisor, fichaOrientador, arquivoTcc: File (PDF/DOC/DOCX, <=25MB)
//   Problema (18/11/2026): o upload inteiro (até 100 MB) precisa caber em ~60 s,
//   senão a borda do servidor corta a conexão antes de chegar aqui e o aluno vê
//   "A conexão caiu no meio do envio". Internet lenta + PDF grande = falha.
//   Continua aceito para não quebrar a versão do formulário que ainda está no ar.
//
// ── Modo 2 (NOVO): JSON em etapas, arquivos em pedaços de 1 MB ───────────────
//   1. { operacao: "preparar", envioId: <uuid gerado no navegador>,
//        arquivos: [{ campo, nome, tipo, tamanho }] }
//      → { ok, protocolo, envioId, tamanhoParte,
//          arquivos: [{ campo, contentType, totalPartes }] }
//   2. Para CADA pedaço, logo antes de enviá-lo:
//      { operacao: "assinar", envioId, arquivos: [mesma lista], campo, parte: i }
//      → { ok, url, contentType }
//      e PUT do pedaço (file.slice) na url, com Content-Type = contentType.
//      O link vale só 60 s no nosso Storage (conferido no FIM do upload; medido
//      em 18/11/2026), por isso é pedido um a um e não todos no "preparar".
//      Cada pedaço é um pedido curto: não esbarra no corte de ~60 s da borda,
//      e um pedaço que falha é só repetido (com link novo).
//   3. { operacao: "concluir", envioId, dados, arquivos: [mesma lista] }
//      → confere que todos os pedaços chegaram com o tamanho certo, junta cada
//        arquivo, grava no lugar definitivo, apaga os pedaços e cria a tarefa.
//      Repetir o "concluir" de um envio já concluído devolve a mesma tarefa
//      (repetido: true), sem duplicar.
//
// declaracaoRevisor é OPCIONAL desde 16/11/2026 (o formulário deixou de exigir):
// ausente, vazia ou tamanho 0 = "não enviada"; a tarefa nasce igual, só com 3 anexos.
//
// Retorna: { ok: true, protocolo, taskId, prazoRetorno, enviadoEm }
//   ou { ok: false, error, details?, campo?, temporario? }

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0'
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

// Bucket dos anexos nativos do gestor de tarefas (o painel "Anexos" só
// reconhece links que contenham gt-doc-assets/gt-task-attachments/documentos-vendas).
const BUCKET = 'gt-doc-assets'
const STORAGE_FOLDER = 'gt-task-attachments/tcc'
// SUPABASE_URL interno no self-hosted é http://kong:8000 — reescrevemos para o
// domínio público (mesmo padrão de whatsapp-send-media/whatsapp-webhook).
const PUBLIC_SUPABASE_URL =
  Deno.env.get('PUBLIC_SUPABASE_URL') || 'https://api.ppgeducacao.site'
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/kong:8000/i, PUBLIC_SUPABASE_URL)

const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB
// 1 MB por pedaço: mesmo a 20 KB/s (internet bem ruim) um pedaço sobe em ~50 s,
// abaixo do corte de ~60 s medido em 18/11/2026 (1,4 MB a 30 KB/s passou em 45 s;
// 3 MB a 30 KB/s foi cortado em 77 s).
const PARTE_BYTES = 1024 * 1024
const PRAZO_DIAS = 7 // dias corridos
const MIME_POR_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const ALLOWED_MIME = new Set(Object.values(MIME_POR_EXT))
const ALLOWED_EXT = new Set(Object.keys(MIME_POR_EXT))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

type Dados = z.infer<typeof dadosSchema>
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

// Anexos que o aluno pode deixar em branco. Campo de arquivo vazio no navegador
// chega como File de tamanho 0 (ou nem chega), então os dois casos contam como "não enviado".
const OPTIONAL_FIELDS = new Set<FileField>(['declaracaoRevisor'])

/** Arquivo já gravado no lugar definitivo. */
type Anexo = { path: string; url: string; fileName: string; type: string; size: number }
/** Arquivo como o navegador declara no modo em pedaços. */
type ArquivoDeclarado = { campo: FileField; nome: string; tipo: string; tamanho: number }

class ErroDoAluno extends Error {
  constructor(message: string, readonly campo?: FileField) {
    super(message)
  }
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

/**
 * Sufixo imprevisível para o NOME do arquivo no Storage.
 *
 * A pasta é o protocolo, que não é segredo (vai na tela e no e-mail do aluno). Sem
 * isto, quem souber o protocolo chegaria ao arquivo. O resto do sistema já faz isso
 * há tempos (`src/lib/uploadHelpers.ts`).
 *
 * Vai no NOME e não na PASTA de propósito: a fila do TCC lê o protocolo do caminho
 * (`useFilaTcc.ts`, /\/tcc\/([^/]+)\//), e mexer na pasta quebraria isso.
 *
 * `crypto.getRandomValues` e não `Math.random`: este sufixo é a única coisa entre um
 * arquivo com nome de aluno e qualquer pessoa da internet.
 */
function sufixoAleatorio(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
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

/** Mesma regra de formato do modo antigo: extensão OU tipo precisam ser PDF/DOC/DOCX. */
function tipoAceito(nome: string, tipoInformado: string): string | null {
  if (ALLOWED_MIME.has(tipoInformado)) return tipoInformado
  return MIME_POR_EXT[getExt(nome)] ?? null
}

function validarDados(bruto: unknown): { dados: Dados } | { resposta: Response } {
  try {
    return { dados: dadosSchema.parse(bruto) }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return {
        resposta: jsonResponse(
          {
            ok: false,
            error: 'Dados inválidos',
            details: e.errors.map((i) => ({ path: i.path, message: i.message })),
          },
          400,
        ),
      }
    }
    return { resposta: jsonResponse({ ok: false, error: 'Dados inválidos', details: String(e) }, 400) }
  }
}

/** Valida a lista de arquivos do modo em pedaços (mesmas regras do multipart). */
function validarManifesto(lista: unknown): ArquivoDeclarado[] {
  if (!Array.isArray(lista) || lista.length > FILE_FIELDS.length) {
    throw new ErroDoAluno('Lista de arquivos inválida')
  }
  const vistos = new Map<FileField, ArquivoDeclarado>()
  for (const item of lista) {
    const campo = (item as { campo?: unknown })?.campo as FileField
    if (!FILE_FIELDS.includes(campo) || vistos.has(campo)) {
      throw new ErroDoAluno('Campo de arquivo inválido')
    }
    const { nome: nomeBruto, tipo: tipoBruto, tamanho: tamanhoBruto } = item as Record<string, unknown>
    const nome = typeof nomeBruto === 'string' ? nomeBruto.trim().slice(0, 200) : ''
    const tamanho = Number(tamanhoBruto)
    if (!Number.isSafeInteger(tamanho) || tamanho < 0) {
      throw new ErroDoAluno(`Tamanho inválido: ${FILE_LABELS[campo]}`, campo)
    }
    if (tamanho === 0) {
      if (OPTIONAL_FIELDS.has(campo)) continue // opcional e não enviado
      throw new ErroDoAluno(`Anexo vazio: ${FILE_LABELS[campo]}`, campo)
    }
    if (tamanho > MAX_FILE_BYTES) throw new ErroDoAluno(`${FILE_LABELS[campo]} excede 25 MB`, campo)
    const tipo = tipoAceito(nome, typeof tipoBruto === 'string' ? tipoBruto : '')
    if (!nome || !tipo) {
      throw new ErroDoAluno(
        `${FILE_LABELS[campo]}: formato não permitido (use PDF, DOC ou DOCX)`,
        campo,
      )
    }
    vistos.set(campo, { campo, nome, tipo, tamanho })
  }
  for (const f of FILE_FIELDS) {
    if (!OPTIONAL_FIELDS.has(f) && !vistos.has(f)) throw new ErroDoAluno(`Anexo ausente: ${FILE_LABELS[f]}`, f)
  }
  return FILE_FIELDS.filter((f) => vistos.has(f)).map((f) => vistos.get(f)!)
}

/** O protocolo nasce do id do envio: igual em todas as tentativas do mesmo envio. */
function protocoloDoEnvio(envioId: string): string {
  return `TCC-${envioId.replace(/-/g, '').slice(0, 10).toUpperCase()}`
}

async function hmacHex(segredo: string, mensagem: string): Promise<string> {
  const enc = new TextEncoder()
  const chave = await crypto.subtle.importKey(
    'raw',
    enc.encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const assinatura = new Uint8Array(await crypto.subtle.sign('HMAC', chave, enc.encode(mensagem)))
  return Array.from(assinatura.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Pasta dos pedaços de UM arquivo. Determinística (o "concluir" acha o que o
 * "preparar" assinou, sem tabela nova) e impossível de adivinhar sem o segredo
 * do servidor. Nome/tamanho entram na conta: trocar o arquivo = pasta nova.
 */
async function pastaDasPartes(segredo: string, envioId: string, a: ArquivoDeclarado): Promise<string> {
  const id = await hmacHex(segredo, `${envioId}|${a.campo}|${a.tamanho}|${a.nome}`)
  return `${STORAGE_FOLDER}/${protocoloDoEnvio(envioId)}/_partes/${id}`
}

const nomeDaParte = (i: number) => String(i).padStart(4, '0')
const quantasPartes = (tamanho: number) => Math.ceil(tamanho / PARTE_BYTES)
const tamanhoDaParte = (a: ArquivoDeclarado, i: number) =>
  i < quantasPartes(a.tamanho) - 1 ? PARTE_BYTES : a.tamanho - PARTE_BYTES * (quantasPartes(a.tamanho) - 1)

/** Grava um arquivo no lugar definitivo e devolve o anexo. */
async function gravarDefinitivo(
  supabase: SupabaseClient,
  protocolo: string,
  campo: FileField,
  nomeOriginal: string,
  tipo: string,
  bytes: Uint8Array,
): Promise<Anexo> {
  const original = nomeOriginal || `${campo}.pdf`
  const path = `${STORAGE_FOLDER}/${protocolo}/${campo}-${sufixoAleatorio()}-${sanitizeName(original)}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: tipo,
    upsert: true,
  })
  if (error) throw new Error(`Falha no upload: ${FILE_LABELS[campo]} (${error.message})`)
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { path, url: toPublicUrl(pub.publicUrl), fileName: original, type: tipo, size: bytes.length }
}

/** Passos comuns aos dois modos: tarefa, responsáveis, anexos e registro da submissão. */
async function criarTarefaTcc(
  supabase: SupabaseClient,
  dados: Dados,
  protocolo: string,
  agora: Date,
  anexos: Partial<Record<FileField, Anexo>>,
): Promise<Response> {
  const prazo = new Date(agora.getTime() + PRAZO_DIAS * 24 * 60 * 60 * 1000)
  const enviados = FILE_FIELDS.filter((f) => anexos[f] !== undefined)

  // Título no padrão: "TCC - {aluno(s)} - dd/mm/aaaa"
  const dataBR = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const tituloTarefa = `TCC - ${dados.alunos.map((a) => a.nome).join(' & ')} - ${dataBR}`
  const alunoPrincipal = dados.alunos[0]

  // Vincula aluno_id: tenta achar pelo email; se não achar, cria registro mínimo
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

  // Descrição em HTML (renderiza limpo + anexos no formato nativo)
  const recebidoEm = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const prazoBR = prazo.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })

  const alunosHtml = dados.alunos
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
    const up = anexos[f]
    if (!up) {
      return `<p>➖ ${escapeHtml(FILE_LABELS[f])} — não enviada (opcional)</p>`
    }
    const display = `${FILE_LABELS[f]} — ${up.fileName}`
    return (
      `<p><a href="${escapeHtml(up.url)}" target="_blank" rel="noopener" ` +
      `data-attachment-kind="file" data-attachment-name="${escapeHtml(display)}">📎 ${escapeHtml(display)}</a></p>`
    )
  }).join('\n')

  const descricao = [
    `<p><strong>Protocolo:</strong> ${escapeHtml(protocolo)} · <strong>Recebido em:</strong> ${escapeHtml(recebidoEm)} · <strong>Prazo de retorno:</strong> até ${escapeHtml(prazoBR)} (${PRAZO_DIAS} dias)</p>`,
    `<p><strong>Dados acadêmicos</strong></p>`,
    `<ul>` +
      `<li><strong>Título do TCC:</strong> ${escapeHtml(dados.tituloTcc)}</li>` +
      `<li><strong>Curso:</strong> ${escapeHtml(dados.curso)}</li>` +
      `<li><strong>Turma:</strong> ${escapeHtml(dados.turma)}</li>` +
      `<li><strong>Orientador:</strong> ${escapeHtml(dados.orientador)}</li>` +
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

  // Cria tarefa em RECEPÇÃO com prazo = now + 7 dias
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
      { ok: false, error: 'Falha ao criar tarefa', details: taskErr?.message, temporario: true },
      503,
    )
  }

  // Atribuir Adriane e Ana Paula
  const { error: assignErr } = await supabase.from('gt_task_assignees').insert([
    { task_id: task.id, user_id: ADRIANE_ID },
    { task_id: task.id, user_id: ANAPAULA_ID },
  ])
  if (assignErr) {
    console.error('[submeter-tcc] erro atribuindo responsáveis:', assignErr.message)
  }

  // Registro estruturado dos anexos (gt_task_attachments) — alimenta a
  // contagem/badge da tarefa; o painel visível lê do HTML da descrição.
  const attachmentsRows = enviados.map((f) => ({
    task_id: task.id,
    file_url: anexos[f]!.url,
    file_name: `${FILE_LABELS[f]} — ${anexos[f]!.fileName}`,
    file_type: anexos[f]!.type || 'application/octet-stream',
    file_size: anexos[f]!.size,
  }))
  const { error: attErr } = await supabase.from('gt_task_attachments').insert(attachmentsRows)
  if (attErr) {
    console.error('[submeter-tcc] erro anexos:', attErr.message)
  }

  // Persiste payload estruturado (fonte para a automação de e-mails)
  const { error: subErr } = await supabase.from('gt_form_submissions').insert({
    list_id: LIST_ID,
    task_id: task.id,
    submitter_name: alunoPrincipal.nome,
    submitter_email: alunoPrincipal.email.trim().toLowerCase(),
    payload: {
      protocolo,
      recebidoEm: agora.toISOString(),
      prazoRetorno: prazo.toISOString(),
      alunos: dados.alunos,
      curso: dados.curso,
      turma: dados.turma,
      orientador: dados.orientador,
      tituloTcc: dados.tituloTcc,
      // Anexo opcional não enviado não entra no objeto
      arquivos: Object.fromEntries(
        enviados.map((f) => [
          f,
          { path: anexos[f]!.path, url: anexos[f]!.url, fileName: anexos[f]!.fileName },
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
}

// ── Modo 1: multipart (antigo) ───────────────────────────────────────────────
async function receberMultipart(req: Request, supabase: SupabaseClient): Promise<Response> {
  let form: FormData
  try {
    form = await req.formData()
  } catch (_e) {
    return jsonResponse({ ok: false, error: 'multipart/form-data inválido' }, 400)
  }

  const rawDados = form.get('dados')
  if (typeof rawDados !== 'string') {
    return jsonResponse({ ok: false, error: 'Campo `dados` ausente' }, 400)
  }
  let bruto: unknown
  try {
    bruto = JSON.parse(rawDados)
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Dados inválidos', details: String(e) }, 400)
  }
  const v = validarDados(bruto)
  if ('resposta' in v) return v.resposta

  // Valida arquivos
  const files: Partial<Record<FileField, File>> = {}
  for (const field of FILE_FIELDS) {
    const f = form.get(field)
    if (OPTIONAL_FIELDS.has(field) && (!(f instanceof File) || f.size === 0)) {
      continue // opcional e não enviado
    }
    if (!(f instanceof File)) {
      return jsonResponse({ ok: false, error: `Anexo ausente: ${FILE_LABELS[field]}` }, 400)
    }
    if (f.size === 0) {
      return jsonResponse({ ok: false, error: `Anexo vazio: ${FILE_LABELS[field]}` }, 400)
    }
    if (f.size > MAX_FILE_BYTES) {
      return jsonResponse({ ok: false, error: `${FILE_LABELS[field]} excede 25 MB` }, 400)
    }
    if (!tipoAceito(f.name, f.type)) {
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

  const agora = new Date()
  const protocolo = `TCC-${agora.getTime().toString(36).toUpperCase()}`

  const anexos: Partial<Record<FileField, Anexo>> = {}
  for (const field of FILE_FIELDS) {
    const file = files[field]
    if (!file) continue
    try {
      anexos[field] = await gravarDefinitivo(
        supabase,
        protocolo,
        field,
        file.name,
        tipoAceito(file.name, file.type)!,
        new Uint8Array(await file.arrayBuffer()),
      )
    } catch (e) {
      console.error('[submeter-tcc] upload error:', field, (e as Error).message)
      return jsonResponse(
        { ok: false, error: `Falha no upload: ${FILE_LABELS[field]}`, details: (e as Error).message },
        500,
      )
    }
  }

  return criarTarefaTcc(supabase, v.dados, protocolo, agora, anexos)
}

// ── Modo 2: JSON em pedaços (novo) ───────────────────────────────────────────
function preparar(body: Record<string, unknown>): Response {
  const envioId = String(body.envioId ?? '')
  if (!UUID_RE.test(envioId)) return jsonResponse({ ok: false, error: 'Identificador do envio inválido' }, 400)
  const arquivos = validarManifesto(body.arquivos)
  return jsonResponse({
    ok: true,
    protocolo: protocoloDoEnvio(envioId),
    envioId,
    tamanhoParte: PARTE_BYTES,
    arquivos: arquivos.map((a) => ({ campo: a.campo, contentType: a.tipo, totalPartes: quantasPartes(a.tamanho) })),
  })
}

/** Link de envio de UM pedaço, pedido logo antes de enviá-lo (vale 60 s). */
async function assinar(
  body: Record<string, unknown>,
  supabase: SupabaseClient,
  segredo: string,
): Promise<Response> {
  const envioId = String(body.envioId ?? '')
  if (!UUID_RE.test(envioId)) return jsonResponse({ ok: false, error: 'Identificador do envio inválido' }, 400)
  const arquivos = validarManifesto(body.arquivos)
  const a = arquivos.find((x) => x.campo === body.campo)
  const parte = Number(body.parte)
  if (!a || !Number.isInteger(parte) || parte < 0 || parte >= quantasPartes(a.tamanho)) {
    return jsonResponse({ ok: false, error: 'Pedaço inválido' }, 400)
  }
  const pasta = await pastaDasPartes(segredo, envioId, a)
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(`${pasta}/${nomeDaParte(parte)}`, { upsert: true })
  if (error || !data) throw new Error(`assinar parte: ${error?.message}`)
  // O runtime self-hosted assina com o Kong interno; o navegador recebe a origem pública.
  const link = new URL(data.signedUrl)
  return jsonResponse({ ok: true, url: `${PUBLIC_SUPABASE_URL}${link.pathname}${link.search}`, contentType: a.tipo })
}

async function concluir(
  body: Record<string, unknown>,
  supabase: SupabaseClient,
  segredo: string,
): Promise<Response> {
  const envioId = String(body.envioId ?? '')
  if (!UUID_RE.test(envioId)) return jsonResponse({ ok: false, error: 'Identificador do envio inválido' }, 400)
  const v = validarDados(body.dados)
  if ('resposta' in v) return v.resposta
  const arquivos = validarManifesto(body.arquivos)
  const protocolo = protocoloDoEnvio(envioId)

  // Resposta perdida + aluno clicando de novo: devolve a tarefa que já existe.
  const { data: jaFeito, error: erroBusca } = await supabase
    .from('gt_form_submissions')
    .select('task_id, payload')
    .eq('list_id', LIST_ID)
    .eq('payload->>protocolo', protocolo)
    .limit(1)
    .maybeSingle()
  if (erroBusca) throw new Error(`buscar envio anterior: ${erroBusca.message}`)
  if (jaFeito) {
    const p = (jaFeito.payload ?? {}) as Record<string, string>
    return jsonResponse({
      ok: true,
      protocolo,
      taskId: jaFeito.task_id,
      prazoRetorno: p.prazoRetorno,
      enviadoEm: p.recebidoEm,
      repetido: true,
    })
  }

  // 1) Todos os pedaços chegaram, com o tamanho certo? (antes de gravar qualquer coisa)
  const pastas = new Map<FileField, string>()
  for (const a of arquivos) {
    const pasta = await pastaDasPartes(segredo, envioId, a)
    pastas.set(a.campo, pasta)
    const { data: lista, error } = await supabase.storage.from(BUCKET).list(pasta, { limit: 1000 })
    if (error) throw new Error(`listar partes: ${error.message}`)
    const tamanhos = new Map((lista ?? []).map((o) => [o.name, Number(o.metadata?.size)]))
    for (let i = 0; i < quantasPartes(a.tamanho); i++) {
      if (tamanhos.get(nomeDaParte(i)) !== tamanhoDaParte(a, i)) {
        throw new ErroDoAluno(
          `O arquivo não chegou completo: ${FILE_LABELS[a.campo]}. Envie novamente.`,
          a.campo,
        )
      }
    }
  }

  // 2) Junta cada arquivo (um por vez, para não segurar 100 MB na memória) e grava.
  const agora = new Date()
  const anexos: Partial<Record<FileField, Anexo>> = {}
  for (const a of arquivos) {
    const pasta = pastas.get(a.campo)!
    const bytes = new Uint8Array(a.tamanho)
    for (let i = 0; i < quantasPartes(a.tamanho); i++) {
      const { data, error } = await supabase.storage.from(BUCKET).download(`${pasta}/${nomeDaParte(i)}`)
      if (error || !data) throw new Error(`baixar parte ${i}: ${error?.message}`)
      const parte = new Uint8Array(await data.arrayBuffer())
      if (parte.length !== tamanhoDaParte(a, i)) {
        throw new ErroDoAluno(`O arquivo não chegou completo: ${FILE_LABELS[a.campo]}. Envie novamente.`, a.campo)
      }
      bytes.set(parte, i * PARTE_BYTES)
    }
    anexos[a.campo] = await gravarDefinitivo(supabase, protocolo, a.campo, a.nome, a.tipo, bytes)
  }

  const resposta = await criarTarefaTcc(supabase, v.dados, protocolo, agora, anexos)

  // 3) Limpa os pedaços (inclusive sobras de tentativas com outro arquivo). Falha aqui
  //    não desfaz o envio: só deixa lixo na pasta _partes.
  if (resposta.ok) {
    try {
      const raiz = `${STORAGE_FOLDER}/${protocolo}/_partes`
      const { data: pastasPartes } = await supabase.storage.from(BUCKET).list(raiz, { limit: 100 })
      for (const p of pastasPartes ?? []) {
        const { data: objs } = await supabase.storage.from(BUCKET).list(`${raiz}/${p.name}`, { limit: 1000 })
        const caminhos = (objs ?? []).map((o) => `${raiz}/${p.name}/${o.name}`)
        if (caminhos.length) await supabase.storage.from(BUCKET).remove(caminhos)
      }
    } catch (e) {
      console.warn('[submeter-tcc] limpeza das partes falhou:', (e as Error).message)
    }
  }
  return resposta
}

async function receberJson(req: Request, supabase: SupabaseClient, segredo: string): Promise<Response> {
  const texto = await req.text()
  if (texto.length > 256 * 1024) return jsonResponse({ ok: false, error: 'Corpo muito grande' }, 413)
  let body: Record<string, unknown>
  try {
    body = JSON.parse(texto)
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido' }, 400)
  }
  if (!body || typeof body !== 'object') return jsonResponse({ ok: false, error: 'JSON inválido' }, 400)
  if (body.operacao === 'preparar') return preparar(body)
  if (body.operacao === 'assinar') return assinar(body, supabase, segredo)
  if (body.operacao === 'concluir') return concluir(body, supabase, segredo)
  return jsonResponse({ ok: false, error: 'Operação inválida' }, 400)
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
    const tipo = req.headers.get('content-type') ?? ''
    if (tipo.includes('application/json')) return await receberJson(req, supabase, serviceKey)
    return await receberMultipart(req, supabase)
  } catch (e) {
    if (e instanceof ErroDoAluno) {
      return jsonResponse({ ok: false, error: e.message, campo: e.campo }, 400)
    }
    const err = e as { message?: string }
    console.error('[submeter-tcc] erro inesperado:', err?.message ?? e)
    // 503 (e não 502/504): o Cloudflare deixa passar, então o formulário lê a
    // mensagem e sabe que pode repetir.
    return jsonResponse(
      { ok: false, error: 'Erro temporário no servidor. Tente novamente.', temporario: true },
      503,
    )
  }
})
