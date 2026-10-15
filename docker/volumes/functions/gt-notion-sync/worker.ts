// Espelho unilateral Gestor -> Notion (15/10/2026). Somente o serviço lê o token no Vault.
// O runtime self-hosted não garante verify_jwt: autenticar aqui ANTES de carregar a conexão.
import {
  codigoSeguro, ErroSync, manterProjetos, mesmoId, planejarTarefa,
  PROPRIEDADES_PPGVET, STATUS_NOTION, UUID, validarCorpo,
  type TarefaNotionSnapshot,
} from './regras.ts';

const NOTION_VERSION = '2026-03-11';
const ORCAMENTO_MS = 45_000;
const MAX_ESCRITAS = 20;
const PAGINA_SQL = 100;
const URL_SISTEMA = 'https://sistemappgvet.ppgeducacao.site';

interface ResultadoBanco { data: unknown; error: unknown }
interface ConsultaBanco extends PromiseLike<ResultadoBanco> {
  eq(coluna: string, valor: unknown): ConsultaBanco;
  order(coluna: string, opcoes?: { ascending?: boolean; nullsFirst?: boolean }): ConsultaBanco;
}
export interface Admin {
  rpc(nome: string, argumentos: Record<string, unknown>): PromiseLike<ResultadoBanco>;
  from(tabela: string): {
    select(colunas: string): ConsultaBanco;
    upsert(dados: Record<string, unknown>, opcoes: { onConflict: string }): PromiseLike<ResultadoBanco>;
  };
}
interface Logger { warn(mensagem: string, contexto: Record<string, unknown>): void }
export interface DependenciasWorker {
  serviceRole?: string;
  supabaseUrl?: string;
  baseUrl?: string;
  criarAdmin: () => Admin;
  logger: Logger;
}

interface Integracao {
  id: string;
  departamento_id: string;
  notion_database_id: string;
  notion_projeto_id: string;
  cursor_tarefa_id: string | null;
}

interface Propriedade {
  id: string;
  type: string;
  relation?: Array<{ id: string }>;
  rich_text?: Array<{ plain_text?: string; text?: { content: string } }>;
  has_more?: boolean;
}

interface PaginaNotion {
  id: string;
  in_trash?: boolean;
  is_archived?: boolean;
  parent: { data_source_id?: string; database_id?: string };
  properties: Record<string, Propriedade>;
}

interface EsquemaNotion {
  id: string;
  in_trash?: boolean;
  parent?: { database_id?: string };
  properties: Record<string, {
    id: string;
    type: string;
    status?: { options: Array<{ name: string }> };
    select?: { options: Array<{ name: string }> };
    relation?: { data_source_id?: string; database_id?: string };
  }>;
}

