/**
 * Régua das ações da Inbox numa caixa IMAP.
 *
 * Cada bloco aqui congela um defeito real que a primeira versão do
 * `imap-mark-read` tinha, e que só apareceria depois da primeira caixa conectada:
 *  1. UID de Enviados aplicado na INBOX (mexeria na mensagem ERRADA);
 *  2. `pasta` da thread nunca escrita (arquivar/excluir não tirava da lista);
 *  3. excluir e spam caindo na pasta de Arquivo.
 */
import { describe, expect, it } from "vitest";
import {
  agruparUidsPorPasta,
  avisoSemPasta,
  destinoDaAcao,
  pastaDaChave,
  patchLocalDaAcao,
  soLocal,
} from "./marcacao.ts";

const CAIXA = "9110bf0f-2f64-4abd-a516-3d9205b6a583";

describe("pastaDaChave", () => {
  it("lê a pasta da chave gravada pelo sync", () => {
    expect(pastaDaChave(`imap:${CAIXA}:inbox:42`)).toBe("inbox");
    expect(pastaDaChave(`imap:${CAIXA}:sent:42`)).toBe("sent");
  });

  it("não devolve pasta para a chave provisória do imap-send", () => {
    // `enviada` é gravada antes de o sync ler a mensagem de volta: não há UID ainda.
    expect(pastaDaChave(`imap:${CAIXA}:enviada:<abc@ppgeducacao.com.br>`)).toBeNull();
  });

  it("ignora chave de outro motor ou lixo", () => {
    expect(pastaDaChave("18f2c9a1b3d4")).toBeNull(); // id do Gmail
    expect(pastaDaChave(null)).toBeNull();
    expect(pastaDaChave("")).toBeNull();
    expect(pastaDaChave("imap:só-isso")).toBeNull();
  });
});

describe("agruparUidsPorPasta", () => {
  it("separa INBOX de Enviados — UID é por pasta, não por caixa", () => {
    const grupos = agruparUidsPorPasta([
      { gmail_message_id: `imap:${CAIXA}:inbox:7`, imap_uid: 7 },
      { gmail_message_id: `imap:${CAIXA}:sent:5`, imap_uid: 5 },
      { gmail_message_id: `imap:${CAIXA}:inbox:9`, imap_uid: 9 },
    ]);
    expect(grupos.inbox).toEqual([7, 9]);
    expect(grupos.sent).toEqual([5]);
  });

  it("o UID 5 dos Enviados NÃO entra no lote da INBOX", () => {
    // Este é o defeito: com a INBOX selecionada, `UID STORE 5` acertaria uma
    // mensagem de outra conversa — a que por acaso tem UID 5 na INBOX.
    const grupos = agruparUidsPorPasta([
      { gmail_message_id: `imap:${CAIXA}:sent:5`, imap_uid: 5 },
    ]);
    expect(grupos.inbox).toEqual([]);
  });

  it("descarta mensagem sem UID, com UID zero e a provisória", () => {
    const grupos = agruparUidsPorPasta([
      { gmail_message_id: `imap:${CAIXA}:inbox:3`, imap_uid: null },
      { gmail_message_id: `imap:${CAIXA}:inbox:0`, imap_uid: 0 },
      { gmail_message_id: `imap:${CAIXA}:enviada:<x@y>`, imap_uid: null },
      { gmail_message_id: "18f2c9a1b3d4", imap_uid: 12 },
    ]);
    expect(grupos).toEqual({ inbox: [], sent: [] });
  });

  it("não repete UID quando a mesma mensagem aparece duas vezes", () => {
    const grupos = agruparUidsPorPasta([
      { gmail_message_id: `imap:${CAIXA}:inbox:4`, imap_uid: 4 },
      { gmail_message_id: `imap:${CAIXA}:inbox:4`, imap_uid: "4" },
    ]);
    expect(grupos.inbox).toEqual([4]);
  });

  it("aguenta lista vazia e nula", () => {
    expect(agruparUidsPorPasta([])).toEqual({ inbox: [], sent: [] });
    expect(agruparUidsPorPasta(undefined as never)).toEqual({ inbox: [], sent: [] });
  });
});

