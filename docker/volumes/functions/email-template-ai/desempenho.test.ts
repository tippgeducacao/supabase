import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { resolverDesempenhoEmailIA, tratarAcaoDesempenhoEmailIA } from "./desempenho";

const USUARIO = "11111111-1111-4111-8111-111111111111";
const CAMPANHA = "22222222-2222-4222-8222-222222222222";
const MODELO = "33333333-3333-4333-8333-333333333333";
const MODELO_B = "44444444-4444-4444-8444-444444444444";
const AGORA = "2026-09-15T15:00:00.000Z";
type Linha = Record<string, unknown>;
const campanha = (ab = false): Linha => ({ id: CAMPANHA, nome: "Campanha bovinos", template_id: MODELO, template_b_id: ab ? MODELO_B : null,
  status: "concluida", iniciada_em: "2026-09-14T10:00:00Z", concluida_em: "2026-09-14T11:00:00Z",
  modelo_a_id: ab ? MODELO : null, modelo_a_nome: "Explicativa", modelo_a_assunto: "Conheça o curso", modelo_a_texto: "Conteúdo aprovado A",
  modelo_b_id: ab ? MODELO_B : null, modelo_b_nome: "Benefícios", modelo_b_assunto: "Aulas práticas", modelo_b_texto: "Conteúdo aprovado B" });
function banco(c: Linha | null = campanha(), total = 0) {
  const consultas: Array<{ tabela: string; campos: string; opcoes?: Record<string, unknown>; filtros: Array<[string, unknown]> }> = [];
  const fila = Array.from({ length: total }, (_, n) => ({ id: n, campanha_id: CAMPANHA, status: n === 0 ? "pulado" : n === 1 ? "falhou" : "enviado", contato_email: "CONTATO_PRIVADO" }));
  const logs = fila.slice(2).map((e, n) => ({ id: e.id, contexto_tipo: "campanha", contexto_id: CAMPANHA,
    idempotencia_key: `campanha:${String(e.id).padStart(8, "0")}-1111-4111-8111-111111111111`, provider_message_id: String(e.id),
    status: "enviado", entregue_em: n % 2 ? null : AGORA, clicado_count: n < 3 ? 20 : 0, aberto_count: n < 5 ? 10 : 0, aberto_em: null,
    destinatario_email: "CONTATO_PRIVADO", corpo_texto_render: "Olá, PESSOA_PRIVADA" }));
  const rpc = vi.fn(async () => ({ data: null as unknown, error: null as unknown }));
  let falhar: string | undefined;
  const cliente = { rpc, from(tabela: string) {
    const registro = { tabela, campos: "", opcoes: undefined as Record<string, unknown> | undefined, filtros: [] as Array<[string, unknown]> };
    consultas.push(registro);
    const filtros: Array<(l: Linha) => boolean> = [];
    const expressao = (e: string): ((l: Linha) => boolean) => {
      const [campo, op, ...resto] = e.split("."); const valor = resto.join(".");
      if (op === "not" && valor === "is.null") return l => l[campo] !== null && l[campo] !== undefined;
      if (op === "in") return l => valor.slice(1, -1).split(",").includes(String(l[campo]));
      if (op === "gt") return l => Number(l[campo]) > Number(valor);
      return l => String(l[campo]) === valor;
    };
    const resultado = (unico = false) => {
      const linhas = (tabela === "email_campanhas" ? c ? [c] : [] : tabela === "email_campanhas_envios" ? fila : logs).filter(l => filtros.every(f => f(l)));
      return { data: unico ? linhas[0] ?? null : null, count: linhas.length, error: falhar === tabela ? { message: "SQL_SEGREDO" } : null };
    };
    const q = {
      select(campos: string, opcoes?: Record<string, unknown>) { registro.campos = campos; registro.opcoes = opcoes; return q; },
      eq(campo: string, valor: unknown) { registro.filtros.push([campo, valor]); filtros.push(l => l[campo] === valor); return q; },
      like(campo: string, valor: string) { registro.filtros.push([campo, valor]); const re = new RegExp(`^${valor.replace(/_/g, ".").replace(/%/g, ".*")}$`); filtros.push(l => re.test(String(l[campo]))); return q; },
      not(campo: string, _op: string, valor: unknown) { filtros.push(l => l[campo] !== valor); return q; },
      or(valor: string) { const partes = valor.split(/,(?![^()]*\))/).map(expressao); filtros.push(l => partes.some(f => f(l))); return q; },
      maybeSingle: async () => resultado(true),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resultado()).then(resolve),
    };
    return q;
  } } as unknown as SupabaseClient;
  return { cliente, consultas, rpc, logs, falhar: (t: string) => { falhar = t; } };
}
function resultadoAB() {
  return { campanha_id: CAMPANHA, status: "concluida", iniciada_em: "2026-09-14T10:00:00Z", concluida_em: "2026-09-14T11:00:00Z", atualizado_em: AGORA, vencedor: null,
    variantes: [MODELO, MODELO_B].map((id, i) => ({ variante: i ? "B" : "A", template_id: id, nome: i ? "Benefícios" : "Explicativa",
      destinatarios: 1201, pendentes: 0, suprimidos: 1, falhos: 0, aceitos: 1200, entregues: 1190, clicaram: i ? 60 : 30, abertos: 400 })) };
}

