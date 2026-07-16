// Ferramentas EXTERNAS (fora do sistema PPG). Hoje: previsão do tempo via Open-Meteo
// (grátis, SEM chave de API). A pesquisa na web é a ferramenta nativa da Anthropic
// (web_search), declarada no brain.ts — não precisa de código aqui.

/** Códigos WMO → descrição em PT-BR (padrão do Open-Meteo). */
const WMO: Record<number, string> = {
  0: "céu limpo", 1: "predomínio de sol", 2: "parcialmente nublado", 3: "nublado",
  45: "nevoeiro", 48: "nevoeiro com geada",
  51: "garoa fraca", 53: "garoa", 55: "garoa forte",
  56: "garoa congelante", 57: "garoa congelante forte",
  61: "chuva fraca", 63: "chuva", 65: "chuva forte",
  66: "chuva congelante", 67: "chuva congelante forte",
  71: "neve fraca", 73: "neve", 75: "neve forte", 77: "granizo fino",
  80: "pancadas de chuva fracas", 81: "pancadas de chuva", 82: "pancadas de chuva fortes",
  85: "pancadas de neve", 86: "pancadas de neve fortes",
  95: "trovoada", 96: "trovoada com granizo", 99: "trovoada com granizo forte",
};
const desc = (c: number | undefined) => (c == null ? "—" : (WMO[c] ?? `código ${c}`));

export const FERRAMENTAS_EXTERNAS = [
  {
    name: "consultar_tempo",
    description:
      "Previsão do tempo/clima de uma cidade (padrão: Ampère/PR, onde fica a PPGVET). Traz o agora (temperatura, sensação, umidade, vento) e a previsão dos próximos dias (mín/máx, chance de chuva). Use sempre que o dono perguntar de tempo, clima, chuva, temperatura, se vai dar praia/viagem etc.",
    input_schema: {
      type: "object",
      properties: {
        cidade: { type: "string", description: "cidade (opcional; padrão 'Ampère'). Ex.: 'Curitiba', 'São Paulo', 'Pato Branco'" },
        dias: { type: "number", description: "dias de previsão, 1 a 7 (padrão 3)" },
      },
    },
  },
];

const NOMES_EXT = new Set(FERRAMENTAS_EXTERNAS.map((t) => t.name));
export function ehExterna(nome: string): boolean { return NOMES_EXT.has(nome); }

export async function executarExterna(nome: string, input: any): Promise<any> {
  try {
    if (nome === "consultar_tempo") return await cTempo(input);
    return { erro: `ferramenta externa desconhecida: ${nome}` };
  } catch (e) {
    return { erro: `Falha em ${nome}: ${(e as Error).message}` };
  }
}

async function cTempo(input: any) {
  const cidadeIn = String(input?.cidade || "Ampère").trim();

  // 1) geocoding (grátis, sem chave) — prefere Brasil quando houver homônimo.
  const g = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidadeIn)}&count=5&language=pt&format=json`,
  );
  if (!g.ok) throw new Error(`geocoding ${g.status}`);
  const achados = (await g.json())?.results ?? [];
  const local = achados.find((r: any) => r.country_code === "BR") ?? achados[0];
  if (!local) return { erro: `Não achei a cidade "${cidadeIn}". Pode confirmar o nome?` };

  // 2) previsão
  const dias = Math.min(Math.max(Number(input?.dias) || 3, 1), 7);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${local.latitude}&longitude=${local.longitude}`
    + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max`
    + `&timezone=America%2FSao_Paulo&forecast_days=${dias}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const j = await r.json();

  const cur = j?.current ?? {};
  const d = j?.daily ?? {};
  return {
    local: `${local.name}${local.admin1 ? " / " + local.admin1 : ""}`,
    agora: {
      condicao: desc(cur.weather_code),
      temperatura_c: cur.temperature_2m,
      sensacao_c: cur.apparent_temperature,
      umidade_pct: cur.relative_humidity_2m,
      chuva_mm: cur.precipitation,
      vento_kmh: cur.wind_speed_10m,
    },
    previsao: (d.time ?? []).map((dia: string, i: number) => ({
      dia,
      condicao: desc(d.weather_code?.[i]),
      min_c: d.temperature_2m_min?.[i],
      max_c: d.temperature_2m_max?.[i],
      chuva_mm: d.precipitation_sum?.[i],
      chance_chuva_pct: d.precipitation_probability_max?.[i],
    })),
    _nota: "Fonte: Open-Meteo. Temperaturas em °C, fuso de Brasília. Resuma em linguagem natural (não despeje a tabela crua).",
  };
}
