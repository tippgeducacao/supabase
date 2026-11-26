// central-ideias — a porta do robô da Central de Ideias (scripts/central-ideias, GitHub Actions).
//
// Duas ações, as duas só com a senha de app_secrets('central_ideias_senha') no cabeçalho
// `x-central-ideias-senha` (o robô não tem chave de serviço nem login):
//   contexto → fontes ativas, nossas contas (Instagram, 30 dias) e os 7 dias anteriores
//   salvar   → grava as miniaturas no bucket central-ideias e o dia (upsert) em central_ideias_dias
// Doc: docs/Marketing — Portal e Conteúdo.md › Central de Ideias.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { resumirAvaliacoes, resumirNossasContas, validarDia, validarMiniaturas, type Avaliacao } from "./regras.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-central-ideias-senha",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Fora da análise "nossas contas": a PPG é outra marca (~/conhecimento/marca.md: nunca misturar) e a
// raafaelcostta é a conta pessoal do diretor (usuário, 23/11/2026).
const CONTAS_FORA = ["ppg.educacao", "raafaelcostta"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: segredo } = await admin.from("app_secrets").select("valor")
    .eq("chave", "central_ideias_senha").maybeSingle();
  try {
    await exigirAcesso(req, { segredo: { cabecalho: "x-central-ideias-senha", valor: segredo?.valor } });
  } catch (e) {
    return respostaAcessoNegado(e, cors);
  }

  try {
    const corpo = await req.json().catch(() => ({}));

    if (corpo.acao === "contexto") {
      const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const sessentaDias = new Date(Date.now() - 60 * 86_400_000).toISOString();
      const [fontes, contas, posts, historico, guia, avaliacoes] = await Promise.all([
        admin.from("central_ideias_fontes").select("tipo, valor, observacao").eq("ativo", true),
        admin.from("ig_accounts").select("id, username").eq("is_active", true),
        admin.from("ig_post_metrics")
          .select("account_id, caption, media_type, permalink, timestamp, reach, likes, comments, saves, shares, engagement_rate, thumbnail_url")
          .gte("timestamp", desde).limit(2000),
        admin.from("central_ideias_dias").select("dia, conteudo->metricas, conteudo->ideias")
          .order("dia", { ascending: false }).limit(7),
        // O guia de gravação mais recente (refeito no dia 1º): guia as ideias "na empresa".
        admin.from("central_ideias_dias").select("guia:conteudo->guia").not("conteudo->guia", "is", null)
          .order("dia", { ascending: false }).limit(1).maybeSingle(),
        // O que o time recusou ou fez: o robô evita o recusado e aprende com o resultado do que foi feito.
        admin.from("central_ideias_avaliacoes").select("status, titulo, ideia, motivo, link_post")
          .gte("created_at", sessentaDias).order("created_at", { ascending: false }).limit(100),
      ]);
      const erro = fontes.error || contas.error || posts.error || historico.error || guia.error || avaliacoes.error;
      if (erro) return json({ error: erro.message }, 500);
      const nomes = new Map((contas.data ?? []).filter((c) => !CONTAS_FORA.includes(c.username))
        .map((c) => [c.id, c.username]));
      const nossos = (posts.data ?? []).filter((p) => nomes.has(p.account_id))
        .map((p) => ({ ...p, conta: nomes.get(p.account_id)! }));
      const nossasContas = resumirNossasContas(nossos);
      return json({
        fontes: fontes.data,
        nossas_contas: nossasContas,
        // Todas as nossas contas (com as de fora da análise): post delas ou em collab nunca vira inspiração.
        nossas_contas_nomes: (contas.data ?? []).map((c) => c.username),
        avaliacoes_do_time: resumirAvaliacoes((avaliacoes.data ?? []) as Avaliacao[], nossos,
          Object.fromEntries(nossasContas.por_conta.map((c) => [c.conta, c.alcance_medio]))),
        // Só métricas e títulos: é o que o robô usa para a linha de base e para não repetir ideia.
        guia: (guia.data as { guia?: unknown } | null)?.guia ?? null,
        historico: (historico.data ?? []).map((h: Record<string, unknown>) => ({
          dia: h.dia,
          metricas: h.metricas ?? null,
          ideias: Array.isArray(h.ideias) ? h.ideias.map((i: { titulo?: string }) => i?.titulo).filter(Boolean) : [],
        })),
      });
    }

    if (corpo.acao === "salvar") {
      const dia = validarDia(corpo);
      if (typeof dia === "string") return json({ error: dia }, 400);
      const miniaturas = validarMiniaturas(corpo.miniaturas);
      if (typeof miniaturas === "string") return json({ error: miniaturas }, 400);
      // link → caminho no bucket. Nome = hash do link: o mesmo post em dias diferentes reaproveita o arquivo.
      const caminhos: Record<string, string> = {};
      for (const m of miniaturas) {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(m.link))))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        const caminho = `${hash}.jpg`;
        const bytes = Uint8Array.from(atob(m.jpeg_base64), (c) => c.charCodeAt(0));
        const { error: upErr } = await admin.storage.from("central-ideias")
          .upload(caminho, bytes, { contentType: "image/jpeg", upsert: true });
        if (upErr) console.warn("[central-ideias] miniatura:", m.link, upErr.message);  // sem a imagem o dia sai igual
        else caminhos[m.link] = caminho;
      }
      dia.conteudo = { ...dia.conteudo, miniaturas: caminhos };
      // Rodar o mesmo dia de novo sem --guia não pode apagar o guia de gravação gravado nele.
      if (!dia.conteudo.guia) {
        const { data: antigo } = await admin.from("central_ideias_dias").select("guia:conteudo->guia")
          .eq("dia", dia.dia).maybeSingle();
        const guiaAntigo = (antigo as { guia?: unknown } | null)?.guia;
        if (guiaAntigo) dia.conteudo = { ...dia.conteudo, guia: guiaAntigo };
      }
      const { error } = await admin.from("central_ideias_dias").upsert(dia, { onConflict: "dia" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, dia: dia.dia });
    }

    return json({ error: "acao deve ser 'contexto' ou 'salvar'." }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro inesperado";
    console.error("[central-ideias]", msg);
    return json({ error: msg }, 500);
  }
});
