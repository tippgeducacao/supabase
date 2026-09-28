/**
 * "O domínio recebe e-mail num servidor e a caixa lê OUTRO."
 *
 * ⚠️ INCIDENTE 28/09/2026 — migração de cPanel. O MX de `ppgeducacao.com.br` passou a
 * apontar para o servidor novo (`mail.ppgeducacao.com.br` → 143.95.219.78), mas as
 * caixas IMAP estavam cadastradas com o host explícito do servidor ANTIGO
 * (`br804.hostgator.com.br` → 50.116.87.190). O antigo continuou aceitando login, então
 * o sync rodava a cada 2 minutos, gravava `last_sync_at` e limpava o erro — e nenhum
 * e-mail novo chegava desde 25/09. Nada na tela dizia que havia algo errado: do ponto de
 * vista do protocolo, estava tudo certo.
 *
 * A única testemunha é o DNS: comparar para onde o domínio ENTREGA (MX) com onde a caixa
 * LÊ (`imap_host`). Endereços sem nenhum IP em comum = alerta.
 *
 * ⚠️ É ALERTA, não erro: há arranjos legítimos em que o MX é outro (filtro antispam na
 * frente do servidor). Por isso a caixa continua sincronizando e a tela só avisa. E
 * qualquer falha de resolução é INCONCLUSIVA — nunca vira alerta, que alarme falso ensina
 * a ignorar o alarme.
 */

export interface RegistroMx {
  exchange: string;
  preference: number;
}

export interface Resolvedor {
  mx(dominio: string): Promise<RegistroMx[]>;
  ipv4(host: string): Promise<string[]>;
}

export interface AlertaServidor {
  tipo: "servidor_mudou";
  /** Onde a caixa lê hoje (`imap_host`). */
  host_atual: string;
  /** Para onde o domínio entrega (MX de menor preferência). */
  host_do_dominio: string;
  ips_atual: string[];
  ips_do_dominio: string[];
}

const semPonto = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

/** Decide só com o que já foi resolvido — pura, é onde mora a regra. */
export function compararServidores(
  hostAtual: string,
  ipsAtual: string[],
  hostDoDominio: string,
  ipsDoDominio: string[],
): AlertaServidor | null {
  const atual = semPonto(hostAtual);
  const dominio = semPonto(hostDoDominio);
  if (!atual || !dominio) return null;
  if (atual === dominio) return null;
  // Sem IP de um dos lados não dá para afirmar nada.
  if (!ipsAtual.length || !ipsDoDominio.length) return null;
  const doDominio = new Set(ipsDoDominio);
  if (ipsAtual.some((ip) => doDominio.has(ip))) return null;
  return {
    tipo: "servidor_mudou",
    host_atual: atual,
    host_do_dominio: dominio,
    ips_atual: [...new Set(ipsAtual)].sort(),
    ips_do_dominio: [...doDominio].sort(),
  };
}

const comPrazo = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`dns: prazo de ${ms}ms`)), ms)),
  ]);

/**
 * Resolve e compara. Qualquer erro (DNS fora, domínio sem MX, prazo) devolve `null`:
 * inconclusivo não é alerta.
 */
export async function verificarServidorDoDominio(
  email: string,
  imapHost: string,
  resolvedor: Resolvedor,
  prazoMs = 4_000,
): Promise<AlertaServidor | null> {
  const dominio = semPonto(String(email).split("@")[1] ?? "");
  if (!dominio || !imapHost) return null;
  try {
    const mx = await comPrazo(resolvedor.mx(dominio), prazoMs);
    const principal = [...mx].sort((a, b) => a.preference - b.preference)[0];
    if (!principal?.exchange) return null;
    const [ipsDoDominio, ipsAtual] = await Promise.all([
      comPrazo(resolvedor.ipv4(semPonto(principal.exchange)), prazoMs),
      comPrazo(resolvedor.ipv4(semPonto(imapHost)), prazoMs),
    ]);
    return compararServidores(imapHost, ipsAtual, principal.exchange, ipsDoDominio);
  } catch {
    return null;
  }
}

/** DNS por HTTPS — reserva para quando o runtime não expõe (ou nega) `Deno.resolveDns`. */
async function doh(nome: string, tipo: "MX" | "A"): Promise<{ type: number; data: string }[]> {
  const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(nome)}&type=${tipo}`, {
    headers: { accept: "application/dns-json" },
  });
  if (!r.ok) throw new Error(`doh ${r.status}`);
  const corpo = await r.json();
  return Array.isArray(corpo?.Answer) ? corpo.Answer : [];
}

/**
 * O resolvedor de verdade: `Deno.resolveDns` quando existe (o edge-runtime da VPS tem o
 * op compilado — conferido em 28/09/2026), DNS por HTTPS quando ele falha.
 */
export function resolvedorDaPlataforma(): Resolvedor {
  const d = (globalThis as any).Deno;
  const nativo = typeof d?.resolveDns === "function";
  return {
    async mx(dominio) {
      if (nativo) {
        try {
          return (await d.resolveDns(dominio, "MX")) as RegistroMx[];
        } catch { /* cai no DoH */ }
      }
      return (await doh(dominio, "MX"))
        .filter((a) => a.type === 15)
        .map((a) => {
          const [pref, host] = String(a.data).trim().split(/\s+/);
          return { preference: Number(pref) || 0, exchange: host ?? "" };
        });
    },
    async ipv4(host) {
      if (nativo) {
        try {
          return (await d.resolveDns(host, "A")) as string[];
        } catch { /* cai no DoH */ }
      }
      return (await doh(host, "A")).filter((a) => a.type === 1).map((a) => String(a.data));
    },
  };
}
