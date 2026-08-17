// Intake da COBRANCA: SprintHub -> fila do discador 3C+ (`cob_3c_fila`).
//
// SUBSTITUI o workflow n8n "SprintHub X 3C (Funil de Cobrancas)", que gravava em
// `leads_buffer_cobranca_30_dias` no Supabase da conta pessoal.
//
// Por que uma function DEDICADA e nao o `crm-lead-webhook`:
// o motor de captacao cria/atualiza o contato em `public.leads`, e a fila do discador
// SDR (`threec_mailing_selecionar`) varre `public.leads` — o inadimplente viraria lead
// de demanda e receberia LIGACAO DE VENDAS. Com `criar_oportunidade` seria pior ainda:
// semearia o Agente Joao (`cliente_ppg_leads_sdr` + forward n8n) e o inadimplente
// levaria mensagem comercial no WhatsApp. Esta function nao toca em nada do comercial.
//
// Chamada (URL configurada na integracao de saida do SprintHub):
//   POST /functions/v1/cobranca-3c-webhook?secret=<segredo>
//   (o segredo tambem pode vir no header `x-webhook-secret`)
//
// Nao filtra por dias de atraso: 30/60/90 convivem na MESMA lista (decisao de
// 17/08/2026). O numero vira coluna do mailing para o agente ver na tela do 3C.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SECRET_ENV = Deno.env.get('COB_3C_WEBHOOK_SECRET') ?? ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ------------------------------------------------------------ leitura ----
// Montado com String.fromCharCode e ASCII puro DE PROPOSITO: aspa curva e marca de
// acento literais no fonte quebram o parser do Deno ("Unterminated regexp literal")
// e derrubam o boot da function inteira — ja aconteceu no threec-mailing-sync.
// 34 " · 39 ' · 96 ` · 8216-8221 aspas curvas
const ASPAS = new RegExp('[' + String.fromCharCode(34, 39, 96, 8216, 8217, 8220, 8221) + ']', 'g')

// O SprintHub manda chave com acento, espaco e parenteses ("Numero",
// "Responsavel(Nome)"). NFD separa o acento da letra e o filtro [^a-z0-9] leva
// embora tanto o acento solto quanto a pontuacao: "Formacao" e "formacao" viram
// a mesma chave, sem precisar de regex de caractere combinante.
const normKey = (k: string): string =>
  k.normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '')

// Achata o objeto para achar a chave mesmo se o Sprint aninhar em `body`/`data`.
function achatar(obj: unknown, saida: Record<string, unknown> = {}, prof = 0): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || prof > 4) return saida
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const nk = normKey(k)
    // a chave mais rasa vence: o payload de cima e o que o Sprint mapeou
    if (!(nk in saida) && (v === null || typeof v !== 'object')) saida[nk] = v
    if (v && typeof v === 'object') achatar(v, saida, prof + 1)
  }
  return saida
}

// Token do Sprint que chegou sem ser substituido ("{contactfield=firstname}" como
// VALOR). Guardar isso como nome faria o agente ver a chave crua na tela do 3C.
const ehTokenCru = (s: string): boolean => /^\{.*\}$/.test(s.trim())

const pegar = (plano: Record<string, unknown>, ...nomes: string[]): string => {
  for (const n of nomes) {
    const v = plano[normKey(n)]
    if (v === undefined || v === null) continue
    const s = String(v).trim()
    if (s !== '' && !ehTokenCru(s)) return s
  }
  return ''
}

