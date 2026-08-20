/**
 * Cola entre o banco e a pilha IMAP: carrega a config da caixa, decifra a senha,
 * abre sessão e traduz erro de protocolo em estado que a Inbox entende.
 */
import { chaveDoAmbiente, decifrar } from "./cripto.ts";
import { abrirImap, abrirSocket, comPrazo, type ModoTls, type SessaoImap } from "./conexao.ts";
import { ErroImapAuth, ErroImapRede } from "./client.ts";
import { ClienteSmtp, ErroSmtpAuth } from "./smtp.ts";

export interface ConfigImap {
  id: string;
  caixa_id: string;
  imap_host: string;
  imap_port: number;
  imap_tls: ModoTls;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: ModoTls;
  usuario: string;
  senha_cifrada: string;
  pasta_enviados: string | null;
  pasta_arquivo: string | null;
  pasta_lixeira: string | null;
  pasta_spam: string | null;
  uid_validity: number | null;
  ultimo_uid: number;
  uid_validity_enviados: number | null;
  ultimo_uid_enviados: number;
  /** Fronteira do histórico, descendo. `null` = ainda não iniciado; `0`/`1` = completo. */
  uid_backfill: number | null;
  uid_backfill_enviados: number | null;
}

/**
 * Classificação do erro. É a MESMA distinção que o motor do Gmail faz, e ela decide
 * se o cron insiste ou desiste: credencial recusada não melhora sozinha (parar e
 * pedir ação humana), rede instável melhora (tentar de novo no próximo ciclo).
 */
export function classificarErro(e: unknown): { estado: string; permanente: boolean; recado: string } {
  if (e instanceof ErroImapAuth || e instanceof ErroSmtpAuth) {
    return {
      estado: "auth_failed",
      permanente: true,
      recado: "A caixa recusou usuário/senha. Se a senha mudou no painel de hospedagem, atualize-a aqui.",
    };
  }
  if (e instanceof ErroImapRede) {
    return { estado: "host_unreachable", permanente: false, recado: (e as Error).message };
  }
  const msg = (e as Error)?.message ?? String(e);
  if (/certificate|tls|ssl/i.test(msg)) {
    return { estado: "tls_error", permanente: false, recado: msg };
  }
  return { estado: "erro", permanente: false, recado: msg };
}

export async function marcarErro(admin: any, caixaId: string, e: unknown): Promise<void> {
  const { estado, recado } = classificarErro(e);
  await admin
    .from("email_caixas_conectadas")
    .update({ last_sync_error: `${estado}: ${recado}`.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", caixaId);
}

export async function limparErro(admin: any, caixaId: string): Promise<void> {
  await admin
    .from("email_caixas_conectadas")
    .update({ last_sync_error: null, last_sync_at: new Date().toISOString() })
    .eq("id", caixaId);
}

export async function carregarConfig(admin: any, caixaId: string): Promise<ConfigImap> {
  const { data, error } = await admin
    .from("email_caixa_imap_config")
    .select("*")
    .eq("caixa_id", caixaId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao ler a config IMAP: ${error.message}`);
  if (!data) throw new Error("Caixa sem configuração IMAP.");
  return data as ConfigImap;
}

export async function senhaDaConfig(config: ConfigImap): Promise<string> {
  return await decifrar(config.senha_cifrada, await chaveDoAmbiente());
}

export async function abrirSessao(config: ConfigImap): Promise<SessaoImap> {
  return await abrirImap(
    { host: config.imap_host, port: config.imap_port, tls: config.imap_tls },
    config.usuario,
    await senhaDaConfig(config),
  );
}

/** Conecta ao SMTP e autentica. Usado no envio e no teste de conexão. */
export async function abrirSmtp(
  config: Pick<ConfigImap, "smtp_host" | "smtp_port" | "smtp_tls" | "usuario">,
  senha: string,
): Promise<{ cliente: ClienteSmtp; fechar: () => Promise<void> }> {
  const d = (globalThis as any).Deno;
  const alvo = `${config.smtp_host}:${config.smtp_port}`;
  let conn = await abrirSocket({ host: config.smtp_host, port: config.smtp_port, tls: config.smtp_tls });
  let cliente = new ClienteSmtp(conn);
  await comPrazo(cliente.saudacao(), 20_000, `${alvo} (saudação)`);
  await comPrazo(cliente.ehlo("ppgvet"), 20_000, `${alvo} (EHLO)`);

  if (config.smtp_tls === "starttls") {
    await comPrazo(cliente.startTls(), 20_000, `${alvo} (STARTTLS)`);
    // ⚠️ TODO passo tem prazo, e o handshake é o que MAIS precisa. Servidor que
    // aceita o TCP e não completa o TLS deixa esta promessa pendurada para sempre:
    // a edge é morta pelo supervisor sem lançar erro nenhum, e a tela fica girando
    // sem mensagem. Foi exatamente esse o sintoma de "nem enviando está" em
    // 2026-08-20, com a porta 465 (bloqueada na saída da VPS).
    conn = await comPrazo(
      d.startTls(conn, { hostname: config.smtp_host }),
      20_000,
      `${alvo} (handshake TLS)`,
    );
    cliente = new ClienteSmtp(conn);
    // Depois do STARTTLS o EHLO tem que ser REFEITO: as capacidades anunciadas em
    // claro não valem na sessão cifrada (o AUTH normalmente só aparece agora).
    await comPrazo(cliente.ehlo("ppgvet"), 20_000, `${alvo} (EHLO cifrado)`);
  }

  await comPrazo(cliente.autenticar(config.usuario, senha), 20_000, `${alvo} (login)`);
  return {
    cliente,
    fechar: async () => {
      await cliente.sair();
      try { conn.close(); } catch { /* já caiu */ }
    },
  };
}
