import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Entrypoint REAL da edge com banco falso: a inscrição do edital traz o card da pré-inscrição.
const cliente = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: () => cliente }));
let atender: (req: Request) => Promise<Response>;
let gravacoes: Record<string, Array<Record<string, unknown>>>;
let filtrosCard: Array<Record<string, unknown>>;
let cardAnterior: Record<string, unknown> | null;
let integracao: Record<string, unknown>;

const FUNIL = "10ffe911-792a-4ed0-bf5c-39232c268117";
const PRE = "828ab123-35fc-4bd6-accb-2d39455d0744";
const EDITAL = "0f8044a0-5d1e-497d-b9cf-4515b6b93b5b";
const AREA = "33071817-22fc-4852-99db-f36f5d7b56ed";
const ORDEM: Record<string, number> = { [PRE]: 0, [EDITAL]: 1, [AREA]: 9 };

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: () => "valor-sintetico" },
    serve: (handler: typeof atender) => { atender = handler; },
  });
  await import("./index.ts");
});

beforeEach(() => {
  vi.clearAllMocks();
  gravacoes = {};
  filtrosCard = [];
  cardAnterior = null;
  integracao = {
    id: "integracao-edital", slug: "teste", nome: "Edital sintético", secret: "segredo-sintetico", ativa: true,
    field_mapping: { nome: "lead.nome", email: "lead.email" },
    config: { semearAgente: false, acoes: { itens: [{ id: "acao-card", tipo: "criar_oportunidade", params: {
      titulo: "{webhook=Area} · {webhook=Protocolo}", funilId: FUNIL, etapaId: EDITAL, avancarDe: [PRE],
      responsavel: { estrategia: "nenhum" }, naoCriarRepetidas: false,
    } }] } },
  };
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Teste não permite rede externa"); }));
  cliente.rpc.mockImplementation(async () => ({ data: null, error: null }));
  cliente.from.mockImplementation((tabela: string) => {
    let operacao = "select";
    const filtros: Record<string, unknown> = {};
    const resultado = (unico = false) => {
      if (tabela === "crm_webhook_integrations") return { data: integracao, error: null };
      if (tabela === "crm_oportunidades" && operacao === "select" && filtros.in_etapa_id) {
        filtrosCard.push({ ...filtros });
        return { data: cardAnterior, error: null };
      }
      if (tabela === "crm_funis_etapas") {
        const ids = (filtros.in_id as string[] | undefined) ?? [];
        return { data: ids.map((id) => ({ id, ordem: ORDEM[id] })), error: null };
      }
      if (operacao === "insert") return { data: { id: `${tabela}-novo` }, error: null };
      return { data: unico ? null : [], error: null };
    };
    const consulta: Record<string, unknown> = {
      select: () => consulta, gt: () => consulta, lt: () => consulta, order: () => consulta,
      limit: () => consulta, match: () => consulta, or: () => consulta, neq: () => consulta,
      is: () => consulta, ilike: () => consulta, not: () => consulta,
      eq: (c: string, v: unknown) => { filtros[`eq_${c}`] = v; return consulta; },
      in: (c: string, v: unknown) => { filtros[`in_${c}`] = v; return consulta; },
      insert: (valor: Record<string, unknown>) => { operacao = "insert"; (gravacoes[tabela] ??= []).push(valor); return consulta; },
      upsert: (valor: Record<string, unknown>) => { operacao = "insert"; (gravacoes[`${tabela}:upsert`] ??= []).push(valor); return consulta; },
      update: (valor: Record<string, unknown>) => { operacao = "update"; (gravacoes[`${tabela}:update`] ??= []).push(valor); return consulta; },
      single: async () => resultado(true), maybeSingle: async () => resultado(true),
      then: (resolver: (valor: unknown) => unknown) => Promise.resolve(resultado()).then(resolver),
    };
    return consulta;
  });
});
afterAll(() => vi.unstubAllGlobals());

async function enviar() {
  const resposta = await atender(new Request("https://edge.invalid/crm-lead-webhook?int=teste", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Secret": "segredo-sintetico" },
    body: JSON.stringify({ nome: "Professora Sintética", email: "sintetica@example.invalid", Area: "Piscicultura", Protocolo: "PROF26-AAA" }),
  }));
  expect(resposta.status).toBe(200);
  return resposta.json();
}

describe("Criar oportunidade com 'trazer o card destas etapas'", () => {
  it("card aberto na pré-inscrição anda para a inscrição do edital e é o devolvido (documentos caem nele)", async () => {
    cardAnterior = { id: "card-pre", etapa_id: PRE, recadastros: 0 };
    const r = await enviar();
    expect(r).toMatchObject({ ok: true, oportunidade_id: "card-pre" });
    // Procura só no funil da ação, card aberto e não arquivado, nas etapas marcadas.
    expect(filtrosCard[0]).toMatchObject({ eq_funil_id: FUNIL, eq_status: "aberta", eq_arquivada: false, in_etapa_id: [PRE] });
    expect(gravacoes["crm_oportunidades:update"]).toEqual([
      expect.objectContaining({ etapa_id: EDITAL, titulo: "Piscicultura · PROF26-AAA" }),
    ]);
    expect(gravacoes["crm_oportunidades:update"][0]).not.toHaveProperty("recadastro_em");
    expect(gravacoes.crm_oportunidades).toBeUndefined();
  });

  it("card já à frente da etapa da ação não volta: só recadastro, título preservado", async () => {
    integracao.config = { ...(integracao.config as object), acoes: { itens: [{ id: "acao-pre", tipo: "criar_oportunidade", params: {
      titulo: "Pré-inscrição · {webhook=nome}", funilId: FUNIL, etapaId: PRE, avancarDe: [PRE, EDITAL, AREA],
      responsavel: { estrategia: "nenhum" },
    } }] } };
    cardAnterior = { id: "card-area", etapa_id: AREA, recadastros: 2 };
    const r = await enviar();
    expect(r).toMatchObject({ ok: true, oportunidade_id: "card-area" });
    const upd = gravacoes["crm_oportunidades:update"][0];
    expect(upd).toMatchObject({ recadastros: 3, recadastro_titulo: "Pré-inscrição · Professora Sintética" });
    expect(upd).not.toHaveProperty("etapa_id");
    expect(upd).not.toHaveProperty("titulo");
    expect(gravacoes.crm_oportunidades).toBeUndefined();
  });

  it("sem card nas etapas marcadas (foi direto ao edital): nasce card novo na etapa da ação", async () => {
    const r = await enviar();
    expect(r.ok).toBe(true);
    expect(gravacoes.crm_oportunidades).toEqual([
      expect.objectContaining({ funil_id: FUNIL, etapa_id: EDITAL, origem_acao_id: "acao-card" }),
    ]);
  });

  it("opção desligada (webhooks de sempre) nem procura card de outra etapa", async () => {
    const params = (integracao.config as any).acoes.itens[0].params;
    delete params.avancarDe;
    await enviar();
    expect(filtrosCard).toEqual([]);
    expect(gravacoes.crm_oportunidades).toHaveLength(1);
  });
});
