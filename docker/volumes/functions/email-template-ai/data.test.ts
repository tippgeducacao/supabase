import { describe, expect, it } from "vitest";
import { resolverContextoEmailIA, resolverImagensBibliotecaEmailIA, tratarAcaoDadosEmailIA, urlImagemBiblioteca, validarSelecaoContextoEmailIA } from "./data";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { compararFontesEmailIA, MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA, validarSnapshotFontesEmailIA } from "../_shared/emailBuilder/aiFontes";

const CURSO = "11111111-1111-4111-8111-111111111111";
const MARCA = "22222222-2222-4222-8222-222222222222";
const MIDIA = "33333333-3333-4333-8333-333333333333";
const CAMPANHA = "44444444-4444-4444-8444-444444444444";
const URL = "https://api.exemplo.test";
type Linha = Record<string, unknown>;
function banco(tabelas: Record<string, Linha[]>, falhar?: string) {
  const consultas: Array<{ tabela: string; campos: string; filtros: Array<[string, unknown]>; intervalo?: number[] }> = [];
  const cliente = { from(tabela: string) {
    const consulta = { tabela, campos: "", filtros: [] as Array<[string, unknown]>, intervalo: undefined as number[] | undefined };
    consultas.push(consulta);
    let limite: number | undefined;
    const resultado = (unico = false) => {
      const filtradas = (tabelas[tabela] ?? []).filter(l => consulta.filtros.every(([campo, valor]) => l[campo] === valor));
      const paginadas = consulta.intervalo ? filtradas.slice(consulta.intervalo[0], consulta.intervalo[1] + 1) : filtradas.slice(0, limite);
      const dados = paginadas.map(l => Object.fromEntries(consulta.campos.split(",").map(c => [c, l[c]])));
      return { data: unico ? dados[0] ?? null : dados, error: tabela === falhar ? { message: "SEGREDO_INTERNO" } : null };
    };
    const q = {
      select(campos: string) { consulta.campos = campos; return q; },
      eq(campo: string, valor: unknown) { consulta.filtros.push([campo, valor]); return q; },
      order() { return q; },
      range(inicio: number, fim: number) { consulta.intervalo = [inicio, fim]; return q; },
      limit(valor: number) { limite = valor; return q; },
      maybeSingle: async () => resultado(true),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resultado()).then(resolve),
    };
    return q;
  } } as unknown as SupabaseClient;
  return { cliente, consultas };
}

