import { beforeAll, expect, it, vi } from "vitest";

vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: vi.fn() }));

let reconciliar: typeof import("./index.ts").reconciliarTemplatesOrfaos;

beforeAll(async () => {
  vi.stubGlobal("Deno", { env: { get: () => "teste" }, serve: vi.fn() });
  ({ reconciliarTemplatesOrfaos: reconciliar } = await import("./index.ts"));
});

it("template órfão com envio gravado vira 'enviado'; sem envio volta à fila", async () => {
  const updates: Array<{ dados: Record<string, unknown>; filtros: unknown[][] }> = [];
  const filtrosEnvio: unknown[][] = [];
  const from = (tabela: string) => {
    const filtros: unknown[][] = [];
    const data = tabela === "crm_mensagens_agendadas"
      ? [{ id: "a1", telefone: "5511999990001", processando_desde: "2030-01-01T10:00:00Z" },
        { id: "a2", telefone: "5511999990002", processando_desde: "2030-01-01T10:01:00Z" }]
      : [{ agendada: "a1", wa_message_id: "wamid.1", created_at: "2030-01-01T10:00:05Z" }];
    const q: Record<string, unknown> = {
      select: () => q, limit: () => q,
      update: (dados: Record<string, unknown>) => { updates.push({ dados, filtros }); return q; },
      then: (ok: (r: unknown) => unknown) => Promise.resolve({ data, error: null }).then(ok),
    };
    for (const m of ["eq", "neq", "lt", "gte", "in"]) {
      q[m] = (...a: unknown[]) => { filtros.push([m, ...a]); if (tabela === "crm_whatsapp_messages") filtrosEnvio.push([m, ...a]); return q; };
    }
    return q;
  };

  const erro = await reconciliar({ from } as never, "processando_desde", "2030-01-01T10:05:00Z");

  expect(erro).toBeNull();
  expect(filtrosEnvio).toContainEqual(["in", "metadata->>mensagem_agendada_id", ["a1", "a2"]]);
  expect(filtrosEnvio).toContainEqual(["gte", "created_at", "2030-01-01T10:00:00Z"]);
  expect(filtrosEnvio.find((f) => f[0] === "in" && f[1] === "telefone")?.[2]).toContain("5511999990001");
  const enviado = updates.find((u) => u.dados.status === "enviado");
  expect(enviado?.dados.wa_message_id).toBe("wamid.1");
  expect(enviado?.filtros).toContainEqual(["eq", "id", "a1"]);
  const fila = updates.find((u) => u.dados.status === "agendado");
  expect(fila?.filtros).toContainEqual(["in", "id", ["a2"]]);
});