describe("resultados de campanha reconsultados pela IA", () => {
  it("agrega campanha simples acima de mil destinatários sem baixar contatos, corpos ou eventos individuais", async () => {
    const b = banco(campanha(), 1201);
    const resultado = await resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO, () => new Date(AGORA));
    expect(resultado).toMatchObject({ tipo: "unica", coleta: "contagens", atualizado_em: AGORA,
      variantes: [{ destinatarios: 1201, suprimidos: 1, falhos: 1, aceitos: 1199, entregues: 600, clicaram: 3, abertos: 5, origem_conteudo: "indisponivel", assunto: null }] });
    expect(JSON.stringify(resultado)).not.toContain("PRIVAD");
    expect(b.consultas.slice(1).every(q => q.campos === "id" && q.opcoes?.head === true && q.opcoes?.count === "exact")).toBe(true);
    expect(b.consultas.some(q => q.tabela === "email_templates")).toBe(false);
    expect(b.rpc).not.toHaveBeenCalled();
  });
  it("exclui logs de outra campanha e envio manual, conta uma mensagem com muitos cliques uma só vez", async () => {
    const b = banco(campanha(), 5);
    b.logs.push({ ...b.logs[0], contexto_id: MODELO }, { ...b.logs[0], idempotencia_key: "manual:teste" });
    const r = await resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO);
    expect(r.variantes[0]).toMatchObject({ aceitos: 3, clicaram: 3 });
  });
  it("consulta A/B com a RPC autenticada, preserva população/variantes e usa somente snapshot", async () => {
    const b = banco(campanha(true)); b.rpc.mockResolvedValue({ data: resultadoAB(), error: null });
    const resultado = await resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO);
    expect(b.rpc).toHaveBeenCalledWith("email_campanha_resultados_ab", { p_usuario_esperado: USUARIO, p_campanha: CAMPANHA });
    expect(resultado).toMatchObject({ tipo: "ab", coleta: "rpc_ab", variantes: [{ variante: "A", destinatarios: 1201, texto: "Conteúdo aprovado A", origem_conteudo: "snapshot" }, { variante: "B", clicaram: 60 }] });
    expect(b.consultas).toHaveLength(1);
  });
  it("marca trecho parcial e não busca HTML nem dados do destinatário", async () => {
    const c = campanha(true); c.modelo_a_texto = "a".repeat(5000);
    const b = banco(c); b.rpc.mockResolvedValue({ data: resultadoAB(), error: null });
    const r = await resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO);
    expect(r.variantes[0].texto).toHaveLength(3000); expect(r.variantes[0].texto_resumido).toBe(true);
    expect(b.consultas[0].campos).not.toContain("corpo_html");
  });
  it("preserva ausência de dados sem inventar campanha vencedora", async () => {
    const b = banco(campanha(), 0); const r = await resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO);
    expect(r.variantes[0]).toMatchObject({ destinatarios: 0, aceitos: 0, clicaram: 0 }); expect(r).not.toHaveProperty("vencedor");
  });
  it("falha de consulta não vira resultado vazio ou expõe detalhes internos", async () => {
    const b = banco(campanha(), 4); b.falhar("emails_enviados");
    await expect(resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO)).rejects.toMatchObject({ status: 503, code: "RESULTS_UNAVAILABLE" });
    await expect(resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO)).rejects.not.toThrow("SQL_SEGREDO");
  });
  it("não usa retorno RPC de outra campanha/variante nem fallback quando auth.uid falha", async () => {
    const b = banco(campanha(true));
    for (const dado of [null, { ...resultadoAB(), campanha_id: MODELO }, { ...resultadoAB(), variantes: [{ ...resultadoAB().variantes[0], template_id: MODELO_B }, resultadoAB().variantes[1]] }]) {
      b.rpc.mockResolvedValue({ data: dado, error: null }); await expect(resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO)).rejects.toMatchObject({ status: 503 });
    }
    b.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "PRIVADO" } });
    await expect(resolverDesempenhoEmailIA(b.cliente, CAMPANHA, USUARIO)).rejects.toMatchObject({ status: 503 });
    expect(b.consultas.every(q => q.tabela === "email_campanhas")).toBe(true);
  });
  it("rejeita números enviados pelo navegador e seleção inválida antes de consultar", async () => {
    const b = banco(); const deps = { clienteUsuario: b.cliente, usuarioId: USUARIO };
    await expect(tratarAcaoDesempenhoEmailIA({ acao: "consultar_resultados", contexto: { campanha_id: CAMPANHA }, resultados: { clicaram: 100 } }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(resolverDesempenhoEmailIA(b.cliente, "../campanha", USUARIO)).rejects.toMatchObject({ status: 400 });
    expect(b.consultas).toHaveLength(0);
  });
  it("cada pedido lê novamente o resultado e usa a conta esperada", async () => {
    const b = banco(campanha(true)); const resultado = resultadoAB(); b.rpc.mockImplementation(async () => ({ data: structuredClone(resultado), error: null }));
    const deps = { clienteUsuario: b.cliente, usuarioId: USUARIO };
    const a = await tratarAcaoDesempenhoEmailIA({ acao: "consultar_resultados", contexto: { campanha_id: CAMPANHA }, usuario_esperado: USUARIO }, deps);
    resultado.variantes[0].clicaram = 31;
    const novo = await tratarAcaoDesempenhoEmailIA({ acao: "consultar_resultados", contexto: { campanha_id: CAMPANHA }, usuario_esperado: USUARIO }, deps);
    expect(a?.resultados.variantes[0].clicaram).toBe(30); expect(novo?.resultados.variantes[0].clicaram).toBe(31);
  });
});
