// mimosa-vendas
// A MIMOSA do Portal Comercial — inteligência de vendas com acesso AO VIVO a tudo que o
// comercial tem no sistema (substitui `sales-copilot-chat`, 28/09/2026).
//
// Como ela sabe as coisas (e por que está sempre atualizada):
//   * Nada é copiado. A cada pergunta, o catálogo (preço oficial, matrícula, quem pode
//     cursar, próximo prático…) é lido do banco e vai no prompt; o resto ela busca com
//     ferramentas (grade, práticos, professores, turmas, material de venda, documentos,
//     busca geral) — RPCs `mimosa_*` chamadas com o JWT de QUEM PERGUNTA.
//   * Documento novo enviado pela gestão entra na busca na mesma hora.
//   * Conta de orçamento é feita por código (`_shared/mimosaOrcamento.ts`), não pela IA.
//
// ⚠️ Nunca chame as RPCs com a service role: elas exigem `auth.uid()` e voltam VAZIAS.
//    Foi exatamente assim que a Mimosa antiga ficou meses sem ver grade, práticos,
//    turmas e professores.
// ⚠️ Chamada pelo NAVEGADOR → nunca devolver 502/504 (o Cloudflare troca por página
//    sem CORS). Recusa antes do stream = 401/422/429 em JSON; depois, evento `erro`.
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { executarFerramenta, FERRAMENTAS } from "./ferramentas.ts";
import { blocoBase, blocoConversa, hojeEmBrasilia, PROMPT_BASE } from "./prompt.ts";
import { criarRastreioDaTela, motivoDaReserva, rodarAgente, type EventoMimosa, type ResumoAgente } from "./agente.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Opus 5 por padrão (precisão acima de tudo: ela responde preço e data para o lead).
// Troca sem deploy de código: env MIMOSA_VENDAS_MODEL / MIMOSA_VENDAS_EFFORT.
const MODELO = Deno.env.get("MIMOSA_VENDAS_MODEL") ?? "claude-opus-5";
const MODELO_RESERVA = "claude-sonnet-5";
const ESFORCOS = ["low", "medium", "high", "xhigh", "max"] as const;
const ESFORCO = (ESFORCOS as readonly string[]).includes(Deno.env.get("MIMOSA_VENDAS_EFFORT") ?? "")
  ? Deno.env.get("MIMOSA_VENDAS_EFFORT")!
  : "medium";
const MAX_TOKENS = 16000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** Mesma ordem da Mimosa antiga: chave cadastrada no sistema, depois env. */
async function chaveAnthropic(): Promise<string | null> {
  try {
    const { data } = await admin().from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data?.api_key) return String(data.api_key);
  } catch { /* cai para o env */ }
  return Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("AGENTE_SDR_ANTHROPIC_KEY") ?? null;
}