interface ListaNotion<T> { results: T[]; has_more: boolean; next_cursor: string | null }
interface Contagem { lidas: number; criadas: number; atualizadas: number; desvinculadas: number; inalteradas: number; erros: number }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function aguardar(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Não registra URL, cabeçalhos, payload ou mensagem externa, nem mesmo em falhas. */
class Notion {
  private ultimaChamada = 0;
  escritas = 0;

  constructor(
    private readonly token: string,
    private readonly limite: number,
    private readonly renovarLease: () => Promise<void>,
  ) {}

  async chamar<T>(caminho: string, metodo = 'GET', corpo?: unknown, escrita = false): Promise<T> {
    if (escrita && this.escritas >= MAX_ESCRITAS) throw new ErroSync('rodada_limitada');
    const serializado = corpo === undefined ? undefined : JSON.stringify(corpo);
    if (serializado && new TextEncoder().encode(serializado).length > 480_000) throw new ErroSync('payload_excede_limite_notion');
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      if (Date.now() + 2_000 >= this.limite) throw new ErroSync('rodada_limitada');
      await aguardar(Math.max(0, 350 - (Date.now() - this.ultimaChamada)));
      // Renovar também em retry: nenhuma escrita pode continuar sob um lease que se perdeu.
      if (escrita) await this.renovarLease();
      this.ultimaChamada = Date.now();
      let resposta: Response;
      try {
        resposta = await fetch(`https://api.notion.com/v1/${caminho}`, {
          method: metodo,
          headers: { Authorization: `Bearer ${this.token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
          body: serializado,
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, this.limite - Date.now() - 1_000))),
        });
      } catch {
        // Um POST pode ter chegado ao Notion. A próxima rodada consulta PPGVet ID antes de recriar.
        throw new ErroSync('notion_rede_ou_timeout');
      }
      if (resposta.status === 429 && tentativa < 2) {
        const retryAfter = Number(resposta.headers.get('Retry-After') ?? '1');
        const espera = Number.isFinite(retryAfter) ? Math.max(350, retryAfter * 1_000) : 1_000;
        await resposta.body?.cancel();
        // Não desrespeitar Retry-After longo: retomar na próxima chamada agendada.
        if (espera > 10_000 || Date.now() + espera + 2_000 >= this.limite) throw new ErroSync('notion_limite_de_requisicoes');
        await aguardar(espera);
        continue;
      }
      if (!resposta.ok) {
        await resposta.body?.cancel();
        throw new ErroSync(`notion_http_${resposta.status}`);
      }
      if (escrita) this.escritas++;
      try { return await resposta.json() as T; } catch { throw new ErroSync('notion_resposta_invalida'); }
    }
    throw new ErroSync('notion_limite_de_requisicoes');
  }
}

async function prepararDestino(notion: Notion, integracao: Integracao): Promise<{ fonteId: string; tipoStatus: 'status' | 'select' }> {
  const database = await notion.chamar<{ data_sources: Array<{ id: string }>; in_trash?: boolean }>(`databases/${integracao.notion_database_id}`);
  if (database.in_trash || database.data_sources?.length !== 1 || !UUID.test(database.data_sources[0].id)) throw new ErroSync('base_notion_ambigua_ou_indisponivel');
  const fonteId = database.data_sources[0].id;
  const esquema = await notion.chamar<EsquemaNotion>(`data_sources/${fonteId}`);
  const projeto = await notion.chamar<PaginaNotion>(`pages/${integracao.notion_projeto_id}`);
  if (esquema.in_trash || projeto.in_trash) throw new ErroSync('destino_notion_na_lixeira');
  const esperadas = { Tarefa: 'title', Projeto: 'relation', Data: 'date' };
  for (const [nome, tipo] of Object.entries(esperadas)) {
    if (esquema.properties?.[nome]?.type !== tipo) throw new ErroSync('esquema_notion_incompativel');
  }
  const tipoStatus = esquema.properties.Status?.type;
  if (tipoStatus !== 'status' && tipoStatus !== 'select') throw new ErroSync('status_notion_incompativel');
  const opcoes = esquema.properties.Status[tipoStatus]?.options.map((opcao) => opcao.name) ?? [];
  if (STATUS_NOTION.some((status) => !opcoes.includes(status))) throw new ErroSync('status_notion_incompativel');
  const relacao = esquema.properties.Projeto.relation;
  let destinoCorreto = mesmoId(relacao?.data_source_id, projeto.parent?.data_source_id)
    || mesmoId(relacao?.database_id, projeto.parent?.database_id);
  if (!destinoCorreto && relacao?.database_id && projeto.parent?.data_source_id) {
    const fonteProjeto = await notion.chamar<EsquemaNotion>(`data_sources/${projeto.parent.data_source_id}`);
    destinoCorreto = mesmoId(relacao.database_id, fonteProjeto.parent?.database_id);
  }
  if (!destinoCorreto) throw new ErroSync('relacao_projeto_incompativel');

  const adicionar: Record<string, unknown> = {};
  for (const [nome, tipo] of Object.entries(PROPRIEDADES_PPGVET)) {
    const atual = esquema.properties[nome];
    if (atual && atual.type !== tipo) throw new ErroSync('propriedade_ppgvet_incompativel');
    if (!atual) adicionar[nome] = { [tipo]: {} };
  }
  if (Object.keys(adicionar).length) await notion.chamar(`data_sources/${fonteId}`, 'PATCH', { properties: adicionar }, true);
  return { fonteId, tipoStatus };
}

function validarPagina(pagina: PaginaNotion, tarefaId: string, fonteId: string, databaseId: string) {
  const mesmaBase = pagina.parent?.data_source_id
    ? mesmoId(pagina.parent.data_source_id, fonteId) : mesmoId(pagina.parent?.database_id, databaseId);
  const origem = pagina.properties?.['PPGVet ID'];
  const valor = origem?.rich_text?.map((item) => item.plain_text ?? item.text?.content ?? '').join('');
  if (!UUID.test(pagina.id) || !mesmaBase || origem?.type !== 'rich_text' || !mesmoId(valor, tarefaId)) throw new ErroSync('pagina_notion_vinculo_incompativel');
}

async function projetosAtuais(notion: Notion, pagina: PaginaNotion): Promise<Array<{ id: string }>> {
  const propriedade = pagina.properties.Projeto;
  if (propriedade?.type !== 'relation' || !propriedade.relation) throw new ErroSync('relacao_projeto_incompativel');
  if (!propriedade.has_more) return propriedade.relation;
  // GET page corta relations em 25 itens. Ler a propriedade paginada antes de preservar todos.
  const projetos: Array<{ id: string }> = [];
  let cursor: string | null = null;
  do {
    const parametros = new URLSearchParams({ page_size: '100' });
    if (cursor) parametros.set('start_cursor', cursor);
    const parte = await notion.chamar<ListaNotion<{ relation: { id: string } }>>(
      `pages/${pagina.id}/properties/${encodeURIComponent(decodeURIComponent(propriedade.id))}?${parametros}`,
    );
    if (!Array.isArray(parte.results)) throw new ErroSync('notion_resposta_invalida');
    projetos.push(...parte.results.map((item) => item.relation));
    if (projetos.length > 100) throw new ErroSync('relacao_excede_limite_notion');
    if (parte.has_more && (!parte.next_cursor || parte.next_cursor === cursor)) throw new ErroSync('notion_paginacao_invalida');
    cursor = parte.has_more ? parte.next_cursor : null;
  } while (cursor);
  return projetos;
}

async function encontrarPagina(notion: Notion, fonteId: string, tarefaId: string): Promise<PaginaNotion | null> {
  const paginas: PaginaNotion[] = [];
  // A partição arquivada também precisa ser consultada após uma criação sem confirmação SQL.
  // Nunca recriar automaticamente uma página que o usuário arquivou entre a falha e o retry.
  for (const arquivada of [false, true]) {
    const resposta = await notion.chamar<ListaNotion<PaginaNotion>>(`data_sources/${fonteId}/query`, 'POST', {
      filter: { property: 'PPGVet ID', rich_text: { equals: tarefaId } }, page_size: 2, is_archived: arquivada,
    });
    if (!Array.isArray(resposta.results)) throw new ErroSync('notion_resposta_invalida');
    paginas.push(...resposta.results);
    if (resposta.has_more || paginas.length > 1) throw new ErroSync('ppgvet_id_duplicado_no_notion');
  }
  return paginas[0] ?? null;
}

async function sincronizarIntegracao(admin: Admin, integracao: Integracao, limite: number, logger: Logger, baseUrl: string) {
  const contagem: Contagem = { lidas: 0, criadas: 0, atualizadas: 0, desvinculadas: 0, inalteradas: 0, erros: 0 };
  const falhas = new Set<string>();
  let parcial = false;
  const claim = await admin.rpc('gt_notion_claim', { p_integracao_id: integracao.id });
  if (claim.error) throw new ErroSync('banco_claim_falhou');
  if (!claim.data) return { integracao_id: integracao.id, ocupada: true, ...contagem };
  const leaseToken = String(claim.data);
  let erroRodada: string | null = null;
  try {
    const renovarLease = async () => {
      const resultado = await admin.rpc('gt_notion_renovar_lease', { p_integracao_id: integracao.id, p_lease_token: leaseToken });
      if (resultado.error || resultado.data !== true) throw new ErroSync('lease_perdido');
    };
    const segredo = await admin.rpc('gt_notion_obter_token', { p_integracao_id: integracao.id });
    if (segredo.error || typeof segredo.data !== 'string' || !segredo.data.trim()) throw new ErroSync('token_notion_nao_configurado');
    const notion = new Notion(segredo.data, limite, renovarLease);
    const { fonteId, tipoStatus } = await prepararDestino(notion, integracao);
    let apos: string | null = integracao.cursor_tarefa_id;
    const salvarCursor = async (cursor: string | null) => {
      const resultado = await admin.rpc('gt_notion_salvar_cursor', { p_integracao_id: integracao.id, p_lease_token: leaseToken, p_cursor: cursor });
      if (resultado.error || resultado.data !== true) throw new ErroSync('banco_cursor_falhou');
    };
    let continuar = true;
    while (continuar) {
      if (Date.now() + 2_000 >= limite || notion.escritas >= MAX_ESCRITAS) { parcial = true; break; }
      const snapshot = await admin.rpc('gt_notion_snapshot', { p_integracao_id: integracao.id, p_apos: apos, p_limite: PAGINA_SQL });
      if (snapshot.error || !Array.isArray(snapshot.data)) throw new ErroSync('banco_snapshot_falhou');
      const tarefas = snapshot.data as TarefaNotionSnapshot[];
      if (!tarefas.length) break;
      for (const tarefa of tarefas) {
        if (Date.now() + 2_000 >= limite || notion.escritas >= MAX_ESCRITAS) { parcial = true; continuar = false; break; }
        apos = tarefa.tarefa_id;
        contagem.lidas++;
        try {
          const plano = await planejarTarefa(tarefa, integracao.notion_projeto_id, integracao.departamento_id, baseUrl, tipoStatus);
          if (plano.acao === 'ignorar' || plano.acao === 'sem_alteracao') { contagem.inalteradas++; continue; }
          // Fingerprint igual nunca consulta a página: o lote inicial avança até as últimas tarefas.
          let pagina = tarefa.notion_page_id
            ? await notion.chamar<PaginaNotion>(`pages/${tarefa.notion_page_id}`)
            : await encontrarPagina(notion, fonteId, tarefa.tarefa_id);
          if (pagina) {
            validarPagina(pagina, tarefa.tarefa_id, fonteId, integracao.notion_database_id);
            if (pagina.in_trash) throw new ErroSync('pagina_notion_na_lixeira');
            if (pagina.is_archived) throw new ErroSync('pagina_notion_arquivada');
          }
          if (plano.acao === 'desvincular') {
            // Sair do escopo não é apagar notas: retirar somente Trabalho e marcar a origem inativa.
            // O vínculo permanece e permite reutilizar a página quando a tarefa voltar ao José.
            if (!pagina) throw new ErroSync('pagina_notion_vinculada_indisponivel');
            const projetos = (await projetosAtuais(notion, pagina)).filter(({ id }) => !mesmoId(id, integracao.notion_projeto_id));
            await notion.chamar(`pages/${pagina.id}`, 'PATCH', {
              properties: { 'Ativa no PPGVet': { checkbox: false }, Projeto: { relation: projetos } },
            }, true);
            contagem.desvinculadas++;
          } else if (plano.acao === 'sincronizar') {
            if (pagina) {
              const projetos = manterProjetos(await projetosAtuais(notion, pagina), integracao.notion_projeto_id);
              // Não enviar children, markdown, template, erase_content, ícone ou capa.
              await notion.chamar(`pages/${pagina.id}`, 'PATCH', {
                properties: { ...plano.propriedades, Projeto: { relation: projetos } },
              }, true);
              contagem.atualizadas++;
            } else {
              pagina = await notion.chamar<PaginaNotion>('pages', 'POST', {
                parent: { type: 'data_source_id', data_source_id: fonteId }, properties: plano.propriedades,
              }, true);
              if (!UUID.test(pagina.id)) throw new ErroSync('notion_resposta_invalida');
              contagem.criadas++;
            }
          }
          // O vínculo só confirma o fingerprint após sucesso remoto. Falha SQL é recuperável pelo ID.
          await renovarLease();
          const gravacao = await admin.from('gt_notion_vinculos').upsert({
            integracao_id: integracao.id, tarefa_id: tarefa.tarefa_id,
            notion_page_id: pagina!.id, fingerprint: plano.fingerprint,
            atualizado_em: new Date().toISOString(),
          }, { onConflict: 'integracao_id,tarefa_id' });
          if (gravacao.error) throw new ErroSync('banco_vinculo_falhou');
        } catch (erro) {
          const codigo = codigoSeguro(erro);
          if (codigo === 'rodada_limitada') { parcial = true; continuar = false; break; }
          // Lease perdido invalida a rodada inteira; falha individual não prende o restante da fila.
          if (codigo === 'lease_perdido') throw erro;
          contagem.erros++;
          falhas.add(codigo);
          logger.warn('Tarefa não sincronizada', { integracao_id: integracao.id, tarefa_id: tarefa.tarefa_id, codigo });
        }
        // Persistir também falhas: quatro timeouts iniciais não podem prender todas as demais tarefas.
        await salvarCursor(apos);
      }
      if (tarefas.length < PAGINA_SQL) break;
    }
    await salvarCursor(parcial ? apos : null);
    erroRodada = falhas.size ? Array.from(falhas).join(',') : null;
    return { integracao_id: integracao.id, parcial, ...contagem, falhas: Array.from(falhas) };
  } catch (erro) {
    erroRodada = codigoSeguro(erro);
    throw erro;
  } finally {
    const liberacao = await admin.rpc('gt_notion_release', { p_integracao_id: integracao.id, p_lease_token: leaseToken, p_erro: erroRodada });
    if (liberacao.error) logger.warn('Não foi possível liberar a rodada; o lease expira sozinho', { codigo: 'banco_release_falhou' });
  }
}

export function criarHandler({ serviceRole, supabaseUrl, criarAdmin, logger, baseUrl = URL_SISTEMA }: DependenciasWorker) {
return async (req: Request) => {
  if (req.method !== 'POST') return json({ erro: 'metodo_nao_permitido' }, 405);
  if (!serviceRole || !supabaseUrl) return json({ erro: 'servico_nao_configurado' }, 503);
  const inicio = Date.now();
  const admin = criarAdmin();
  try {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (bearer !== serviceRole) {
      const segredoCron = req.headers.get('x-gt-notion-cron-secret');
      if (!segredoCron || segredoCron.length > 512) return json({ erro: 'nao_autorizado' }, 401);
      const validacao = await admin.rpc('gt_notion_validar_cron', { p_segredo: segredoCron });
      if (validacao.error || validacao.data !== true) return json({ erro: 'nao_autorizado' }, 401);
    }
    if (Number(req.headers.get('content-length') ?? 0) > 1_024) return json({ erro: 'corpo_invalido' }, 400);
    const texto = await req.text();
    if (texto.length > 1_024) return json({ erro: 'corpo_invalido' }, 400);
    let corpo: { integracao_id?: string };
    try { corpo = validarCorpo(texto.trim() ? JSON.parse(texto) : {}); }
    catch { return json({ erro: 'corpo_invalido' }, 400); }

    let consulta = admin.from('gt_notion_integracoes').select('id,departamento_id,notion_database_id,notion_projeto_id,cursor_tarefa_id').eq('ativo', true)
      .order('ultima_execucao', { ascending: true, nullsFirst: true });
    if (corpo.integracao_id) consulta = consulta.eq('id', corpo.integracao_id);
    const configuracoes = await consulta;
    if (configuracoes.error || !Array.isArray(configuracoes.data)) throw new ErroSync('banco_integracoes_falhou');
    const resultados: Array<Record<string, unknown>> = [];
    let parcial = false;
    for (const integracao of (configuracoes.data ?? []) as Integracao[]) {
      if (Date.now() + 5_000 >= inicio + ORCAMENTO_MS) { parcial = true; break; }
      try {
        resultados.push(await sincronizarIntegracao(admin, integracao, inicio + ORCAMENTO_MS - 3_000, logger, baseUrl));
      } catch (erro) {
        const codigo = codigoSeguro(erro);
        logger.warn('Rodada da integração interrompida', { integracao_id: integracao.id, codigo });
        resultados.push({ integracao_id: integracao.id, erro: codigo });
      }
    }
    const ok = resultados.every((resultado) => !resultado.erro && !(typeof resultado.erros === 'number' && resultado.erros > 0));
    return json({ ok, parcial: parcial || resultados.some((resultado) => resultado.parcial === true), resultados });
  } catch (erro) {
    const codigo = codigoSeguro(erro);
    logger.warn('Sincronização interrompida', { codigo });
    return json({ ok: false, erro: codigo }, 500);
  }
};
}
