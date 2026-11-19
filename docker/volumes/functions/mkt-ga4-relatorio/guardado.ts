// Pontos fechados da curva acumulada dos testes A/B, guardados no banco (tabela mkt_ga4_teste_acumulado, migration
// 20261119171137): cada abertura da aba e o aviso das 8h só pedem ao GA4 os dias que ainda podem mudar (19/11/2026).
// Só a chave de serviço lê e grava a tabela; quem chama já passou pela porta da edge.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Guardado, LinhaGa4 } from "./ga4.ts";

const TABELA = "mkt_ga4_teste_acumulado";

export function guardadoNoBanco(db: SupabaseClient): Guardado {
  return {
    async ler({ inicio, site }, dias) {
      const { data, error } = await db.from(TABELA).select("dia, linhas").eq("inicio", inicio).eq("site", site).in("dia", dias);
      if (error) throw error;
      return new Map((data ?? []).map((r: { dia: string; linhas: LinhaGa4[] }) => [r.dia, r.linhas]));
    },
    async gravar({ inicio, site }, pontos) {
      const { error } = await db.from(TABELA).upsert([...pontos].map(([dia, linhas]) => ({ inicio, site, dia, linhas })));
      if (error) throw error;
    },
  };
}
