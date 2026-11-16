// Sinais do navegador que os sites mandam junto com o lead (payload v1, 16/11/2026): cookies da Meta
// (`_fbc`/`_fbp`), IP e user agent do visitante. A meta-crm-capi devolve as etapas do funil com eles,
// e a nota de correspondência da Meta sobe. Valor fora do formato não grava (lixo de placeholder).
// Docs: developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc

export type SinaisMeta = { fbc?: string; fbp?: string; ip_address?: string; user_agent?: string };

const FBC = /^fb\.\d\.\d{10,13}\.[\w-]{10,500}$/;
const FBP = /^fb\.\d\.\d{10,13}\.\d{5,25}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/** Os sinais válidos do corpo; só os que vieram e passaram no formato. */
export function sinaisMetaDe(payload: Record<string, unknown> | null | undefined): SinaisMeta {
  const t = (k: string) => (typeof payload?.[k] === "string" ? (payload[k] as string).trim() : "");
  const s: SinaisMeta = {};
  if (FBC.test(t("fbc"))) s.fbc = t("fbc");
  if (FBP.test(t("fbp"))) s.fbp = t("fbp");
  const ip = t("ip");
  if ((IPV4.test(ip) && ip.split(".").every((n) => +n <= 255)) || (ip.includes(":") && IPV6.test(ip))) s.ip_address = ip;
  if (t("user_agent").length >= 10) s.user_agent = t("user_agent").slice(0, 500);
  return s;
}