describe("fontes reais de contexto de e-mail IA", () => {
  it("recusa IDs inválidos e campos adicionais antes de consultar dados", async () => {
    const { cliente, consultas } = banco({});
    expect(() => validarSelecaoContextoEmailIA({ curso_id: "../outro" })).toThrow();
    await expect(resolverContextoEmailIA(cliente, { usuario_id: CURSO }, URL)).rejects.toThrow();
    expect(consultas).toHaveLength(0);
  });
  it("pagina todo catálogo acima do corte de mil linhas do PostgREST", async () => {
    const { cliente, consultas } = banco({ comercial_cursos: Array.from({ length: 1201 }, (_, n) => ({ id: String(n), nome: `Curso ${n}`, ativo: true })) });
    const resultado = await tratarAcaoDadosEmailIA({ acao: "listar_contextos" }, { cliente, usuarioId: CURSO, urlPublica: URL });
    expect(resultado?.cursos).toHaveLength(1201);
    expect(consultas.filter(c => c.tabela === "comercial_cursos").map(c => c.intervalo)).toEqual([[0, 499], [500, 999], [1000, 1499]]);
  });
  it("usa modalidade confirmada do catálogo atual, playbook e URLs cadastradas", async () => {
    const academico = "482013e3-7634-4b7d-8e5e-73416548ca5c";
    const { cliente } = banco({
      comercial_cursos: [{ id: CURSO, nome: "Clínica de Bovinos", curso_id: academico, ativo: true, modalidade: "inconsistente", banner_url: `${URL}/banner.png` }],
      cursos: [{ id: academico, nome: "Clínica de Bovinos", ativo: true }],
      comercial_curso_playbook: [{ curso_id: CURSO, ativo: true, habilidades: "Diagnóstico clínico", publico_alvo: "Veterinários" }],
      comercial_curso_links: [{ curso_id: CURSO, ativo: true, titulo: "Inscrição", url: "https://inscricao.test/bovinos", tipo: "inscricao" }],
    });
    const resultado = await resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL);
    expect(resultado.texto).toContain("online / semipresencial");
    expect(resultado.texto).toContain("Veterinários");
    expect(resultado.texto).toContain("https://inscricao.test/bovinos");
    expect(resultado.texto).not.toContain("inconsistente");
    expect(resultado.texto).toContain("Preço, vagas, desconto e prazo de matrícula não foram confirmados");
    expect(resultado.imagensPermitidas).toEqual([`${URL}/banner.png`]);
  });
  it("não infere modalidade de curso sem vínculo nem confirma preços históricos de campanha", async () => {
    const { cliente, consultas } = banco({
      comercial_cursos: [{ id: CURSO, nome: "Curso novo", ativo: true }],
      email_campanhas: [{ id: CAMPANHA, nome: "Campanha antiga", template_id: "template", segmento_id: "segmento" }],
      email_templates: [{ id: "template", corpo_texto: "Oferta de R$ 100,00", corpo_html: "HTML_PRIVADO" }],
      email_segmentos: [{ id: "segmento", nome: "Interessados", contatos_estaticos: ["contato@privado.test"], query_dinamica: { segredo: true } }],
    });
    const resultado = await resolverContextoEmailIA(cliente, { curso_id: CURSO, campanha_id: CAMPANHA }, URL);
    expect(resultado.texto).toContain("não confirmada");
    expect(resultado.texto).toContain("referência histórica; condições e prazos exigem conferência");
    expect(resultado.texto).not.toContain("privado");
    expect(consultas.find(c => c.tabela === "email_segmentos")?.campos).toBe("nome,descricao");
  });
  it("sinaliza falhas do banco sem apresentar contexto vazio como consulta bem-sucedida", async () => {
    const { cliente } = banco({}, "comercial_cursos");
    await expect(resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL)).rejects.toMatchObject({ status: 503, code: "CONTEXT_UNAVAILABLE" });
    await expect(resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL)).rejects.not.toThrow("SEGREDO_INTERNO");
  });
});

