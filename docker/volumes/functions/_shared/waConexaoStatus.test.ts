import { afterEach, describe, expect, it, vi } from "vitest";
import { atualizarStatusWaConexao } from "./waConexaoStatus.ts";

const QUEDA_ANTERIOR = "2026-09-11T10:00:00.000Z";
const OK_ANTERIOR = "2026-09-11T10:01:00.000Z";
const AGORA = "2026-09-11T11:00:00.000Z";

type Linha = Record<string, unknown> & { id: string; status_conexao: string };

/** Simula os predicados do UPDATE sobre a linha atual, inclusive entre requisições. */
function bancoEmMemoria(
  inicial: Partial<Linha> = {},
  antesDeAtualizar?: (tentativa: number, linha: Linha) => string | void,
) {
  const linha: Linha = {
    id: "linha-1",
    status_conexao: "desconectado",
    ultimo_status_em: QUEDA_ANTERIOR,
    alerta_visto_em: OK_ANTERIOR,
    numero: "5546999990000",
    qrcode: null,
    paircode: null,
    ...inicial,
  };
  let tentativas = 0;
  const admin = {
    from: () => ({
      update(patch: Record<string, unknown>) {
        const filtros: Array<(registro: Linha) => boolean> = [];
        const executar = async () => {
          const erro = antesDeAtualizar?.(++tentativas, linha);
          if (erro) return { data: null, error: { message: erro } };
          if (!filtros.every((filtro) => filtro(linha))) return { data: [], error: null };
          Object.assign(linha, patch);
          return { data: [{ id: linha.id }], error: null };
        };
        const consulta = {
          eq(coluna: string, valor: unknown) {
            filtros.push((registro) => registro[coluna] === valor);
            return consulta;
          },
          neq(coluna: string, valor: unknown) {
            filtros.push((registro) => registro[coluna] !== valor);
            return consulta;
          },
          select: executar,
          then: (resolver: (valor: Awaited<ReturnType<typeof executar>>) => unknown) => executar().then(resolver),
        };
        return consulta;
      },
    }),
  } as unknown as Parameters<typeof atualizarStatusWaConexao>[0];
  return { admin, linha };
}

afterEach(() => vi.useRealTimers());

describe("atualizarStatusWaConexao", () => {
  it("repetir a queda reconhecida preserva o OK e o horário, mesmo com número atualizado", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    const { admin, linha } = bancoEmMemoria();

    expect(await atualizarStatusWaConexao(admin, linha.id, "desconectado", { numero: "5546999991111" })).toBe(false);

    expect(linha).toMatchObject({
      status_conexao: "desconectado",
      ultimo_status_em: QUEDA_ANTERIOR,
      alerta_visto_em: OK_ANTERIOR,
      numero: "5546999991111",
    });
  });

  it("uma reconexão seguida de nova queda renova o horário e deixa o OK anterior para trás", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    const { admin, linha } = bancoEmMemoria({ qrcode: "qr-antigo", paircode: "123456" });

    expect(await atualizarStatusWaConexao(admin, linha.id, "conectado")).toBe(true);
    expect(linha).toMatchObject({ status_conexao: "conectado", ultimo_status_em: AGORA, qrcode: null, paircode: null });

    const novaQueda = "2026-09-11T11:01:00.000Z";
    vi.setSystemTime(novaQueda);
    expect(await atualizarStatusWaConexao(admin, linha.id, "desconectado")).toBe(true);
    expect(linha).toMatchObject({
      status_conexao: "desconectado", ultimo_status_em: novaQueda, alerta_visto_em: OK_ANTERIOR,
    });
  });

  it("renova QR e pareamento sem inventar transição enquanto continua conectando", async () => {
    const { admin, linha } = bancoEmMemoria({ status_conexao: "conectando", qrcode: "qr-antigo" });

    expect(await atualizarStatusWaConexao(admin, linha.id, "conectando", { qrcode: "qr-novo", paircode: "654321" })).toBe(false);
    expect(linha).toMatchObject({ qrcode: "qr-novo", paircode: "654321", ultimo_status_em: QUEDA_ANTERIOR });
  });

  it("limpa QR remanescente de linha conectada sem renovar o horário", async () => {
    const { admin, linha } = bancoEmMemoria({ status_conexao: "conectado", qrcode: "qr-antigo", paircode: "123456" });

    expect(await atualizarStatusWaConexao(admin, linha.id, "conectado")).toBe(false);
    expect(linha).toMatchObject({ qrcode: null, paircode: null, ultimo_status_em: QUEDA_ANTERIOR });
  });

  it("dois eventos da mesma queda concorrentes registram apenas a primeira transição", async () => {
    vi.useFakeTimers().setSystemTime(AGORA);
    const { admin, linha } = bancoEmMemoria({ status_conexao: "conectado" });

    const primeiro = atualizarStatusWaConexao(admin, linha.id, "desconectado");
    vi.setSystemTime("2026-09-11T11:00:01.000Z");
    const repetido = atualizarStatusWaConexao(admin, linha.id, "desconectado");

    expect(await Promise.all([primeiro, repetido])).toEqual([true, false]);
    expect(linha).toMatchObject({ status_conexao: "desconectado", ultimo_status_em: AGORA, alerta_visto_em: OK_ANTERIOR });
  });

  it("refresh de evento antigo não limpa QR de uma reconexão iniciada entre os UPDATEs", async () => {
    const { admin, linha } = bancoEmMemoria({ status_conexao: "conectado" }, (tentativa, atual) => {
      if (tentativa === 2) Object.assign(atual, { status_conexao: "conectando", qrcode: "qr-nova-reconexao", ultimo_status_em: AGORA });
    });

    expect(await atualizarStatusWaConexao(admin, linha.id, "conectado")).toBe(false);
    expect(linha).toMatchObject({ status_conexao: "conectando", qrcode: "qr-nova-reconexao", ultimo_status_em: AGORA });
  });

  it("propaga falha ao persistir a transição, sem declarar sucesso", async () => {
    const { admin, linha } = bancoEmMemoria({ status_conexao: "conectado" }, () => "banco indisponível");

    await expect(atualizarStatusWaConexao(admin, linha.id, "desconectado")).rejects.toThrow("Falha ao atualizar status da linha: banco indisponível");
    expect(linha.status_conexao).toBe("conectado");
  });

  it("propaga falha no refresh de metadados mesmo sem transição", async () => {
    const { admin, linha } = bancoEmMemoria({}, (tentativa) => tentativa === 2 ? "banco indisponível" : undefined);

    await expect(atualizarStatusWaConexao(admin, linha.id, "desconectado", { numero: "5546999991111" }))
      .rejects.toThrow("Falha ao atualizar dados da linha: banco indisponível");
    expect(linha).toMatchObject({ numero: "5546999990000", ultimo_status_em: QUEDA_ANTERIOR });
  });
});
