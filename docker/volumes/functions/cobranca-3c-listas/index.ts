// Listas da COBRANCA no discador 3C+ — faxina e montagem diaria.
//
// SUBSTITUI o workflow n8n "Cobranca PPGVET -> 3C Plus" (schedule de 2 em 2 min).
//
// O DEFEITO do n8n: ele criava a lista do dia mas NUNCA apagava a do dia anterior.
// Quem quitava seguia vivo nas listas velhas e continuava recebendo ligacao de
// cobranca — desconforto real com cliente que ja esta em dia.
//
// O ciclo novo (dois crons):
//   19:00 BRT  ?acao=faxina  -> apaga TODAS as listas da campanha, sem olhar nome
//                               (campanha fica zerada; das 19h as 10h30 nao
//                               existe fila, de proposito)
//   10:30 BRT  ?acao=montar  -> cria a lista do dia e sobe so quem AINDA e
//                               inadimplente (depois de o time revisar o funil)
//
// Chamada:
//   POST /functions/v1/cobranca-3c-listas?acao=montar
//   POST ?acao=montar&dry=1        -> simula (nao cria lista, nao envia, nao marca)
//   POST ?acao=faxina&dry=1        -> lista o que MORRERIA, sem apagar nada
//   POST ?acao=faxina&ids=1,2      -> apaga listas por id (usado no teste do DELETE)
//   POST ?acao=flag&nome=check_smart_filter&valor=false
//                                  -> liga/desliga um filtro de entrada da campanha
//                                     (so as 3 check_*; &dry=1 so mostra os valores)
//   POST ?acao=repescar            -> se a lista do dia ACABOU (dial+redial = 0),
//                                     remonta com a fila inteira. Cron de 15 em 15
//                                     min, 11:00-18:30 BRT. &dry=1 simula
//   POST ?acao=sondar&limite=12    -> por que 246 de 335 nao entram: testa numero
//                                     a numero, em 4 formatos, em lista propria
//                                     de peso 0, e apaga tudo no fim

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ⚠️ HOST NOVO desde 22/08/2026: a FluxoTI virou **3C Plus** e aposentou o domínio.
// `fluxoti.com` não resolve mais (sem DNS) e `3c.fluxoti.com`, embora ainda responda
// pelo Cloudflare, devolve o MESMO 404 de nginx em todo path — raiz, /login, /api,
// /health. Não é token nem rede: não há nada servido ali.
// Medido com o token real, de dentro da VPS:
//     3c.fluxoti.com/api/v1/agents/status  -> 404
//     app.3c.plus/api/v1/agents/status     -> 200 OK
// O token continua o mesmo; só o endereço mudou. Parou tudo entre 21h46 e 21h48 BRT
// de 21/08/2026 — Dash Ligação, TV, mailing quente (0 lead no discador) e as listas
// de cobrança, todos de uma vez, porque as quatro functions caem neste default
// (THREEC_BASE_URL não está definida na VPS).
const THREEC_BASE_ENV = Deno.env.get('THREEC_BASE_URL') ?? 'https://app.3c.plus/api/v1'
const THREEC_TOKEN =
  Deno.env.get('3C_TOKEN_API') ??
  Deno.env.get('THREEC_API_TOKEN') ??
  Deno.env.get('THREEC_TOKEN') ??
  ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

// ORDEM IMPORTA: e a mesma com que a lista e criada (o 3C fixa o header na criacao).
// Mudou aqui -> tem que mudar tambem no corpo do POST /lists.
const HEADER = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao', 'dias_atraso'] as const

// Teto do 3C por requisicao: "O campo Mailing deve ter no maximo 300 itens".
const MAX_POR_POST = 300

// Quantas vezes por dia a lista pode ser remontada depois de esgotar. 3 e o que o
// setor ja fazia a mao (a lista do dia + duas reciclagens). Mais que isso vira
// ligacao demais para a mesma pessoa no mesmo dia.
const MAX_REPESCAGENS_POR_DIA = 3

interface FilaRow {
  chave: string
  telefone: string
  nome: string
  email: string
  formacao: string
  dias_atraso: number | null
  visto_em: string
}

// Modelo MailingList do 3C. `dial` e `redial` sao o que AINDA falta discar e
// rediscar nesta lista: a lista ACABOU quando os dois zeram (e o "Finalizado em"
// com a barra cheia do painel). Estes campos sempre vieram na resposta do
// GET /lists — so nunca tinham sido lidos.
interface Lista3C {
  id: number | string
  name?: string
  nome?: string
  total?: number
  dial?: number
  redial?: number
  dialed?: number
  dialed_percentage?: number
  completed?: number
  answered?: number
  weight?: number
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Invisiveis que o cadastro traz colado no nome (o lead usa para furar filtro de
// bot). Montado por CODIGO, nunca literal: caractere invisivel no fonte quebra o
// parser do Deno ("Unterminated regexp literal") e derruba o boot da function —
// ja aconteceu no threec-mailing-sync.
// 00AD soft hyphen · 034F combining grapheme joiner · 200B-200F zero-width e
// marcas de direcao · 2060-2064 word joiner e invisiveis · FEFF BOM
const CODIGOS_INVISIVEIS = [
  0x00ad, 0x034f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
]
const INVISIVEIS = new RegExp(
  '[' + CODIGOS_INVISIVEIS.map((c) => String.fromCharCode(c)).join('') + ']',
  'g',
)
const limpar = (s: string): string =>
  (s ?? '').normalize('NFKC').replace(INVISIVEIS, '').replace(/\s+/g, ' ').trim()

// Nome da lista do dia, no fuso de Sao Paulo (o cron roda em UTC).
function nomeListaDoDia(prefixo: string): string {
  const data = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  return `${prefixo} ${data}`
}

const nomeDaLista = (l: Lista3C): string => String(l.name ?? l.nome ?? '')

// O que fica registrado sobre uma lista. `dial`/`redial` respondem "sobrou algo
// para discar aqui?" — e o que diz se uma lista viva na campanha esta roubando
// gente da lista do dia.
const resumoDaLista = (l: Lista3C): Record<string, unknown> => ({
  id: l.id,
  nome: nomeDaLista(l),
  total: l.total ?? null,
  dial: l.dial ?? null,
  redial: l.redial ?? null,
  dialed: l.dialed ?? null,
})

// O agente le o `identifier` primeiro na tela do 3C.
function montarIdentifier(nome: string, dias: number | null): string {
  const n = limpar(nome) || 'Aluno'
  const id = dias ? `${n} - ${dias} dias` : n
  return id.slice(0, 120)
}

// ------------------------------------------------------------- API 3C ----
function alvo(base: string, caminho: string): string {
  return `${base}${caminho}${caminho.includes('?') ? '&' : '?'}api_token=${THREEC_TOKEN}`
}

// A API do 3C PAGINA. Ler so a primeira pagina some com listas — o mesmo erro ja
// aconteceu com os agentes (ver docs/Telefonia (3C).md).
async function listarTodasAsListas(base: string, campanha: string): Promise<Lista3C[]> {
  const todas: Lista3C[] = []
  const vistos = new Set<string>()

  for (let page = 1; page <= 50; page++) {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists?page=${page}`), {
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) {
      if (page === 1) throw new Error(`GET lists falhou: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`)
      break
    }
    const corpo = await resp.json()
    const pagina: Lista3C[] = Array.isArray(corpo?.data) ? corpo.data : Array.isArray(corpo) ? corpo : []
    if (pagina.length === 0) break

    let novas = 0
    for (const l of pagina) {
      const k = String(l.id)
      if (!vistos.has(k)) { vistos.add(k); todas.push(l); novas++ }
    }
    // API sem paginacao devolve tudo sempre igual: sem item novo, para.
    if (novas === 0) break

    const meta = corpo?.meta ?? corpo
    const atual = Number(meta?.current_page ?? page)
    const ultima = Number(meta?.last_page ?? 0)
    if (ultima && atual >= ultima) break
  }
  return todas
}

// ------------------------------------------------------------- faxina ----
async function faxina(base: string, campanha: string, idsManuais: string[], dry: boolean) {
  const todas = await listarTodasAsListas(base, campanha)

  // Apaga TODAS as listas da campanha, sem olhar o nome (decisao do usuario em
  // 19/08/2026). A campanha de cobranca e descartavel por natureza: ela nasce as
  // 10:30 e morre as 19:00 todo dia, entao nao existe lista para preservar nela.
  //
  // A regra anterior so matava quem comecasse com o prefixo configurado, para
  // nunca apagar lista de terceiro. Na pratica isso abriu o buraco: a reciclagem
  // que o setor faz a mao cria listas chamadas "reciclagem", que nao batiam no
  // prefixo e SOBREVIVIAM a faxina — em 18/08/2026 duas delas passaram a noite
  // vivas com ~176 registros e quem tinha quitado continuou sendo discado, que e
  // exatamente o defeito que motivou a saida do n8n.
  //
  // O escopo continua contido: esta function so toca a campanha de
  // `cob_3c_config.campanha_id`. "Apagar tudo" e tudo DESSA campanha, mais nada.
  // Consequencia assumida: lista criada a mao aqui tambem morre as 19:00.
  const alvos = idsManuais.length > 0
    ? todas.filter((l) => idsManuais.includes(String(l.id)))
    : todas

  const apagadas: Array<Record<string, unknown>> = []
  const falhas: string[] = []

  if (!dry) {
    for (const l of alvos) {
      const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${l.id}`), { method: 'DELETE' })
      if (resp.ok || resp.status === 204) {
        apagadas.push(resumoDaLista(l))
      } else {
        falhas.push(`lista ${l.id}: HTTP ${resp.status} ${(await resp.text()).slice(0, 150)}`)
      }
    }
  }

  return {
    listas_na_campanha: todas.length,
    alvos: alvos.map(resumoDaLista),
    apagadas,
    falhas,
    // So sobra algo aqui quando a chamada veio com `?ids=` (apagar listas
    // especificas). Na faxina diaria isto e SEMPRE vazio — se vier lista aqui,
    // alguem passou ids, ou o DELETE falhou e a falha esta em `falhas`.
    preservadas: todas
      .filter((l) => !alvos.some((a) => String(a.id) === String(l.id)))
      .map(resumoDaLista),
  }
}

