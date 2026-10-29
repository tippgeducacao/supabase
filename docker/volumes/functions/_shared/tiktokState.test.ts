import { describe, expect, it } from "vitest";
import { conferirState, criarState } from "./tiktokState";

const SEGREDO = "segredo-do-app";
const UID = "8f0c1a52-1111-4222-8333-944455556666";
const AGORA = 1_800_000_000_000;

describe("state assinado do OAuth do TikTok (29/10/2026)", () => {
  it("aceita o state que o servidor gerou, dentro do prazo", async () => {
    const s = await criarState(SEGREDO, "ads", UID, 30 * 60_000, AGORA);
    const r = await conferirState(SEGREDO, "ads", s, AGORA + 60_000);
    expect(r).toMatchObject({ ok: true, usuarioId: UID });
  });

  it("recusa sem state, com o state fixo antigo e com lixo", async () => {
    expect(await conferirState(SEGREDO, "ads", null, AGORA)).toEqual({ ok: false, motivo: "ausente" });
    expect(await conferirState(SEGREDO, "ads", "ppgvet", AGORA)).toEqual({ ok: false, motivo: "invalido" });
    expect(await conferirState(SEGREDO, "ads", "a.b.c.d.e", AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });

  it("recusa state assinado com outro segredo", async () => {
    const s = await criarState("outro-segredo", "ads", UID, 30 * 60_000, AGORA);
    expect(await conferirState(SEGREDO, "ads", s, AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });

  it("recusa state do outro app (ads ≠ perfil)", async () => {
    const s = await criarState(SEGREDO, "ads", UID, 30 * 60_000, AGORA);
    expect(await conferirState(SEGREDO, "perfil", s, AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });

  it("recusa prazo esticado à mão (a assinatura quebra) e prazo vencido", async () => {
    const s = await criarState(SEGREDO, "ads", UID, 30 * 60_000, AGORA);
    const p = s.split(".");
    p[1] = (AGORA + 10 * 365 * 86_400_000).toString(36);
    expect(await conferirState(SEGREDO, "ads", p.join("."), AGORA)).toEqual({ ok: false, motivo: "invalido" });
    expect(await conferirState(SEGREDO, "ads", s, AGORA + 31 * 60_000)).toEqual({ ok: false, motivo: "vencido" });
  });

  it("recusa trocar o usuário dentro do state", async () => {
    const s = await criarState(SEGREDO, "perfil", UID, 60_000, AGORA);
    const p = s.split(".");
    p[2] = "00000000-0000-4000-8000-000000000000";
    expect(await conferirState(SEGREDO, "perfil", p.join("."), AGORA)).toEqual({ ok: false, motivo: "invalido" });
  });
});
