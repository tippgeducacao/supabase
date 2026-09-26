import { provedorOpenai, type ProvedorIA } from './agente.ts';
import { phoneVariants } from './conta.ts';
import { modeloOpenaiPermitido } from './modelosOpenai.ts';

/**
 * Balde estável 0–99 do lead, para ligar a Luna numa fatia (`luna_percentual`, 26/09/2026).
 * Pelos 8 últimos dígitos: o 9º dígito e o DDI não mudam o balde, então atendimento e follow-up
 * do mesmo lead caem sempre no mesmo lado — e o grupo de controle é recalculável depois, só com
 * o telefone, para comparar Luna × Claude.
 */
export function baldeDoLead(telefone: string): number {
  const d = String(telefone ?? '').replace(/\D/g, '').slice(-8);
  let h = 0x811c9dc5; // FNV-1a 32 bits
  for (const c of d) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

// Uma seleção por chamada, compartilhada por atendimento e follow-up. Nunca comparar
// só o final do telefone na LISTA: outro DDD não pode herdar o piloto do Gustavo.
// Percentual: 0 (padrão) = ninguém além da lista; 10 = ~10% dos leads, sempre os mesmos.
export async function selecionarProvedorDoLead(supabase: any, telefone: string): Promise<ProvedorIA | null> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('luna_telefones, luna_percentual, openai_modelo_piloto, openai_raciocinio_encadeado').eq('id', 1).maybeSingle();
    if (error || !data) return null;
    const variantes = new Set(phoneVariants(telefone));
    const lista: unknown[] = Array.isArray(data.luna_telefones) ? data.luna_telefones : [];
    const naLista = lista.some((t) => variantes.has(String(t).replace(/\D/g, '')));
    const percentual = Number(data.luna_percentual);
    const noPercentual = !naLista && Number.isInteger(percentual) && percentual > 0 && percentual <= 100
      && String(telefone ?? '').replace(/\D/g, '').length >= 8 && baldeDoLead(telefone) < percentual;
    if (!naLista && !noPercentual) return null;
    let provedor = provedorOpenai();
    if (provedor?.formato !== 'openai') return provedor;
    provedor = { ...provedor, origem: naLista ? 'lista' : 'percentual' };
    if (modeloOpenaiPermitido(data.openai_modelo_piloto)) provedor = { ...provedor, modelo: data.openai_modelo_piloto };
    return data.openai_raciocinio_encadeado === true
      ? { ...provedor, raciocinio: true, memoriaRaciocinio: new Map() }
      : provedor;
  } catch { return null; }
}
