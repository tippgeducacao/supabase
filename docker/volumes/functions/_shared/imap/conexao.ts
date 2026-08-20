/**
 * Abertura de socket — a única parte da pilha IMAP/SMTP que toca a plataforma.
 *
 * Fica isolada aqui de propósito: `client.ts` e `smtp.ts` recebem a conexão pronta e
 * por isso continuam testáveis sem rede. Quem importa este arquivo está em runtime Deno.
 *
 * Verificado no edge-runtime v1.71.2 da VPS em 2026-08-20: `Deno.connectTls` existe e
 * completa handshake contra IMAP 993.
 */
import { ClienteImap, ErroImapRede } from "./client.ts";

export type ModoTls = "ssl" | "starttls";

export interface AlvoConexao {
  host: string;
  port: number;
  tls: ModoTls;
}

const TIMEOUT_PADRAO_MS = 20_000;

interface ApiDeno {
  connect: (o: { hostname: string; port: number }) => Promise<Deno.TcpConn>;
  connectTls: (o: { hostname: string; port: number }) => Promise<Deno.TlsConn>;
  startTls: (c: Deno.TcpConn, o: { hostname: string }) => Promise<Deno.TlsConn>;
}

function api(): ApiDeno {
  const d = (globalThis as { Deno?: unknown }).Deno as ApiDeno | undefined;
  if (!d?.connectTls) {
    throw new ErroImapRede("Runtime sem suporte a TCP — impossível falar IMAP/SMTP daqui.");
  }
  return d;
}

/**
 * Um connect que desiste. Sem isto, servidor que aceita o TCP e nunca responde
 * segura a edge function até o teto de tempo dela — e o usuário vê "carregando"
 * até o navegador cansar, sem erro nenhum.
 */
export async function comPrazo<T>(
  tarefa: Promise<T>,
  ms: number,
  oQue: string,
): Promise<T> {
  let id: number | undefined;
  const estouro = new Promise<never>((_, rejeitar) => {
    id = setTimeout(
      () => rejeitar(new ErroImapRede(`${oQue} não respondeu em ${Math.round(ms / 1000)}s.`)),
      ms,
    ) as unknown as number;
  });
  try {
    return await Promise.race([tarefa, estouro]);
  } finally {
    if (id !== undefined) clearTimeout(id);
  }
}

/** Socket cru, já com TLS resolvido conforme o modo. */
export async function abrirSocket(
  alvo: AlvoConexao,
  timeoutMs = TIMEOUT_PADRAO_MS,
): Promise<Deno.TlsConn | Deno.TcpConn> {
  const d = api();
  const oQue = `${alvo.host}:${alvo.port}`;
  try {
    if (alvo.tls === "ssl") {
      return await comPrazo(d.connectTls({ hostname: alvo.host, port: alvo.port }), timeoutMs, oQue);
    }
    return await comPrazo(d.connect({ hostname: alvo.host, port: alvo.port }), timeoutMs, oQue);
  } catch (e) {
    if (e instanceof ErroImapRede) throw e;
    throw new ErroImapRede(`Não foi possível conectar em ${oQue}: ${(e as Error).message}`);
  }
}

export interface SessaoImap {
  cliente: ClienteImap;
  fechar: () => Promise<void>;
}

/** Conecta, faz STARTTLS se for o caso, e loga. Devolve a sessão pronta para uso. */
export async function abrirImap(
  alvo: AlvoConexao,
  usuario: string,
  senha: string,
  timeoutMs = TIMEOUT_PADRAO_MS,
): Promise<SessaoImap> {
  const d = api();
  let conn = await abrirSocket(alvo, timeoutMs);
  let cliente = new ClienteImap(conn);
  await comPrazo(cliente.saudacao(), timeoutMs, `${alvo.host} (saudação)`);

  if (alvo.tls === "starttls") {
    const r = await cliente.executar("STARTTLS");
    if (r.status !== "OK") {
      throw new ErroImapRede(`Servidor recusou STARTTLS: ${r.texto}`);
    }
    // Depois do STARTTLS a sessão RECOMEÇA: nova conexão cifrada, contador de tag
    // zerado, e o servidor não repete a saudação. Por isso um cliente novo.
    conn = await d.startTls(conn as Deno.TcpConn, { hostname: alvo.host });
    cliente = new ClienteImap(conn);
  }

  await comPrazo(cliente.login(usuario, senha), timeoutMs, `${alvo.host} (login)`);
  await cliente.carregarCapacidades();

  return {
    cliente,
    fechar: async () => {
      await cliente.sair();
      try {
        conn.close();
      } catch {
        // conexão já caiu — nada a fazer
      }
    },
  };
}
