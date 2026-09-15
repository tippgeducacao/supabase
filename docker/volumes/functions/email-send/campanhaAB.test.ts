import { describe, expect, it, vi } from "vitest";
import { resolverModeloCampanhaAB } from "./campanhaAB.ts";

const pedido = { contexto_tipo: "campanha", contexto_id: "c", campanha_envio_id: "fila", template_id: "b", remetente_id: "r", destinatario_email: "pessoa@example.invalid", idempotencia_key: "campanha:fila" };
function ambiente() {
  const modelo = { id: "b", assunto: "Assunto confirmado", corpo_html: "<p>Versão original</p>", corpo_texto: "Original", uso: "marketing" };
  const campanha = { id: "c", template_id: "a", template_b_id: "b", remetente_id: "r", status: "enviando", modelos_snapshot: { B: modelo } };
  const envio = { campanha_id: "c", contato_email: "pessoa@example.invalid", template_id: "b", variante: "B", status: "pendente" };
  const cliente = { rpc: vi.fn(), from: vi.fn((tabela: string) => { const q = { select: () => q, eq: () => q, single: async () => ({ data: tabela === "email_campanhas" ? campanha : envio, error: null }) }; return q; }) };
  return { cliente, campanha, envio, modelo };
}
describe("conteúdo confirmado de campanha", () => {
  it("lê o snapshot e não consulta o modelo editável", async () => {
    const a = ambiente(); expect(await resolverModeloCampanhaAB(a.cliente, pedido, true)).toEqual(a.modelo);
    expect(a.cliente.from.mock.calls.map(c => c[0])).toEqual(["email_campanhas", "email_campanhas_envios"]);
  });
  it.each([
    { ...pedido, contexto_tipo: "manual" }, { ...pedido, idempotencia_key: "outra" },
    { ...pedido, idempotencia_janela_min: 10 },
  ])("não aceita namespace/chave/janela fora do fluxo da fila", async alterado => {
    await expect(resolverModeloCampanhaAB(ambiente().cliente, alterado, true)).rejects.toThrow("exclusivos");
  });
  it("não permite reservar chaves de campanha por usuário comum", async () => {
    const a = ambiente(); await expect(resolverModeloCampanhaAB(a.cliente, pedido, false)).rejects.toThrow("exclusivos");
    expect(a.cliente.from).not.toHaveBeenCalled();
  });
  it.each([
    { ...pedido, destinatario_email: "outra@example.invalid" }, { ...pedido, template_id: "a" },
    { ...pedido, remetente_id: "outro" }, { ...pedido, idempotencia_key: "campanha:outra" },
  ])("não troca destinatário, variante, remetente ou chave", async alterado => {
    await expect(resolverModeloCampanhaAB(ambiente().cliente, alterado, true)).rejects.toThrow();
  });
  it("respeita pausa antes de resolver o corpo", async () => {
    const a = ambiente(); a.campanha.status = "pausada";
    await expect(resolverModeloCampanhaAB(a.cliente, pedido, true)).rejects.toThrow("pausado");
  });
  it("preserva envios transacionais fora do namespace campanha", async () => {
    const a = ambiente(); expect(await resolverModeloCampanhaAB(a.cliente, { destinatario_email: "pessoa@example.invalid", contexto_tipo: "webhook", idempotencia_key: "webhook:1" }, false)).toBeNull();
    expect(a.cliente.from).not.toHaveBeenCalled();
  });
});
