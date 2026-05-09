// Helper compartilhado para carregar e formatar contexto de marca em prompts de IA.
// Fase 1 da refatoração multi-marca: fonte única de verdade para como o
// brand_profile vira contexto de prompt em todas as edge functions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export interface BrandProfile {
  id: string;
  account_name?: string | null;
  brand_name?: string | null;
  segmento?: string | null;
  tom_de_voz?: string | null;
  tom_descricao?: string | null;
  vocabulario_chave?: string | null;
  metaforas_estrategicas?: string | null;
  estrutura_visual?: string | null;
  alertas_nao_usar?: string | null;
  frases_exemplo?: string | null;
  persona_dores?: string | null;
  persona_objecoes?: string | null;
  persona_desejos?: string | null;
  persona_perfil_demografico?: string | null;
  publico_alvo?: string | null;
  termos_proibidos?: string[] | null;
  termos_obrigatorios?: string[] | null;
  regras_estilo?: string[] | null;
}

type SupabaseClientLike = ReturnType<typeof createClient>;

export async function loadBrandProfile(
  supabase: SupabaseClientLike,
  brand_profile_id: string | null | undefined,
): Promise<BrandProfile | null> {
  if (!brand_profile_id) return null;
  const { data } = await supabase
    .from("brand_profiles")
    .select("*")
    .eq("id", brand_profile_id)
    .maybeSingle();
  return (data as BrandProfile) ?? null;
}

export function buildBrandContext(bp: BrandProfile | null | undefined): string {
  if (!bp) return "";
  const lines: string[] = [];
  lines.push(`MARCA: ${bp.brand_name || bp.account_name || ""}`);
  if (bp.segmento) lines.push(`SEGMENTO: ${bp.segmento}`);
  if (bp.tom_de_voz) lines.push(`TOM DE VOZ: ${bp.tom_de_voz}`);
  if (bp.tom_descricao) lines.push(`DESCRIÇÃO DO TOM: ${bp.tom_descricao}`);
  if (bp.publico_alvo) lines.push(`PÚBLICO-ALVO: ${bp.publico_alvo}`);
  if (bp.persona_perfil_demografico)
    lines.push(`PERFIL DEMOGRÁFICO: ${bp.persona_perfil_demografico}`);
  if (bp.persona_dores) lines.push(`DORES DA PERSONA: ${bp.persona_dores}`);
  if (bp.persona_desejos) lines.push(`DESEJOS DA PERSONA: ${bp.persona_desejos}`);
  if (bp.persona_objecoes) lines.push(`OBJEÇÕES DA PERSONA: ${bp.persona_objecoes}`);
  if (bp.vocabulario_chave) lines.push(`VOCABULÁRIO-CHAVE: ${bp.vocabulario_chave}`);
  if (bp.metaforas_estrategicas)
    lines.push(`METÁFORAS ESTRATÉGICAS: ${bp.metaforas_estrategicas}`);
  if (bp.frases_exemplo) lines.push(`FRASES EXEMPLO: ${bp.frases_exemplo}`);
  if (bp.alertas_nao_usar) lines.push(`ALERTAS - NÃO USAR: ${bp.alertas_nao_usar}`);
  if (Array.isArray(bp.termos_proibidos) && bp.termos_proibidos.length)
    lines.push(`TERMOS PROIBIDOS: ${bp.termos_proibidos.join(", ")}`);
  if (Array.isArray(bp.termos_obrigatorios) && bp.termos_obrigatorios.length)
    lines.push(`TERMOS OBRIGATÓRIOS: ${bp.termos_obrigatorios.join(", ")}`);
  if (Array.isArray(bp.regras_estilo) && bp.regras_estilo.length)
    lines.push(`REGRAS DE ESTILO:\n- ${bp.regras_estilo.join("\n- ")}`);
  return lines.join("\n");
}
