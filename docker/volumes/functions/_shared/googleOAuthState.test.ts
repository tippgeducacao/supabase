import { describe, expect, it } from "vitest";
import { conferirStateGoogle, criarStateGoogle } from "./googleOAuthState";

const SEGREDO = "client-secret-do-google";
const INTEG = "1f0c1a52-1111-4222-8333-944455556666";
const UID = "8f0c1a52-1111-4222-8333-944455556666";
const AGORA = 1_800_000_000_000;

describe("state assinado do OAuth do Google (12/11/2026)", () => {
  it("aceita o state que o START gerou, dentro do prazo, com integração, usuário e modo", async () => {
    const s = await criarStateGoogle(SEGREDO, { integrationId: INTEG, usuarioId: UID, modo: "email" }, 15 * 60_000, AGORA);
    const r = await conferirStateGoogle(SEGREDO, s, AGORA + 60_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).toMatchObject({ i: INTEG, u: UID, m: "email" });
  });

  it("recusa o formato antigo (base64 de JSON sem assinatura) — o ataque que fechamos", async () => {
    const antigo = btoa(JSON.stringify({ i: INTEG, u: UID, m: "full", n: "x" }));
    expect(await conferirStateGoogle(SEGREDO, antigo, AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });

  it("recusa sem state, lixo e state assinado com outro segredo", async () => {
    expect(await conferirStateGoogle(SEGREDO, null, AGORA)).toEqual({ ok: false, motivo: "ausente" });
    expect(await conferirStateGoogle(SEGREDO, "a.b", AGORA)).toEqual({ ok: false, motivo: "invalido" });
    const outro = await criarStateGoogle("outro", { integrationId: INTEG, usuarioId: UID, modo: "full" }, 15 * 60_000, AGORA);
    expect(await conferirStateGoogle(SEGREDO, outro, AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });

  it("recusa quem troca a integração dentro do payload (assinatura não bate)", async () => {
    const s = await criarStateGoogle(SEGREDO, { integrationId: INTEG, usuarioId: UID, modo: "full" }, 15 * 60_000, AGORA);
    const [corpo, assinatura] = s.split(".");
    const json = JSON.parse(atob(corpo.replace(/-/g, "+").replace(/_/g, "/")));
    json.i = "00000000-0000-4000-8000-000000000000";
    const forjado = btoa(JSON.stringify(json)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await conferirStateGoogle(SEGREDO, `${forjado}.${assinatura}`, AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });

  it("recusa depois do prazo", async () => {
    const s = await criarStateGoogle(SEGREDO, { integrationId: INTEG, usuarioId: UID, modo: "calendar" }, 15 * 60_000, AGORA);
    expect(await conferirStateGoogle(SEGREDO, s, AGORA + 16 * 60_000)).toEqual({ ok: false, motivo: "vencido" });
  });

  it("modo desconhecido vira 'full' (igual ao comportamento anterior)", async () => {
    const s = await criarStateGoogle(SEGREDO, { integrationId: INTEG, usuarioId: UID, modo: "qualquer" as never }, 15 * 60_000, AGORA);
    const r = await conferirStateGoogle(SEGREDO, s, AGORA);
    expect(r.ok && r.state.m).toBe("full");
  });

  it("sem segredo configurado, não emite nem aceita (fechado por padrão)", async () => {
    await expect(criarStateGoogle("", { integrationId: INTEG, usuarioId: UID, modo: "full" })).rejects.toThrow();
    const s = await criarStateGoogle(SEGREDO, { integrationId: INTEG, usuarioId: UID, modo: "full" }, 15 * 60_000, AGORA);
    expect(await conferirStateGoogle("", s, AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });
});
