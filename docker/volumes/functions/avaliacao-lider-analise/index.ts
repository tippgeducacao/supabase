// avaliacao-lider-analise
// Análise por IA de TUDO o que foi respondido sobre UM líder no trimestre: a equipe
// (Avaliação de Liderança, anônima), os outros líderes e a diretoria (Avaliação entre
// Líderes) e a autoavaliação. Salva em fin_clima_analises_ia_lider (uma por pessoa e
// trimestre; gerar de novo substitui). Ver docs/Clima Organizacional.md.
//
// Quem pode pedir: o PRÓPRIO avaliado (participante da avaliação) ou a diretoria do Setor do
// Amanhã (pode_ver_resultados_avaliacoes), para qualquer participante. O runtime self-hosted
// não aplica verify_jwt: a checagem é aqui, com o token de quem chama.
//
// Os dados são lidos e resumidos AQUI, com a chave de serviço, pelas mesmas regras da tela
// (_shared) — a tela não manda número nenhum; a IA recebe os resumos, sem o nome de quem
// escreveu (só o papel: líder ou diretoria).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  ESQUEMA_ANALISE,
  INSTRUCOES_ANALISE,
  baseDaAnalise,
  dadosParaIA,
  validarAnalise,
  type AnaliseLider,
} from "../_shared/analiseLider.ts";
import { nomeNaPergunta, resumoDoAvaliado, type LinhaResposta } from "../_shared/avaliacaoEntreLideres.ts";
import { resumoDaEquipe, type PerguntaDaEquipe } from "../_shared/resumoEquipeDoLider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MODELO = Deno.env.get("AVALIACAO_ANALISE_MODEL") ?? "claude-opus-5";