// O 3C deduplica por telefone na CAMPANHA inteira e descarta em silencio quem ja
// existe nela — apagar as listas NAO limpa essa base (aprendizado do discador SDR).
// Sem limpar, a lista de amanha nasceria quase vazia, porque a maioria dos
// inadimplentes de hoje continua inadimplente amanha.
// O corpo aceito por este endpoint ainda nao foi confirmado ao vivo: tenta os
// formatos plausiveis e registra qual passou. Enquanto nenhum passar, a config
// `limpar_base_campanha` fica desligada e a montagem avisa na tela.
async function limparBaseDaCampanha(base: string, campanha: string) {
  const tentativas: Array<Record<string, unknown>> = [
    { all: true },
    { delete_all: true },
    { status: 'all' },
    {},
  ]
  for (const corpo of tentativas) {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/mailing/delete`), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corpo),
    })
    const txt = await resp.text()
    if (resp.ok || resp.status === 204) return { ok: true, corpo_aceito: corpo, status: resp.status }
    console.warn('[cobranca-3c-listas] mailing/delete recusou', JSON.stringify(corpo), resp.status, txt.slice(0, 150))
  }
  return { ok: false, corpo_aceito: null, status: null }
}

// -------------------------------------------------------- diagnostico ----
// ⚠️ A 1a versao deste diagnostico deu um veredito ERRADO (17/08/2026): ela
// assumia que a primeira insercao daria `imported_lines: 1` e, ao ver 0 na
// reinsercao, cantou "dedup por campanha". Na verdade a PRIMEIRA insercao ja
// vinha 0 — o mailing nunca importou nada, e "reinsercao" nao media coisa alguma.
// Licao: sem baseline que funciona, o teste nao tem o que comparar.
//
// Agora e uma MATRIZ. Cada variacao cria a sua propria lista, insere UMA linha,
// le `imported_lines` e apaga a lista. Como o unico fator que muda entre elas e o
// formato do payload, a que importar 1 identifica a causa por eliminacao:
//
//   n8n-classico  6 colunas, exatamente as que o n8n usava e funcionavam
//   com-dias      7 colunas, dias_atraso PREENCHIDO
//   dias-vazio    7 colunas, dias_atraso VAZIO   (suspeito: coluna declarada e sem valor)
//   minimo        3 colunas (identifier/areacode/phone), o menor payload possivel
//   phone-sem-ddd 6 colunas, phone SEM o DDD      (talvez o 3C queira areacode separado)
//
// Se TODAS derem 0, o payload nao e a causa: ou o telefone ja esta preso na base
// da campanha, ou ha algo mais fundamental — e ai o `reinsercao` (que so roda
// quando alguma variacao funciona) responde se apagar a lista libera o numero.
async function diagnostico(base: string, campanha: string, telefone: string) {
  const criadas: string[] = []
  const ddd = telefone.substring(0, 2)

  const apagar = async (listaId: string) => {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}`), { method: 'DELETE' })
    return { status: resp.status, ok: resp.ok || resp.status === 204 }
  }

  const inserir = async (listaId: string, header: readonly string[], linha: Record<string, unknown>) => {
    const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/mailing`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ header, mailing: [linha] }),
    })
    const txt = await resp.text()
    let importados: number | null = null
    try { const j = JSON.parse(txt); importados = typeof j?.imported_lines === 'number' ? j.imported_lines : null } catch { /* nao-JSON */ }
    return { status: resp.status, importados, corpo: txt.slice(0, 300) }
  }

  const base6 = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao'] as const
  // O 3C CONCATENA areacode + phone: `phone` vai SEM o DDD, senao a linha e
  // descartada em silencio (provado em 17/08/2026 — ver o comentario na montagem).
  const semDdd = telefone.substring(2)
  const linha6 = {
    identifier: 'DIAGNOSTICO - nao ligar', areacode: ddd, phone: semDdd,
    nome: 'Diagnostico', email: 'diagnostico@ppgvet.com', formacao: 'Teste',
  }

  const variacoes: Array<{ chave: string; header: readonly string[]; linha: Record<string, unknown> }> = [
    // controle: o formato ja provado. Se ESTE falhar, o problema nao e o payload.
    { chave: 'base6-controle', header: base6, linha: linha6 },
    // a pergunta aberta: a 7a coluna (dias_atraso) quebra a importacao?
    { chave: 'com-dias', header: HEADER, linha: { ...linha6, dias_atraso: '30' } },
    { chave: 'dias-vazio', header: HEADER, linha: { ...linha6, dias_atraso: '' } },
    // regressao: com o DDD colado no phone tem que dar 0 (confirma o diagnostico)
    { chave: 'phone-com-ddd-regressao', header: base6, linha: { ...linha6, phone: telefone } },
  ]

  const resultados: Array<Record<string, unknown>> = []
  let vencedora: string | null = null
  let corpoDaCriacao: string | null = null

  try {
    const antes = await listarTodasAsListas(base, campanha)
    const marca = new Date().toISOString().replace(/[^0-9]/g, '').slice(8, 14)

    for (const v of variacoes) {
      const nova = await criarListaBruto(base, campanha, `ZZ DIAG ${v.chave} ${marca}`, v.header)
      criadas.push(nova.id)
      // guarda o corpo da 1a criacao: mostra se o 3C devolve o header registrado
      if (!corpoDaCriacao) corpoDaCriacao = nova.corpo.slice(0, 600)

      const r = await inserir(nova.id, v.header, v.linha)
      resultados.push({ variacao: v.chave, lista_id: nova.id, colunas: v.header.length, ...r })
      if (r.importados && r.importados > 0 && !vencedora) vencedora = v.chave
      await apagar(nova.id)
    }

    // So faz sentido perguntar "apagar libera o numero?" se alguma variacao importa.
    let reinsercao: Record<string, unknown> | null = null
    if (vencedora) {
      const v = variacoes.find((x) => x.chave === vencedora)!
      const nova = await criarListaBruto(base, campanha, `ZZ DIAG reinsercao ${marca}`, v.header)
      criadas.push(nova.id)
      const r = await inserir(nova.id, v.header, v.linha)
      reinsercao = { ...r, explicacao: 'mesmo telefone, depois de a lista anterior ter sido apagada' }
      await apagar(nova.id)
    }

    const dedupPorCampanha = vencedora !== null && (reinsercao?.importados as number | null) === 0

    let veredito: string
    if (!vencedora) {
      veredito = 'NENHUMA VARIACAO IMPORTOU — o problema NAO e o formato do payload. '
        + 'Ou este telefone ja esta na base da campanha, ou o mailing depende de algo fora da API. '
        + 'Rode de novo com um telefone que nunca entrou nesta campanha.'
    } else if (dedupPorCampanha) {
      veredito = `FORMATO OK ("${vencedora}") mas o telefone ficou PRESO na campanha depois de apagar a lista `
        + '— o ciclo diario precisa limpar a base da campanha (cob_3c_config.limpar_base_campanha).'
    } else {
      veredito = `TUDO CERTO com o formato "${vencedora}": apagar a lista libera o telefone. `
        + 'O ciclo 19:00/10:30 funciona como esta.'
    }

    for (const id of criadas) { try { await apagar(id) } catch { /* ja apagada */ } }

    return {
      veredito,
      formato_que_funciona: vencedora,
      dedup_por_campanha: dedupPorCampanha,
      listas_na_campanha_antes: antes.length,
      resultados,
      reinsercao,
      corpo_da_criacao_da_lista: corpoDaCriacao,
      listas_de_teste_apagadas: criadas,
    }
  } catch (err) {
    for (const id of criadas) { try { await apagar(id) } catch { /* ja era */ } }
    return { veredito: 'FALHOU', erro: String(err), resultados, listas_de_teste_apagadas: criadas }
  }
}

// -------------------------------------------------------------- sonda ----
// POR QUE ISTO EXISTE (19/08/2026): a lista do dia sobe com 89 de 335 — 246
// pessoas, 73% da carteira, NAO CONSEGUEM ENTRAR no discador. Nao e sobra de
// lista velha (a campanha estava provadamente vazia: `campanha_antes: []`) e nao
// e tamanho de lote (a perda se espalha: 69/300 e 20/35). O unico padrao e um
// gradiente por tempo de cobranca — quanto mais dias de atraso, menos importa.
//
// Duas coisas explicariam isso, e o `imported_lines` agregado NAO separa:
//   (a) propriedade do NUMERO  — blacklist do 3C, ou numero morto na operadora
//   (b) FORMATO do payload     — o 3C querendo o telefone de outro jeito
//
// A sonda separa: pega uma amostra ESTRATIFICADA (metade do topo da fila, com
// mais dias de atraso; metade do fim, com menos) e insere CADA numero SOZINHO,
// em cada formato candidato, lendo o `imported_lines` de cada insercao isolada.
//   - so um formato passa                         -> era formato, e sabemos qual
//   - nenhum formato passa para os mesmos numeros  -> e propriedade do numero
//   - aceitacao acompanhando dias_atraso           -> confirma o gradiente
//
// Cria e APAGA a propria lista, com peso 0 para o discador nao pegar os numeros
// nos segundos em que eles ficam la. Nao toca na lista do dia.
// 20/08/2026: `phone` com 9 digitos importa 100%, mas o 3C DISCA errado — o painel
// mostra (55) 9XXXX-XXXX para todo mundo, ou seja, ele perde o DDD e prefixa 55.
// `areacode` NAO existe na documentacao da API (foi herdado do n8n): a hipotese e
// que ela seja coluna decorativa e o 3C so leia `phone`. Por isso agora cada
// formato carrega o PROPRIO header — da para testar sem a coluna.
const COM_AREACODE = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao'] as const
const SEM_AREACODE = ['identifier', 'phone', 'nome', 'email', 'formacao'] as const

const FORMATOS_SONDA: Array<{
  chave: string
  header: readonly string[]
  monta: (tel: string) => Record<string, string>
}> = [
  // producao HOJE: importa 100% e disca errado (vira DDD 55)
  { chave: 'com_areacode_9', header: COM_AREACODE, monta: (t) => ({ areacode: t.slice(0, 2), phone: t.slice(2) }) },
  // producao ONTEM: numero completo em phone, com a coluna areacode junto
  { chave: 'com_areacode_11', header: COM_AREACODE, monta: (t) => ({ areacode: t.slice(0, 2), phone: t }) },
  // A CANDIDATA: sem a coluna areacode, numero completo em phone
  { chave: 'sem_areacode_11', header: SEM_AREACODE, monta: (t) => ({ phone: t }) },
  // controle: a coluna existe mas vem vazia — separa "coluna atrapalha" de "valor atrapalha"
  { chave: 'areacode_vazio_11', header: COM_AREACODE, monta: (t) => ({ areacode: '', phone: t }) },
  // E.164 sem o mais, sem a coluna
  { chave: 'sem_areacode_55_13', header: SEM_AREACODE, monta: (t) => ({ phone: '55' + t }) },
]

async function sondar(base: string, campanha: string, limite: number) {
  const apagar = async (listaId: string) => {
    try {
      await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}`), { method: 'DELETE' })
    } catch { /* a faxina das 19:00 pega o que sobrar */ }
  }

  // Peso 0 = o discador nao consome esta lista. Best-effort: se o 3C recusar o
  // corpo, a exposicao continua sendo os poucos segundos ate o DELETE.
  const zerarPeso = async (listaId: string) => {
    try {
      await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/updateWeight`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ weight: 0 }),
      })
    } catch { /* best-effort */ }
  }

  const meia = Math.max(1, Math.floor(limite / 2))
  const campos = 'telefone, nome, email, formacao, dias_atraso, vezes_recebido, primeiro_visto_em'
  const consulta = (asc: boolean) =>
    supabase.from('cob_3c_fila').select(campos)
      .eq('telefone_valido', true).is('removido_em', null)
      .order('dias_atraso', { ascending: asc }).limit(meia)

  const [topo, fim] = await Promise.all([consulta(false), consulta(true)])
  if (topo.error || fim.error) throw new Error(topo.error?.message ?? fim.error?.message)

  const vistos = new Set<string>()
  const amostra: Array<Record<string, unknown>> = []
  for (const r of [...(topo.data ?? []), ...(fim.data ?? [])]) {
    const linha = r as Record<string, unknown>
    const tel = String(linha.telefone ?? '')
    if (tel.length !== 11 || vistos.has(tel)) continue
    vistos.add(tel)
    amostra.push(linha)
  }
  if (amostra.length === 0) throw new Error('nenhum telefone valido na fila para sondar')

  const marca = new Date().toISOString().replace(/[^0-9]/g, '').slice(8, 14)
  const veredito: Record<string, Record<string, unknown>> = {}
  const listasCriadas: string[] = []

  for (const f of FORMATOS_SONDA) {
    let listaId: string
    try {
      listaId = (await criarListaBruto(base, campanha, `ZZ SONDA ${f.chave} ${marca}`, f.header)).id
    } catch (err) {
      veredito[f.chave] = { erro_ao_criar_lista: String(err) }
      continue
    }
    listasCriadas.push(listaId)
    await zerarPeso(listaId)

    const porNumero: Record<string, number | null> = {}
    for (const linha of amostra) {
      const tel = String(linha.telefone)
      const campos_ = f.monta(tel)
      let imp: number | null = null
      try {
        const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/mailing`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            header: f.header,
            mailing: [{
              identifier: 'SONDA - nao ligar',
              ...campos_,
              nome: limpar(String(linha.nome ?? '')) || 'Aluno',
              email: limpar(String(linha.email ?? '')),
              formacao: limpar(String(linha.formacao ?? '')),
            }],
          }),
        })
        const txt = await resp.text()
        try {
          const j = JSON.parse(txt)
          imp = typeof j?.imported_lines === 'number' ? j.imported_lines : null
        } catch { /* corpo nao-JSON */ }
      } catch { /* falha de rede: fica null */ }
      porNumero[tel] = imp
    }

    veredito[f.chave] = {
      aceitos: Object.values(porNumero).filter((v) => (v ?? 0) > 0).length,
      testados: amostra.length,
      por_numero: porNumero,
    }
    await apagar(listaId)
  }

  // Uma linha por pessoa: da para ver de bate-pronto se o mesmo numero e recusado
  // em TODOS os formatos (propriedade do numero) ou so em alguns (formato).
  const porPessoa = amostra.map((linha) => {
    const tel = String(linha.telefone)
    const res: Record<string, unknown> = {
      telefone: tel,
      dias_atraso: linha.dias_atraso ?? null,
      vezes_recebido: linha.vezes_recebido ?? null,
      primeiro_visto_em: linha.primeiro_visto_em ?? null,
    }
    for (const f of FORMATOS_SONDA) {
      const pn = (veredito[f.chave]?.por_numero ?? {}) as Record<string, number | null>
      res[f.chave] = pn[tel] ?? null
    }
    return res
  })

  const nenhumFormato = porPessoa.filter((r) =>
    FORMATOS_SONDA.every((f) => !((r[f.chave] as number | null) ?? 0))).length

  return {
    amostra: amostra.length,
    por_formato: Object.fromEntries(
      Object.entries(veredito).map(([k, v]) => [k, { aceitos: v.aceitos ?? null, testados: v.testados ?? null }]),
    ),
    recusados_em_TODOS_os_formatos: nenhumFormato,
    leitura: nenhumFormato === porPessoa.length
      ? 'NENHUM numero entrou em NENHUM formato: e propriedade do numero (blacklist do 3C ou numero morto), nao o payload.'
      : nenhumFormato === 0
        ? 'todo numero entrou em algum formato: o problema E o payload — veja qual formato aceitou mais.'
        : 'misto: parte dos numeros e recusada em qualquer formato (propriedade do numero) e parte depende do formato.',
    por_pessoa: porPessoa,
    listas_de_teste_apagadas: listasCriadas,
  }
}

