import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { caminhoParecerValido } from "./acesso.ts";

const estado = vi.hoisted(() => ({
  handler: null as null | ((r: Request) => Promise<Response>),
  permitido: true, entrevista: true, erroPermissao: false, erroGuardar: false,
  eventos: [] as { tipo: string; papel?: string; destino?: string; caminho?: string }[],
}));
const oportunidade = "11111111-1111-4111-8111-111111111111";
const audioPath = oportunidade + "/parecer-1234567890123.webm";

vi.mock("https://esm.sh/@supabase/supabase-js@2.50.0", () => ({
  createClient: (_url: string, chave: string, opcoes?: any) => {
    const papel = opcoes?.global?.headers?.Authorization === "Bearer sessao" ? "usuario" : "servico";
    if (papel === "usuario" && chave !== "anon") throw new Error("Cliente humano inesperado");
    return {
      from(tabela: string) {
        const q: any = {};
        for (const metodo of ["select", "eq", "neq", "order", "limit"]) q[metodo] = () => q;
        q.maybeSingle = async () => {
          estado.eventos.push({ tipo: tabela, papel });
          return { data: tabela === "ai_api_keys" ? { api_key: "chave-sintetica" }
            : estado.entrevista ? { id: "entrevista-sintetica" } : null, error: null };
        };
        return q;
      },
      storage: { from: () => ({
        download: async (caminho: string) => {
          estado.eventos.push({ tipo: "download", papel, caminho });
          return { data: new Blob(["audio sintetico"], { type: "audio/webm" }), error: null };
        },
      }) },
      rpc: async () => {
        estado.eventos.push({ tipo: "guardar_audio", papel });
        return { data: !estado.erroGuardar, error: estado.erroGuardar ? { code: "42501" } : null };
      },
    };
  },
}));

beforeAll(async () => {
  vi.stubGlobal("Deno", {
    env: { get: (nome: string) => ({
      SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "servico",
      SUPABASE_ANON_KEY: "anon",
    } as Record<string,string>)[nome] },
    serve: (handler: (r: Request) => Promise<Response>) => { estado.handler = handler; },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    estado.eventos.push({ tipo: "rede", destino: String(url) });
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "usuario-sintetico" });
    if (String(url).endsWith("/rest/v1/rpc/rh_pode_ver_contratacao")) {
      return estado.erroPermissao ? Response.json({}, { status: 500 }) : Response.json(estado.permitido);
    }
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      return Response.json({ candidates: [{ content: { parts: [{ text: "Transcrição sintética." }] }, finishReason: "STOP" }] });
    }
    if (String(url) === "https://api.anthropic.com/v1/messages") {
      return Response.json({ content: [{ type: "text", text: '{"comunicacao":null}' }] });
    }
    throw new Error("Rede não prevista no teste: " + url);
  }));
  await import("./index.ts");
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  estado.permitido = true; estado.entrevista = true; estado.erroPermissao = false;
  estado.erroGuardar = false; estado.eventos.length = 0;
});
const chamar = (body: unknown, token = "sessao") => estado.handler!(new Request("https://edge.invalid", {
  method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const pedido = () => ({ audio_path: audioPath, oportunidade_id: oportunidade });

describe("parecer de RH: autorização antes de arquivo e IA", () => {
  it("nega Marketing antes de ler o recurso ou chamar provedor", async () => {
    estado.permitido = false;
    expect((await chamar(pedido())).status).toBe(403);
    expect(estado.eventos.every(e => e.tipo === "rede" && e.destino!.startsWith("https://supabase.invalid/"))).toBe(true);
  });
  it("falha fechada se a RPC de permissão estiver indisponível", async () => {
    estado.erroPermissao = true;
    expect((await chamar(pedido())).status).toBe(503);
    expect(estado.eventos.some(e => e.tipo === "download")).toBe(false);
  });
  it("nega caminho de outra oportunidade e travessias antes de consultar Storage", async () => {
    for (const path of [
      "22222222-2222-4222-8222-222222222222/parecer-1.webm",
      oportunidade + "/../parecer-1.webm", oportunidade + "/%2e%2e/parecer-1.webm",
      oportunidade + "/parecer-1.webm?x=1",
    ]) {
      expect((await chamar({ ...pedido(), audio_path: path })).status).toBe(400);
    }
    expect(estado.eventos.some(e => e.tipo === "download")).toBe(false);
  });
  it("nega oportunidade sem entrevista visível, antes de baixar ou transcrever", async () => {
    estado.entrevista = false;
    expect((await chamar(pedido())).status).toBe(403);
    expect(estado.eventos.some(e => e.tipo === "download")).toBe(false);
  });
  it("mantém sessão humana na consulta, download e gravação autorizados", async () => {
    expect((await chamar(pedido())).status).toBe(200);
    for (const tipo of ["rh_entrevistas", "download", "guardar_audio"]) {
      expect(estado.eventos.find(e => e.tipo === tipo)?.papel).toBe("usuario");
    }
  });
  it("preserva serviço explícito e não tenta validá-lo como uma sessão humana", async () => {
    expect((await chamar(pedido(), "servico")).status).toBe(200);
    expect(estado.eventos.some(e => e.destino?.includes("/auth/v1/user"))).toBe(false);
    expect(estado.eventos.find(e => e.tipo === "download")?.papel).toBe("servico");
  });
  it("não informa sucesso quando a gravação foi recusada", async () => {
    estado.erroGuardar = true;
    const resposta = await chamar(pedido());
    expect(resposta.status).toBe(500);
    expect((await resposta.json()).ok).toBe(false);
  });
  it("valida o caminho emitido pelo front e rejeita valores sem identidade", () => {
    expect(caminhoParecerValido(audioPath, oportunidade)).toBe(true);
    expect(caminhoParecerValido(audioPath, undefined)).toBe(false);
    expect(caminhoParecerValido(null, oportunidade)).toBe(false);
  });
});
