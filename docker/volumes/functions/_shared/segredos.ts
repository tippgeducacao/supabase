// Leitura de segredo de app pela edge, em cascata, do mais seguro para o legado.
//
// ⚠️ A ORDEM IMPORTA e não é estética:
//   1) `app_secrets`        — tabela service-role-only. É onde segredo novo deve nascer.
//   2) env do edge-runtime  — serve, mas trocar env no Dokploy pede redeploy do serviço, e
//                             redeploy do stack do Supabase APAGA edge function (regra 2).
//   3) `ped_configuracoes`  — LEGADO, e inseguro: a tabela tem policy de leitura
//                             `USING(true)`, então qualquer pessoa logada lê o segredo.
//                             Fica na cascata só para não quebrar o que já dependia dela.
//
// Quem adicionar credencial nova: use (1). O passo (3) existe para ser esvaziado, não copiado.
import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Supa = ReturnType<typeof createClient>;

export async function getSegredo(supabase: Supa, chave: string): Promise<string | null> {
  try {
    const { data } = await supabase.from("app_secrets").select("valor").eq("chave", chave).maybeSingle();
    const v = (data?.valor as string) || "";
    if (v) return v;
  } catch { /* tabela ainda não existe neste ambiente */ }

  const env = Deno.env.get(chave);
  if (env) return env;

  try {
    const { data } = await supabase.from("ped_configuracoes").select("valor").eq("chave", chave).maybeSingle();
    const v = (data?.valor as string) || "";
    if (v) {
      console.warn(`[segredos] "${chave}" veio de ped_configuracoes (legado, leitura aberta). Mova para app_secrets.`);
      return v;
    }
  } catch { /* idem */ }

  return null;
}