// -------------------------------------------------------------- purga ----
// O NO DO PROBLEMA (20/08/2026). A sonda mostrou que os dois formatos falhavam
// por motivos OPOSTOS:
//
//   phone 11 digitos  disca certo, mas e RECUSADO para quem ja esteve na
//                     campanha — a base da campanha guarda o numero mesmo depois
//                     de a lista ser apagada
//   phone  9 digitos  importa sempre (string diferente, escapa da dedup) mas o 3C
//                     perde o DDD e disca 55+numero: "Destino indisponivel"
//
// Ou seja: o formato certo e o de 11 digitos, e o que falta e conseguir LIMPAR a
// base da campanha todo dia. `DELETE /campaigns/{id}/mailing/delete` existe e a
// doc so diz "corpo: 1 campo" — qual campo, ninguem sabe.
//
// Esta acao descobre por eliminacao, com um telefone real que HOJE e recusado:
//   1. confirma o baseline (insere 11 digitos -> tem que dar 0)
//   2. tenta cada candidato de corpo/metodo
//   3. depois de cada tentativa, reinsere e le imported_lines
//   4. o candidato que fizer o numero voltar a entrar E a resposta
//
// Os candidatos POR TELEFONE vem primeiro de proposito: se um deles funcionar,
// da para limpar so quem vai ser reimportado, sem zerar a campanha inteira.
async function purga(base: string, campanha: string, telefone: string) {
  const semDdd = telefone.slice(2)
  const ddd = telefone.slice(0, 2)
  const header = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao'] as const

  const criadas: string[] = []
  const apagar = async (id: string) => {
    try { await fetch(alvo(base, `/campaigns/${campanha}/lists/${id}`), { method: 'DELETE' }) } catch { /* faxina pega */ }
  }

  // Insere o numero COMPLETO (11 digitos) numa lista descartavel e devolve
  // imported_lines. 1 = a base soltou o telefone. 0 = continua preso.
  let corpoCruDaRecusa: string | null = null
  const tentarInserir = async (rotulo: string): Promise<number | null> => {
    let id: string
    try {
      id = (await criarListaBruto(base, campanha, `ZZ PURGA ${rotulo}`, header)).id
    } catch { return null }
    criadas.push(id)
    let imp: number | null = null
    try {
      const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${id}/mailing`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          header,
          mailing: [{
            identifier: 'PURGA - nao ligar', areacode: ddd, phone: telefone,
            nome: 'Purga', email: 'purga@ppgvet.com', formacao: 'Teste',
          }],
        }),
      })
      const txt = await resp.text()
      try {
        const j = JSON.parse(txt)
        imp = typeof j?.imported_lines === 'number' ? j.imported_lines : null
      } catch { /* nao-JSON */ }
      // O 3C pode estar dizendo POR QUE recusou e ninguem nunca leu: ate aqui so o
      // `imported_lines` era extraido e o resto do corpo era descartado.
      if ((imp ?? 0) === 0 && corpoCruDaRecusa === null) {
        corpoCruDaRecusa = `HTTP ${resp.status} :: ${txt.slice(0, 1500)}`
      }
    } catch { /* rede */ }
    await apagar(id)
    return imp
  }

  const baseline = await tentarInserir('baseline')

  // CICLO — o teste que separa "dedup" de "numero recusado por outro motivo".
  // Feito com um telefone que HOJE ENTRA (baseline=1):
  //   1a insercao  1  (entrou)
  //   2a insercao  0  -> dedup existe e e IMEDIATA: entrar ja prende o numero
  //                1  -> nao ha dedup, e a recusa dos outros tem outra causa
  //   apos delete  1  -> o corpo do delete FUNCIONA
  // Sem este teste nao da para saber se o delete nao funciona ou se nao havia
  // nada para deletar.
  if (baseline !== 0) {
    const segunda = await tentarInserir('ciclo-2a-insercao')
    let aposDelete: number | null = null
    let statusDelete: number | null = null
    if (segunda === 0) {
      try {
        const resp = await fetch(alvo(base, `/campaigns/${campanha}/mailing/delete`), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ phone: [telefone] }),
        })
        statusDelete = resp.status
      } catch { /* rede */ }
      aposDelete = await tentarInserir('ciclo-apos-delete')
    }
    for (const id of criadas) await apagar(id)
    return {
      veredito: segunda !== 0
        ? 'NAO HA DEDUP: o mesmo telefone entra duas vezes seguidas. Entao a recusa dos outros numeros NAO e "ja esteve na campanha" — a causa e outra e a purga nao resolve.'
        : aposDelete && aposDelete > 0
          ? 'DEDUP CONFIRMADA e o DELETE FUNCIONA: {"phone":[...]} liberou o telefone. E este corpo que a faxina tem que mandar.'
          : 'DEDUP CONFIRMADA mas o delete NAO libera: entrar prende o numero e nada nesta API solta.',
      modo: 'ciclo',
      primeira_insercao: baseline,
      segunda_insercao: segunda,
      status_do_delete: statusDelete,
      insercao_apos_delete: aposDelete,
    }
  }

  const candidatos: Array<{ rotulo: string; metodo: string; caminho: string; corpo: unknown }> = [
    // O 422 de 20/08 entregou o campo: mandando `phone` como STRING a API responde
    // "O campo Telefone precisa ser um conjunto" — ou seja, o campo se chama
    // `phone` (singular) e o valor tem que ser ARRAY. As tentativas anteriores
    // erraram os dois lados: `phones` no plural (204 e nenhum efeito) e `phone`
    // como string (422). Estes vem primeiro agora.
    { rotulo: 'phone_array_11', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { phone: [telefone] } },
    { rotulo: 'phone_array_9', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { phone: [semDdd] } },
    { rotulo: 'phone_array_55', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { phone: ['55' + telefone] } },
    { rotulo: 'phones_11', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { phones: [telefone] } },
    { rotulo: 'phones_9', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { phones: [semDdd] } },
    { rotulo: 'numbers_11', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { numbers: [telefone] } },
    { rotulo: 'phone_str', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { phone: telefone } },
    { rotulo: 'mailing_arr', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { mailing: [telefone] } },
    { rotulo: 'identifiers', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { identifiers: ['PURGA - nao ligar'] } },
    // campanha inteira
    { rotulo: 'all_true', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { all: true } },
    { rotulo: 'delete_all', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { delete_all: true } },
    { rotulo: 'status_all', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { status: 'all' } },
    { rotulo: 'filter_all', metodo: 'DELETE', caminho: 'mailing/delete', corpo: { filter: 'all' } },
    { rotulo: 'corpo_vazio', metodo: 'DELETE', caminho: 'mailing/delete', corpo: {} },
    { rotulo: 'post_all', metodo: 'POST', caminho: 'mailing/delete', corpo: { all: true } },
    // NAO reintroduza `DELETE /campaigns/{id}/lists` aqui. Ele foi testado em
    // 20/08, respondeu 204, NAO liberou o telefone e apagou a lista do dia junto —
    // a purga e diagnostico, nao pode ter candidato destrutivo. Para apagar
    // listas existe a faxina, que registra o que apagou.
  ]

  const tentativas: Array<Record<string, unknown>> = []
  let vencedor: string | null = null

  for (const c of candidatos) {
    let status: number | null = null
    let corpoResp = ''
    try {
      const resp = await fetch(alvo(base, `/campaigns/${campanha}/${c.caminho}`), {
        method: c.metodo,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(c.corpo === null ? {} : { body: JSON.stringify(c.corpo) }),
      })
      status = resp.status
      // 1200 e nao 150: o corpo do 422 do 3C traz `errors` com o NOME do campo que
      // ele esperava — truncar isso foi o que fez a primeira rodada (20/08) voltar
      // sem saber qual era o campo certo.
      corpoResp = (await resp.text()).slice(0, 1200)
    } catch (err) {
      corpoResp = String(err).slice(0, 150)
    }

    const depois = await tentarInserir(c.rotulo)
    tentativas.push({ candidato: c.rotulo, metodo: c.metodo, status, resposta: corpoResp, reinsercao: depois })
    if ((depois ?? 0) > 0) { vencedor = c.rotulo; break }
  }

  for (const id of criadas) await apagar(id)

  return {
    corpo_cru_da_recusa: corpoCruDaRecusa,
    veredito: vencedor
      ? `ACHOU: "${vencedor}" liberou o telefone. E este corpo que a faxina tem que mandar todo dia, e ai o phone pode voltar aos 11 digitos.`
      : 'NENHUM candidato liberou o telefone. A base da campanha nao se limpa por esta API — o caminho passa a ser capturar o que o painel faz (F12) ou falar com a FluxoTI.',
    corpo_que_funciona: vencedor,
    baseline_confirmado: baseline,
    tentativas,
  }
}

// ---------------------------------------------------------- recusados ----
// QUEM sao as pessoas que o 3C nao aceita — nominalmente, nao em contagem.
//
// O caminho ate aqui (20/08/2026), com as duas teorias que morreram no meio:
//   - nao e sobra de lista velha  (montagem com `campanha_antes: []` recusou igual)
//   - nao e tamanho de lote       (a perda se espalha entre os lotes)
//   - nao e dedup                 (o modo ciclo da purga inseriu o MESMO telefone
//                                  duas vezes seguidas e as duas entraram)
//   - nao e a coluna areacode     (com valor, vazia ou ausente da o mesmo)
// O que sobra e a unica coisa consistente com tudo: o 3C VALIDA o numero quando
// consegue — e so consegue quando o DDD esta junto, nos 11 digitos. Com 9 digitos
// ele nao tem como julgar, aceita todo mundo, e depois disca 55+numero.
//
// Se isso esta certo, a lista curta nao e defeito de integracao: e a carteira
// tendo telefone que nao existe mais. E aí o defeito de verdade e OUTRO — o
// sistema descartar essa gente em silencio, sem ninguem saber quem ficou de fora.
//
// Esta acao insere cada pessoa SOZINHA numa lista descartavel de peso 0 e anota
// quem o 3C recusou. E lenta de proposito (uma requisicao por pessoa): so assim
// da para saber o NOME de quem esta fora, e nao so quantos.
async function recusados(base: string, campanha: string, limite: number | null) {
  const { data: fila, error } = await supabase.rpc('cob_3c_selecionar', { p_limite: limite ?? 3000 })
  if (error) throw new Error('falha ao selecionar a fila: ' + error.message)
  const rows = (fila ?? []) as FilaRow[]
  if (rows.length === 0) return { veredito: 'fila vazia', total: 0 }

  const header = ['identifier', 'areacode', 'phone', 'nome', 'email', 'formacao'] as const
  const listaId = (await criarListaBruto(base, campanha, `ZZ RECUSADOS ${Date.now()}`, header)).id
  try {
    await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/updateWeight`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ weight: 0 }),
    })
  } catch { /* best-effort */ }

  const testar = async (r: FilaRow): Promise<boolean | null> => {
    try {
      const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/mailing`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          header,
          mailing: [{
            identifier: 'CHECAGEM - nao ligar',
            areacode: r.telefone.slice(0, 2),
            phone: r.telefone,
            nome: limpar(r.nome) || 'Aluno',
            email: limpar(r.email),
            formacao: limpar(r.formacao),
          }],
        }),
      })
      const j = JSON.parse(await resp.text())
      return typeof j?.imported_lines === 'number' ? j.imported_lines > 0 : null
    } catch {
      return null
    }
  }

  // De 5 em 5: rapido o suficiente para caber no tempo da function, devagar o
  // suficiente para nao tomar 429 do 3C.
  const recusadas: Array<Record<string, unknown>> = []
  let aceitos = 0
  for (let i = 0; i < rows.length; i += 5) {
    const fatia = rows.slice(i, i + 5)
    const res = await Promise.all(fatia.map(testar))
    res.forEach((ok, k) => {
      const r = fatia[k]
      if (ok) aceitos++
      else {
        recusadas.push({
          nome: r.nome, telefone: r.telefone, dias_atraso: r.dias_atraso,
          email: r.email, indeterminado: ok === null,
        })
      }
    })
  }

  try { await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}`), { method: 'DELETE' }) } catch { /* faxina pega */ }

  const porFaixa: Record<string, { recusados: number }> = {}
  for (const r of recusadas) {
    const k = String(r.dias_atraso ?? 'sem faixa')
    porFaixa[k] = { recusados: (porFaixa[k]?.recusados ?? 0) + 1 }
  }

  return {
    total_na_fila: rows.length,
    aceitos_pelo_3c: aceitos,
    recusados_pelo_3c: recusadas.length,
    por_faixa_de_atraso: porFaixa,
    recusados: recusadas,
  }
}