function responder(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Chave da Anthropic ativa em ai_api_keys (a mesma do relatório do DISC). */
async function chaveAnthropic(admin: any): Promise<string> {
  const { data, error } = await admin
    .from("ai_api_keys")
    .select("api_key")
    .eq("provider", "anthropic")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Erro ao ler a chave da IA: " + error.message);
  if (!data?.api_key) throw new Error("Nenhuma chave da Anthropic ativa em ai_api_keys. Configure em /ia-config.");
  return data.api_key as string;
}

/** A análise salva contou as mesmas respostas que existem agora? */
function mesmaBase(a: any, b: any): boolean {
  return ["respostas_equipe", "avaliacoes_lideres", "avaliacoes_diretoria", "autoavaliacao"]
    .every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

/** "2026-10-14" → "14/10". */
function dataCurta(iso: string): string {
  const [, m, d] = String(iso).split("-");
  return `${d}/${m}`;
}

/** Nome da ficha comparável ao que o formulário gravou (mesma regra da RPC da tela). */
const normalizarNome = (s: string | null | undefined) =>
  (s ?? "").replace(/^[\s,;.\t]+|[\s,;.\t]+$/g, "").toLowerCase();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // 1) Quem está chamando.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return responder(401, { error: "Entre no sistema para gerar a análise." });
    const doUsuario = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: sessao, error: erroSessao } = await doUsuario.auth.getUser(token);
    const eu = sessao?.user?.id;
    if (erroSessao || !eu) return responder(401, { error: "Sessão inválida. Entre novamente." });

    // 2) O pedido.
    const corpo = await req.json().catch(() => null);
    const trimestre = String(corpo?.trimestre ?? "");
    if (!/^\d{4}-Q[1-4]$/.test(trimestre)) return responder(400, { error: "Trimestre inválido." });
    const avaliadoId = String(corpo?.avaliado_id ?? eu);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 3) Permissão: o próprio avaliado, ou a diretoria do Setor do Amanhã.
    const { data: participantes, error: erroPart } = await admin
      .from("fin_avaliacao_lideres_participantes")
      .select("profile_id, papel, ativo");
    if (erroPart) throw new Error(erroPart.message);
    const ativos = (participantes ?? []).filter((p: any) => p.ativo);
    const avaliado = ativos.find((p: any) => p.profile_id === avaliadoId);
    if (!avaliado) return responder(404, { error: "Essa pessoa não participa das avaliações de líderes." });
    if (avaliadoId !== eu) {
      const { data: pode, error: erroPode } = await doUsuario.rpc("pode_ver_resultados_avaliacoes");
      if (erroPode) return responder(503, { error: "Não consegui conferir o seu acesso. Tente de novo." });
      if (pode !== true) return responder(403, { error: "Só a própria pessoa ou a diretoria podem gerar esta análise." });
    }

    // 3b) Ciclo em andamento: as respostas da equipe só aparecem quando ele fecha (anonimato —
    // ver o número subir ao vivo entregava quem acabou de responder), então a análise espera.
    const { data: aberto, error: erroAberto } = await admin.rpc("avaliacao_ciclo_aberto");
    if (erroAberto) throw new Error(erroAberto.message);
    const cicloAberto = ((aberto ?? []) as { trimestre: string; fecha_em: string }[])[0];
    if (cicloAberto?.trimestre === trimestre) {
      return responder(409, {
        error: `A análise do ${trimestre} fica disponível quando o ciclo fechar (último dia: ${dataCurta(cicloAberto.fecha_em)}).`,
      });
    }

    const { data: perfis } = await admin
      .from("profiles")
      .select("id, name")
      .in("id", ativos.map((p: any) => p.profile_id));
    const nomeDe = new Map<string, string>((perfis ?? []).map((p: any) => [p.id, String(p.name ?? "").trim()]));
    const nomeCurto = nomeNaPergunta(nomeDe.get(avaliadoId) ?? "", [...nomeDe.values()]) || "o líder";
    const papelDoAvaliador: Record<string, string> = Object.fromEntries(
      (participantes ?? []).map((p: any) => [p.profile_id, p.papel]),
    );

    // 4a) Pares e diretoria (Avaliação entre Líderes).
    const { data: entre, error: erroEntre } = await admin
      .from("fin_clima_respostas_entre_lideres")
      .select("avaliador_id, avaliado_id, respostas")
      .eq("avaliado_id", avaliadoId)
      .eq("trimestre", trimestre);
    if (erroEntre) throw new Error(erroEntre.message);
    const resumoEntre = resumoDoAvaliado((entre ?? []) as LinhaResposta[], avaliadoId);

    // 4b) Equipe (Avaliação de Liderança, anônima). Desde o ciclo automático (25/09/2026) a
    // resposta leva o `lider_id`; as de antes casam por setor + nome do líder gravado.
    let equipe = null;
    const minhasPorId = new Map<string, any>();
    const { data: peloLider, error: erroPeloLider } = await admin
      .from("fin_clima_respostas_lider")
      .select("id, respostas")
      .eq("lider_id", avaliadoId)
      .eq("trimestre", trimestre);
    if (erroPeloLider) throw new Error(erroPeloLider.message);
    for (const r of peloLider ?? []) minhasPorId.set(r.id, r);

    const { data: fichas, error: erroFichas } = await admin.from("fin_colaboradores").select("id, nome").eq("profile_id", avaliadoId);
    if (erroFichas) throw new Error(erroFichas.message);
    const fichaIds = (fichas ?? []).map((f: any) => f.id);
    if (fichaIds.length > 0) {
      const { data: setores, error: erroSetores } = await admin.from("fin_setores").select("id, lider_id").in("lider_id", fichaIds);
      if (erroSetores) throw new Error(erroSetores.message);
      const nomeDaFicha = new Map<string, string>((fichas ?? []).map((f: any) => [f.id, normalizarNome(f.nome)]));
      const liderDoSetor = new Map<string, string>((setores ?? []).map((s: any) => [String(s.id), nomeDaFicha.get(s.lider_id) ?? ""]));
      if (liderDoSetor.size > 0) {
        const { data: daEquipe, error: erroEquipe } = await admin
          .from("fin_clima_respostas_lider")
          .select("id, setor_id, lider_nome, lider_id, respostas")
          .in("setor_id", [...liderDoSetor.keys()])
          .is("lider_id", null)
          .eq("trimestre", trimestre);
        if (erroEquipe) throw new Error(erroEquipe.message);
        for (const r of daEquipe ?? []) {
          if (normalizarNome(r.lider_nome) === liderDoSetor.get(String(r.setor_id))) minhasPorId.set(r.id, r);
        }
      }
    }

    const minhas = [...minhasPorId.values()];
    if (minhas.length > 0) {
        // Perguntas do banco; resposta gravada pelo id vira a chave fixa `l{ordem}` (a mesma ponte da tela).
        const { data: perguntasBanco, error: erroPerguntas } = await admin
          .from("fin_clima_perguntas")
          .select("id, bloco, texto, tipo_resposta, ordem")
          .eq("tipo_avaliacao", "lider");
        // Sem as perguntas a IA leria "nenhuma resposta da equipe" — e isso seria salvo.
        if (erroPerguntas) throw new Error(erroPerguntas.message);
        const perguntas: PerguntaDaEquipe[] = (perguntasBanco ?? [])
          .sort((a: any, b: any) => a.ordem - b.ordem)
          .map((p: any) => ({ chave: `l${p.ordem}`, bloco: p.bloco ?? "", texto: p.texto ?? "", tipo: p.tipo_resposta ?? "" }));
        const chaveDoId = new Map<string, string>((perguntasBanco ?? []).map((p: any) => [p.id, `l${p.ordem}`]));
        const normalizadas = minhas.map((r: any) => {
          const saida: Record<string, unknown> = {};
          for (const [k, v] of Object.entries((r.respostas ?? {}) as Record<string, unknown>)) {
            const fixa = chaveDoId.get(k) ?? k;
            if (!(fixa in saida)) saida[fixa] = v;
          }
          return saida;
        });
        if (perguntas.length > 0 && normalizadas.length > 0) equipe = resumoDaEquipe(perguntas, normalizadas);
    }

    if (resumoEntre.avaliacoes === 0 && !equipe) {
      return responder(400, { error: `Ainda não há respostas sobre ${nomeCurto} em ${trimestre}.` });
    }

    // 4c) Clique repetido (ou a tela que desistiu de esperar e a pessoa clicou de novo): se a
    // análise deste trimestre foi gerada há menos de 10 min com a MESMA base, devolve a salva em
    // vez de pagar a IA de novo.
    const base = baseDaAnalise(resumoEntre, papelDoAvaliador, equipe?.respostas ?? 0);
    const { data: recente, error: erroRecente } = await admin
      .from("fin_clima_analises_ia_lider")
      .select("id, avaliado_id, trimestre, analise, base, modelo, updated_at")
      .eq("avaliado_id", avaliadoId)
      .eq("trimestre", trimestre)
      .maybeSingle();
    if (erroRecente) throw new Error(erroRecente.message);
    if (recente && Date.now() - new Date(recente.updated_at).getTime() < 10 * 60 * 1000 && mesmaBase(recente.base, base)) {
      return responder(200, recente);
    }

    // 5) IA — Claude, com saída no formato fixo e reserva automática se o modelo recusar.
    // `effort: "low"`: é um resumo de dados já contados; o raciocínio longo só somava tempo
    // (medido em 28/09/2026: ~40 s no padrão, e o Kong corta em 60 s).
    const chave = await chaveAnthropic(admin);
    const pedido = {
      model: MODELO,
      max_tokens: 8000,
      fallbacks: "default",
      system: INSTRUCOES_ANALISE,
      messages: [
        {
          role: "user",
          content: dadosParaIA({ nome: nomeCurto, trimestre, equipe, entreLideres: resumoEntre, papelDoAvaliador }),
        },
      ],
      output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA_ANALISE } },
    };

    // A reserva automática (`fallbacks`) é beta: se a conta recusar o recurso (400), vai sem ela.
    let comReserva = true;
    /** Uma chamada à IA, com novas tentativas de rede. Um `Response` = erro pronto para devolver. */
    const chamarIA = async (): Promise<any> => {
      for (let tentativa = 0; tentativa < 3; tentativa++) {
        const { fallbacks: _reserva, ...semReserva } = pedido;
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": chave,
            "anthropic-version": "2023-06-01",
            ...(comReserva ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
          },
          body: JSON.stringify(comReserva ? pedido : semReserva),
        });
        if (r.ok) return await r.json();
        const txt = await r.text().catch(() => "");
        console.error("anthropic", r.status, txt.slice(0, 400));
        if (/credit|billing/i.test(txt)) {
          return responder(402, { error: "Os créditos de IA acabaram. Avise o TI para recarregar." });
        }
        if (r.status === 400 && comReserva && /fallback/i.test(txt)) {
          comReserva = false;
          continue;
        }
        // 4xx (fora 429) é definitivo; 429/5xx tenta de novo.
        if (r.status < 500 && r.status !== 429) {
          return responder(502, { error: `A IA recusou o pedido (${r.status}). Tente de novo mais tarde.` });
        }
        await new Promise((ok) => setTimeout(ok, 1500 * (tentativa + 1)));
      }
      return responder(503, { error: "A IA está ocupada agora. Tente de novo em alguns minutos." });
    };

    // Até duas gerações: se a primeira vier incompleta (lista vazia, JSON quebrado ou cortada),
    // pede de novo em vez de salvar análise pela metade.
    let analise: AnaliseLider | null = null;
    let modeloUsado = MODELO;
    for (let geracao = 0; geracao < 2 && !analise; geracao++) {
      const resposta = await chamarIA();
      if (resposta instanceof Response) return resposta;
      if (resposta.stop_reason === "refusal") {
        return responder(502, { error: "A IA não quis analisar este conteúdo. Fale com o TI." });
      }
      modeloUsado = String(resposta.model ?? MODELO);
      if (resposta.stop_reason === "max_tokens") {
        console.error("avaliacao-lider-analise: análise cortada (max_tokens)");
        continue;
      }
      const texto = (resposta.content ?? []).find((b: any) => b.type === "text")?.text ?? "";
      let bruto: unknown = null;
      try {
        bruto = JSON.parse(texto);
      } catch {
        // Defesa: pega da primeira { até a última } (se vier texto em volta).
        const i = texto.indexOf("{");
        const f = texto.lastIndexOf("}");
        try {
          bruto = i >= 0 && f > i ? JSON.parse(texto.slice(i, f + 1)) : null;
        } catch {
          bruto = null;
        }
      }
      analise = validarAnalise(bruto);
      if (!analise) console.error("avaliacao-lider-analise: resposta incompleta, tamanho", texto.length);
    }
    if (!analise) {
      return responder(502, { error: "A IA devolveu uma análise incompleta duas vezes. Tente de novo em instantes." });
    }

    // 6) Salva (gerar de novo substitui).
    const agora = new Date().toISOString();
    const { data: salva, error: erroSalvar } = await admin
      .from("fin_clima_analises_ia_lider")
      .upsert(
        {
          avaliado_id: avaliadoId,
          trimestre,
          analise,
          base,
          modelo: modeloUsado,
          gerado_por: eu,
          updated_at: agora,
        },
        { onConflict: "avaliado_id,trimestre" },
      )
      .select("id, avaliado_id, trimestre, analise, base, modelo, updated_at")
      .single();
    if (erroSalvar) throw new Error(erroSalvar.message);

    return responder(200, salva);
  } catch (e) {
    console.error("avaliacao-lider-analise", e);
    return responder(500, { error: e instanceof Error ? e.message : "Erro inesperado." });
  }
});
