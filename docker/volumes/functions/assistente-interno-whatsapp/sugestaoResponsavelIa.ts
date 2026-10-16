// Chamada à IA da sugestão de responsável (a régua pura mora em sugestaoResponsavel.ts).
// Falhou (sem chave, timeout de 25 s, recusa, resposta fora do esquema) = null: o aviso sai sem a
// sugestão — nunca atrasa nem barra o aviso.
import { getAnthropicKey } from "./anthropic.ts";
import {
  escolherPessoa, lerPessoas, lerResposta, montarPedido, MODELO_SUGESTAO, textoDaDescricao, type Sugestao,
} from "./sugestaoResponsavel.ts";

const TETO_MS = 25_000;

export type { Sugestao };

/** Busca o contexto, pergunta à IA e escolhe a pessoa. Qualquer falha = null (nunca lança). */
export async function sugerirResponsavel(
  admin: any, avisoId: string, tarefa: { titulo: string; descricaoHtml: string | null; criador: string | null },
): Promise<Sugestao | null> {
  try {
    const { data, error } = await admin.rpc("gt_avisos_sugestao_contexto", { p_aviso: avisoId });
    if (error) throw new Error(error.message);
    const pessoas = lerPessoas(data);
    if (!pessoas.length) return null;
    const areas = new Set(pessoas.map((p) => p.area));
    // Uma área só: não há o que perguntar à IA.
    if (areas.size === 1) return escolherPessoa(pessoas[0].area, "", pessoas);

    const key = await getAnthropicKey(admin);
    if (!key) return null;
    const { system, user, schema } = montarPedido(
      { titulo: tarefa.titulo, descricao: textoDaDescricao(tarefa.descricaoHtml), criador: tarefa.criador }, pessoas);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TETO_MS);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          // Recusa do modelo cai num modelo de reserva escolhido pela própria API.
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model: MODELO_SUGESTAO,
          max_tokens: 2000,
          fallbacks: "default",
          output_config: { effort: "low", format: { type: "json_schema", schema } },
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const lido = lerResposta(await res.json(), pessoas);
      return lido ? escolherPessoa(lido.area, lido.motivo, pessoas) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error("[avisos-tarefas] sugestão de responsável falhou:", (e as Error).message);
    return null;
  }
}