// ------------------------------------------------------------ sandbox ----
// DESCOBRE, SEM RISCO, se `check_smart_filter` e gravavel — e por qual metodo.
//
// O problema: essa flag (e as irmas `check_blacklist` e `check_dnd`) descarta ~73%
// do mailing no import, nao aparece em nenhuma aba de "Configurar Campanha", e o
// `PATCH /campaigns/{id}` responde 200 OK IGNORANDO o campo (relido, continua
// true). Sobrariam `PUT`/`POST`, que tem 22 campos — e um PUT errado na campanha
// de producao pode zerar rota, qualificacao e horario de quem esta discando agora.
//
// Entao o teste acontece numa campanha DESCARTAVEL: cria, mexe, le de volta,
// apaga. A campanha 282311 nao e tocada em momento nenhum.
//
// A descoberta dos campos obrigatorios e feita pelo proprio 3C: um POST com corpo
// vazio volta 422 com `errors` nomeando o que falta (foi assim que o campo do
// mailing/delete apareceu). O que ele pedir, copiamos da campanha real.
async function sandbox(base: string, campanha: string) {
  const passos: Array<Record<string, unknown>> = []
  let sandboxId: string | null = null

  const req = async (metodo: string, caminho: string, corpo?: unknown) => {
    const resp = await fetch(alvo(base, caminho), {
      method: metodo,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    })
    const txt = await resp.text()
    let json_: unknown = null
    try { json_ = JSON.parse(txt) } catch { /* nao-JSON */ }
    return { status: resp.status, json: json_ as Record<string, unknown> | null, texto: txt.slice(0, 700) }
  }

  const lerFlag = async (id: string): Promise<unknown> => {
    const r = await req('GET', `/campaigns/${id}`)
    const d = (r.json?.data ?? r.json) as Record<string, unknown> | null
    return d ? d.check_smart_filter : null
  }

  try {
    // 1. a campanha real serve de molde — nada nela e alterado, so lido
    const realResp = await req('GET', `/campaigns/${campanha}`)
    const real = (realResp.json?.data ?? {}) as Record<string, unknown>

    // 2. o 3C diz o que e obrigatorio
    const vazio = await req('POST', '/campaigns', {})
    const exigidos = Object.keys((vazio.json?.errors ?? {}) as Record<string, unknown>)
    passos.push({ passo: 'campos_obrigatorios', status: vazio.status, exigidos })

    // 3. monta o corpo copiando da real o que ele pediu
    const corpo: Record<string, unknown> = {}
    for (const campo of exigidos) {
      if (campo in real && real[campo] !== null) corpo[campo] = real[campo]
    }
    corpo.name = `ZZ SANDBOX ${Date.now()}`
    corpo.check_smart_filter = false // <- a pergunta do teste

    // O 3C pede `qualification_list` na criacao, mas devolve esse id ANINHADO no
    // GET, dentro de `dialer_settings.qualification_list_id`. Nome de entrada
    // diferente do nome de saida — copiar campo a campo nao acha sozinho.
    if (exigidos.includes('qualification_list') && corpo.qualification_list === undefined) {
      const ds = (real.dialer_settings ?? {}) as Record<string, unknown>
      if (ds.qualification_list_id != null) corpo.qualification_list = ds.qualification_list_id
    }

    const criar = await req('POST', '/campaigns', corpo)
    const criada = (criar.json?.data ?? null) as Record<string, unknown> | null
    passos.push({
      passo: 'criar', status: criar.status,
      corpo_enviado: Object.keys(corpo),
      erros: criar.json?.errors ?? null,
      resposta: criada ? null : criar.texto,
    })
    if (!criada?.id) {
      return { veredito: 'NAO CONSEGUI CRIAR A CAMPANHA DE TESTE — veja errors para saber o que falta.', passos }
    }
    sandboxId = String(criada.id)

    // 4. a flag pegou na CRIACAO?
    const naCriacao = await lerFlag(sandboxId)
    passos.push({ passo: 'flag_na_criacao', valor: naCriacao, esperado: false })

    // 5. e no PATCH? e no PUT? (tudo no sandbox)
    //
    // ⚠️ A flag e IGNORADA na criacao: a campanha nasce com `true` mesmo pedindo
    // `false`. Entao o alvo do teste e `false` — pedir `true` daria "mudou" sem
    // nada ter mudado, que foi o erro da 1a versao deste teste (21/08/2026) e por
    // pouco nao virou um veredito errado.
    const patch = await req('PATCH', `/campaigns/${sandboxId}`, { check_smart_filter: false })
    const aposPatch = await lerFlag(sandboxId)
    passos.push({ passo: 'patch_para_false', status: patch.status, valor_relido: aposPatch, mudou: aposPatch === false })

    // O PUT exige mais tres campos que o POST nao pedia — descobertos pelo 422 da
    // rodada anterior. Ficam explicitos aqui.
    const corpoPut: Record<string, unknown> = {
      ...corpo,
      name: String(criada.name ?? corpo.name),
      check_smart_filter: false,
      is_predictive: real.is_predictive ?? false,
      update_mailing_data: real.update_mailing_data ?? false,
      limit_call_per_agent: real.limit_call_per_agent ?? 0,
    }
    const put = await req('PUT', `/campaigns/${sandboxId}`, corpoPut)
    const aposPut = await lerFlag(sandboxId)
    passos.push({ passo: 'put_para_false', status: put.status, valor_relido: aposPut, mudou: aposPut === false, erros: put.json?.errors ?? null })

    const gravavelNaCriacao = naCriacao === false
    const gravavelPorPatch = aposPatch === false
    const gravavelPorPut = aposPut === false

    return {
      veredito: gravavelPorPut || gravavelPorPatch
        ? `A FLAG E GRAVAVEL por ${gravavelPorPut ? 'PUT' : 'PATCH'} — da para desligar na campanha real por esse metodo.`
        : gravavelNaCriacao
          ? 'A flag so pega na CRIACAO da campanha: nao da para desligar na 282311: seria preciso criar uma campanha nova ja com ela desligada e migrar a operacao.'
          : 'A FLAG NAO E GRAVAVEL POR API de jeito nenhum — nem criando, nem PATCH, nem PUT. O caminho e a FluxoTI.',
      gravavel_na_criacao: gravavelNaCriacao,
      gravavel_por_patch: gravavelPorPatch,
      gravavel_por_put: gravavelPorPut,
      passos,
    }
  } finally {
    // O sandbox NUNCA fica para tras, nem se algo acima explodir.
    if (sandboxId) {
      try { await fetch(alvo(base, `/campaigns/${sandboxId}`), { method: 'DELETE' }) } catch { /* nada a fazer */ }
    }
  }
}

