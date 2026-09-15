import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { resolverOfertaEmailIA, tratarAcaoOfertasEmailIA } from "./ofertas";
import { CAMPOS_DADOS_OFERTA } from "../_shared/emailBuilder/aiOferta";

const USUARIO = "33333333-3333-4333-8333-333333333333", CURSO = "22222222-2222-4222-8222-222222222222", ID = "11111111-1111-4111-8111-111111111111";
const OFERTA = { id: ID, curso_id: CURSO, nome: "Condição de setembro", preco_centavos: 150000, parcelas: null, valor_parcela_centavos: null, desconto_pontos_base: 1000, vagas_informadas: null,
  inicio_em: "2026-09-15T10:00:00Z", fim_em: "2026-09-16T10:00:00Z", url_destino: "https://site.test/curso", condicoes: "Oferta exclusiva para o público desta campanha.", disponivel: true,
  revisao: 1, aprovada_por: USUARIO, aprovada_em: "2026-09-15T09:00:00Z", revogada_em: null };
type Linha = Record<string, unknown>;
function banco(ofertas: Linha[] = [OFERTA], opcoes: { erro?: boolean; cursoInativo?: boolean } = {}) {
  const consultas: string[] = [];
  const cliente = { from(tabela: string) {
    consultas.push(tabela);
    let inicio = 0, fim = 499;
    const filtros: Array<[string, unknown]> = [];
    const resultado = (unico = false) => {
      const linhas = (tabela === "email_ia_ofertas" ? ofertas : opcoes.cursoInativo ? [] : [{ id: CURSO, ativo: true }])
        .filter(l => filtros.every(([k, v]) => l[k] === v)).slice(inicio, fim + 1);
      return { data: unico ? linhas[0] ?? null : linhas, error: opcoes.erro ? { message: "segredo interno" } : null };
    };
    const q = { select: () => q, eq(k: string, v: unknown) { filtros.push([k, v]); return q; }, order: () => q,
      range(i: number, f: number) { inicio = i; fim = f; return q; }, maybeSingle: async () => resultado(true),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resultado()).then(resolve) };
    return q;
  } } as unknown as SupabaseClient;
  return { cliente, consultas };
}
const SELECAO = { oferta_id: ID, curso_id: CURSO }, AGORA = new Date("2026-09-15T12:00:00Z");
describe("oferta consultada novamente antes da geração", () => {
  it("não consulta ofertas sem seleção", async () => {
    const b = banco(); expect(await resolverOfertaEmailIA(b.cliente, {})).toBe(null); expect(b.consultas).toEqual([]);
  });
  it("usa somente a oferta vigente vinculada ao curso e registra campos efetivos", async () => {
    const b = banco(), resultado = await resolverOfertaEmailIA(b.cliente, SELECAO, { agora: AGORA });
    expect(resultado?.oferta?.id).toBe(ID);
    for (const [campo, valor] of Object.entries(resultado!.fonte.campos)) expect(resultado!.texto).toContain(`${campo}: ${valor}`);
    expect(resultado?.naoVerificaveis.map(a => a.tipo)).toEqual(["prazo", "vagas"]);
    expect(b.consultas).toEqual(["email_ia_ofertas", "comercial_cursos"]);
  });
  it.each([{ fim_em: "2026-09-15T12:00:00Z" }, { inicio_em: "2026-09-15T13:00:00Z" }, { disponivel: false }, { revogada_em: "2026-09-15T11:00:00Z" }, { vagas_informadas: 0 }, { curso_id: USUARIO }])("rejeita condições indisponíveis: %j", async alteracao => {
    const b = banco([{ ...OFERTA, ...alteracao }]);
    await expect(resolverOfertaEmailIA(b.cliente, SELECAO, { agora: AGORA })).rejects.toBeInstanceOf(Error);
    const conferencia = await resolverOfertaEmailIA(b.cliente, SELECAO, { agora: AGORA, conferencia: true });
    expect(conferencia?.fonte).toMatchObject({ id: ID, estado: "indisponivel", campos: {} });
    expect(conferencia?.texto).toBe(""); expect(conferencia?.naoVerificaveis).toHaveLength(4);
  });
  it("recusa curso removido e não disfarça falha de consulta como ausência de fonte", async () => {
    await expect(resolverOfertaEmailIA(banco([OFERTA], { cursoInativo: true }).cliente, SELECAO, { agora: AGORA })).rejects.toMatchObject({ code: "OFFER_UNAVAILABLE" });
    await expect(resolverOfertaEmailIA(banco([], { erro: true }).cliente, SELECAO, { conferencia: true })).rejects.toMatchObject({ code: "OFFERS_UNAVAILABLE", status: 503 });
  });
  it("preserva identidade de oferta removida na conferência", async () => {
    const resultado = await resolverOfertaEmailIA(banco([]).cliente, SELECAO, { conferencia: true });
    expect(resultado?.fonte).toMatchObject({ tipo: "oferta", id: ID, estado: "indisponivel" });
  });
});
describe("ações de ofertas com conta e revisão", () => {
  it("exige conta esperada antes de ler ou escrever", async () => {
    const b = banco();
    await expect(tratarAcaoOfertasEmailIA({ acao: "listar_ofertas", curso_id: CURSO }, { cliente: b.cliente, usuarioId: USUARIO })).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(b.consultas).toEqual([]);
  });
  it("pagina mais de mil ofertas sem corte silencioso", async () => {
    const b = banco(Array.from({ length: 1101 }, () => ({ ...OFERTA })));
    const resultado = await tratarAcaoOfertasEmailIA({ acao: "listar_ofertas", curso_id: CURSO, usuario_esperado: USUARIO }, { cliente: b.cliente, usuarioId: USUARIO });
    expect(resultado?.ofertas).toHaveLength(1101); expect(b.consultas).toHaveLength(3);
  });
  it("não aprova sem confirmação e repassa a revisão ao cliente autenticado", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: OFERTA, error: null });
    const deps = { cliente: banco().cliente, clienteUsuario: { rpc } as unknown as SupabaseClient, usuarioId: USUARIO };
    const oferta = Object.fromEntries(CAMPOS_DADOS_OFERTA.map(k => [k, OFERTA[k]]));
    const corpo = { acao: "salvar_oferta", oferta, revisao_esperada: 0, usuario_esperado: USUARIO };
    await expect(tratarAcaoOfertasEmailIA(corpo, deps)).rejects.toMatchObject({ code: "OFFER_APPROVAL_REQUIRED" });
    expect(rpc).not.toHaveBeenCalled();
    await tratarAcaoOfertasEmailIA({ ...corpo, confirmar_aprovacao: true }, deps);
    expect(rpc).toHaveBeenCalledWith("email_ia_salvar_oferta", expect.objectContaining({ p_usuario_esperado: USUARIO, p_revisao_esperada: 0, p_confirmar_aprovacao: true }));
  });
  it("preserva conflito e não expõe erro bruto do banco", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "40001", message: "segredo interno" } });
    await expect(tratarAcaoOfertasEmailIA({ acao: "desativar_oferta", oferta_id: ID, revisao_esperada: 1, usuario_esperado: USUARIO },
      { cliente: banco().cliente, clienteUsuario: { rpc } as unknown as SupabaseClient, usuarioId: USUARIO })).rejects.toMatchObject({ code: "OFFER_CONFLICT", status: 409 });
  });
});
