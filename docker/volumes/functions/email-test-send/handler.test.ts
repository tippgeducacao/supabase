import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { criarHandlerTesteEmail } from "./handler";

const USUARIO = "11111111-1111-4111-8111-111111111111", TEMPLATE = "22222222-2222-4222-8222-222222222222", REMETENTE = "33333333-3333-4333-8333-333333333333";
const PEDIDO = { template_id: TEMPLATE, destinatario_email: "teste@example.invalid", usuario_esperado: USUARIO };
function ambiente(opcoes: { invalido?: boolean; ativo?: boolean; cargo?: string; resposta?: Record<string, unknown>; status?: number; falhaRede?: boolean; falhaRemetente?: boolean } = {}) {
  const consultas: string[] = [], getUser = vi.fn().mockResolvedValue({ data: { user: opcoes.invalido ? null : { id: USUARIO } }, error: null });
  const cliente = { auth: { getUser }, rpc: vi.fn().mockImplementation((_n, a) => Promise.resolve({ data: a.role_name === (opcoes.cargo ?? "admin"), error: null })), from(tabela: string) {
    consultas.push(tabela); const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: tabela === "profiles" ? { ativo: opcoes.ativo !== false } : { id: REMETENTE }, error: tabela === "email_remetentes" && opcoes.falhaRemetente ? { message: "privado" } : null }) }; return q;
  } } as unknown as SupabaseClient;
  const buscar = vi.fn().mockImplementation(async () => { if (opcoes.falhaRede) throw new Error("chave privada"); return Response.json(opcoes.resposta ?? { ok: true, log_id: "log", provider_message_id: "provedor" }, { status: opcoes.status ?? 200 }); });
  const handler = criarHandlerTesteEmail({ cliente, urlSupabase: "https://backend.invalid", buscar });
  const chamar = (corpo: unknown = PEDIDO, authorization: string | null = "Bearer token-usuario", method = "POST") => handler(new Request("https://backend.invalid/functions/v1/email-test-send", {
    method, headers: { ...(authorization ? { Authorization: authorization } : {}), "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(corpo) } : {}),
  }));
  return { chamar, buscar, consultas, getUser };
}
describe("teste de e-mail autenticado, sem envio real", () => {
  it("OPTIONS e método indevido não consultam dados nem enviam", async () => {
    const a = ambiente(); expect((await a.chamar(undefined, null, "OPTIONS")).status).toBe(200); expect((await a.chamar(undefined, null, "GET")).status).toBe(405);
    expect(a.getUser).not.toHaveBeenCalled(); expect(a.buscar).not.toHaveBeenCalled();
  });
  it("pedido anônimo nunca ganha service_role nem consulta remetentes", async () => {
    const a = ambiente(); expect((await a.chamar(PEDIDO, null)).status).toBe(401); expect(a.consultas).toEqual([]); expect(a.buscar).not.toHaveBeenCalled();
  });
  it.each([{ invalido: true, esperado: 401 }, { ativo: false, esperado: 403 }, { cargo: "vendedor", esperado: 403 }])("recusa acesso inválido antes do envio %j", async opcoes => {
    const a = ambiente(opcoes); expect((await a.chamar()).status).toBe(opcoes.esperado); expect(a.buscar).not.toHaveBeenCalled(); expect(a.consultas).not.toContain("email_remetentes");
  });
  it("recusa troca de conta antes de consultar remetente ou invocar envio", async () => {
    const a = ambiente(); expect((await a.chamar({ ...PEDIDO, usuario_esperado: REMETENTE })).status).toBe(409); expect(a.buscar).not.toHaveBeenCalled();
  });
  it("admin preserva JWT original e confirma somente resposta aceita do motor", async () => {
    const a = ambiente(); const r = await a.chamar(); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ ok: true, success: true, log_id: "log" });
    const [url, opcoes] = a.buscar.mock.calls[0]; expect(url).toBe("https://backend.invalid/functions/v1/email-send");
    expect(opcoes.headers.Authorization).toBe("Bearer token-usuario"); expect(JSON.parse(opcoes.body)).toMatchObject({ usuario_esperado: USUARIO, template_id: TEMPLATE, contexto_tipo: "teste" });
  });
  it("avulso preserva conteúdo atual sem sobrescrever pelo template", async () => {
    const a = ambiente({ cargo: "diretor" });
    const r = await a.chamar({ ...PEDIDO, assunto: "Assunto", corpo_html: "<p>Conteúdo novo</p>" });
    expect(r.status).toBe(200); const envio = JSON.parse(a.buscar.mock.calls[0][1].body);
    expect(envio.template_id).toBeUndefined(); expect(envio.remetente_id).toBe(REMETENTE); expect(envio.corpo_html).toBe("<p>Conteúdo novo</p>");
  });
  it.each([{ destinatario_email: "alvo@test.invalid\r\nBcc:outro@test.invalid" }, { assunto: "Olá\r\nSubject:outro", corpo_html: "<p>Corpo</p>" }, { variaveis: { nome: { interno: true } } }, { remetente_id: "livre" }])("recusa destinatário/corpo inválido %j", async mudanca => {
    const a = ambiente(); expect((await a.chamar({ ...PEDIDO, ...mudanca })).status).toBe(400); expect(a.buscar).not.toHaveBeenCalled();
  });
  it.each([{ ok: true, suprimido: true }, { ok: true, duplicado: true }, { success: true }, { ok: false }, { ok: true, error: "Falha" }])("200 sem envio novo não vira confirmação: %j", async resposta => {
    const a = ambiente({ resposta }); expect((await a.chamar()).status).toBe(422); expect(a.buscar).toHaveBeenCalledTimes(1);
  });
  it("preserva falha do provedor e não repete erro de rede incerto", async () => {
    const limite = ambiente({ resposta: { error: "Aguarde" }, status: 429 }); const r = await limite.chamar(); expect(r.status).toBe(429); expect(await r.json()).toEqual({ error: "Aguarde" });
    const rede = ambiente({ falhaRede: true }); const falha = await rede.chamar(); expect(falha.status).toBe(503); expect(await falha.text()).not.toContain("privada"); expect(rede.buscar).toHaveBeenCalledTimes(1);
  });
});