// ------------------------------------------------------------- montar ----
// Devolve o id E o corpo cru: o diagnostico precisa ver com que header o 3C
// registrou a lista (se ele nao registrar o header, o mailing e descartado).
async function criarListaBruto(
  base: string, campanha: string, nome: string, header: readonly string[],
): Promise<{ id: string; corpo: string }> {
  // multipart-form-data com header[i]: e o formato que o n8n usava e que o 3C aceita.
  const form = new FormData()
  form.append('name', nome)
  header.forEach((h, i) => form.append(`header[${i}]`, h))

  const resp = await fetch(alvo(base, `/campaigns/${campanha}/lists`), { method: 'POST', body: form })
  const txt = await resp.text()
  if (!resp.ok) throw new Error(`POST lists falhou: HTTP ${resp.status} ${txt.slice(0, 200)}`)

  let id: unknown = null
  try {
    const j = JSON.parse(txt)
    id = j?.data?.id ?? j?.id ?? null
  } catch { /* corpo nao-JSON */ }
  if (!id) throw new Error(`3C criou a lista mas nao devolveu id: ${txt.slice(0, 200)}`)
  return { id: String(id), corpo: txt }
}

const criarLista = async (base: string, campanha: string, nome: string): Promise<string> =>
  (await criarListaBruto(base, campanha, nome, HEADER)).id

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Gate. Duas portas, nunca anon:
  //   1) service role  -> o cron interno (e operacao manual via SQL)
  //   2) JWT de usuario do FINANCEIRO/GESTAO -> os botoes da tela do portal
  // Aceita as DUAS chaves de service role: a do vault e a env do container sao
  // strings diferentes — comparar so com uma da 403 no cron.
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!auth) return json({ error: 'forbidden' }, 403)

  let autorizado = auth === SERVICE_ROLE
  if (!autorizado) {
    let vaultKey: string | null = null
    try {
      const r = await supabase.rpc('_get_service_role_key')
      vaultKey = (r.data as string | null) ?? null
    } catch (err) {
      console.error('[cobranca-3c-listas] falha ao ler a key do vault', String(err))
    }
    autorizado = !!vaultKey && auth === vaultKey
  }
  if (!autorizado) {
    // Porta 2: a MESMA regua da RLS das cob_* decide, avaliada no contexto do
    // usuario (auth.uid()) — não reimplementamos permissão aqui.
    try {
      const comoUsuario = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${auth}` } },
      })
      const { data: u } = await comoUsuario.auth.getUser()
      if (u?.user) {
        const fin = await comoUsuario.rpc('is_financial_user')
        const ges = await comoUsuario.rpc('is_management_user')
        autorizado = fin.data === true || ges.data === true
      }
    } catch (err) {
      console.error('[cobranca-3c-listas] falha ao validar usuario', String(err))
    }
  }
  if (!autorizado) return json({ error: 'forbidden' }, 403)

  if (!THREEC_TOKEN) return json({ error: '3C_TOKEN_API nao configurado no edge-runtime' }, 500)

  const url = new URL(req.url)
  let acao = (url.searchParams.get('acao') ?? 'montar').toLowerCase()
  const dry = url.searchParams.get('dry') === '1'
  const idsManuais = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const qLimite = Number(url.searchParams.get('limite') ?? '') || null
  // Preenchido so pela repescagem; entra no nome da lista la embaixo.
  let sufixoRepescagem = ''

  const { data: cfg, error: eCfg } = await supabase
    .from('cob_3c_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
  if (eCfg || !cfg) return json({ error: 'cob_3c_config indisponivel', detail: eCfg?.message }, 500)

  // `ativo=false` pausa o pipeline, mas dry-run e diagnostico continuam liberados:
  // e como o time confere o que aconteceria ANTES de ligar.
  if (!cfg.ativo && !dry && acao !== 'diagnostico') {
    return json({ ok: true, skip: 'pipeline pausado (cob_3c_config.ativo=false)' })
  }

  const base = (cfg.base_url ?? '').trim() || THREEC_BASE_ENV
  const campanha = String(cfg.campanha_id)
  const prefixo = String(cfg.prefixo_lista)

  // ------------------------------------------------------- DIAGNOSTICO ----
  if (acao === 'diagnostico') {
    const tel = (url.searchParams.get('telefone') ?? '').replace(/\D/g, '')
    // Sem numero default DE PROPOSITO: o telefone entra numa lista de uma campanha
    // que pode estar discando. Use um numero SEU, ou pause a campanha antes.
    if (tel.length !== 11) {
      return json({ error: 'passe ?telefone=DDD+9+numero (11 digitos). Use um numero SEU: ele entra numa lista real por alguns segundos.' }, 400)
    }
    return json({ ok: true, acao: 'diagnostico', ...(await diagnostico(base, campanha, tel)) })
  }

  // ------------------------------------------------------------- SONDA ----
  if (acao === 'sondar') {
    const limite = Math.min(Math.max(Number(url.searchParams.get('limite') ?? '') || 12, 2), 40)
    try {
      const res = await sondar(base, campanha, limite)
      await supabase.from('cob_3c_execucoes').insert({
        acao: 'sondar', dry: true, ok: true, enviados: res.amostra, detalhe: res,
      })
      return json({ ok: true, acao: 'sondar', ...res })
    } catch (err) {
      await supabase.from('cob_3c_execucoes').insert({
        acao: 'sondar', dry: true, ok: false, erro: String(err),
      })
      return json({ error: 'sonda falhou', detail: String(err) }, 502)
    }
  }

  // ------------------------------------------------------------- PURGA ----
  if (acao === 'purga') {
    const tel = (url.searchParams.get('telefone') ?? '').replace(/\D/g, '')
    if (tel.length !== 11) return json({ error: 'passe ?telefone= com 11 digitos, de um numero que a sonda marcou como RECUSADO' }, 400)
    try {
      return json({ ok: true, acao: 'purga', ...(await purga(base, campanha, tel)) })
    } catch (err) {
      return json({ error: 'purga falhou', detail: String(err) }, 502)
    }
  }

  // --------------------------------------------------------- RECUSADOS ----
  if (acao === 'recusados') {
    try {
      return json({ ok: true, acao: 'recusados', ...(await recusados(base, campanha, qLimite)) })
    } catch (err) {
      return json({ error: 'checagem falhou', detail: String(err) }, 502)
    }
  }

  // -------------------------------------------------------- REPESCAGEM ----
  // A lista do dia seca MUITO antes das 19:00 — em 19/08 os 89 acabaram em menos
  // de uma hora (`dial: 0, redial: 0`) e o time ficou sem fila. A repescagem
  // remonta a lista quando isso acontece.
  //
  // POR QUE NAO USAR A RECICLAGEM NATIVA DO 3C: ela tem tres travas que a tornam
  // inviavel como automacao — exige progresso acima de 75%, demora ATE 2H para
  // processar, e nao tem endpoint na API (so existe no painel, na mao).
  //
  // A nossa nao passa por nenhuma das tres: refaz a lista a partir da
  // `cob_3c_fila`, na hora. E possivel porque nao ha dedup por campanha — o modo
  // ciclo da purga provou que o mesmo telefone entra duas vezes seguidas.
  //
  // REGRA DE NEGOCIO (confirmada com o setor de cobranca em 21/08/2026): eles
  // marcam TODOS os status na reciclagem manual — Nao atendidas, Abandonadas,
  // Finalizada, Falha, CP-Pos e CP-Pre. Ou seja: volta TODO MUNDO, sem filtrar por
  // desfecho. Por isso aqui nao ha filtro por qualificacao: a repescagem e a
  // montagem do dia de novo, com outro nome de lista.
  if (acao === 'repescar') {
    const todasAgora = await listarTodasAsListas(base, campanha)
    const doDia = todasAgora.filter((l) => nomeDaLista(l).startsWith(prefixo))

    if (doDia.length === 0) {
      return json({ ok: true, acao: 'repescar', skip: 'nao ha lista de cobranca na campanha — quem cria e a montagem das 10:30' })
    }

    // "Acabou" = nao sobrou nada para discar NEM para rediscar em NENHUMA lista da
    // campanha — nao so nas nossas. A faxina apaga tudo antes de remontar, entao
    // contar so as listas com o prefixo faria a repescagem apagar uma lista
    // "reciclagem" feita a mao pelo setor com fila viva dentro.
    const pendente = todasAgora.reduce((acc, l) => acc + (Number(l.dial ?? 0) + Number(l.redial ?? 0)), 0)
    if (pendente > 0) {
      return json({
        ok: true, acao: 'repescar', skip: 'ainda ha fila na campanha',
        pendente, listas: todasAgora.map(resumoDaLista),
      })
    }

    // Janela. Nao repescar cedo demais (a montagem das 10:30 acabou de rodar) nem
    // tarde demais — lista criada 18:45 morre as 19:00 sem ninguem discar.
    const agoraBrt = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    const d = new Date(agoraBrt)
    const minutos = d.getHours() * 60 + d.getMinutes()
    if (minutos < 11 * 60 || minutos >= 18 * 60 + 30) {
      return json({ ok: true, acao: 'repescar', skip: 'fora da janela (11:00 as 18:30 BRT)', hora_brt: d.toTimeString().slice(0, 5) })
    }

    // Teto diario: sem isto ele reengata a tarde inteira e a mesma pessoa leva
    // ligacao atras de ligacao. Contado pelo proprio historico — nao precisa de
    // coluna nova em cob_3c_config.
    const inicioDoDia = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
    const { count } = await supabase
      .from('cob_3c_execucoes')
      .select('id', { count: 'exact', head: true })
      .eq('acao', 'montar').eq('dry', false)
      .ilike('lista_nome', '%repescagem%')
      .gte('executado_em', inicioDoDia)
    const feitas = count ?? 0
    if (feitas >= MAX_REPESCAGENS_POR_DIA) {
      return json({ ok: true, acao: 'repescar', skip: `teto do dia atingido (${feitas}/${MAX_REPESCAGENS_POR_DIA})` })
    }

    if (dry) {
      return json({
        ok: true, acao: 'repescar', dry: true,
        faria: `apagaria ${doDia.length} lista(s) esgotada(s) e montaria a repescagem ${feitas + 1}`,
        listas_esgotadas: doDia.map(resumoDaLista),
      })
    }

    // Apaga a esgotada antes de remontar: a campanha nao acumula lista morta, e o
    // painel nao fica com duas listas do mesmo dia disputando peso.
    await faxina(base, campanha, [], false)
    sufixoRepescagem = ` — repescagem ${feitas + 1}`
    acao = 'montar' // daqui em diante e a montagem normal, so com outro nome
  }

  // ---------------------------------------------------------------- LER ----
  // GET cru na API do 3C, so leitura. Existe porque a investigacao da lista curta
  // precisa olhar cantos da API que nao tem acao propria (qualificacoes e a flag
  // `should_insert_blacklist`, por exemplo) e o threec-proxy tem allowlist fechada
  // e exige JWT de usuario.
  // Trancado no metodo GET de proposito: e ferramenta de diagnostico, nao deve
  // conseguir alterar nada no 3C nem por engano.
  if (acao === 'ler') {
    const caminho = (url.searchParams.get('path') ?? '').split('/').filter(Boolean).join('/')
    if (!caminho) return json({ error: 'passe ?path=, ex: qualification_lists' }, 400)
    const CARACTERE_OK = /[A-Za-z0-9_.?=&{}-]/
    if (![...caminho].every((c) => c === '/' || CARACTERE_OK.test(c))) {
      return json({ error: 'path invalido' }, 400)
    }
    try {
      const resp = await fetch(alvo(base, `/${caminho}`), { headers: { Accept: 'application/json' } })
      const txt = await resp.text()
      try {
        return json({ ok: resp.ok, status: resp.status, path: caminho, corpo: JSON.parse(txt) })
      } catch {
        return json({ ok: resp.ok, status: resp.status, path: caminho, corpo_texto: txt.slice(0, 4000) })
      }
    } catch (err) {
      return json({ error: 'GET falhou', detail: String(err) }, 502)
    }
  }

  // ---------------------------------------------------------------- FLAG ----
  // Liga/desliga um dos filtros de entrada da campanha.
  //
  // POR QUE EXISTE: sao esses filtros que descartam ~73% do mailing no import, em
  // silencio (200 OK com imported_lines menor). E eles NAO aparecem em lugar
  // nenhum de "Configurar Campanha" — as quatro abas foram varridas em 21/08/2026.
  // So existem no modelo da API. `PATCH /campaigns/{id}` e atualizacao PARCIAL,
  // entao mexer numa flag nao mexe no resto da campanha.
  //
  // TRAVA: so estas tres chaves, so booleano. Esta function nao vira ferramenta
  // de editar campanha — se um dia precisar mexer em outra coisa, faca no painel,
  // onde fica registrado quem mudou.
  //
  // ⚠️ `check_dnd` (Nao Me Perturbe) e registro LEGAL de telemarketing. Desligar e
  // decisao da diretoria, nao do TI. Esta aqui porque a API aceita, nao porque e
  // recomendado.
  if (acao === 'flag') {
    const FLAGS_PERMITIDAS = ['check_smart_filter', 'check_blacklist', 'check_dnd']
    const nome = (url.searchParams.get('nome') ?? '').trim()
    const valorTxt = (url.searchParams.get('valor') ?? '').trim().toLowerCase()

    if (!FLAGS_PERMITIDAS.includes(nome)) {
      return json({ error: `nome deve ser uma de: ${FLAGS_PERMITIDAS.join(', ')}` }, 400)
    }
    if (valorTxt !== 'true' && valorTxt !== 'false') {
      return json({ error: 'valor deve ser true ou false' }, 400)
    }
    const valor = valorTxt === 'true'

    const lerCampanha = async (): Promise<Record<string, unknown> | null> => {
      const r = await fetch(alvo(base, `/campaigns/${campanha}`), { headers: { Accept: 'application/json' } })
      if (!r.ok) return null
      const j = await r.json()
      return (j?.data ?? j) as Record<string, unknown>
    }

    const antes = await lerCampanha()
    if (!antes) return json({ error: 'nao consegui ler a campanha antes de mexer' }, 502)

    if (dry) {
      return json({
        ok: true, acao: 'flag', dry: true, nome,
        valor_atual: antes[nome] ?? null, valor_novo: valor,
        todas_as_flags: Object.fromEntries(FLAGS_PERMITIDAS.map((f) => [f, antes[f] ?? null])),
      })
    }

    const resp = await fetch(alvo(base, `/campaigns/${campanha}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ [nome]: valor }),
    })
    const corpo = (await resp.text()).slice(0, 600)

    // Le de novo: a resposta do PATCH pode dizer OK sem ter aplicado. So o valor
    // relido prova que mudou — mesma licao do `imported_lines`.
    const depois = await lerCampanha()
    const aplicou = depois ? depois[nome] === valor : null

    return json({
      ok: aplicou === true,
      acao: 'flag',
      nome,
      valor_antes: antes[nome] ?? null,
      valor_pedido: valor,
      valor_relido: depois ? (depois[nome] ?? null) : null,
      aplicou,
      status_do_patch: resp.status,
      corpo_do_patch: corpo,
      todas_as_flags_agora: depois
        ? Object.fromEntries(FLAGS_PERMITIDAS.map((f) => [f, depois[f] ?? null]))
        : null,
    })
  }

  // ------------------------------------------------------------- SANDBOX ----
  if (acao === 'sandbox') {
    try {
      return json({ ok: true, acao: 'sandbox', ...(await sandbox(base, campanha)) })
    } catch (err) {
      return json({ error: 'sandbox falhou', detail: String(err) }, 502)
    }
  }

  // ------------------------------------------------------------ FAXINA ----
  if (acao === 'faxina') {
    let res
    try {
      res = await faxina(base, campanha, idsManuais, dry)
    } catch (err) {
      await supabase.from('cob_3c_execucoes').insert({ acao: 'faxina', dry, ok: false, erro: String(err) })
      return json({ error: 'faxina falhou', detail: String(err) }, 502)
    }

    let limpezaBase: unknown = null
    if (!dry && cfg.limpar_base_campanha) {
      limpezaBase = await limparBaseDaCampanha(base, campanha)
    }

    if (!dry) {
      await supabase.from('cob_3c_config').update({
        lista_atual_id: null, lista_atual_nome: null, lista_atual_criada_em: null, atualizado_em: new Date().toISOString(),
      }).eq('id', 1)
    }

    await supabase.from('cob_3c_execucoes').insert({
      acao: 'faxina',
      dry,
      ok: res.falhas.length === 0,
      listas_apagadas: res.apagadas,
      erro: res.falhas.length ? res.falhas.slice(0, 3).join(' | ') : null,
      detalhe: { ...res, limpeza_base_campanha: limpezaBase },
    })

    return json({ ok: res.falhas.length === 0, acao: 'faxina', dry, ...res, limpeza_base_campanha: limpezaBase })
  }

  // ------------------------------------------------------------ MONTAR ----
  if (acao !== 'montar') return json({ error: `acao desconhecida: ${acao}` }, 400)

  const { data: fila, error: eSel } = await supabase.rpc('cob_3c_selecionar', {
    p_limite: qLimite ?? cfg.limite_por_rodada,
  })
  if (eSel) return json({ error: 'falha ao selecionar a fila', detail: eSel.message }, 500)

  const rows = (fila ?? []) as FilaRow[]
  if (rows.length === 0) {
    await supabase.from('cob_3c_execucoes').insert({
      acao: 'montar', dry, ok: true, erro: 'nenhum inadimplente na janela',
    })
    return json({ ok: true, acao: 'montar', enviados: 0, motivo: 'nenhum inadimplente na janela de recencia' })
  }

  // ⚠️⚠️ `phone` vai COM O DDD, os 11 digitos completos. NAO MEXA sem ler isto
  // inteiro — este campo ja virou tres vezes e cada virada custou um dia de
  // operacao.
  //
  // O ponto que demorou a ficar claro: os dois formatos falham, por motivos
  // OPOSTOS, e so um dos fracassos e visivel no `imported_lines`.
  //
  //   9 digitos   importa 100% e o painel diz que esta tudo bem. Mas o 3C perde o
  //               DDD e disca 55+numero: em 20/08 a lista de 329 rendeu ligacao
  //               nenhuma, todas "Falha - Destino indisponivel", telefone exibido
  //               como (55) 9XXXX-XXXX para a carteira inteira.
  //   11 digitos  disca CERTO, mas o 3C RECUSA quem ja esteve na campanha antes —
  //               a base da campanha guarda o numero mesmo depois de a lista ser
  //               apagada. Por isso a lista sai menor.
  //
  // Medido em 20/08, mesma amostra, mesmo instante — a recusa separa por tempo de
  // carteira, nao por caracteristica do numero (quem esta ha mais tempo ja foi
  // discado e ficou preso na base):
  //
  //   54999162692 (90d)   9 dig OK    11 dig RECUSADO
  //   45999911142 (90d)   9 dig OK    11 dig RECUSADO
  //   88992776992 (90d)   9 dig OK    11 dig RECUSADO
  //   49998138421 (30d)   9 dig OK    11 dig OK
  //   77999268808 (30d)   9 dig OK    11 dig OK
  //   46999750543 (30d)   9 dig OK    11 dig OK
  //
  // ESCOLHA DELIBERADA: lista menor com ligacao que COMPLETA vale mais que lista
  // cheia que nao disca. Comparativo real:
  //   18/08, 11 digitos,  89 pessoas -> 167 ligacoes, 6 conectadas com operador
  //   20/08,  9 digitos, 329 pessoas -> 0 conectadas, tudo destino indisponivel
  //
  // EM ABERTO: para a lista voltar a sair cheia e preciso limpar a base da
  // campanha. `?acao=purga` testou 13 corpos/metodos em
  // `DELETE /campaigns/{id}/mailing/delete` (20/08) e NENHUM liberou o telefone —
  // varios responderam 204 sem efeito, o resto 422. A API nao expoe isso. Os
  // caminhos que sobram: capturar o que o painel do 3C faz ao limpar o mailing
  // (F12 -> Network), ou pedir o endpoint a FluxoTI.
  //
  // ⚠️ NAO troque este campo por "a lista esta pequena". Pequena e o sintoma
  // conhecido; a alternativa e uma lista grande que nao liga para ninguem.
  // Antes de qualquer mudanca aqui: rode `?acao=sondar`.
  //
  // A LICAO QUE CUSTOU A SEMANA: `imported_lines` prova que a linha foi ACEITA,
  // NAO que o numero e DISCAVEL. Em 19/08 a sonda mediu so aceitacao (9 digitos
  // 24/24, 11 digitos 8/24) e a conclusao foi trocar o formato — o que produziu no
  // dia seguinte uma lista cheia que nao completava uma ligacao sequer. Aceitacao
  // pela API != numero que completa. Meca as DUAS coisas antes de concluir.
  //
  // ⚠️ O threec-mailing-sync (discador do SDR/comercial) manda `phone: r.telefone`,
  // COM o DDD — o formato que a sonda mediu em 33%. Se a regua do 3C for a mesma na
  // campanha dele, aquele mailing vem sendo descartado em silencio ha meses. Nao foi
  // mexido aqui de proposito: e outra campanha em producao e merece a propria sonda.
  const mailing = rows.map((r) => ({
    identifier: montarIdentifier(r.nome, r.dias_atraso),
    areacode: r.telefone.substring(0, 2),
    phone: r.telefone,
    nome: limpar(r.nome),
    email: limpar(r.email),
    formacao: limpar(r.formacao),
    dias_atraso: r.dias_atraso ?? '',
  }))

  const nomeLista = nomeListaDoDia(prefixo) + sufixoRepescagem

  if (dry) {
    return json({
      ok: true, acao: 'montar', dry: true, lista_nome: nomeLista,
      total: mailing.length, amostra: mailing.slice(0, 5),
    })
  }

  // Idempotente: rodar montar duas vezes no mesmo dia reusa a lista, nao duplica.
  let listaId: string
  let criada = false
  // Foto da campanha ANTES de montar. Sobra de lista viva (reciclagem, lista
  // manual, lista de ontem) e a suspeita numero 1 quando a lista do dia nasce
  // curta — em 18/08/2026 nao deu para provar nada porque isto nao era gravado.
  let campanhaAntes: Array<Record<string, unknown>> = []
  try {
    const todas = await listarTodasAsListas(base, campanha)
    campanhaAntes = todas.map(resumoDaLista)
    const existente = todas.find((l) => nomeDaLista(l) === nomeLista)
    if (existente) {
      listaId = String(existente.id)
    } else {
      listaId = await criarLista(base, campanha, nomeLista)
      criada = true
    }
  } catch (err) {
    await supabase.from('cob_3c_execucoes').insert({
      acao: 'montar', dry: false, ok: false, lista_nome: nomeLista, erro: String(err),
      detalhe: { campanha_antes: campanhaAntes },
    })
    return json({ error: 'falha ao criar/achar a lista do dia', detail: String(err) }, 502)
  }

  // Envia em lotes: a API recusa mais de 300 itens por POST.
  const aceitos: number[] = []
  let descartados = 0
  const falhas: string[] = []
  // Resultado de CADA POST. Sem isto uma montagem curta so diz "faltaram N", e
  // nao da para saber se a perda foi inteira num lote ou espalhada — foi
  // exatamente o que faltou para explicar os 244 descartados de 18/08/2026.
  const lotes: Array<Record<string, unknown>> = []

  for (let ini = 0; ini < mailing.length; ini += MAX_POR_POST) {
    const fatia = mailing.slice(ini, ini + MAX_POR_POST)
    const numeroDoLote = ini / MAX_POR_POST
    let resp: Response
    try {
      resp = await fetch(alvo(base, `/campaigns/${campanha}/lists/${listaId}/mailing`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ header: HEADER, mailing: fatia }),
      })
    } catch (err) {
      falhas.push(`lote ${numeroDoLote}: ${String(err)}`)
      lotes.push({ lote: numeroDoLote, enviados: fatia.length, erro: String(err) })
      continue
    }
    const corpo = await resp.text()
    if (resp.status >= 200 && resp.status < 300) {
      // 2xx NAO significa "importou tudo": `imported_lines` traz o numero real.
      let imp: number | null = null
      try {
        const j = JSON.parse(corpo)
        imp = typeof j?.imported_lines === 'number' ? j.imported_lines : null
      } catch { /* corpo nao-JSON */ }
      // Sem `imported_lines` no corpo o lote conta como aceito inteiro — otimista
      // de proposito, mas o log marca para nao virar numero de confianca falsa.
      const impDoLote = imp ?? fatia.length
      if (impDoLote < fatia.length) descartados += fatia.length - impDoLote
      lotes.push({
        lote: numeroDoLote,
        enviados: fatia.length,
        importados: impDoLote,
        descartados: fatia.length - impDoLote,
        sem_imported_lines: imp === null,
        status: resp.status,
      })
      for (let k = ini; k < ini + fatia.length; k++) aceitos.push(k)
    } else {
      falhas.push(`lote ${numeroDoLote}: HTTP ${resp.status} ${corpo.slice(0, 200)}`)
      lotes.push({
        lote: numeroDoLote,
        enviados: fatia.length,
        status: resp.status,
        corpo: corpo.slice(0, 200),
      })
    }
  }

  if (aceitos.length === 0) {
    await supabase.from('cob_3c_execucoes').insert({
      acao: 'montar', dry: false, ok: false, lista_id: listaId, lista_nome: nomeLista,
      enviados: mailing.length, erro: falhas.slice(0, 3).join(' | '),
      detalhe: { lotes, campanha_antes: campanhaAntes },
    })
    return json({ error: '3C recusou todos os lotes', detail: falhas.slice(0, 3) }, 422)
  }

  const chaves = aceitos.map((k) => rows[k].chave)
  const { data: marcados, error: eMarcar } = await supabase.rpc('cob_3c_marcar_enviados', {
    p_chaves: chaves,
    p_lista_id: listaId,
  })
  if (eMarcar) console.error('[cobranca-3c-listas] enviou mas nao marcou', eMarcar.message)

  await supabase.from('cob_3c_config').update({
    lista_atual_id: listaId,
    lista_atual_nome: nomeLista,
    lista_atual_criada_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq('id', 1)

  const importados = aceitos.length - descartados

  await supabase.from('cob_3c_execucoes').insert({
    acao: 'montar',
    dry: false,
    ok: falhas.length === 0,
    lista_id: listaId,
    lista_nome: nomeLista,
    enviados: mailing.length,
    importados,
    descartados,
    erro: falhas.length ? falhas.slice(0, 3).join(' | ') : null,
    detalhe: {
      lista_criada_agora: criada,
      marcados: marcados ?? 0,
      lotes,
      campanha_antes: campanhaAntes,
    },
  })

  return json({
    ok: falhas.length === 0,
    acao: 'montar',
    lista_id: listaId,
    lista_nome: nomeLista,
    lista_criada_agora: criada,
    enviados: mailing.length,
    importados,
    // Se isto vier alto, o 3C esta deduplicando contra a base da CAMPANHA e a
    // faxina precisa tambem limpar o mailing dela (cob_3c_config.limpar_base_campanha).
    descartados_duplicata_campanha: descartados,
    marcados: marcados ?? 0,
    falhas: falhas.slice(0, 3),
  })
}

Deno.serve(async (req) => {
  try {
    return await handler(req)
  } catch (err) {
    console.error('[cobranca-3c-listas] erro nao tratado', err)
    return json({ error: 'erro interno', detail: String(err) }, 500)
  }
})
