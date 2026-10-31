// Régua de rede pública já usada por link-preview/unfurl-url (29/10).
// Extraída para o envio de mídia: URL de pedido não pode alcançar a rede da VPS.
import { MidiaInvalida } from "./midiaRecebida.ts";
class UrlBloqueada extends MidiaInvalida { constructor(_motivo: string) { super(); } }
const HOST_INTERNO = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|arpa|test|invalid|onion)$/i;

function ipPublico(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((n) => n > 255) || p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 169 && p[1] === 254
      || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && (p[1] === 168 || p[1] === 0 || p[1] === 2 || p[1] === 88 && p[2] === 99)
      || p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51 && p[2] === 100)
      || p[0] === 203 && p[1] === 0 && p[2] === 113) return false;
    return true;
  }
  if (!/^[\da-f:.]+$/i.test(ip) || !ip.includes(":")) return false;
  let canonico: string;
  try { canonico = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return false; }
  const [a, b] = canonico.split(":").map((n) => parseInt(n || "0", 16));
  // Só IPv6 global unicast (2000::/3), fora de 6to4, Teredo/benchmark e documentação.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && a !== 0x3fff;
}

async function resolverIps(host: string): Promise<string[]> {
  const d = (globalThis as { Deno?: { resolveDns?: (host: string, tipo: "A" | "AAAA") => Promise<string[]> } }).Deno;
  if (typeof d?.resolveDns !== "function") throw new UrlBloqueada("DNS indisponível.");
  const r = await Promise.allSettled([d.resolveDns(host, "A"), d.resolveDns(host, "AAAA")]);
  return r.flatMap((x) => (x.status === "fulfilled" ? (x.value as string[]) : []));
}

export async function conferirUrlPublica(bruta: string): Promise<URL> {
  let u: URL;
  try { u = new URL(bruta); } catch { throw new UrlBloqueada("URL inválida."); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new UrlBloqueada("URL não permitida.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UrlBloqueada("Porta não permitida.");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ehIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  if (!ehIp && (!host.includes(".") || HOST_INTERNO.test(host))) throw new UrlBloqueada("Endereço interno não permitido.");
  const ips = ehIp ? [host] : await resolverIps(host);
  if (!ips.length || ips.some((ip) => !ipPublico(ip))) throw new UrlBloqueada("Endereço interno não permitido.");
  return u;
}
