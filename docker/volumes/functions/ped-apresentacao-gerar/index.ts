// ped-apresentacao-gerar — a IA escreve um bloco da apresentação de venda de uma pós (24/11/2026).
//
// Quem chama: alguém do Pedagógico, pela aba «Venda e certificação» do curso (botão «Gerar com IA»).
// Pedido: { pos_id, bloco } — bloco é um de BLOCOS (_shared/apresentacaoVenda.ts).
//
// 1. confere a sessão e o Pedagógico (user_can_access_pedagogico, o mesmo gate do resto do módulo);
// 2. junta o que o sistema já sabe da pós: cadastro, grade (ped_curso_aulas_blueprint), aulas ao vivo
//    extras, professores e a ficha de venda (comercial_programa_data), se existir;
// 3. pede à IA SÓ este bloco, com saída em JSON (schema por bloco); o que o material não traz vai
//    para «lacunas», nunca para o texto;
// 4. limpa e confere (normalizarBloco) e grava no RASCUNHO (ped_apresentacao_venda_gravar_ia).
//    O deck do vendedor não muda: só o clique «Aprovar» do Pedagógico publica (regra «o Pedagógico tem
//    a palavra final»).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { fichaSemVisual } from "../_shared/comercialQuizGeracao.ts";
import {
  MIN_MATERIAL_CHARS, SISTEMA, ehBloco, montarMaterial, normalizarBloco, pedidoDoBloco, schemaDoBloco,
  type AulaExtra, type LinhaGrade, type PosMaterial, type ProfessorMaterial,
} from "../_shared/apresentacaoVenda.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELO = Deno.env.get("PED_APRESENTACAO_MODEL") ?? "claude-opus-5-5";
/** Abaixo dos ~100 s em que o Cloudflare troca a resposta por uma página de erro sem CORS. */
const TEMPO_IA_MS = 80_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function chaveAnthropic(db: Db): Promise<string> {
  const { data, error } = await db
    .from("ai_api_keys")
    .select("api_key")
    .eq("provider", "anthropic")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Erro ao ler a chave da Anthropic: " + error.message);
  if (!data?.api_key) throw new Error("Nenhuma chave Anthropic ativa em ai_api_keys (/ia-config).");
  return data.api_key as string;
}

