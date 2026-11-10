/**
 * Link temporário de um arquivo da Biblioteca Didática (10/11/2026).
 *
 * A biblioteca (projeto Lovable, outro sistema) guarda em `manual_materials.external_url` o
 * link PÚBLICO do nosso storage e entrega o arquivo ao aluno pelo próprio domínio
 * (`/api/public/material-externo/<id>`). Desde 30/10/2026 o bucket `gt-doc-assets` é privado e
 * o link público redireciona para `/arquivo-privado` (a entrada do sistema). A biblioteca passou
 * a entregar essa página no lugar do PDF: 875 materiais sem abrir para o aluno, que via
 * "Falha ao carregar documento PDF".
 *
 * Aqui a biblioteca troca o link público por um link ASSINADO de 1 hora, com o host público.
 * Só sai link de arquivo que foi mandado à biblioteca (regra em `_shared/bibliotecaArquivo.ts`):
 *   - `pedagogico-biblioteca/...`: cargas do Drive feitas para ela;
 *   - `pedagogico-aulas/...` com anexo COM `biblioteca_tag` em `ped_aula_anexos` (o que a fila
 *     entrega). Anexo sem tag (lista de presença, transcrição) não sai.
 * O bucket continua privado. Esta edge não lista, não grava e não apaga nada.
 *
 * Quem chama: a biblioteca, com o MESMO segredo da ingestão (`ped_biblioteca_config.ingest_secret`,
 * `PPGVET_INGEST_SECRET` do lado de lá) no cabeçalho `x-biblioteca-segredo`; ou a chave de
 * serviço, para conferência nossa.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3'
import { corsHeaders } from '../_shared/cors.ts'
import { exigirAcesso, respostaAcessoNegado } from '../_shared/acesso.ts'
import { assinarObjeto, MidiaInvalida, objetoDoStorage, paraHostPublico, type ObjetoPrivado } from '../_shared/midiaRecebida.ts'
import { BUCKET_BIBLIOTECA, origemDoArquivo } from '../_shared/bibliotecaArquivo.ts'

/** A biblioteca guarda o link e o reaproveita até perto de vencer. */
const VALIDADE_S = 60 * 60

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ erro: 'Use POST.' }, 405)

  // O segredo mora no banco, junto do endereço da ingestão (nunca em env: ver biblioteca-sync).
  // Ler a config é o que permite conferir quem chama; nada mais é lido antes da conferência.
  const { data: config } = await supabase
    .from('ped_biblioteca_config')
    .select('ingest_secret')
    .maybeSingle()

  try {
    await exigirAcesso(req, {
      servico: true,
      segredo: { cabecalho: 'x-biblioteca-segredo', valor: config?.ingest_secret ?? '' },
    })
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders)
  }

  let url = ''
  try {
    const corpo = await req.json()
    url = typeof corpo?.url === 'string' ? corpo.url.trim() : ''
  } catch {
    return json({ erro: 'Corpo inválido: envie JSON com "url".' }, 400)
  }

  let objeto: ObjetoPrivado | null
  try {
    objeto = objetoDoStorage(url)
  } catch (e) {
    if (e instanceof MidiaInvalida) return json({ erro: 'Endereço não permitido.' }, 400)
    throw e
  }
  if (!objeto) return json({ erro: 'Endereço não permitido.' }, 400)

  const origem = origemDoArquivo(objeto.bucket, objeto.caminho)
  if (origem === null) return json({ erro: 'Arquivo fora da Biblioteca Didática.' }, 403)

  if (origem === 'anexo') {
    const { data, error } = await supabase
      .from('ped_aula_anexos')
      .select('id')
      .eq('storage_path', objeto.caminho)
      .not('biblioteca_tag', 'is', null)
      .limit(1)
    if (error) {
      console.error('[biblioteca-arquivo] falha ao conferir o anexo', error)
      return json({ erro: 'Não foi possível conferir o arquivo.' }, 503)
    }
    if (!data?.length) return json({ erro: 'Arquivo fora da Biblioteca Didática.' }, 403)
  }

  try {
    const assinado = await assinarObjeto(BUCKET_BIBLIOTECA, objeto.caminho, VALIDADE_S, {
      base: SUPABASE_URL,
      chave: SERVICE_ROLE_KEY,
    })
    // O link sai com o host INTERNO (kong:8000); a biblioteca está fora da nossa rede.
    return json({
      url: paraHostPublico(assinado),
      expira_em: new Date(Date.now() + VALIDADE_S * 1000).toISOString(),
    })
  } catch (e) {
    console.error('[biblioteca-arquivo] falha ao assinar', e)
    return json({ erro: 'Não foi possível gerar o link do arquivo.' }, 502)
  }
})
