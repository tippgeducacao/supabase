/** Contrato do espelho: somente propriedades administradas pelo PPGVet; notas são do José. */
export interface TarefaNotionSnapshot {
  tarefa_id: string;
  elegivel: boolean;
  titulo: string | null;
  descricao: string | null;
  prioridade: string | null;
  data_inicio: string | null;
  data_entrega: string | null;
  concluida: boolean;
  em_andamento: boolean;
  etapa: string | null;
  notion_page_id: string | null;
  fingerprint_anterior: string | null;
}

export const PROPRIEDADES_PPGVET = {
  'PPGVet ID': 'rich_text',
  PPGVet: 'url',
  'Etapa PPGVet': 'rich_text',
  'Prioridade PPGVet': 'rich_text',
  'Descrição PPGVet': 'rich_text',
  'Início PPGVet': 'date',
  'Ativa no PPGVet': 'checkbox',
} as const;

export const STATUS_NOTION = ['Não Iniciado', 'Em Progresso', 'Concluído'] as const;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mensagens estáticas: respostas do Notion/SQL podem conter títulos, descrições ou segredos. */
export class ErroSync extends Error {
  constructor(public readonly codigo: string) {
    super(codigo);
    this.name = 'ErroSync';
  }
}

export function codigoSeguro(erro: unknown): string {
  return erro instanceof ErroSync ? erro.codigo : 'falha_interna';
}

export function mesmoId(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase());
}

export function validarCorpo(valor: unknown): { integracao_id?: string } {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new ErroSync('corpo_invalido');
  const corpo = valor as Record<string, unknown>;
  if (Object.keys(corpo).some((chave) => chave !== 'integracao_id')) throw new ErroSync('corpo_invalido');
  if (corpo.integracao_id === undefined) return {};
  if (typeof corpo.integracao_id !== 'string' || !UUID.test(corpo.integracao_id)) throw new ErroSync('integracao_invalida');
  return { integracao_id: corpo.integracao_id };
}

export function textoNotion(texto: string) {
  // O limite é por objeto (2.000) E por array (100). Não truncar descrição em silêncio.
  const partes: Array<{ type: 'text'; text: { content: string } }> = [];
  let parte = '';
  for (const caractere of texto) {
    if (parte.length + caractere.length > 2_000) {
      partes.push({ type: 'text', text: { content: parte } });
      parte = '';
    }
    parte += caractere;
    if (partes.length >= 100) throw new ErroSync('texto_excede_limite_notion');
  }
  if (parte) partes.push({ type: 'text', text: { content: parte } });
  return partes;
}

function decodificarEntidades(texto: string): string {
  const entidades: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return texto.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entidade: string) => {
    if (!entidade.startsWith('#')) return entidades[entidade.toLowerCase()] ?? original;
    const hexadecimal = entidade.toLowerCase().startsWith('#x');
    const numero = Number.parseInt(entidade.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return numero > 0 && numero <= 0x10ffff && !(numero >= 0xd800 && numero <= 0xdfff)
      ? String.fromCodePoint(numero) : original;
  });
}

export function descricaoTexto(descricao: string | null): string {
  // TipTap armazena HTML. O resultado vai para rich_text, nunca para HTML executável.
  return decodificarEntidades((descricao ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_original, url: string, texto: string) => texto.includes(url) ? texto : `${texto} (${url})`)
    .replace(/<(img|video|audio)\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi,
      (_original, tipo: string, url: string) => `[${tipo}: ${url}]`)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|pre)\s*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validarData(valor: string | null): string | null {
  if (!valor) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const data = new Date(`${valor}T00:00:00Z`);
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== valor) throw new ErroSync('data_invalida');
    return valor;
  }
  // O snapshot usa timestamptz::text do Postgres: espaço e offset +00 são válidos ali.
  const normalizado = valor.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T').replace(/([+-]\d{2})$/, '$1:00');
  // Um horário sem fuso é ambíguo; não usar o fuso do servidor como se fosse do usuário.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalizado)) throw new ErroSync('data_invalida');
  validarData(normalizado.slice(0, 10));
  const data = new Date(normalizado);
  if (!Number.isFinite(data.getTime())) throw new ErroSync('data_invalida');
  return data.toISOString();
}

