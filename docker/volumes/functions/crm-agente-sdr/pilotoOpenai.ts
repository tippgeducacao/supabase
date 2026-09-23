import { provedorOpenai, type ProvedorIA } from './agente.ts';
import { phoneVariants } from './conta.ts';

// Uma seleção por chamada, compartilhada por atendimento e follow-up. Nunca comparar
// só o final do telefone: outro DDD não pode herdar o piloto do Gustavo.
export async function selecionarProvedorDoLead(supabase: any, telefone: string): Promise<ProvedorIA | null> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('luna_telefones').eq('id', 1).maybeSingle();
    if (error || !Array.isArray(data?.luna_telefones)) return null;
    const variantes = new Set(phoneVariants(telefone));
    return data.luna_telefones.some((t: string) => variantes.has(String(t).replace(/\D/g, ''))) ? provedorOpenai() : null;
  } catch { return null; }
}
