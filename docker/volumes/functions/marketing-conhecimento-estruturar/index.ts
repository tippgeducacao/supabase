import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { tirarTravessao } from "../_shared/limparSaidaIA.ts";

/**
 * FICHA DA AULA — transforma a transcrição de uma aula em material de pauta.
 *
 * Lê uma linha de `marketing_conhecimento` (resumo do Gemini + fala inteira) e escreve em
 * `ficha` o que o marketing precisa para produzir: tópicos, números ditos pelo professor,
 * casos de campo, falas que viram gancho, dúvidas dos alunos, erros que ele corrige.
 *
 * Dois jeitos de chamar:
 *  - CRON (pg_net, a cada minuto): header `x-cron-secret` igual ao da
 *    `marketing_conhecimento_config`. Só trabalha com `estruturar_ativo = true` — o lote
 *    custa dinheiro da Anthropic e nasce desligado. A chave de serviço NÃO serve aqui: a que
 *    o banco manda é outra, e a chamada voltaria recusada em silêncio.
 *  - PESSOA do marketing: JWT + `{ ids: [...] }`, para (re)fazer fichas específicas.
 *
 * Uma aula por chamada: a transcrição tem ~40 mil tokens e o runtime corta em 150 s.
 *
 * Erros (revisão de 29/09/2026):
 *  - Passageiro (429, 5xx, 529 "overloaded", tempo, rede) → a aula VOLTA para `pendente` e
 *    conta em `ficha_tentativas`; na 3ª falha vira `erro`. Antes, uma queda da Anthropic
 *    punha a fila inteira em `erro` para sempre, 3 aulas por minuto.
 *  - Sem crédito na Anthropic → devolve a aula e DESLIGA o lote (`estruturar_ativo = false`):
 *    insistir não resolve e cada chamada ainda ocupa a fila.
 *  - Pela tela, a resposta é 202 na hora e o trabalho segue em segundo plano
 *    (`EdgeRuntime.waitUntil`): o Cloudflare corta em ~100 s e a pessoa veria erro de uma
 *    ficha que sai (e é cobrada) do mesmo jeito.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MODELO = "claude-opus-5";
const MAX_TENTATIVAS = 5;

class ErroPassageiro extends Error {}
class SemCredito extends Error {}
/** Transcrição maior que isso é aula dupla colada; o começo já dá a ficha. */
const LIMITE_TEXTO = 400_000;
const PRAZO_MS = 135_000;

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "resumo", "professor", "publico", "topicos", "dados_tecnicos", "casos_praticos",
    "falas_marcantes", "duvidas_frequentes", "erros_comuns", "ganchos_de_conteudo", "palavras_chave",
  ],
  properties: {
    resumo: { type: "string" },
    professor: { type: "string" },
    publico: { type: "string" },
    topicos: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["titulo", "explicacao"],
        properties: { titulo: { type: "string" }, explicacao: { type: "string" } },
      },
    },
    dados_tecnicos: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["dado", "contexto"],
        properties: { dado: { type: "string" }, contexto: { type: "string" } },
      },
    },
    casos_praticos: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["caso", "licao"],
        properties: { caso: { type: "string" }, licao: { type: "string" } },
      },
    },
    falas_marcantes: { type: "array", items: { type: "string" } },
    duvidas_frequentes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["pergunta", "resposta"],
        properties: { pergunta: { type: "string" }, resposta: { type: "string" } },
      },
    },
    erros_comuns: { type: "array", items: { type: "string" } },
    ganchos_de_conteudo: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["formato", "angulo"],
        properties: { formato: { type: "string" }, angulo: { type: "string" } },
      },
    },
    palavras_chave: { type: "array", items: { type: "string" } },
  },
};