describe("patchLocalDaAcao", () => {
  const agora = "2026-08-20T18:00:00.000Z";

  it("escreve a PASTA, que é o que a lista da Inbox filtra", () => {
    expect(patchLocalDaAcao("archive", { agora })).toMatchObject({ arquivado: true, pasta: "archived" });
    expect(patchLocalDaAcao("trash", { agora })).toMatchObject({ arquivado: true, pasta: "trash" });
    expect(patchLocalDaAcao("spam", { agora })).toMatchObject({ arquivado: true, pasta: "spam" });
    expect(patchLocalDaAcao("unarchive", { agora })).toMatchObject({ arquivado: false, pasta: "inbox" });
  });

  it("lido/não lido não mexe em pasta nenhuma", () => {
    expect(patchLocalDaAcao("read", { agora })).toEqual({ updated_at: agora, nao_lido: false });
    expect(patchLocalDaAcao("unread", { agora })).toEqual({ updated_at: agora, nao_lido: true });
  });

  it("estrela e vínculo com tarefa são só do sistema", () => {
    expect(patchLocalDaAcao("star", { agora })).toEqual({ updated_at: agora, favoritado: true });
    expect(patchLocalDaAcao("unstar", { agora })).toEqual({ updated_at: agora, favoritado: false });
    expect(patchLocalDaAcao("link_task", { agora, taskId: "t-1" })).toEqual({ updated_at: agora, task_id: "t-1" });
    expect(patchLocalDaAcao("link_task", { agora })).toEqual({ updated_at: agora, task_id: null });
  });
});

describe("soLocal", () => {
  it("para as ações que o IMAP não tem", () => {
    expect(soLocal("star")).toBe(true);
    expect(soLocal("unstar")).toBe(true);
    expect(soLocal("link_task")).toBe(true);
    // Desarquivar precisaria do UID na pasta de Arquivo, que o MOVE já invalidou.
    expect(soLocal("unarchive")).toBe(true);
    expect(soLocal("read")).toBe(false);
    expect(soLocal("archive")).toBe(false);
    expect(soLocal("trash")).toBe(false);
  });
});

describe("destinoDaAcao", () => {
  const pastas = {
    pasta_arquivo: "INBOX.Archive",
    pasta_lixeira: "INBOX.Trash",
    pasta_spam: "INBOX.spam",
  };

  it("cada ação vai para a SUA pasta — excluir não é arquivar", () => {
    expect(destinoDaAcao("archive", pastas)).toEqual({ pasta: "INBOX.Archive", rotulo: "Arquivo" });
    expect(destinoDaAcao("trash", pastas)).toEqual({ pasta: "INBOX.Trash", rotulo: "Lixeira" });
    expect(destinoDaAcao("spam", pastas)).toEqual({ pasta: "INBOX.spam", rotulo: "Spam" });
  });

  it("devolve pasta nula quando o servidor não tem a pasta, sem cair no Arquivo", () => {
    const semNada = { pasta_arquivo: "INBOX.Archive" };
    expect(destinoDaAcao("trash", semNada)).toEqual({ pasta: null, rotulo: "Lixeira" });
    expect(destinoDaAcao("spam", semNada)).toEqual({ pasta: null, rotulo: "Spam" });
  });

  it("não move nada para ação que não é de movimento", () => {
    expect(destinoDaAcao("read", pastas)).toBeNull();
    expect(destinoDaAcao("star", pastas)).toBeNull();
    expect(destinoDaAcao("unarchive", pastas)).toBeNull();
  });

  it("o aviso diz qual pasta faltou", () => {
    expect(avisoSemPasta("Lixeira")).toContain("Lixeira");
    expect(avisoSemPasta("Spam")).toContain("Spam");
  });
});
