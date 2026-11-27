// Consultas e gravações do registro da reunião (service role). As regras estão em processar.ts.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type { Agendamento, Repo } from "./processar.ts";

// % e _ são curingas do ILIKE; e-mail com sublinhado não pode casar outro
const literal = (v: string) => v.replace(/[\\%_]/g, "\\$&");

function ou<T>({ data, error }: { data: T; error: { message: string } | null }): T {
  if (error) throw new Error(error.message);
  return data;
}

export function repoDoBanco(admin: SupabaseClient): Repo {
  return {
    agendamentosPorMeet: async (codigo) =>
      (ou(
        await admin
          .from("agendamentos")
          .select("id, empresa_id, data_agendamento")
          .ilike("link_reuniao", `%meet.google.com/${codigo}%`)
          .not("empresa_id", "is", null)
          .limit(50),
      ) ?? []) as Agendamento[],

    empresasPorEmail: async (email) => {
      const contatos = ou(
        await admin.from("leads").select("empresa_id").ilike("email", literal(email)).not("empresa_id", "is", null).limit(20),
      ) as Array<{ empresa_id: string }> | null;
      const proprias = ou(await admin.from("crm_empresas").select("id").ilike("email", literal(email)).limit(20)) as
        | Array<{ id: string }>
        | null;
      const ids = [...new Set([...(contatos ?? []).map((c) => c.empresa_id), ...(proprias ?? []).map((e) => e.id)])];
      if (!ids.length) return [];
      const ativas = ou(await admin.from("crm_empresas").select("id").in("id", ids).not("arquivado", "is", true)) as
        | Array<{ id: string }>
        | null;
      return (ativas ?? []).map((e) => e.id);
    },

    emailsDosContatos: async (empresaId) =>
      (
        (ou(
          await admin.from("leads").select("email").eq("empresa_id", empresaId).not("email", "is", null).limit(1000),
        ) as Array<{ email: string }> | null) ?? []
      ).map((l) => l.email),

    registroDaSessao: async (sessionId) =>
      ou(
        await admin
          .from("crm_empresa_atividades")
          .select("id, empresa_id, metadata")
          .eq("metadata->>read_ai_session_id", sessionId)
          .maybeSingle(),
      ) as { id: string; empresa_id: string; metadata: Record<string, unknown> } | null,

    criar: async (linha) => {
      const criada = ou(
        await admin
          .from("crm_empresa_atividades")
          .insert({ ...linha, tipo: "reuniao", user_id: null, user_nome: "Read AI" })
          .select("id")
          .single(),
      ) as { id: string };
      return criada.id;
    },

    atualizar: async (id, dados) => {
      ou(await admin.from("crm_empresa_atividades").update(dados).eq("id", id));
    },
  };
}
