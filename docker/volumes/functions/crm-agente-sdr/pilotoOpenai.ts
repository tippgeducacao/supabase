import { provedorOpenai, type ProvedorIA } from './agente.ts';
import { phoneVariants } from './conta.ts';
import { modeloOpenaiPermitido } from './modelosOpenai.ts';

// Uma seleção por chamada, compartilhada por atendimento e follow-up. Nunca comparar
// só o final do telefone: outro DDD não pode herdar o piloto do Gustavo.
export async function selecionarProvedorDoLead(supabase: any, telefone: string): Promise<ProvedorIA | null> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('luna_telefones, openai_modelo_piloto, openai_raciocinio_encadeado').eq('id', 1).maybeSingle();
    if (error || !Array.isArray(data?.luna_telefones)) return null;
    const variantes = new Set(phoneVariants(telefone));
    if (!data.luna_telefones.some((t: string) => variantes.has(String(t).replace(/\D/g, '')))) return null;
    let provedor = provedorOpenai();
    if (provedor?.formato !== 'openai') return provedor;
    if (modeloOpenaiPermitido(data.openai_modelo_piloto)) provedor = { ...provedor, modelo: data.openai_modelo_piloto };
    return data.openai_raciocinio_encadeado === true
      ? { ...provedor, raciocinio: true, memoriaRaciocinio: new Map() }
      : provedor;
  } catch { return null; }
}
