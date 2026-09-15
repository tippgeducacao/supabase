import { describe, expect, it } from "vitest";
import { compararFontesEmailIA, criarSnapshotFontesEmailIA, MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA, validarSnapshotFontesEmailIA, type FonteContextoEmailIA } from "./aiFontes";
const CURSO = "11111111-1111-4111-8111-111111111111";
const OUTRO = "22222222-2222-4222-8222-222222222222";
const fonte = (campos: Record<string, string> = { Nome: "Curso", Resumo: "Formação" }): FonteContextoEmailIA => ({ tipo: "curso", id: CURSO, rotulo: "Curso cadastrado", estado: "disponivel", campos });
const snapshot = (f: FonteContextoEmailIA[] = [fonte()], data = "2026-09-14T12:00:00Z") => criarSnapshotFontesEmailIA({ curso_id: CURSO }, f, new Date(data));
describe("proveniência limitada de fontes do e-mail", () => {
  it("hash e comparação ignoram ordem de campos e momento da consulta", async () => {
    const a = await snapshot(); const b = await snapshot([fonte({ Resumo: "Formação", Nome: "Curso" })], "2026-09-15T12:00:00Z");
    expect(a.fontes[0].hash).toBe(b.fontes[0].hash); expect(compararFontesEmailIA(a, b)).toEqual({ estado: "sem_alteracoes", alteracoes: [] });
  });
  it("detecta mudança de conteúdo mesmo com timestamp idêntico", async () => {
    const a = await snapshot(); const b = await snapshot([fonte({ Nome: "Curso", Resumo: "Conteúdo atualizado" })]);
    expect(compararFontesEmailIA(a, b)).toMatchObject({ estado: "alterado", alteracoes: [{ tipo: "curso", situacao: "alterada", campos: [{ campo: "Resumo", anterior: "Formação", atual: "Conteúdo atualizado" }] }] });
  });
  it("compara identidades, sem confundir reordenação com remoção", async () => {
    const playbook: FonteContextoEmailIA = { ...fonte({ Público: "Veterinários" }), tipo: "playbook" };
    const a = await snapshot([fonte(), playbook]); const b = await snapshot([playbook, fonte()]);
    expect(compararFontesEmailIA(a, b).estado).toBe("sem_alteracoes");
    expect(compararFontesEmailIA(a, await snapshot()).alteracoes).toMatchObject([{ tipo: "playbook", situacao: "removida" }]);
    expect(compararFontesEmailIA(await snapshot(), a).alteracoes).toMatchObject([{ tipo: "playbook", situacao: "adicionada" }]);
  });
  it("preserva estado indisponível em conferências sucessivas", async () => {
    const indisponivel = await snapshot([{ ...fonte({}), estado: "indisponivel" }]);
    expect(compararFontesEmailIA(await snapshot(), indisponivel)).toMatchObject({ estado: "indisponivel", alteracoes: [{ situacao: "indisponivel" }] });
    expect(compararFontesEmailIA(indisponivel, indisponivel)).toEqual({ estado: "indisponivel", alteracoes: [] });
  });
  it("sem fontes não equivale a confirmar referências, PDF, preço ou matrícula", async () => {
    const vazio = await criarSnapshotFontesEmailIA({}, []);
    expect(compararFontesEmailIA(vazio, vazio)).toEqual({ estado: "sem_fontes", alteracoes: [] });
    expect(vazio.nao_verificaveis.map(a => a.tipo)).toEqual(["preco", "prazo", "vagas", "desconto"]);
    expect(vazio.nao_verificaveis.find(a => a.tipo === "prazo")?.motivo).toContain("Vigência");
  });
  it("limita24KB com prévias explícitas sem perder mudanças fora delas", async () => {
    const inicio = "Formação veterinária. ".repeat(1000);
    const a = await snapshot([fonte({ Conteúdo: inicio + "Condição anterior." })]);
    const b = await snapshot([fonte({ Conteúdo: inicio + "Condição posterior." })]);
    expect(new TextEncoder().encode(JSON.stringify(a)).byteLength).toBeLessThanOrEqual(MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA);
    expect(a.fontes[0].campos_resumidos).toEqual(["Conteúdo"]); expect(a.fontes[0].campos.Conteúdo).not.toContain("Condição anterior");
    expect(compararFontesEmailIA(a, b).alteracoes[0].campos[0]).toMatchObject({ campo: "Conteúdo", anterior_resumido: true, atual_resumido: true });
  });
  it("campos integrais prevalecem sobre hash adulterado do navegador", async () => {
    const a = await snapshot(); const b = structuredClone(a); b.fontes[0].campos.Resumo = "Outro conteúdo";
    expect(compararFontesEmailIA(a, b).estado).toBe("alterado");
  });
  it("conserva cobertura parcial sem substituir a identidade da fonte original", async () => {
    const a = await snapshot(); const parcial = validarSnapshotFontesEmailIA({ ...a, cobertura_parcial: true });
    expect(parcial.cobertura_parcial).toBe(true); expect(parcial.selecao).toEqual(a.selecao);
    expect(compararFontesEmailIA(parcial, a)).toEqual({ estado: "sem_alteracoes", alteracoes: [] });
    expect(a).not.toHaveProperty("cobertura_parcial");
    for (const cobertura_parcial of [false, "true", {}]) expect(() => validarSnapshotFontesEmailIA({ ...a, cobertura_parcial })).toThrow();
  });
  it("reserva espaço para marcar cobertura parcial quando o registro chega perto de 24 KB", async () => {
    const pequeno = await snapshot([fonte({ Conteúdo: "a" })]);
    const tamanho = MAX_BYTES_SNAPSHOT_FONTES_EMAIL_IA - new TextEncoder().encode(JSON.stringify(pequeno)).byteLength - 15;
    const limite = await snapshot([fonte({ Conteúdo: "a".repeat(tamanho) })]);
    expect(() => validarSnapshotFontesEmailIA({ ...limite, cobertura_parcial: true })).not.toThrow();
  });
  it("recusa identidades alheias, duplicatas, campos/hash inválidos e dados extras", async () => {
    const a = await snapshot();
    for (const b of [
      { ...a, selecao: { curso_id: OUTRO } }, { ...a, fontes: [...a.fontes, ...a.fontes] },
      { ...a, fontes: [{ ...a.fontes[0], hash: "adulterado" }] },
      { ...a, fontes: [{ ...a.fontes[0], campos_resumidos: ["campo inexistente"] }] },
      { ...a, fontes: [{ ...a.fontes[0], hashes_campos: {} }] },
      { ...a, documento: "conteúdo fora do contrato" },
      { ...a, nao_verificaveis: [...a.nao_verificaveis, a.nao_verificaveis[0]] },
    ]) expect(() => validarSnapshotFontesEmailIA(b)).toThrow();
    const outro = await criarSnapshotFontesEmailIA({ curso_id: OUTRO }, [{ ...fonte(), id: OUTRO }]);
    expect(() => compararFontesEmailIA(a, outro)).toThrow("seleções diferentes");
  });
});
