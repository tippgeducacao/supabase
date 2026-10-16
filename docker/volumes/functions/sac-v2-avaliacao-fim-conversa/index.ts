// Avaliação de Atendimento: a IA identifica o FIM da conversa (16/10/2026).
//
// O agendamento do banco (`sac_v2_avaliacao_fim_conversa_chamar`, a cada 10 min) chama esta edge
// com o segredo no cabeçalho x-sac-fim-conversa-secret. Ela pega as conversas paradas entre 30 min e
// 3 h (`sac_v2_avaliacao_fim_candidatos`), pergunta à IA se cada uma acabou e grava a resposta
// (`sac_v2_avaliacao_fim_registrar`): se acabou, a pergunta da nota entra na fila e o tick manda,
// com as regras de sempre (janela de 24 h, resposta da equipe, 7 dias, bloqueio). O card NÃO é
// resolvido aqui — escolha do usuário.
//
// ⚠️ Só a decisão VÁLIDA é gravada. Falha passageira da IA (rede, 429, 5xx, prazo) não grava nada,
// e a mesma pausa é lida de novo na rodada seguinte; gravar "erro" a marcaria como lida para sempre.
// Saída fora do formato e recusa ficam gravadas como erro: repetir só gastaria de novo.
//
// Corpo opcional `{"ensaio": true, "max_horas": 24, "limite": 20}`: lê e devolve as decisões sem
// gravar nada (usado para conferir o julgamento antes de ligar o agendamento).
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { ESQUEMA_DECISAO, interpretarDecisao, montarConversa, PROMPT_FIM_DE_CONVERSA, type Candidata } from "./regras.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Haiku 5.5 desde 16/10/2026, a pedido do usuário (custo). Nas 30 leituras reais do dia decidiu
// igual ao Opus 5.5 em 28; nas outras 2 ficou com "não acabou", o lado seguro. Medido: 1.887
// tokens de entrada e ~69 de saída por leitura = ~US$ 0,0002 (o Opus dava US$ 0,0087). Sem
// fallback do servidor (o Haiku não tem): falha passageira só repete na rodada seguinte.
// Troca sem deploy de código: SAC_FIM_CONVERSA_MODEL.
const MODELO = Deno.env.get("SAC_FIM_CONVERSA_MODEL") ?? "claude-haiku-5-5";
const COM_FALLBACK = MODELO.startsWith("claude-opus-5") || MODELO.startsWith("claude-fable");
const LIMITE_PADRAO = 20;
const EM_PARALELO = 4;
const PRAZO_IA_MS = 60_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/** Mesma ordem das outras IAs do sistema: chave cadastrada na tela, depois env. */
async function chaveAnthropic(): Promise<string | null> {
  try {
    const { data } = await admin().from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data?.api_key) return String(data.api_key);
  } catch { /* cai para o env */ }
  return Deno.env.get("ANTHROPIC_API_KEY") ?? null;
}

type Leitura =
  | { tipo: "decisao"; encerrada: boolean; motivo: string; modelo: string }
  | { tipo: "erro_definitivo"; erro: string; modelo: string | null }
  | { tipo: "erro_passageiro"; erro: string }
  | { tipo: "parar"; erro: string };

async function ler(cliente: Anthropic, c: Candidata, agora: Date): Promise<Leitura> {
  try {
    const resposta = await cliente.beta.messages.create({
      model: MODELO,
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA_DECISAO } },
      ...(COM_FALLBACK ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      system: PROMPT_FIM_DE_CONVERSA,
      messages: [{ role: "user", content: montarConversa(c, agora) }],
    } as never) as Anthropic.Beta.BetaMessage;
    if (resposta.stop_reason === "refusal") return { tipo: "erro_definitivo", erro: "recusa", modelo: resposta.model };
    if (resposta.stop_reason === "max_tokens") return { tipo: "erro_passageiro", erro: "max_tokens" };
    const texto = resposta.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text;
    const d = interpretarDecisao(texto);
    if (!d) return { tipo: "erro_definitivo", erro: `saida_invalida: ${(texto ?? "").slice(0, 120)}`, modelo: resposta.model };
    return { tipo: "decisao", encerrada: d.encerrada, motivo: d.motivo, modelo: resposta.model };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return { tipo: "parar", erro: "chave recusada" };
    }
    if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) {
      return { tipo: "parar", erro: "sem créditos" };
    }
    if (e instanceof Anthropic.BadRequestError) {
      return { tipo: "erro_definitivo", erro: `400: ${e.message.slice(0, 200)}`, modelo: null };
    }
    return { tipo: "erro_passageiro", erro: (e as Error)?.message?.slice(0, 200) ?? String(e) };
  }
}