export function dataNotion(inicio: string | null, entrega: string | null) {
  // Data alimenta o calendário de prazos do Notion. Início tem propriedade própria:
  // existem tarefas históricas cujo prazo antecede o início, e não devemos inventar um intervalo.
  const start = validarData(entrega || inicio);
  return start ? { start, end: null } : null;
}

export function statusNotion(tarefa: Pick<TarefaNotionSnapshot, 'concluida' | 'em_andamento'>) {
  return tarefa.concluida ? 'Concluído' : tarefa.em_andamento ? 'Em Progresso' : 'Não Iniciado';
}

export function propriedadesTarefa(tarefa: TarefaNotionSnapshot, projetoId: string, departamentoId: string, baseUrl: string, tipoStatus: 'status' | 'select' = 'status') {
  if (!UUID.test(tarefa.tarefa_id) || !UUID.test(projetoId) || !UUID.test(departamentoId)) throw new ErroSync('identificador_invalido');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new ErroSync('url_sistema_invalida');
  const link = new URL(`/gestao-de-tarefas/tarefa/${tarefa.tarefa_id}`, url.origin);
  link.searchParams.set('dep', departamentoId);
  const prioridades: Record<string, string> = { urgent: 'Urgente', high: 'Alta', normal: 'Normal', low: 'Baixa' };
  return {
    Tarefa: { title: textoNotion(tarefa.titulo?.trim() || 'Tarefa sem título') },
    Projeto: { relation: [{ id: projetoId }] },
    Status: { [tipoStatus]: { name: statusNotion(tarefa) } },
    Data: { date: dataNotion(tarefa.data_inicio, tarefa.data_entrega) },
    'PPGVet ID': { rich_text: textoNotion(tarefa.tarefa_id) },
    PPGVet: { url: link.toString() },
    'Etapa PPGVet': { rich_text: textoNotion(tarefa.etapa ?? '') },
    'Prioridade PPGVet': { rich_text: textoNotion(prioridades[tarefa.prioridade ?? ''] ?? tarefa.prioridade ?? '') },
    'Descrição PPGVet': { rich_text: textoNotion(descricaoTexto(tarefa.descricao)) },
    'Início PPGVet': { date: dataNotion(tarefa.data_inicio, null) },
    'Ativa no PPGVet': { checkbox: true },
  };
}

function ordenarJson(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenarJson);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).sort(([a], [b]) => a.localeCompare(b)).map(([chave, item]) => [chave, ordenarJson(item)]));
  return valor;
}

export async function fingerprint(valor: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(ordenarJson(valor)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type PlanoTarefa =
  | { acao: 'ignorar' }
  | { acao: 'sem_alteracao' }
  | { acao: 'desvincular'; fingerprint: string }
  | { acao: 'sincronizar'; fingerprint: string; propriedades: ReturnType<typeof propriedadesTarefa> };

export async function planejarTarefa(tarefa: TarefaNotionSnapshot, projetoId: string, departamentoId: string, baseUrl: string, tipoStatus: 'status' | 'select' = 'status'): Promise<PlanoTarefa> {
  if (!tarefa.elegivel) {
    if (!tarefa.notion_page_id) return { acao: 'ignorar' };
    const hash = await fingerprint({ versao: 2, ativa: false, projetoId });
    return tarefa.fingerprint_anterior === hash ? { acao: 'sem_alteracao' } : { acao: 'desvincular', fingerprint: hash };
  }
  const propriedades = propriedadesTarefa(tarefa, projetoId, departamentoId, baseUrl, tipoStatus);
  const hash = await fingerprint({ versao: 2, propriedades });
  return tarefa.notion_page_id && tarefa.fingerprint_anterior === hash
    ? { acao: 'sem_alteracao' } : { acao: 'sincronizar', fingerprint: hash, propriedades };
}

export function manterProjetos(outros: Array<{ id: string }>, projetoId: string): Array<{ id: string }> {
  const ids = new Map(outros.map(({ id }) => [id.replaceAll('-', '').toLowerCase(), id]));
  ids.set(projetoId.replaceAll('-', '').toLowerCase(), projetoId);
  if (ids.size > 100) throw new ErroSync('relacao_excede_limite_notion');
  return Array.from(ids.values(), (id) => ({ id }));
}
