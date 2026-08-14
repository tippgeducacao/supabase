/**
 * Handler do descadastro, com banco falso — fecha o critério de aceite 6:
 * token válido suprime o endereço; token inválido devolve 400.
 */
import { describe, expect, it } from "vitest";
import { FakeSupabase } from "../../../tests/helpers/fakeSupabase.ts";
import { tratarDescadastro } from "./handler.ts";
import { assinarDescadastro } from "../_shared/resend.ts";

// O módulo lê Deno.env dentro das funções; um stub basta para o HMAC ter chave.
(globalThis as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => (k === "EMAIL_UNSUB_SECRET" ? "segredo-de-teste" : undefined) },
};

const banco = () => new FakeSupabase({ email_supressoes: { linhas: [], unicas: ["email"] } });

function req(email: string, token: string, metodo = "GET"): Request {
  const url = `https://api.exemplo.com/functions/v1/email-descadastro?e=${encodeURIComponent(email)}&t=${token}`;
  return new Request(url, { method: metodo });
}

describe("critério 6 — token válido suprime", () => {
  it("registra o endereço com motivo descadastro e devolve 200", async () => {
    const db = banco();
    const email = "aluno@exemplo.com";
    const token = await assinarDescadastro(email);

    const res = await tratarDescadastro(req(email, token), { supabase: db });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("descadastrado");
    expect(db.linhas("email_supressoes")).toEqual([
      expect.objectContaining({ email, motivo: "descadastro" }),
    ]);
  });

  it("normaliza para minúsculas antes de gravar", async () => {
    const db = banco();
    const email = "Aluno@Exemplo.COM";
    const token = await assinarDescadastro(email);

    await tratarDescadastro(req(email, token), { supabase: db });

    expect(db.linhas("email_supressoes")[0].email).toBe("aluno@exemplo.com");
  });

  it("clicar duas vezes não duplica nem dá erro", async () => {
    const db = banco();
    const email = "aluno@exemplo.com";
    const token = await assinarDescadastro(email);

    const r1 = await tratarDescadastro(req(email, token), { supabase: db });
    const r2 = await tratarDescadastro(req(email, token), { supabase: db });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(db.linhas("email_supressoes")).toHaveLength(1);
  });

  it("aceita o one-click POST do Gmail", async () => {
    const db = banco();
    const email = "aluno@exemplo.com";
    const token = await assinarDescadastro(email);

    const res = await tratarDescadastro(req(email, token, "POST"), { supabase: db });

    expect(res.status).toBe(200);
    expect(db.linhas("email_supressoes")).toHaveLength(1);
  });
});

describe("critério 6 — token inválido devolve 400", () => {
  it("token adulterado não suprime", async () => {
    const db = banco();
    const res = await tratarDescadastro(req("aluno@exemplo.com", "f".repeat(32)), { supabase: db });

    expect(res.status).toBe(400);
    expect(db.linhas("email_supressoes")).toHaveLength(0);
  });

  it("token de OUTRO e-mail não descadastra terceiros", async () => {
    const db = banco();
    // Este é o ataque que o HMAC impede: pegar o próprio link e trocar o endereço.
    const tokenDeOutro = await assinarDescadastro("vitima@exemplo.com");
    const res = await tratarDescadastro(req("atacante@exemplo.com", tokenDeOutro), { supabase: db });

    expect(res.status).toBe(400);
    expect(db.linhas("email_supressoes")).toHaveLength(0);
  });

  it("faltando e-mail ou token devolve 400", async () => {
    const db = banco();
    for (const url of [
      "https://api.exemplo.com/f?e=aluno@exemplo.com",
      "https://api.exemplo.com/f?t=abc",
      "https://api.exemplo.com/f",
    ]) {
      const res = await tratarDescadastro(new Request(url), { supabase: db });
      expect(res.status, url).toBe(400);
    }
    expect(db.linhas("email_supressoes")).toHaveLength(0);
  });

  it("a página de erro não vaza o motivo técnico", async () => {
    const db = banco();
    const res = await tratarDescadastro(req("aluno@exemplo.com", "invalido"), { supabase: db });
    const html = await res.text();

    expect(html).toContain("não confere");
    expect(html.toLowerCase()).not.toContain("hmac");
  });
});