/** Roda `fn` em até `n` itens ao mesmo tempo, na ordem da lista. */
async function emLotes<T, R>(itens: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const saida: R[] = new Array(itens.length);
  let proximo = 0;
  const trabalhar = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, trabalhar));
  return saida;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "método não suportado" }, 405);

  const db = admin();
  const segredo = req.headers.get("x-sac-fim-conversa-secret") ?? "";
  const { data: valido, error: erroValidar } = await db.rpc("sac_v2_fim_conversa_validar", { p_segredo: segredo });
  if (erroValidar) {
    console.error("[sac-v2-avaliacao-fim-conversa] validar", erroValidar.message);
    return json({ erro: "não foi possível conferir o acesso" }, 503);
  }
  if (valido !== true) return json({ erro: "não autorizado" }, 401);

  let corpo: { ensaio?: boolean; max_horas?: number; limite?: number } = {};
  try {
    corpo = await req.json();
  } catch { /* sem corpo = rodada normal */ }
  const ensaio = corpo.ensaio === true;
  const limite = Math.max(1, Math.min(Number(corpo.limite) || LIMITE_PADRAO, 50));
  const maxHoras = ensaio ? Math.max(1, Math.min(Number(corpo.max_horas) || 3, 48)) : 3;

  const { data: candidatas, error: erroLista } = await db.rpc("sac_v2_avaliacao_fim_candidatos", {
    p_limite: limite, p_max_horas: maxHoras,
  });
  if (erroLista) {
    console.error("[sac-v2-avaliacao-fim-conversa] candidatos", erroLista.message);
    return json({ erro: "não foi possível listar as conversas" }, 503);
  }
  const lista = (candidatas ?? []) as Candidata[];
  if (lista.length === 0) return json({ lidas: 0, ensaio });

  const chave = await chaveAnthropic();
  if (!chave) return json({ erro: "IA sem chave configurada" }, 422);
  const cliente = new Anthropic({ apiKey: chave, maxRetries: 1, timeout: PRAZO_IA_MS });

  const agora = new Date();
  let parar: string | null = null;
  const resultados = await emLotes(lista, EM_PARALELO, async (c) => {
    if (parar) return { atendimento_id: c.atendimento_id, resultado: "nao_lida", erro: parar };
    const l = await ler(cliente, c, agora);
    if (l.tipo === "parar") {
      parar = l.erro;
      return { atendimento_id: c.atendimento_id, resultado: "nao_lida", erro: l.erro };
    }
    if (l.tipo === "erro_passageiro") {
      return { atendimento_id: c.atendimento_id, resultado: "tentar_de_novo", erro: l.erro };
    }
    if (ensaio) {
      return {
        atendimento_id: c.atendimento_id,
        setor: c.setor,
        encerrada: l.tipo === "decisao" ? l.encerrada : null,
        motivo: l.tipo === "decisao" ? l.motivo : null,
        erro: l.tipo === "erro_definitivo" ? l.erro : null,
        ultimas: (c.mensagens ?? []).slice(-4),
      };
    }
    const { data: resultado, error } = await db.rpc("sac_v2_avaliacao_fim_registrar", {
      p_atendimento_id: c.atendimento_id,
      p_ultima_mensagem_id: c.ultima_mensagem_id,
      p_encerrada: l.tipo === "decisao" ? l.encerrada : null,
      p_motivo: l.tipo === "decisao" ? l.motivo : null,
      p_modelo: l.modelo,
      p_erro: l.tipo === "erro_definitivo" ? l.erro : null,
    });
    if (error) return { atendimento_id: c.atendimento_id, resultado: "falha_ao_gravar", erro: error.message };
    return { atendimento_id: c.atendimento_id, resultado };
  });

  const contagem: Record<string, number> = {};
  for (const r of resultados as Array<Record<string, unknown>>) {
    const chaveContagem = ensaio
      ? (r.encerrada === true ? "acabou" : r.encerrada === false ? "nao_acabou" : String(r.resultado ?? "erro"))
      : String(r.resultado);
    contagem[chaveContagem] = (contagem[chaveContagem] ?? 0) + 1;
  }
  console.log(JSON.stringify({ fn: "sac-v2-avaliacao-fim-conversa", ensaio, lidas: lista.length, contagem, modelo: MODELO, parou: parar }));
  return json(ensaio ? { ensaio, lidas: lista.length, contagem, resultados } : { lidas: lista.length, contagem, parou: parar });
});