describe("snapshot das fontes resolvidas e consulta sem geração", () => {
  it("captura os mesmos campos usados e ignora updated_at sem mudança de fatos", async () => {
    const tabelas = { comercial_cursos: [{ id: CURSO, nome: "Curso", resumo_curto: "Resumo original", ativo: true, updated_at: "2026-09-01", vigencia_fim: "2026-09-20" }], comercial_curso_playbook: [], comercial_curso_links: [] };
    const { cliente, consultas } = banco(tabelas);
    const contexto = await resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL);
    const anterior = validarSnapshotFontesEmailIA(contexto.snapshot_fontes);
    for (const f of anterior.fontes) for (const [campo, valor] of Object.entries(f.campos)) expect(contexto.texto).toContain(`${campo}: ${valor}`);
    tabelas.comercial_cursos[0].updated_at = "2026-09-14"; tabelas.comercial_cursos[0].vigencia_fim = "2026-12-31";
    expect(compararFontesEmailIA(anterior, (await resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL)).snapshot_fontes).estado).toBe("sem_alteracoes");
    expect(consultas.find(c => c.tabela === "comercial_cursos")?.campos).not.toContain("vigencia");
    tabelas.comercial_cursos[0].resumo_curto = "Resumo atualizado";
    const conferida = await tratarAcaoDadosEmailIA({ acao: "conferir_fontes", snapshot_fontes: anterior }, { cliente, usuarioId: CURSO, urlPublica: URL });
    expect(conferida?.comparacao).toMatchObject({ estado: "alterado", alteracoes: [{ tipo: "curso", campos: [{ campo: "Resumo", anterior: "Resumo original", atual: "Resumo atualizado" }] }] });
  });
  it("curso removido/inativo é indisponível na conferência, sem apagar baseline", async () => {
    const tabelas = { comercial_cursos: [{ id: CURSO, nome: "Curso", ativo: true }], comercial_curso_playbook: [], comercial_curso_links: [] };
    const { cliente } = banco(tabelas); const anterior = (await resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL)).snapshot_fontes;
    const copia = structuredClone(anterior); tabelas.comercial_cursos[0].ativo = false;
    const conferida = await tratarAcaoDadosEmailIA({ acao: "conferir_fontes", snapshot_fontes: anterior }, { cliente, usuarioId: CURSO, urlPublica: URL });
    expect(conferida?.comparacao).toMatchObject({ estado: "indisponivel" }); expect(anterior).toEqual(copia);
    await expect(resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL)).rejects.toThrow("catálogo ativo");
  });
  it("detecta conteúdo do playbook, URL do link, texto da campanha e marca sem timestamps", async () => {
    const tabelas = {
      comercial_cursos: [{ id: CURSO, nome: "Curso", ativo: true }],
      comercial_curso_playbook: [{ curso_id: CURSO, ativo: true, definicao: "Definição inicial" }],
      comercial_curso_links: [{ curso_id: CURSO, ativo: true, titulo: "Inscrição", url: "https://inscricao.test/a", tipo: "inscricao" }],
      email_campanhas: [{ id: CAMPANHA, nome: "Campanha", template_id: "template", segmento_id: "segmento" }],
      email_templates: [{ id: "template", corpo_texto: "Texto anterior" }], email_segmentos: [{ id: "segmento", nome: "Interessados" }],
      brand_profiles: [{ id: MARCA, brand_name: "Marca", is_active: true, tom_de_voz: "formal" }],
    };
    const { cliente } = banco(tabelas); const selecao = { curso_id: CURSO, campanha_id: CAMPANHA, marca_id: MARCA };
    const anterior = (await resolverContextoEmailIA(cliente, selecao, URL)).snapshot_fontes;
    tabelas.comercial_curso_playbook[0].definicao = "Outra definição"; tabelas.comercial_curso_links[0].url = "https://inscricao.test/b";
    tabelas.email_templates[0].corpo_texto = "Outro texto"; tabelas.brand_profiles[0].tom_de_voz = "direto";
    const atual = (await resolverContextoEmailIA(cliente, selecao, URL)).snapshot_fontes;
    expect(compararFontesEmailIA(anterior, atual).alteracoes.map(a => a.tipo)).toEqual(["playbook", "links", "campanha", "marca"]);
  });
  it("contexto grande guarda só fontes usadas, com prévias declaradas e hashes completos", async () => {
    const { cliente } = banco({ comercial_cursos: [{ id: CURSO, nome: "Curso", ativo: true }],
      comercial_curso_playbook: [{ curso_id: CURSO, ativo: true, definicao: "á".repeat(3000), descricao_detalhada: "é".repeat(5000), publico_alvo: "í".repeat(3000), habilidades: "ó".repeat(3000), objetivos_profissionais: "ú".repeat(3000), professores_destaques: "ç".repeat(3000) }],
      comercial_curso_links: Array.from({ length: 50 }, (_, n) => ({ curso_id: CURSO, ativo: true, titulo: `Link ${n}`, tipo: "inscricao", url: `https://inscricao.test/${"a".repeat(1000)}${n}` })),
      brand_profiles: [{ id: MARCA, brand_name: "MARCA_FORA_DO_LIMITE", is_active: true }],
    });
    const contexto = await resolverContextoEmailIA(cliente, { curso_id: CURSO, marca_id: MARCA }, URL);
    expect(contexto.texto.length).toBeLessThanOrEqual(28000); expect(contexto.texto).not.toContain("MARCA_FORA_DO_LIMITE");
    expect(contexto.snapshot_fontes.fontes.some(f => f.tipo === "marca")).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(contexto.snapshot_fontes)).byteLength).toBeLessThanOrEqual(MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA);
    expect(contexto.snapshot_fontes.fontes.some(f => f.campos_resumidos.length)).toBe(true);
  });
  it("dados indisponíveis do banco não se tornam fonte removida nem contexto conferido", async () => {
    const { cliente } = banco({ comercial_cursos: [{ id: CURSO, nome: "Curso", ativo: true }], comercial_curso_playbook: [], comercial_curso_links: [] });
    const anterior = (await resolverContextoEmailIA(cliente, { curso_id: CURSO }, URL)).snapshot_fontes;
    await expect(tratarAcaoDadosEmailIA({ acao: "conferir_fontes", snapshot_fontes: anterior }, { cliente: banco({}, "comercial_cursos").cliente, usuarioId: CURSO, urlPublica: URL })).rejects.toMatchObject({ status: 503 });
    const invalido = banco({}); await expect(tratarAcaoDadosEmailIA({ acao: "conferir_fontes", snapshot_fontes: { ...anterior, selecao: { curso_id: "outro" } } }, { cliente: invalido.cliente, usuarioId: CURSO, urlPublica: URL })).rejects.toThrow(); expect(invalido.consultas).toHaveLength(0);
  });
});

