// 10/09/2026: a promessa de tentar depois precisa sobreviver ao isolate do SDR.
// Usa a fila de mensagens já existente, com autoria explícita e cancelável no CRM.
// Só documentos com recusa confirmada entram; timeout/5xx não autorizam duplicação.
import type { ResultadoMaterial } from './resultadoEnvioMaterial.ts';

export const AUTOR_REENVIO_MATERIAL = 'IA SDR — reenvio de cronograma';
export const INTERVALO_REENVIO_MS = 30 * 60_000;
export const LIMITE_REENVIO_MS = 60 * 60_000;

type RespostaBanco = { data: Record<string, unknown> | null; error: unknown };
type Consulta = PromiseLike<RespostaBanco> & {
  eq(coluna: string, valor: unknown): Consulta;
  in(coluna: string, valores: string[]): Consulta;
  select(colunas: string): Consulta;
  maybeSingle(): Promise<RespostaBanco>;
};
export type BancoReenvio = { from(tabela: string): {
  insert(linha: Record<string, unknown>): Consulta;
  update(linha: Record<string, unknown>): Consulta;
  select(colunas: string): Consulta;
} };
export type DocumentoReenvio = {
  telefone: string; wa_account_id: string | null; anexo_url: string;
  filename?: string; lead_id?: string | null; oportunidade_id?: string | null;
};

export function podeReagendarMaterial(resultado: ResultadoMaterial): boolean {
  // Recusas permanentes não melhoram ao repetir; a conversa continua mesmo assim.
  return resultado.cronograma_status === 'falhou'
    && ['1', '2', '130429', '131000', '131016']
      .includes(resultado.cronograma_codigo ?? '');
}

export async function cancelarReenvioMaterial(banco: BancoReenvio, documento: DocumentoReenvio): Promise<void> {
  if (!documento.wa_account_id) return;
  const { error } = await banco.from('crm_mensagens_agendadas')
    .update({ status: 'cancelado', erro_detalhe: 'Substituído por novo pedido do cronograma.' })
    .eq('criado_por_nome', AUTOR_REENVIO_MATERIAL).eq('status', 'agendado')
    .eq('wa_account_id', documento.wa_account_id).eq('telefone', documento.telefone)
    .eq('anexo_url', documento.anexo_url);
  if (error) throw new Error('Não foi possível cancelar a tentativa anterior do cronograma.');
}

export async function agendarReenvioMaterial(banco: BancoReenvio, documento: DocumentoReenvio,
  resultado: ResultadoMaterial, agora = Date.now()): Promise<ResultadoMaterial> {
  if (!documento.wa_account_id || !podeReagendarMaterial(resultado)) return resultado;
  const enviarEm = new Date(agora + INTERVALO_REENVIO_MS).toISOString();
  try {
    const { data, error } = await banco.from('crm_mensagens_agendadas').insert({
      ...documento, tipo_mensagem: 'midia', mime_type: 'application/pdf',
      criado_por_nome: AUTOR_REENVIO_MATERIAL, status: 'agendado', enviar_em: enviarEm,
    }).select('id').maybeSingle();
    if (error || typeof data?.id !== 'string' || !data.id.trim()) return resultado;
    return { ...resultado, reenvio_agendado_id: data.id, reenvio_em: enviarEm };
  } catch { return resultado; }
}

// Repetições são limitadas a uma hora e param diante de resultado desconhecido.
// Após um aceite, receipts continuam sendo lidos pelo SDR; não repetimos às cegas.
export function proximaTentativaMaterial(resultado: ResultadoMaterial, criadoEm: string, agora = Date.now()): string | null {
  const inicio = Date.parse(criadoEm);
  if (!Number.isFinite(inicio) || agora + INTERVALO_REENVIO_MS > inicio + LIMITE_REENVIO_MS
    || !podeReagendarMaterial(resultado)) return null;
  return new Date(agora + INTERVALO_REENVIO_MS).toISOString();
}