const SISTEMA = `Você organiza o conhecimento das aulas de uma pós-graduação em medicina veterinária e zootecnia (PPGVET) para o time de marketing, que vai transformar isso em posts, carrosséis, reels e mensagens para leads.

Você recebe as anotações e, quando houver, a transcrição da aula. Escreva a ficha em português do Brasil.

REGRAS
- Só o que está no texto. Não complete com o que você sabe do assunto: se o professor não disse, não entra.
- Números, doses, idades, prazos, índices e porcentagens: exatamente como o professor falou, com o contexto (espécie, categoria, situação). Número errado em post técnico destrói a credibilidade.
- Nunca escreva nome de aluno, monitor ou participante. O único nome que pode aparecer é o do professor. Pergunta de aluno vira "um aluno perguntou".
- "professor": o nome dele como aparece nas anotações (ex.: "também conhecido como Wagner Luquezes"). Se não aparecer, deixe vazio. O nome da conta do Meet (empresa, "Monitor Grupo PPG") não é o nome do professor.
- "falas_marcantes": frases do professor que funcionam sozinhas como abertura de post, quase literais, sem vício de fala.
- "casos_praticos": histórias de campo, de fazenda, de clínica, de granja que ele contou, e a lição.
- "erros_comuns": práticas erradas ou mitos que ele corrige.
- "duvidas_frequentes": perguntas feitas na aula e a resposta dada.
- "ganchos_de_conteudo": 3 a 5 ângulos de post que só esta aula permite (formato: carrossel, reels, story ou feed).
- Lista sem conteúdo fica vazia. Não invente para preencher.
- Tetos: até 8 tópicos, 12 dados técnicos, 6 casos, 8 falas, 8 dúvidas, 8 erros comuns, 5 ganchos e 12 palavras-chave. Escolha os mais úteis para conteúdo; frases curtas.
- Sem travessão (— ou –), sem tom de coach.`;

async function chamarClaude(apiKey: string, conteudo: string): Promise<{ ficha: any; uso: any }> {
  const corpo: Record<string, unknown> = {
    model: MODELO,
    // 8000 cortava a ficha das aulas longas (3 de 5 na 1ª amostra, 29/09/2026): o raciocínio
    // do modelo também conta neste teto, e a ficha sozinha já passava de 7 mil tokens.
    max_tokens: 16000,
    system: SISTEMA,
    output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
    messages: [{ role: "user", content: conteudo }],
  };

  // Conteúdo de sanidade (zoonoses, Salmonella, influenza aviária) pode esbarrar no
  // classificador de biossegurança. Com o fallback, a recusa é refeita em outro modelo.
  const tentar = async (comFallback: boolean, semFormato = false) => {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), PRAZO_MS);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      const body = { ...corpo };
      if (semFormato) {
        // Plano B quando o compilador do JSON garantido da Anthropic cai (503 "Grammar
        // compilation is temporarily unavailable", 29/09/2026, ~6 min): o mesmo pedido, com
        // o formato descrito no texto. O parse abaixo já tolera texto em volta do JSON.
        body.output_config = { effort: "low" };
        body.system = `${SISTEMA}\n\nResponda SOMENTE com um objeto JSON válido, sem nada antes ou depois, seguindo exatamente este esquema:\n${JSON.stringify(ESQUEMA)}`;
      }
      if (comFallback) {
        headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
        body.fallbacks = "default";
      }
      return await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers, body: JSON.stringify(body), signal: controle.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await tentar(true);
    if (res.status === 400) {
      const t = await res.text();
      if (/credit balance/i.test(t)) throw new SemCredito("Sem crédito na Anthropic.");
      // Se o fallback em si for o problema, tenta sem ele uma vez; qualquer outro 400 é nosso.
      if (!/fallback/i.test(t)) throw new Error(`Claude 400: ${t.slice(0, 300)}`);
      res = await tentar(false);
    }
  } catch (e) {
    if (e instanceof SemCredito) throw e;
    // Tempo esgotado (AbortError) e queda de rede (TypeError) são passageiros.
    if (e instanceof Error && (e.name === "AbortError" || e instanceof TypeError)) {
      throw new ErroPassageiro(e.name === "AbortError" ? `Passou de ${PRAZO_MS / 1000} s` : e.message);
    }
    throw e;
  }
  if (!res.ok && [503, 529].includes(res.status)) {
    const t = await res.text();
    if (!/grammar/i.test(t)) throw new ErroPassageiro(`Claude ${res.status}: ${t.slice(0, 300)}`);
    try {
      res = await tentar(true, true);
    } catch (e) {
      throw new ErroPassageiro(e instanceof Error ? e.message : String(e));
    }
  }
  if (!res.ok) {
    const t = (await res.text()).slice(0, 300);
    if (/credit balance/i.test(t)) throw new SemCredito("Sem crédito na Anthropic.");
    if ([408, 409, 425, 429, 500, 502, 503, 504, 529].includes(res.status) || /overloaded|rate.?limit/i.test(t)) {
      throw new ErroPassageiro(`Claude ${res.status}: ${t}`);
    }
    throw new Error(`Claude ${res.status}: ${t}`);
  }

  const r = await res.json();
  if (r?.stop_reason === "refusal") {
    throw new Error(`Recusado pela IA (${r?.stop_details?.category ?? "sem categoria"})`);
  }
  if (r?.stop_reason === "max_tokens") throw new Error("Ficha cortada no meio (max_tokens).");
  const texto = (r?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
  let ficha: any;
  try {
    // Do primeiro { ao último }: no plano B (sem JSON garantido) pode vir texto em volta.
    ficha = JSON.parse(texto.slice(texto.indexOf("{"), texto.lastIndexOf("}") + 1));
  } catch {
    throw new Error("A IA devolveu JSON inválido.");
  }
  return { ficha, uso: r?.usage ?? null };
}

