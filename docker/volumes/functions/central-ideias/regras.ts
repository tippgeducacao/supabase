// Regras puras da edge central-ideias (testadas em regras.test.ts, sem rede).

export interface PostNosso {
  conta: string;
  caption: string | null;
  media_type: string | null;
  permalink: string | null;
  timestamp: string;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  engagement_rate: number | null;
  thumbnail_url?: string | null;
}

const media = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null);

function agrupar<T>(xs: T[], chave: (x: T) => string): Record<string, T[]> {
  const g: Record<string, T[]> = {};
  for (const x of xs) (g[chave(x)] ??= []).push(x);
  return g;
}

const enxuto = (p: PostNosso) => ({
  conta: p.conta,
  link: p.permalink,
  formato: p.media_type,
  data: p.timestamp.slice(0, 10),
  alcance: p.reach,
  curtidas: p.likes,
  comentarios: p.comments,
  salvos: p.saves,
  compartilhamentos: p.shares,
  legenda: (p.caption ?? "").slice(0, 300),
  // Link do CDN da Meta: expira em horas. O robô baixa já e manda a miniatura de volta no salvar.
  miniatura_url: p.thumbnail_url ?? null,
});

// Hora e dia da semana em Brasília (UTC-3, sem horário de verão desde 2019).
const emBrasilia = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3_600_000);
const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** O que o Claude precisa das nossas contas: médias por conta, formato e horário + melhores e piores. */
export function resumirNossasContas(posts: PostNosso[]) {
  const alcance = (p: PostNosso) => p.reach ?? 0;
  const porConta = Object.entries(agrupar(posts, (p) => p.conta)).map(([conta, ps]) => {
    const ord = [...ps].sort((a, b) => alcance(b) - alcance(a));
    return {
      conta,
      posts: ps.length,
      alcance_medio: media(ps.map(alcance)),
      melhores: ord.slice(0, 3).map(enxuto),
      piores: ord.length > 3 ? ord.slice(-2).map(enxuto) : [],
    };
  });
  const resumoPor = (chave: (p: PostNosso) => string) =>
    Object.entries(agrupar(posts, chave)).map(([grupo, ps]) => ({
      grupo,
      posts: ps.length,
      alcance_medio: media(ps.map(alcance)),
      salvos_medio: media(ps.map((p) => p.saves ?? 0)),
    }));
  return {
    total_posts: posts.length,
    por_conta: porConta,
    por_formato: resumoPor((p) => p.media_type ?? "?"),
    por_dia_da_semana: resumoPor((p) => DIAS[emBrasilia(p.timestamp).getUTCDay()]),
    por_faixa_de_hora: resumoPor((p) => {
      const h = emBrasilia(p.timestamp).getUTCHours();
      return h < 6 ? "madrugada" : h < 12 ? "manhã" : h < 18 ? "tarde" : "noite";
    }),
  };
}

/** Confere o corpo de "salvar". Devolve a linha da tabela ou a mensagem de erro. */
export function validarDia(c: Record<string, unknown>) {
  if (typeof c.dia !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.dia)) return "dia deve ser AAAA-MM-DD.";
  if (typeof c.resumo !== "string" || !c.resumo.trim()) return "resumo vazio.";
  if (!c.conteudo || typeof c.conteudo !== "object" || Array.isArray(c.conteudo)) return "conteudo deve ser objeto.";
  if (c.erros !== undefined && !Array.isArray(c.erros)) return "erros deve ser lista.";
  if (c.custo_usd !== undefined && c.custo_usd !== null && typeof c.custo_usd !== "number") return "custo_usd deve ser número.";
  return {
    dia: c.dia,
    resumo: c.resumo.trim(),
    conteudo: c.conteudo as Record<string, unknown>,
    modelo: typeof c.modelo === "string" ? c.modelo : null,
    custo_usd: (c.custo_usd as number | undefined) ?? null,
    erros: (c.erros as unknown[] | undefined) ?? [],
  };
}

export interface Miniatura { link: string; jpeg_base64: string }
const MAX_MINIATURAS = 80;
const MAX_BASE64 = 350_000; // ~256 KB, o limite do bucket central-ideias

/** Confere as miniaturas do "salvar" (o robô manda JPEG pequena por link citado no dia). */
export function validarMiniaturas(m: unknown): Miniatura[] | string {
  if (m === undefined || m === null) return [];
  if (!Array.isArray(m)) return "miniaturas deve ser lista.";
  if (m.length > MAX_MINIATURAS) return `no máximo ${MAX_MINIATURAS} miniaturas.`;
  for (const x of m) {
    if (!x || typeof x.link !== "string" || !/^https?:\/\//.test(x.link)) return "miniatura sem link.";
    if (typeof x.jpeg_base64 !== "string" || !x.jpeg_base64 || x.jpeg_base64.length > MAX_BASE64) {
      return `miniatura inválida ou grande demais: ${x.link}`;
    }
  }
  return m as Miniatura[];
}
