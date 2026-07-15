// Chamada ao Opus 4.8 (Anthropic). Chave própria (env ASSIST_ANTHROPIC_KEY) para isolar
// do comercial; fallback na env ANTHROPIC_API_KEY e na tabela ai_api_keys (gerenciável).
// ⚠️ Opus 4.8 NÃO aceita temperature/top_p/budget_tokens (400). Thinking omitido = sem
// thinking (resposta rápida); o system prompt pede "resposta final, sem narrar raciocínio".

export const MODELO = Deno.env.get("ASSIST_MODEL") || "claude-opus-4-8";

export async function getAnthropicKey(admin: any): Promise<string | null> {
  // Chave DEDICADA (isolamento futuro) só se explicitamente setada p/ ESTE bot.
  // ⚠️ NÃO usar a env genérica ANTHROPIC_API_KEY do container: ela está com uma
  // chave stale/inválida (compartilhada com mimosa/ai-internal-agent) e venceria
  // a do banco. Fonte canônica = ai_api_keys (opção B do dono, chave validada).
  const dedicada = Deno.env.get("ASSIST_ANTHROPIC_KEY");
  if (dedicada) return dedicada;
  const { data } = await admin
    .from("ai_api_keys")
    .select("api_key")
    .eq("provider", "anthropic")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return data?.api_key ?? null;
}

export async function chamarOpus(key: string, body: any): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELO, ...body }),
    });
    if (res.ok) return await res.json();
    const txt = await res.text().catch(() => "");
    // 4xx (exceto 429) é erro definitivo — não retenta.
    if (res.status < 500 && res.status !== 429) throw new Error(`anthropic ${res.status}: ${txt.slice(0, 300)}`);
    lastErr = new Error(`anthropic ${res.status}: ${txt.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  throw lastErr;
}
