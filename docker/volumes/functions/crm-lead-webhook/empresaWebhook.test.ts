import { describe, expect, it } from "vitest";
import { codigoErroEmpresa, dadosDaEmpresa, falhaDaEmpresa, responsavelDaEmpresa } from "./empresaWebhook.ts";

const payload: Record<string, string> = { Empresa: "  Cooperativa Sintética ", Site: "coop.example", Vazio: "" };
const resolver = (v: string) => v.replace(/\{webhook=([^}]+)\}/g, (_, k) => payload[k] ?? "");

describe("dadosDaEmpresa — o que a aba manda para o banco", () => {
  it("separa o nome (localizador) dos campos que só preenchem vazio", () => {
    expect(dadosDaEmpresa([
      { campo: "nome", valor: "{webhook=Empresa}" },
      { campo: "dominio", valor: "{webhook=Site}" },
      { campo: "cidade", valor: "{webhook=Vazio}" },
    ], resolver)).toEqual({ nome: "Cooperativa Sintética", campos: { dominio: "coop.example" } });
  });
  it("campo fora da lista suportada não vai (nem localização pessoal com nome de empresa)", () => {
    expect(dadosDaEmpresa([{ campo: "endereco", valor: "Rua X" }, { campo: "cnpj", valor: "123" }], resolver))
      .toEqual({ nome: null, campos: {} });
  });
  it("sem campos (confirmação) = nome nulo, para o banco usar o vínculo", () => {
    expect(dadosDaEmpresa(undefined, resolver)).toEqual({ nome: null, campos: {} });
  });
  it("linha repetida: vale a primeira com valor", () => {
    expect(dadosDaEmpresa([{ campo: "nome", valor: "{webhook=Vazio}" }, { campo: "nome", valor: "B" }, { campo: "nome", valor: "C" }], resolver).nome).toBe("B");
  });
});

describe("responsavelDaEmpresa", () => {
  it("só usuário fixo vira dono; rodízio/nenhum não", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(responsavelDaEmpresa({ estrategia: "usuario", usuarioId: id })).toBe(id);
    expect(responsavelDaEmpresa({ estrategia: "sequencial", usuarios: [id] })).toBeNull();
    expect(responsavelDaEmpresa({ estrategia: "usuario", usuarioId: "não-é-uuid" })).toBeNull();
    expect(responsavelDaEmpresa(undefined)).toBeNull();
  });
});

describe("falha da empresa vira resposta honesta", () => {
  it("traduz o código do banco", () => {
    expect(codigoErroEmpresa("EMPRESA_AMBIGUA")).toBe("EMPRESA_AMBIGUA");
    expect(codigoErroEmpresa("EMPRESA_DIVERGENTE")).toBe("EMPRESA_DIVERGENTE");
    expect(codigoErroEmpresa("fetch failed")).toBe("EMPRESA_INDISPONIVEL");
  });
  it("nunca devolve 2xx; falta de dado é 4xx e falha passageira é 503", () => {
    expect(falhaDaEmpresa("EMPRESA_NAO_INFORMADA").status).toBe(422);
    expect(falhaDaEmpresa("EMPRESA_AMBIGUA").status).toBe(409);
    expect(falhaDaEmpresa("EMPRESA_ARQUIVADA").status).toBe(409);
    expect(falhaDaEmpresa("EMPRESA_DIVERGENTE").status).toBe(409);
    expect(falhaDaEmpresa("EMPRESA_INDISPONIVEL").status).toBe(503);
  });
  it("empresa divergente não revela a empresa já vinculada na mensagem", () => {
    expect(falhaDaEmpresa("EMPRESA_DIVERGENTE")).toEqual(falhaDaEmpresa("EMPRESA_AMBIGUA"));
  });
});
