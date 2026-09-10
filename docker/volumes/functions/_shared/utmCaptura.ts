// Réguas puras compartilhadas pelos receptores de leads e pelo Pages.
// 10/09/2026: a URL precisa ser lida antes de qualquer fallback de origem; uma UTM
// enviada só na query da landing não pode virar Google/organic por falta de campo.
export const CAMPOS_RASTREAMENTO = [
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id",
  "gclid", "fbclid", "ttclid",
] as const;

type CampoRastreamento = typeof CAMPOS_RASTREAMENTO[number];
export type Rastreamento = Partial<Record<CampoRastreamento, string>>;

const ALIASES: Partial<Record<CampoRastreamento, string>> = {
  utm_campaign: "utm_campaing",
  utm_content: "utm_contet",
};

export function limparValorRastreamento(valor: unknown, limite = 4096): string | undefined {
  if (typeof valor !== "string" && typeof valor !== "number") return undefined;
  const texto = String(valor).trim();
  if (!texto || /^(?:null|undefined)$/i.test(texto) || /^\{.*\}$/.test(texto)) return undefined;
  return texto.slice(0, limite);
}

/** Fontes em prioridade: valor mapeado/configurado → corpo → query → URL da LP. */
export function extrairRastreamento({
  campos = [], urls = [],
}: { campos?: Array<Record<string, unknown>>; urls?: unknown[] }): Rastreamento {
  const fontes = [...campos];
  for (const valor of urls) {
    if (typeof valor !== "string" || !valor.trim()) continue;
    try {
      // Também aceita URL sem protocolo, comum no campo URL do GreatPages.
      const url = new URL(/^https?:\/\//i.test(valor) ? valor : `https://${valor}`);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      fontes.push(Object.fromEntries(url.searchParams));
    } catch { /* Uma URL inválida não deve derrubar a captação. */ }
  }
  const resultado: Rastreamento = {};
  for (const fonte of fontes) {
    const minusculas = Object.fromEntries(Object.entries(fonte).map(([chave, valor]) => [chave.toLowerCase(), valor]));
    for (const campo of CAMPOS_RASTREAMENTO) {
      // Click IDs são opacos e podem exceder 255 caracteres; truncá-los quebra a
      // associação com o anúncio. As colunas são text, com limite defensivo de 4 KiB.
      const limite = campo.endsWith("clid") ? 4096 : 255;
      const valor = limparValorRastreamento(minusculas[campo], limite) ?? limparValorRastreamento(minusculas[ALIASES[campo] ?? ""], limite);
      // GreatPages é o fallback legado do formulário, não um canal de aquisição.
      // Só source usa esta régua: campanha/conteúdo podem ter esse nome literal.
      if (campo === "utm_source" && valor?.toLowerCase() === "greatpages") continue;
      if (!resultado[campo] && valor) resultado[campo] = valor;
    }
  }
  return resultado;
}

const normalizar = (valor: unknown) => limparValorRastreamento(valor)?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const canal = (valor: string | undefined): string | undefined => {
  if (!valor) return undefined;
  if (/^(tiktok|tik tok|tt)(?:$|[_\s-])/.test(valor)) return "tiktok";
  if (/^(linkedin)(?:$|[_\s-])/.test(valor)) return "linkedin";
  if (/^(whatsapp|whats|wa)(?:$|[_\s-])/.test(valor)) return "whatsapp";
  if (/^(metaads|meta|facebook|fb|instagram|ig)(?:$|[_\s-])/.test(valor)) return "meta";
  if (/^(google|gads|adwords)(?:$|[_\s-])/.test(valor)) return "google";
  return undefined;
};

/**
 * Não completa uma primeira atribuição usando dados de uma campanha diferente.
 * A origem do recadastro continua disponível no evento/oportunidade, sem contaminar
 * o contato. Sem identidade em comum, a postura é conservar o que já foi registrado.
 */
export function podeComplementarAtribuicao(atual: Record<string, unknown>, entrada: Record<string, unknown>): boolean {
  const anterior = extrairRastreamento({ campos: [atual] });
  const nova = extrairRastreamento({ campos: [entrada] });
  const fonteAnterior = normalizar(atual.utm_source);
  const fonteNova = normalizar(entrada.utm_source);
  const campanhaAnterior = normalizar(atual.utm_campaign ?? atual.meta_campaign_name);
  const campanhaNova = normalizar(entrada.utm_campaign ?? entrada.meta_campaign_name);

  // Além de campanha, conteúdo/clique diferentes identificam outro toque. Não misturar
  // nem mesmo quando as duas visitas vieram do mesmo canal ou da mesma campanha.
  for (const campo of CAMPOS_RASTREAMENTO) {
    const valorAnterior = campo.endsWith("clid") || campo === "utm_id" ? anterior[campo] : normalizar(anterior[campo]);
    const valorNovo = campo.endsWith("clid") || campo === "utm_id" ? nova[campo] : normalizar(nova[campo]);
    if (valorAnterior && valorNovo && valorAnterior !== valorNovo) return false;
  }
  for (const campo of ["meta_campaign_id", "meta_adset_id", "meta_ad_id", "meta_form_id"]) {
    if (limparValorRastreamento(atual[campo]) && limparValorRastreamento(entrada[campo]) &&
      limparValorRastreamento(atual[campo]) !== limparValorRastreamento(entrada[campo])) return false;
  }
  if (campanhaAnterior && campanhaNova && campanhaAnterior !== campanhaNova) return false;

  const idEmComum = ["utm_id", "ttclid", "gclid", "fbclid", "meta_campaign_id"].some(campo =>
    limparValorRastreamento(atual[campo]) && limparValorRastreamento(atual[campo]) === limparValorRastreamento(entrada[campo]));
  if (campanhaAnterior && !campanhaNova && !idEmComum) return false;
  if (fonteAnterior && !fonteNova && !idEmComum && !(campanhaAnterior && campanhaAnterior === campanhaNova)) return false;

  // Contato legado pode ter fonte conhecida, mas nenhuma UTM. Uma URL TikTok nova
  // não deve fazer a origem Meta antiga mudar silenciosamente pelo trigger do banco.
  if (!fonteAnterior) {
    const canalAnterior = canal(normalizar(atual.fonte_referencia)) ?? canal(normalizar(atual.fonte))
      ?? (anterior.ttclid ? "tiktok" : anterior.gclid ? "google" : anterior.fbclid ? "meta" : undefined);
    const canalNovo = canal(fonteNova)
      ?? (nova.ttclid ? "tiktok" : nova.gclid ? "google" : nova.fbclid ? "meta" : undefined);
    if (canalAnterior && canalAnterior !== canalNovo && !idEmComum) return false;
    if (!Object.keys(anterior).length && !canalAnterior) {
      const fonteDeclarada = normalizar(atual.fonte_referencia) ?? normalizar(atual.fonte);
      if (fonteDeclarada && !["greatpages", "sprinthub", "utm com erro", "acesso direto", "a revisar"].includes(fonteDeclarada)) return false;
    }
  }
  return true;
}

export function complementarPrimeiraAtribuicao(atual: Record<string, unknown>, entrada: Record<string, unknown>): Rastreamento {
  if (!podeComplementarAtribuicao(atual, entrada)) return {};
  const patch: Rastreamento = {};
  const nova = extrairRastreamento({ campos: [entrada] });
  for (const campo of CAMPOS_RASTREAMENTO) {
    if (!limparValorRastreamento(atual[campo]) && nova[campo]) patch[campo] = nova[campo];
  }
  return patch;
}