// Remove aspas e quebras que sujam o nome na tela do agente, PRESERVANDO acento
// (o n8n ja fazia isso — nome sem acento no discador fica feio para o cliente).
const limparTexto = (s: string): string =>
  s.replace(ASPAS, '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()

// Dias de atraso: campo proprio do Sprint e, quando ele nao vem, o numero que
// mora no TITULO da oportunidade ("... 60 dias de atraso").
function extrairDiasAtraso(campo: string, oportunidade: string): number | null {
  const doCampo = parseInt(campo.replace(/\D/g, ''), 10)
  if (Number.isFinite(doCampo) && doCampo > 0) return doCampo

  const m = oportunidade.match(/(\d{1,4})\s*dias?/i) ?? oportunidade.match(/\b(30|60|90|120)\b/)
  if (m) {
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

// Comparacao de segredo em tempo constante — evita vazar o prefixo por timing.
function segredoConfere(recebido: string, esperado: string): boolean {
  if (!esperado || !recebido || recebido.length !== esperado.length) return false
  let dif = 0
  for (let i = 0; i < esperado.length; i++) dif |= recebido.charCodeAt(i) ^ esperado.charCodeAt(i)
  return dif === 0
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  // Health check. Varios conectores (o SprintHub entre eles, aparentemente) batem
  // um GET na URL para validar antes de salvar — e um 405 faz o conector marcar a
  // integracao como invalida e PARAR DE ENVIAR, sem erro visivel do nosso lado.
  // Responde 200 sem exigir segredo: nao devolve nenhum dado, so prova que existe.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return json({ ok: true, servico: 'cobranca-3c-webhook', aceita: 'POST com JSON' })
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = new URL(req.url)
  // Aceita o segredo por onde quer que o conector consiga mandar: query string
  // (?secret= / ?token= / ?key=), header proprio, ou Authorization: Bearer.
  // Conector que engole query string ainda consegue autenticar por header.
  const recebido = (
    url.searchParams.get('secret') ??
    url.searchParams.get('token') ??
    url.searchParams.get('key') ??
    req.headers.get('x-webhook-secret') ??
    req.headers.get('x-secret') ??
    (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ??
    ''
  ).trim()

  // Segredo da env vence o da config (permite girar sem mexer no banco).
  let esperado = SECRET_ENV
  if (!esperado) {
    const { data } = await supabase.from('cob_3c_config').select('webhook_secret').eq('id', 1).maybeSingle()
    esperado = (data?.webhook_secret ?? '').trim()
  }
  // Fail-closed: sem segredo configurado ninguem entra (a URL e publica).
  if (!segredoConfere(recebido, esperado)) {
    console.warn('[cobranca-3c-webhook] segredo invalido ou ausente')
    return json({ error: 'forbidden' }, 403)
  }

  let bruto: unknown
  try {
    bruto = await req.json()
  } catch {
    return json({ error: 'corpo nao e JSON' }, 400)
  }

  const plano = achatar(bruto)

  // ⚠️ Chaves conferidas contra 101 chamadas REAIS do Sprint (crm_webhook_logs,
  // 17/08/2026). O nome chega por DOIS caminhos: 58 vieram em `Nome Lead` e 43 em
  // `{contactfield=firstname}` — a chave literal do token, que alguem deixou como
  // NOME do campo na integracao do Sprint. Os dois juntos cobrem 100%; so com
  // `Nome Lead` o agente veria "Aluno" em 43% da lista. `Sobrenome Lead` nao existe
  // no payload real, mas fica no fallback caso volte a ser mapeado la.
  const nome = limparTexto(
    [pegar(plano, 'Nome Lead', '{contactfield=firstname}', 'nome', 'first_name', 'firstname'),
     pegar(plano, 'Sobrenome Lead', '{contactfield=lastname}', 'sobrenome', 'last_name', 'lastname')]
      .filter(Boolean).join(' '),
  )
  const telefone = pegar(plano, 'Numero', 'telefone', 'whatsapp', 'phone', 'celular')
  const email = pegar(plano, 'email', 'e-mail', 'Email Lead')
  const formacao = limparTexto(pegar(plano, 'Formacao', 'profissao'))
  const oportunidade = limparTexto(pegar(plano, 'Nome Oportunidade', 'oportunidade', 'deal_name', 'titulo'))
  // No payload real as chaves sao `nome_resposavel(Oportunidade)` e
  // `sobrenome_resposavel(Oportunidade)` — com o typo "resposavel" (sem o n) que
  // veio da configuracao do Sprint. Mantidas as grafias corretas no fallback.
  const responsavel = limparTexto(
    [pegar(plano, 'nome_resposavel(Oportunidade)', 'nome_responsavel(Oportunidade)', 'Responsavel(Nome)', 'responsavel'),
     pegar(plano, 'sobrenome_resposavel(Oportunidade)', 'sobrenome_responsavel(Oportunidade)', 'Responsavel(Sobrenome)')]
      .filter(Boolean).join(' '),
  )
  const diasAtraso = extrairDiasAtraso(pegar(plano, 'Dias de Atraso', 'dias_atraso'), oportunidade)

  if (!telefone && !nome) {
    return json({ error: 'payload sem telefone e sem nome', chaves_recebidas: Object.keys(plano).slice(0, 40) }, 422)
  }

  const { data, error } = await supabase.rpc('cob_3c_registrar', {
    p_nome: nome,
    p_telefone: telefone,
    p_email: email,
    p_formacao: formacao,
    p_oportunidade: oportunidade,
    p_dias_atraso: diasAtraso,
    p_responsavel: responsavel,
    p_payload: bruto as Record<string, unknown>,
  })
  if (error) {
    console.error('[cobranca-3c-webhook] falha ao registrar', error.message)
    return json({ error: 'falha ao registrar', detail: error.message }, 500)
  }

  const r = Array.isArray(data) ? data[0] : data
  return json({
    ok: true,
    // o conector do Sprint (herdado do n8n) valida este campo antes de marcar a linha
    sucesso: 'true',
    chave: r?.chave ?? null,
    telefone_valido: r?.telefone_valido ?? false,
    novo: r?.novo ?? false,
    dias_atraso: diasAtraso,
  })
}

// Erro sempre como JSON: "Internal Server Error" pelado nao da para diagnosticar.
Deno.serve(async (req) => {
  try {
    return await handler(req)
  } catch (err) {
    console.error('[cobranca-3c-webhook] erro nao tratado', err)
    return json({ error: 'erro interno', detail: String(err) }, 500)
  }
})