function textoLimitado(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parâmetros que dependem do modelo: o fallback server-side só existe para o Opus 5/Fable. */
function paramsDoModelo(modelo: string): Record<string, unknown> {
  const comFallback = modelo.startsWith("claude-opus-5") || modelo.startsWith("claude-fable");
  return {
    model: modelo,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: ESFORCO },
    ...(comFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
}

function mensagemDeErro(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && motivoDaReserva(e) === "sobrecarga")) {
    return "Estou com muita gente me chamando agora. Tenta de novo em um minutinho?";
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return "Minha chave de acesso à IA foi recusada. Avisa o TI, por favor?";
  }
  if (e instanceof Anthropic.APIConnectionError) return "Não consegui me conectar agora. Tenta de novo?";
  return "Não consegui responder agora. Tenta de novo em instantes?";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ erro: "método não suportado" }, 405);

  // ── Quem está perguntando ────────────────────────────────────────────────
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ erro: "não autenticado" }, 401);
  const sbUsuario = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: userData } = await sbUsuario.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ erro: "Sua sessão expirou. Entra de novo no sistema e me pergunta outra vez?" }, 401);

  // ── O que ela recebeu ────────────────────────────────────────────────────
  const body = await req.json().catch(() => ({}));
  const pergunta = textoLimitado(body?.pergunta, 4000);
  if (!pergunta) return json({ erro: "pergunta vazia" }, 422);
  const conversaId = typeof body?.conversa_id === "string" && UUID.test(body.conversa_id) ? body.conversa_id : null;
  const historico: Anthropic.Beta.BetaMessageParam[] = (Array.isArray(body?.historico) ? body.historico : [])
    .filter((m: { role?: unknown; content?: unknown }) =>
      m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-16)
    .map((m: { role: "user" | "assistant"; content: string }) => ({ role: m.role, content: m.content.slice(0, 6000) }));
  // A API exige começar por `user`; histórico cortado pode começar pela resposta.
  while (historico.length && historico[0].role !== "user") historico.shift();

  // ── Cota (antes de gastar com a IA) ──────────────────────────────────────
  const { data: cota, error: erroCota } = await admin().rpc("mimosa_vendas_iniciar", {
    p_usuario_id: user.id,
    p_conversa_id: conversaId,
  });
  if (erroCota) {
    console.error("[mimosa-vendas] cota", erroCota.message);
    return json({ erro: "Não consegui registrar sua pergunta agora. Tenta de novo?" }, 422);
  }
  if (!cota?.ok) {
    return json({
      erro: cota?.motivo === "dia"
        ? "Por hoje você chegou no limite de perguntas. Amanhã a gente continua!"
        : `Muitas perguntas seguidas. Me dá ${cota?.retry_after ?? 60} segundos e tenta de novo?`,
      retry_after: cota?.retry_after ?? null,
    }, 429);
  }
  const usoId: string = cota.id;

  const finalizarUso = async (resumo: ResumoAgente | null, modelo: string, erro?: string) => {
    try {
      await admin().rpc("mimosa_vendas_finalizar", {
        p_id: usoId,
        p_dados: {
          modelo,
          iteracoes: resumo?.passos ?? null,
          ferramentas: resumo?.ferramentas ?? [],
          tokens_entrada: resumo?.uso.entrada ?? null,
          tokens_saida: resumo?.uso.saida ?? null,
          tokens_cache_leitura: resumo?.uso.cacheLeitura ?? null,
          tokens_cache_escrita: resumo?.uso.cacheEscrita ?? null,
          fallback: resumo?.fallback ?? null,
          erro: erro ?? (resumo && resumo.terminou !== "resposta" ? resumo.terminou : null),
        },
      });
    } catch (e) {
      console.error("[mimosa-vendas] finalizar uso", (e as Error)?.message);
    }
  };

  // ── Contexto ao vivo: catálogo, documentos, avisos, quem pergunta ────────
  const [catalogoR, documentosR, avisosR, perfilR, chave] = await Promise.all([
    sbUsuario.rpc("mimosa_catalogo"),
    sbUsuario.rpc("mimosa_documentos_listar"),
    sbUsuario.from("comercial_portal_avisos").select("titulo,mensagem,expira_em").eq("ativo", true).limit(10),
    admin().from("profiles").select("name,user_type").eq("id", user.id).maybeSingle(),
    chaveAnthropic(),
  ]);

  if (catalogoR.error || !catalogoR.data) {
    console.error("[mimosa-vendas] catálogo", catalogoR.error?.message);
    await finalizarUso(null, MODELO, "catalogo_indisponivel");
    return json({ erro: "Não consegui abrir o catálogo do sistema agora. Tenta de novo?" }, 422);
  }
  if (!chave) {
    await finalizarUso(null, MODELO, "sem_chave");
    return json({ erro: "Estou sem chave de acesso à IA configurada. Avisa o TI, por favor?" }, 422);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const documentos = (Array.isArray(documentosR.data) ? documentosR.data : []).filter((d: any) => d?.em_uso);
  const agora = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const avisos = (avisosR.data ?? []).filter((a: any) => !a.expira_em || new Date(a.expira_em) > agora);
  const nome = perfilR.data?.name ? String(perfilR.data.name).split(" ")[0] : "colega";
  const cargo = perfilR.data?.user_type ? String(perfilR.data.user_type) : "comercial";

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: PROMPT_BASE, cache_control: { type: "ephemeral" } },
    { type: "text", text: blocoBase(catalogoR.data, documentos, avisos), cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: blocoConversa({
        hoje: hojeEmBrasilia(agora).extenso,
        vendedor: nome,
        cargo,
        produtoFoco: textoLimitado(body?.produto_foco, 200),
        lead: textoLimitado(body?.contexto_lead, 4000),
        materialEditorial: textoLimitado(body?.material_editorial, 16000),
      }),
    },
  ];
  const mensagens: Anthropic.Beta.BetaMessageParam[] = [...historico, { role: "user", content: pergunta }];

  const cliente = new Anthropic({ apiKey: chave, maxRetries: 2, timeout: 120_000 });
  const encoder = new TextEncoder();
  const abortar = new AbortController();

  const corpo = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enviar = (ev: EventoMimosa) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
        } catch { /* navegador já foi embora */ }
      };

      let modelo = MODELO;
      const tela = criarRastreioDaTela();
      const deps = {
        abrirStream: (params: Record<string, unknown>) =>
          cliente.beta.messages.stream({ ...params, ...paramsDoModelo(modelo) } as never, { signal: abortar.signal }),
        executar: (nomeFerramenta: string, entrada: unknown) => executarFerramenta(sbUsuario, nomeFerramenta, entrada),
        emitir: (ev: EventoMimosa) => {
          tela.registrar(ev);
          enviar(ev);
        },
        ehErroDaApi: (e: unknown) => e instanceof Anthropic.APIError,
        cancelado: () => abortar.signal.aborted,
      };
      const entrada = { system, tools: FERRAMENTAS, messages: mensagens };

      let resumo: ResumoAgente | null = null;
      try {
        try {
          resumo = await rodarAgente(entrada, deps);
        } catch (e) {
          // Reserva em vez de erro na tela: modelo indisponível (404) ou IA sobrecarregada
          // (529/overloaded_error). Só enquanto nenhuma resposta apareceu; o que já foi
          // recolhido como consulta fica, e a reserva continua a numeração dos passos.
          const motivo = e instanceof Anthropic.APIError ? motivoDaReserva(e) : null;
          if (motivo && modelo !== MODELO_RESERVA && !tela.respostaVisivel() && !abortar.signal.aborted) {
            console.warn("[mimosa-vendas] usando reserva", motivo, modelo);
            modelo = MODELO_RESERVA;
            resumo = await rodarAgente(entrada, deps, { passoInicial: tela.proximoPasso() });
            resumo.fallback = true;
          } else {
            throw e;
          }
        }
        enviar({ tipo: "fontes", itens: resumo.fontes });
        enviar({ tipo: "fim", modelo, passos: resumo.passos, fallback: resumo.fallback });
        await finalizarUso(resumo, modelo);
      } catch (e) {
        if (!abortar.signal.aborted) {
          console.error("[mimosa-vendas] erro", (e as Error)?.message);
          enviar({ tipo: "erro", mensagem: mensagemDeErro(e) });
        }
        await finalizarUso(resumo, modelo, abortar.signal.aborted ? "cancelado" : String((e as Error)?.message ?? e).slice(0, 300));
      } finally {
        try {
          controller.close();
        } catch { /* já fechado */ }
      }
    },
    cancel() {
      // A pessoa fechou a aba ou clicou em parar: não gasta mais nenhuma rodada.
      abortar.abort();
    },
  });

  return new Response(corpo, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      // evita o proxy (nginx/Kong) bufferizar o stream e entregar tudo de uma vez
      "X-Accel-Buffering": "no",
    },
  });
});