/** Travessão sai de todo texto da ficha, em qualquer profundidade. */
function limpar(v: any): any {
  if (typeof v === "string") return tirarTravessao(v).trim();
  if (Array.isArray(v)) return v.map(limpar);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limpar(x)]));
  return v;
}

async function processar(admin: any, apiKey: string, ids: string[]) {
  const resultados: any[] = [];
  for (const id of ids) {
    const { data: aula, error } = await admin
      .from("marketing_conhecimento")
      .select("id, titulo, modulo, curso_rotulo, data_aula, professor, origem, resumo, transcricao, ficha_tentativas")
      .eq("id", id).maybeSingle();
    if (error || !aula) { resultados.push({ id, ok: false, erro: "não encontrada" }); continue; }

    const texto = [
      `AULA: ${aula.titulo}`,
      aula.modulo ? `MÓDULO: ${aula.modulo}` : "",
      aula.curso_rotulo ? `CURSO: ${aula.curso_rotulo}` : "",
      aula.data_aula ? `DATA: ${aula.data_aula}` : "",
      aula.professor ? `PROFESSOR (cadastro): ${aula.professor}` : "",
      aula.origem === "youtube" ? "ORIGEM: aula publicada no YouTube (legenda automática)" : "ORIGEM: aula ao vivo (Google Meet)",
      "",
      "ANOTAÇÕES E RESUMO:",
      aula.resumo || "(sem anotações)",
      "",
      "TRANSCRIÇÃO:",
      aula.transcricao ? aula.transcricao.slice(0, LIMITE_TEXTO) : "(sem transcrição: use só as anotações)",
    ].join("\n");

    const t0 = Date.now();
    try {
      const { ficha, uso } = await chamarClaude(apiKey, texto);
      const limpa = limpar(ficha);
      const update: Record<string, unknown> = {
        ficha: limpa, ficha_status: "ok", ficha_erro: null, ficha_modelo: MODELO,
        ficha_em: new Date().toISOString(),
      };
      if (!aula.professor && limpa?.professor) update.professor = limpa.professor;
      await admin.from("marketing_conhecimento").update(update).eq("id", id);
      console.log("[marketing-conhecimento-estruturar] ok", JSON.stringify({ id, ms: Date.now() - t0, uso }));
      resultados.push({ id, ok: true, ms: Date.now() - t0, uso });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const tentativas = (aula.ficha_tentativas ?? 0) + 1;
      let status = "erro";
      if (e instanceof SemCredito) {
        status = "pendente";
        await admin.from("marketing_conhecimento_config").update({ estruturar_ativo: false, updated_at: new Date().toISOString() }).eq("id", 1);
      } else if (e instanceof ErroPassageiro && tentativas < MAX_TENTATIVAS) {
        status = "pendente";
      }
      await admin.from("marketing_conhecimento")
        .update({
          ficha_status: status, ficha_erro: msg.slice(0, 500), ficha_em: new Date().toISOString(),
          ficha_tentativas: e instanceof SemCredito ? aula.ficha_tentativas ?? 0 : tentativas,
        })
        .eq("id", id);
      console.error("[marketing-conhecimento-estruturar] erro", id, status, msg);
      resultados.push({ id, ok: false, erro: msg, status, ms: Date.now() - t0 });
      if (e instanceof SemCredito) break;
    }
  }
  return resultados;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try {
    const body = await req.json().catch(() => ({}));
    const { data: cfg } = await admin
      .from("marketing_conhecimento_config").select("cron_secret, estruturar_ativo").eq("id", 1).maybeSingle();

    let ids: string[] = [];
    let emSegundoPlano = false;
    const segredo = req.headers.get("x-cron-secret");
    if (segredo) {
      if (!cfg || segredo !== cfg.cron_secret) return json({ error: "Segredo inválido." }, 401);
      if (!cfg.estruturar_ativo) return json({ ok: true, pulado: "estruturar_ativo = false" });
      const { data: reservadas, error } = await admin.rpc("marketing_conhecimento_reservar", { _n: 1 });
      if (error) return json({ error: `Reserva falhou: ${error.message}` }, 500);
      ids = ((reservadas as any[]) ?? []).map((x: any) => (typeof x === "string" ? x : x?.marketing_conhecimento_reservar ?? x?.id)).filter(Boolean);
      if (ids.length === 0) return json({ ok: true, pendentes: 0 });
    } else {
      const authHeader = req.headers.get("Authorization") || "";
      const token = authHeader.replace("Bearer ", "");
      if (!token) return json({ error: "Sessão inválida." }, 401);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: u } = await userClient.auth.getUser(token);
      if (!u?.user) return json({ error: "Sessão inválida." }, 401);
      const [{ data: mkt }, { data: dir }] = await Promise.all([
        userClient.rpc("is_marketing_user"),
        userClient.rpc("is_admin_ou_diretor_user"),
      ]);
      if (!mkt && !dir) return json({ error: "Só o marketing pode estruturar a base." }, 403);
      // UMA aula por pedido: duas passariam dos 150 s do runtime.
      ids = (Array.isArray(body?.ids) ? body.ids : []).filter((x: unknown) => typeof x === "string").slice(0, 1);
      if (ids.length === 0) return json({ error: "Informe a aula (ids)." }, 400);
      // Não reserva o que já está sendo feito (outro clique, ou o cron).
      const { data: livres } = await admin.from("marketing_conhecimento")
        .update({ ficha_status: "processando", ficha_em: new Date().toISOString(), ficha_erro: null })
        .in("id", ids).neq("ficha_status", "processando").select("id");
      ids = ((livres as any[]) ?? []).map((x: any) => x.id);
      if (ids.length === 0) return json({ ok: true, jaEmAndamento: true }, 202);
      emSegundoPlano = true;
    }

    const { data: keyRow } = await admin
      .from("ai_api_keys").select("api_key").eq("provider", "anthropic").eq("is_active", true).limit(1).maybeSingle();
    if (!keyRow) {
      // Devolve as reservas: sem chave, ninguém deve ficar preso em "processando".
      await admin.from("marketing_conhecimento").update({ ficha_status: "pendente" }).in("id", ids);
      return json({ error: "Chave da Anthropic não configurada." }, 500);
    }

    const trabalho = processar(admin, keyRow.api_key, ids);
    const runtime = (globalThis as any).EdgeRuntime;
    if (emSegundoPlano && runtime?.waitUntil) {
      runtime.waitUntil(trabalho);
      return json({ ok: true, emSegundoPlano: true, ids }, 202);
    }
    return json({ ok: true, resultados: await trabalho });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro inesperado";
    console.error("[marketing-conhecimento-estruturar]", msg);
    return json({ error: msg }, 500);
  }
});