/** Uma chamada com saída em JSON. Com reserva do servidor (fallbacks) quando a conta aceita. */
async function chamarIA(apiKey: string, pedido: string, schema: Record<string, unknown>): Promise<unknown> {
  const signal = AbortSignal.timeout(TEMPO_IA_MS);
  const chamar = (comReserva: boolean) =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(comReserva ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 16000,
        ...(comReserva ? { fallbacks: "default" } : {}),
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        system: SISTEMA,
        messages: [{ role: "user", content: pedido }],
      }),
    });
  let res = await chamar(true);
  if (res.status === 400) {
    const txt = await res.clone().text();
    if (/fallback/i.test(txt)) res = await chamar(false);
  }
  if (!res.ok) throw new Error(`IA ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = await res.json();
  if (msg.stop_reason === "refusal") throw new Error("A IA recusou o pedido.");
  if (msg.stop_reason === "max_tokens") throw new Error("A resposta da IA foi cortada (max_tokens).");
  const texto = (msg.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
  return JSON.parse(texto);
}

async function juntarMaterial(db: Db, posId: string): Promise<{ texto: string; nome: string } | null> {
  const { data: pos, error: ePos } = await db
    .from("ped_pos_graduacoes")
    .select("id, nome, nome_comercial, marca, instituicao, formato, carga_horaria, periodo_total_meses, tcc, produto_tipo, curso_comercial_id, coordenador_professor_id")
    .eq("id", posId)
    .maybeSingle();
  if (ePos) throw ePos;
  if (!pos) return null;

  const { data: grade, error: eGrade } = await db
    .from("ped_curso_aulas_blueprint")
    .select("modulo_numero, modulo_nome, tipo_modulo, aula_titulo, titulo, ementa, aula_numero, parte_numero, ordem_no_modulo")
    .eq("pos_graduacao_id", posId)
    .or("ativo.is.null,ativo.eq.true")
    .order("modulo_numero", { ascending: true, nullsFirst: false })
    .order("aula_numero", { ascending: true, nullsFirst: false })
    .order("parte_numero", { ascending: true, nullsFirst: false })
    .limit(600);
  if (eGrade) throw eGrade;

  const { data: extras } = await db
    .from("ped_curso_aula_ao_vivo_extra")
    .select("titulo, ementa, ativo")
    .eq("pos_graduacao_id", posId);

  const { data: vinc } = await db.from("ped_professor_cursos").select("professor_id").eq("pos_graduacao_id", posId);
  const profIds = [...new Set((vinc ?? []).map((v: { professor_id: string }) => v.professor_id))];
  let professores: ProfessorMaterial[] = [];
  if (profIds.length) {
    const { data: profs } = await db
      .from("ped_professores")
      .select("id, nome, titulacao, area_expertise, especialidades, descricao_ia, bio_gerada_ia, bio_curta, mini_curriculo, ativo")
      .in("id", profIds);
    // deno-lint-ignore no-explicit-any
    professores = ((profs ?? []) as any[])
      .filter((p) => p.ativo !== false && p.nome)
      .map((p) => ({
        nome: p.nome,
        titulacao: p.titulacao,
        area_expertise: p.area_expertise,
        especialidades: Array.isArray(p.especialidades) ? p.especialidades : null,
        mini_bio: p.descricao_ia || p.bio_gerada_ia || p.bio_curta || p.mini_curriculo || null,
        coordenador: p.id === pos.coordenador_professor_id,
      }));
  }

  let ficha: Record<string, unknown> | null = null;
  if (pos.curso_comercial_id) {
    const { data: f } = await db
      .from("comercial_programa_data")
      .select("program")
      .eq("curso_id", pos.curso_comercial_id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (f?.program) ficha = fichaSemVisual(f.program);
  }

  const texto = montarMaterial(
    pos as PosMaterial,
    (grade ?? []) as LinhaGrade[],
    // deno-lint-ignore no-explicit-any
    ((extras ?? []) as any[]).filter((e) => e.ativo !== false) as AulaExtra[],
    professores,
    ficha,
  );
  return { texto, nome: pos.nome_comercial || pos.nome };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let usuarioId: string;
  try {
    const chamador = await exigirAcesso(req, { usuario: true });
    if (chamador.tipo !== "usuario") return json({ ok: false, error: "Acesso restrito ao Pedagógico." }, 403);
    usuarioId = chamador.usuarioId;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: pode } = await db.rpc("user_can_access_pedagogico", { _user_id: usuarioId });
  if (pode !== true) return json({ ok: false, error: "Sem permissão (pedagógico)." }, 403);

  const body = await req.json().catch(() => ({}));
  const posId = typeof body?.pos_id === "string" ? body.pos_id.trim() : "";
  const bloco = body?.bloco;
  if (!/^[0-9a-f-]{36}$/i.test(posId)) return json({ ok: false, error: "pos_id inválido." }, 400);
  if (!ehBloco(bloco)) return json({ ok: false, error: "bloco inválido." }, 400);

  try {
    const material = await juntarMaterial(db, posId);
    if (!material) return json({ ok: false, error: "Pós não encontrada." }, 404);
    if (material.texto.length < MIN_MATERIAL_CHARS) {
      return json({
        ok: false,
        error: "A pós ainda tem pouca informação cadastrada (grade, ementas, professores). Complete o cadastro antes de gerar, senão a IA teria de inventar.",
      }, 422);
    }

    const apiKey = await chaveAnthropic(db);
    const bruto = await chamarIA(apiKey, pedidoDoBloco(bloco, material.texto, material.nome), schemaDoBloco(bloco));
    const { dados, lacunas } = normalizarBloco(bloco, bruto);

    const { error: eGrava } = await db.rpc("ped_apresentacao_venda_gravar_ia", {
      p_pos_id: posId,
      p_bloco: bloco,
      p_dados: dados,
      p_lacunas: lacunas,
      p_autor: usuarioId,
    });
    if (eGrava) throw eGrava;

    return json({ ok: true, bloco, dados, lacunas, modelo: MODELO });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    console.error("[ped-apresentacao-gerar]", posId, bloco, msg);
    return json({ ok: false, error: msg.slice(0, 400) }, 500);
  }
});
