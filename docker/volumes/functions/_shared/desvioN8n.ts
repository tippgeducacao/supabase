// Desvio de telefones de TESTE para o agente SDR no n8n (29/09/2026, projeto "Luna no n8n").
// Uma fonte só (tabela crm_sdr_n8n) para os dois lados:
//  · crm-whatsapp-webhook → manda o inbound desses telefones para o n8n, com o segredo no cabeçalho;
//  · crm-agente-sdr       → ignora esses telefones (a reconciliação de órfãos o chamaria e o lead
//                           receberia duas IAs).
// Cache de 60 s: é o caminho mais quente do sistema (toda mensagem recebida passa aqui).

export const CABECALHO_SEGREDO_N8N = 'x-ppg-sdr-segredo';

export type DesvioN8n = { ativo: boolean; url: string; segredo: string; telefones: string[] };
type Cliente = { from: (t: string) => any };

const TTL_MS = 60_000;
let cache: { em: number; valor: DesvioN8n | null } | null = null;

/** Dígitos BR com o 9º dígito (mesma regra do gateway): "554688166051" → "5546988166051". */
export function telefoneCanonico(bruto: unknown): string {
  let d = String(bruto ?? '').split('@')[0].replace(/\D/g, '');
  if (d.startsWith('55')) d = d.slice(2);
  if (d.length === 10 && ['6', '7', '8', '9'].includes(d[2])) d = d.slice(0, 2) + '9' + d.slice(2);
  return d ? `55${d}` : '';
}

/** Lê a configuração (com cache). Falha de leitura = sem desvio (o lead segue no agente de sempre). */
export async function carregarDesvioN8n(cliente: Cliente, agora = Date.now()): Promise<DesvioN8n | null> {
  if (cache && agora - cache.em < TTL_MS) return cache.valor;
  try {
    const { data, error } = await cliente.from('crm_sdr_n8n').select('ativo, entrada_url, segredo, telefones').eq('id', true).maybeSingle();
    if (error) throw new Error(error.message);
    const valor: DesvioN8n | null = data ? {
      ativo: data.ativo === true, url: String(data.entrada_url ?? ''), segredo: String(data.segredo ?? ''),
      telefones: Array.isArray(data.telefones) ? data.telefones.map(String) : [],
    } : null;
    cache = { em: agora, valor };
    return valor;
  } catch (e) {
    console.log('[desvioN8n] leitura falhou, sem desvio:', e instanceof Error ? e.message : String(e));
    return cache?.valor ?? null;
  }
}

/** O telefone vai para o n8n? Só com desvio ligado, URL e segredo preenchidos e o número na lista. */
export function vaiParaN8n(cfg: DesvioN8n | null, telefoneOuJid: unknown): boolean {
  if (!cfg?.ativo || !cfg.url || !cfg.segredo) return false;
  const alvo = telefoneCanonico(telefoneOuJid);
  return Boolean(alvo) && cfg.telefones.some((t) => telefoneCanonico(t) === alvo);
}

/** Só para teste: zera o cache. */
export function _limparCacheDesvioN8n(): void { cache = null; }