describe("biblioteca aprovada de imagens", () => {
  it("valida aprovação e marca novamente a cada geração", async () => {
    const { cliente } = banco({ ai_content_pipeline: [{ id: MIDIA, user_id: CURSO, status: "approved", brand_profile_id: MARCA, generated_image_url: `${URL}/arte.png`, title: "Arte aprovada" }] });
    expect(await resolverImagensBibliotecaEmailIA(cliente, [`marketing:${MIDIA}`], { marca_id: MARCA }, URL, CURSO)).toEqual([{ id: `marketing:${MIDIA}`, nome: "Arte aprovada", url: `${URL}/arte.png`, origem: "Marketing · aprovado", marca_id: MARCA }]);
    await expect(resolverImagensBibliotecaEmailIA(cliente, [`marketing:${MIDIA}`], { marca_id: CURSO }, URL, CURSO)).rejects.toThrow("aprovada");
    await expect(resolverImagensBibliotecaEmailIA(cliente, [`marketing:${MIDIA}`], {}, URL, MARCA)).rejects.toThrow("aprovada");
    const reprovado = banco({ ai_content_pipeline: [{ id: MIDIA, user_id: CURSO, status: "rejected", generated_image_url: `${URL}/arte.png` }] });
    await expect(resolverImagensBibliotecaEmailIA(reprovado.cliente, [`marketing:${MIDIA}`], {}, URL, CURSO)).rejects.toThrow("aprovada");
  });
  it("recusa URL arbitrária, imagens duplicadas e curso fora da seleção", async () => {
    const { cliente, consultas } = banco({});
    await expect(resolverImagensBibliotecaEmailIA(cliente, [`${URL}/arbitraria.png`], {}, URL, CURSO)).rejects.toThrow();
    await expect(resolverImagensBibliotecaEmailIA(cliente, [`marketing:${MIDIA}`, `marketing:${MIDIA}`], {}, URL, CURSO)).rejects.toThrow();
    await expect(resolverImagensBibliotecaEmailIA(cliente, [`curso:${CURSO}:banner`], { curso_id: MARCA }, URL, CURSO)).rejects.toThrow("outro curso");
    expect(consultas).toHaveLength(0);
  });
  it.each(["javascript:alert(1)", "http://exemplo.test/img.png", "https://exemplo.test/img.svg", "https://exemplo.test/img.PNG?X-Amz-Signature=privada", "https://exemplo.test/storage/v1/object/sign/imagens/arte.png?token=privado", "https://usuario:senha@exemplo.test/img.png", "data:image/png;base64,AA=="])("recusa URL executável, temporária ou privada: %s", url => {
    expect(urlImagemBiblioteca(url)).toBeNull();
  });
});
