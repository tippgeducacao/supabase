import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { docVazio } from "../_shared/emailBuilder/types.ts";

const ambiente = vi.hoisted(() => ({ criarCliente: vi.fn() }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.45.0", () => ({ createClient: ambiente.criarCliente }));

let atender: (req: Request) => Promise<Response>;
let env: Record<string, string>;

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: (chave: string) => env?.[chave] },
    serve: (handler: typeof atender) => { atender = handler; },
  });
  await import("./index.ts");
});
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  env = {
    EMAIL_PUBLIC_URL: "https://email.exemplo.com/",
    SUPABASE_PUBLIC_URL: "https://api.exemplo.com",
    SUPABASE_URL: "http://kong:8000",
    SUPABASE_SERVICE_ROLE_KEY: "service-teste",
  };
  ambiente.criarCliente.mockReturnValue({
    auth: { getUser: async () => ({ data: { user: { id: "usuario-1" } } }) },
  });
});

describe("domínio público na prévia do e-mail", () => {
  it.each([true, false])("gera descadastro assinado sem pixel; domínio dedicado configurado: %s", async (dedicado) => {
    if (!dedicado) delete env.EMAIL_PUBLIC_URL;
    const resposta = await atender(new Request("https://api.exemplo.com/functions/v1/email-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer usuario-teste" },
      body: JSON.stringify({ documento: docVazio("Prévia") }),
    }));
    expect(resposta.status).toBe(200);
    const resultado = await resposta.json();
    const baseEsperada = dedicado ? "https://email.exemplo.com" : "https://api.exemplo.com";
    expect(resultado.html).toContain(`${baseEsperada}/functions/v1/email-descadastro?`);
    expect(resultado.texto).toContain(`${baseEsperada}/functions/v1/email-descadastro?`);
    expect(resultado.html).not.toContain("email-track-open");
    expect(resultado.html).not.toContain("http://kong:8000");
    expect(ambiente.criarCliente).toHaveBeenLastCalledWith("http://kong:8000", "service-teste");
  });
});
