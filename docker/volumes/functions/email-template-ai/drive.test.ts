import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { extrairPastaDriveEmailIA, listarPastaDriveEmailIA, sincronizarPastaDriveEmailIA, tipoRealDaImagemDriveEmailIA, tratarAcaoDriveEmailIA } from "./drive";

const PASTA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MARCA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USUARIO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHAVE = "chave-drive-de-teste";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const HTML = new TextEncoder().encode("<html>não sou imagem</html>");

type Linha = Record<string, unknown>;
function banco(tabelas: Record<string, Linha[]>, falhas: Record<string, string> = {}) {
  const enviados: Array<{ caminho: string; mime: string; bytes: number }> = [];
  let sequencia = 0;
  const cliente = {
    from(tabela: string) {
      const dados = () => (tabelas[tabela] ??= []);
      const filtros: Array<[string, unknown]> = [];
      let dentro: [string, unknown[]] | null = null;
      let campos = "*";
      let operacao: "select" | "update" | "insert" | "upsert" = "select";
      let carga: Linha = {};
      const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v) && (!dentro || dentro[1].includes(l[dentro[0]]));
      function executar() {
        if (falhas[tabela]) return { data: null, error: { message: "falha", code: falhas[tabela] } };
        if (operacao === "update") {
          const alvos = dados().filter(casa);
          for (const l of alvos) Object.assign(l, carga);
          return { data: alvos.map(l => ({ ...l })), error: null };
        }
        if (operacao === "insert" || operacao === "upsert") {
          const existente = operacao === "upsert"
            ? dados().find(l => l.pasta_id === carga.pasta_id && l.arquivo_drive_id === carga.arquivo_drive_id) : undefined;
          if (existente) { Object.assign(existente, carga); return { data: [{ ...existente }], error: null }; }
          const nova = { id: `${tabela}-${++sequencia}`, ...carga };
          dados().push(nova);
          return { data: [{ ...nova }], error: null };
        }
        const filtradas = dados().filter(casa);
        return { data: filtradas.map(l => campos === "*" ? { ...l } : Object.fromEntries(campos.split(",").map(c => [c, l[c]]))), error: null };
      }
      const q = {
        select(c = "*") { campos = c; return q; },
        eq(c: string, v: unknown) { filtros.push([c, v]); return q; },
        in(c: string, v: unknown[]) { dentro = [c, v]; return q; },
        order() { return q; },
        range() { return q; },
        update(v: Linha) { operacao = "update"; carga = v; return q; },
        insert(v: Linha) { operacao = "insert"; carga = v; return q; },
        upsert(v: Linha) { operacao = "upsert"; carga = v; return q; },
        maybeSingle: async () => { const r = executar(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(executar()).then(resolve),
      };
      return q;
    },
    storage: {
      from: () => ({
        upload: async (caminho: string, bytes: Uint8Array, opcoes: Record<string, unknown>) => {
          enviados.push({ caminho, mime: String(opcoes.contentType), bytes: bytes.byteLength });
          return { error: null };
        },
        getPublicUrl: (caminho: string) => ({ data: { publicUrl: `https://api.exemplo.test/storage/v1/object/public/email-imagens/${caminho}` } }),
      }),
    },
  } as unknown as SupabaseClient;
  return { cliente, tabelas, enviados };
}

/** Responde como o Drive: uma lista (com páginas) e o conteúdo de cada arquivo. */
function driveFalso(paginas: Array<{ files: unknown[]; nextPageToken?: string }>, arquivos: Record<string, Uint8Array | number> = {}) {
  const chamadas: string[] = [];
  let pagina = 0;
  const buscar = (async (url: string | URL) => {
    const endereco = String(url);
    chamadas.push(endereco);
    if (endereco.includes("/files?")) {
      const atual = paginas[Math.min(pagina++, paginas.length - 1)];
      return new Response(JSON.stringify(atual), { headers: { "Content-Type": "application/json" } });
    }
    const id = endereco.match(/\/files\/([^?]+)\?/)?.[1] ?? "";
    const conteudo = arquivos[id];
    if (typeof conteudo === "number") return new Response("erro", { status: conteudo });
    return new Response(conteudo ?? PNG);
  }) as unknown as typeof fetch;
  return { buscar, chamadas };
}

const arquivoDrive = (id: string, extras: Record<string, unknown> = {}) => ({
  id, name: `${id}.png`, mimeType: "image/png", size: "1024", md5Checksum: "a".repeat(32),
  modifiedTime: "2026-09-20T12:00:00.000Z", imageMediaMetadata: { width: 1200, height: 628 }, ...extras,
});

describe("link da pasta do Drive", () => {
  it("aceita link de pasta, link com id e o id cru", () => {
    expect(extrairPastaDriveEmailIA("https://drive.google.com/drive/folders/1AbC_de-FGH2345678?usp=sharing")).toBe("1AbC_de-FGH2345678");
    expect(extrairPastaDriveEmailIA("https://drive.google.com/open?id=1AbC_de-FGH2345678")).toBe("1AbC_de-FGH2345678");
    expect(extrairPastaDriveEmailIA(" 1AbC_de-FGH2345678 ")).toBe("1AbC_de-FGH2345678");
  });
  it("recusa host de fora do Google, link sem id e vazio", () => {
    expect(() => extrairPastaDriveEmailIA("https://drive.google.com.invasor.test/folders/1AbC_de-FGH2345678")).toThrow(/Google Drive/);
    expect(() => extrairPastaDriveEmailIA("https://drive.google.com/drive/my-drive")).toThrow(/ID da pasta/);
    expect(() => extrairPastaDriveEmailIA("")).toThrow();
  });
});

describe("tipo real do arquivo", () => {
  it("identifica os formatos aceitos e recusa o que não é imagem", () => {
    expect(tipoRealDaImagemDriveEmailIA(PNG)).toBe("image/png");
    expect(tipoRealDaImagemDriveEmailIA(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg");
    expect(tipoRealDaImagemDriveEmailIA(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0]))).toBe("image/gif");
    expect(tipoRealDaImagemDriveEmailIA(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(tipoRealDaImagemDriveEmailIA(HTML)).toBeNull();
  });
});

describe("listagem da pasta", () => {
  it("segue as páginas e descarta o que não é imagem suportada", async () => {
    const { cliente } = banco({});
    const { buscar } = driveFalso([
      { files: [arquivoDrive("arq1234567"), { id: "pasta12345678", name: "Sub", mimeType: "application/vnd.google-apps.folder" }], nextPageToken: "p2" },
      { files: [arquivoDrive("arq7654321", { mimeType: "image/svg+xml" }), arquivoDrive("arq1122334")] },
    ]);
    const { arquivos, truncada } = await listarPastaDriveEmailIA("1AbC_de-FGH2345678", { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(arquivos.map(a => a.id)).toEqual(["arq1234567", "arq1122334"]);
    expect(arquivos[0]).toMatchObject({ mime: "image/png", largura: 1200, altura: 628, bytes: 1024 });
    expect(truncada).toBe(false);
  });
  it("traduz a recusa do Drive em instrução de compartilhamento", async () => {
    const { cliente } = banco({});
    const buscar = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(listarPastaDriveEmailIA("1AbC_de-FGH2345678", { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar }))
      .rejects.toThrow(/qualquer pessoa com o link/);
  });
  it("não fala com o Google sem chave configurada", async () => {
    const { cliente } = banco({});
    await expect(listarPastaDriveEmailIA("1AbC_de-FGH2345678", { cliente, usuarioId: USUARIO })).rejects.toThrow(/chave do Google Drive/);
  });
});

describe("sincronização da pasta", () => {
  const pastaCadastrada = () => ({ id: PASTA, nome: "Artes de e-mail", pasta_drive_id: "1AbC_de-FGH2345678", ativo: true });

  it("espelha no bucket e grava a URL do bucket, nunca a do Drive", async () => {
    const { cliente, tabelas, enviados } = banco({ email_ia_drive_pastas: [pastaCadastrada()], email_ia_drive_imagens: [] });
    const { buscar } = driveFalso([{ files: [arquivoDrive("arq1234567")] }]);
    const resumo = await sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(resumo).toMatchObject({ total: 1, novas: 1, ignoradas: 0, restantes: 0 });
    expect(enviados).toEqual([{ caminho: `drive/${PASTA}/arq1234567.png`, mime: "image/png", bytes: PNG.byteLength }]);
    const gravada = tabelas.email_ia_drive_imagens[0];
    expect(gravada.url).toBe(`https://api.exemplo.test/storage/v1/object/public/email-imagens/drive/${PASTA}/arq1234567.png`);
    expect(String(gravada.url)).not.toContain("google");
    expect(tabelas.email_ia_drive_pastas[0].sincronizado_em).toBeTruthy();
  });

  it("não rebaixa arquivo com o mesmo md5, mas acompanha o nome novo", async () => {
    const { cliente, tabelas } = banco({
      email_ia_drive_pastas: [pastaCadastrada()],
      email_ia_drive_imagens: [{ id: "img-1", pasta_id: PASTA, arquivo_drive_id: "arq1234567", md5: "a".repeat(32), url: "https://api.exemplo.test/x.png", ativo: true, nome: "nome antigo.png", largura: 1200, altura: 628 }],
    });
    const { buscar, chamadas } = driveFalso([{ files: [arquivoDrive("arq1234567")] }]);
    const resumo = await sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(resumo).toMatchObject({ inalteradas: 1, novas: 0, atualizadas: 0 });
    expect(chamadas.filter(c => c.includes("alt=media"))).toHaveLength(0);
    expect(tabelas.email_ia_drive_imagens[0].nome).toBe("arq1234567.png");
  });

  it("rebaixa quando o md5 mudou", async () => {
    const { cliente } = banco({
      email_ia_drive_pastas: [pastaCadastrada()],
      email_ia_drive_imagens: [{ id: "img-1", pasta_id: PASTA, arquivo_drive_id: "arq1234567", md5: "b".repeat(32), url: "https://api.exemplo.test/x.png", ativo: true, nome: "arq1234567.png" }],
    });
    const { buscar } = driveFalso([{ files: [arquivoDrive("arq1234567")] }]);
    expect(await sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar })).toMatchObject({ atualizadas: 1, novas: 0 });
  });

  it("desativa o que sumiu da pasta em vez de apagar", async () => {
    const { cliente, tabelas } = banco({
      email_ia_drive_pastas: [pastaCadastrada()],
      email_ia_drive_imagens: [{ id: "img-1", pasta_id: PASTA, arquivo_drive_id: "sumiu12345", md5: "c".repeat(32), url: "https://api.exemplo.test/x.png", ativo: true, nome: "sumiu.png" }],
    });
    const { buscar } = driveFalso([{ files: [arquivoDrive("arq1234567")] }]);
    const resumo = await sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(resumo.desativadas).toBe(1);
    expect(tabelas.email_ia_drive_imagens).toHaveLength(2);
    expect(tabelas.email_ia_drive_imagens.find(l => l.arquivo_drive_id === "sumiu12345")?.ativo).toBe(false);
  });

  it("listagem truncada não desativa imagem que não foi vista", async () => {
    const arquivos = Array.from({ length: 401 }, (_, n) => arquivoDrive(`arq${String(n).padStart(7, "0")}`, { md5Checksum: "d".repeat(32) }));
    const { cliente, tabelas } = banco({
      email_ia_drive_pastas: [pastaCadastrada()],
      email_ia_drive_imagens: [{ id: "img-1", pasta_id: PASTA, arquivo_drive_id: "arqUltimo00", md5: "d".repeat(32), url: "https://api.exemplo.test/x.png", ativo: true, nome: "ultima.png" }],
    });
    const { buscar } = driveFalso([{ files: arquivos }]);
    const resumo = await sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(resumo.truncada).toBe(true);
    expect(resumo.desativadas).toBe(0);
    expect(tabelas.email_ia_drive_imagens.find(l => l.arquivo_drive_id === "arqUltimo00")?.ativo).toBe(true);
  });

  it("respeita o orçamento da chamada e anuncia o que ficou para a próxima", async () => {
    const arquivos = Array.from({ length: 30 }, (_, n) => arquivoDrive(`arq${String(n).padStart(7, "0")}`, { md5Checksum: `${n}`.padStart(32, "e") }));
    const { cliente } = banco({ email_ia_drive_pastas: [pastaCadastrada()], email_ia_drive_imagens: [] });
    const { buscar } = driveFalso([{ files: arquivos }]);
    const resumo = await sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(resumo.novas).toBe(25);
    expect(resumo.restantes).toBe(5);
  });

  it("ignora arquivo grande demais, download recusado e conteúdo que não é imagem", async () => {
    const { cliente, tabelas, enviados } = banco({ email_ia_drive_pastas: [pastaCadastrada()], email_ia_drive_imagens: [] });
    const { buscar } = driveFalso([{
      files: [
        arquivoDrive("arqGrande01", { size: String(11 * 1024 * 1024), md5Checksum: "1".repeat(32) }),
        arquivoDrive("arqRecusado", { md5Checksum: "2".repeat(32) }),
        arquivoDrive("arqFalsoPng", { md5Checksum: "3".repeat(32) }),
      ],
    }, ], { arqRecusado: 404, arqFalsoPng: HTML });
    const resumo = await sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(resumo).toMatchObject({ total: 3, novas: 0, ignoradas: 3 });
    expect(enviados).toHaveLength(0);
    expect(tabelas.email_ia_drive_imagens).toHaveLength(0);
  });

  it("guarda o motivo da falha na pasta para a pessoa ver", async () => {
    const { cliente, tabelas } = banco({ email_ia_drive_pastas: [pastaCadastrada()], email_ia_drive_imagens: [] });
    const buscar = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(sincronizarPastaDriveEmailIA(PASTA, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar })).rejects.toThrow();
    expect(String(tabelas.email_ia_drive_pastas[0].sincronizacao_erro)).toMatch(/qualquer pessoa com o link/);
  });
});

describe("ações do painel", () => {
  it("ignora ação de outro assunto e recusa tudo sem chave configurada", async () => {
    const { cliente } = banco({});
    expect(await tratarAcaoDriveEmailIA({ acao: "listar_contextos" }, { cliente, usuarioId: USUARIO, chaveDrive: CHAVE })).toBeNull();
    await expect(tratarAcaoDriveEmailIA({ acao: "listar_pastas_drive" }, { cliente, usuarioId: USUARIO })).rejects.toThrow(/GOOGLE_DRIVE_API_KEY/);
  });

  it("confere a pasta no Drive antes de gravar o cadastro", async () => {
    const { cliente, tabelas } = banco({ email_ia_drive_pastas: [], email_ia_drive_imagens: [] });
    const buscar = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(tratarAcaoDriveEmailIA({ acao: "salvar_pasta_drive", nome: "Artes", link: "https://drive.google.com/drive/folders/1AbC_de-FGH2345678" },
      { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar })).rejects.toThrow(/qualquer pessoa com o link/);
    expect(tabelas.email_ia_drive_pastas).toHaveLength(0);
  });

  it("cadastra, já sincroniza e devolve a lista com a contagem", async () => {
    const { cliente, tabelas } = banco({ email_ia_drive_pastas: [], email_ia_drive_imagens: [] });
    const { buscar } = driveFalso([{ files: [arquivoDrive("arq1234567")] }]);
    const resposta = await tratarAcaoDriveEmailIA(
      { acao: "salvar_pasta_drive", nome: "Artes de e-mail", link: "https://drive.google.com/drive/folders/1AbC_de-FGH2345678", marca_id: MARCA },
      { cliente, usuarioId: USUARIO, chaveDrive: CHAVE, buscar });
    expect(tabelas.email_ia_drive_pastas[0]).toMatchObject({ pasta_drive_id: "1AbC_de-FGH2345678", marca_id: MARCA, criado_por: USUARIO });
    expect((resposta?.pastas as Array<Record<string, unknown>>)[0]).toMatchObject({ nome: "Artes de e-mail", imagens: 1 });
    expect(resposta?.resumo).toMatchObject({ novas: 1 });
  });

  it("recusa nome vazio e marca inválida", async () => {
    const { cliente } = banco({ email_ia_drive_pastas: [] });
    const deps = { cliente, usuarioId: USUARIO, chaveDrive: CHAVE };
    await expect(tratarAcaoDriveEmailIA({ acao: "salvar_pasta_drive", nome: "  ", link: "1AbC_de-FGH2345678" }, deps)).rejects.toThrow(/nome/);
    await expect(tratarAcaoDriveEmailIA({ acao: "salvar_pasta_drive", nome: "Artes", marca_id: "x", link: "1AbC_de-FGH2345678" }, deps)).rejects.toThrow(/Marca/);
  });
});
