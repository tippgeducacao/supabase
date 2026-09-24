import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { tirarTravessao } from "../_shared/limparSaidaIA.ts";

/**
 * MOTOR DO BANCO DE CONTEÚDOS
 *
 * Recebe a semana (quarta → terça) e devolve ideias ancoradas no que o pedagógico
 * já tem: aulas daquela semana, aberturas de turma, módulos práticos e datas do setor.
 *
 * Duas decisões que valem a leitura:
 *
 * 1. O modelo NÃO inventa id. Cada fonte entra no prompt com uma etiqueta curta
 *    (A1, B2…) e a resposta referencia a etiqueta; o id real é resolvido aqui.
 *    Modelo escrevendo UUID é erro garantido.
 *
 * 2. O PILAR manda no tom. É ele que carrega o peso do CTA, e é por isso que a
 *    ideia nasce com pilar: o mesmo pilar vai junto para o card e, depois, para a
 *    legenda. Sem isso toda peça sai vendendo curso, que é a reclamação de origem.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchAIWithRetry(url: string, init: RequestInit, label: string, maxAttempts = 4): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const text = await res.text();
      const transient = RETRYABLE_STATUS.has(res.status) || /overloaded|rate.?limit/i.test(text);
      if (transient && attempt < maxAttempts) {
        await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400));
        lastErr = new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
        continue;
      }
      throw new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      if (e instanceof TypeError && attempt < maxAttempts) {
        lastErr = e;
        await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: falhou após ${maxAttempts} tentativas`);
}

interface Etiqueta {
  origem: "aula" | "abertura" | "pratico" | "data";
  id: string;
  rotulo: string;
  ementa: string | null;
  data: string | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Sessão inválida." }, 401);

    // Cliente do USUÁRIO: é ele que chama a RPC das fontes, então a permissão é
    // checada num lugar só (dentro da RPC) em vez de duplicada aqui.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Sessão inválida." }, 401);
    const userId = userData.user.id;

    const { semana_inicio, semana_fim, tema, curso, quantidade } = await req.json();
    if (!semana_inicio || !semana_fim) return json({ error: "Semana não informada." }, 400);
    const quantos = Math.min(Math.max(Number(quantidade) || 8, 1), 15);

    const admin = createClient(supabaseUrl, serviceKey);

    // 1) Fontes da semana (a RPC já aplica o gate de permissão).
    const { data: fontes, error: fontesErr } = await userClient.rpc("marketing_banco_fontes", {
      _inicio: semana_inicio,
      _fim: semana_fim,
    });
    if (fontesErr) return json({ error: `Não consegui ler o pedagógico: ${fontesErr.message}` }, 400);

    const aulas = (fontes as any)?.aulas ?? [];
    const aberturas = (fontes as any)?.aberturas ?? [];
    const praticos = (fontes as any)?.praticos ?? [];
    const datas = (fontes as any)?.datas ?? [];

    // 2) Etiquetas — o modelo referencia A1/B1/C1/D1, nunca um id.
    const etiquetas = new Map<string, Etiqueta>();
    const linhas: string[] = [];

    aulas.forEach((a: any, i: number) => {
      const tag = `A${i + 1}`;
      const rotulo = `Aula ${a.data} — ${a.titulo}${a.curso ? ` (${a.curso})` : ""}${a.professor ? ` · ${a.professor}` : ""}`;
      etiquetas.set(tag, { origem: "aula", id: a.id, rotulo, ementa: a.ementa ?? null, data: a.data ?? null });
      linhas.push(`[${tag}] AULA · ${a.data} · ${a.titulo}${a.curso ? ` · curso: ${a.curso}` : ""}${a.professor ? ` · prof.: ${a.professor}` : ""}\n  Ementa: ${(a.ementa || "sem ementa").slice(0, 700)}`);
    });

    aberturas.forEach((t: any, i: number) => {
      const tag = `B${i + 1}`;
      const rotulo = `Abertura ${t.data_inicio} — ${t.curso ?? "turma"}${t.aula_titulo ? ` · 1ª aula: ${t.aula_titulo}` : ""}`;
      etiquetas.set(tag, { origem: "abertura", id: t.id, rotulo, ementa: t.aula_ementa ?? null, data: t.data_inicio ?? null });
      linhas.push(`[${tag}] ABERTURA DE TURMA · começa em ${t.data_inicio} · ${t.curso ?? ""} ${t.turma ?? ""}\n  1ª aula: ${t.aula_titulo ?? "não definida"}\n  Ementa: ${(t.aula_ementa || "sem ementa").slice(0, 700)}`);
    });

    praticos.forEach((m: any, i: number) => {
      const tag = `C${i + 1}`;
      const rotulo = `Módulo prático — ${m.titulo}${m.curso ? ` (${m.curso})` : ""}`;
      etiquetas.set(tag, { origem: "pratico", id: m.id, rotulo, ementa: m.ementa ?? null, data: null });
      linhas.push(`[${tag}] MÓDULO PRÁTICO · ${m.titulo}${m.curso ? ` · curso: ${m.curso}` : ""}\n  Ementa: ${(m.ementa || "sem ementa").slice(0, 500)}`);
    });

    datas.forEach((d: any, i: number) => {
      const tag = `D${i + 1}`;
      const rotulo = `${d.nome} — ${d.data}`;
      etiquetas.set(tag, { origem: "data", id: d.id, rotulo, ementa: null, data: d.data ?? null });
      linhas.push(`[${tag}] DATA DO SETOR · ${d.data} · ${d.nome}${d.publico ? ` · público: ${d.publico}` : ""}`);
    });

    if (linhas.length === 0 && !tema) {
      return json({ error: "Sem tema e sem nada no pedagógico nesta semana — não há de onde tirar ideia." }, 400);
    }

    // 3) Pilares (a régua do tom) e perfis de marca.
    const [{ data: pilares }, { data: perfis }] = await Promise.all([
      admin.from("marketing_pilares").select("chave, rotulo, descricao, peso_cta").eq("ativo", true).order("ordem"),
      admin.from("marketing_profiles").select("key, label, tagline").eq("active", true).order("sort_order"),
    ]);

    const textoPilares = (pilares || [])
      .map((p: any) => `- ${p.chave} (${p.rotulo}) · CTA: ${p.peso_cta}\n  ${p.descricao ?? ""}`)
      .join("\n");
    const textoPerfis = (perfis || [])
      .map((p: any) => `- ${p.key} · ${p.label}${p.tagline ? ` · ${p.tagline}` : ""}`)
      .join("\n");

    const { data: keyRow } = await admin
      .from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true).limit(1).maybeSingle();
    if (!keyRow) return json({ error: "Chave da Anthropic não configurada." }, 500);

    const systemPrompt = `Você planeja a pauta de conteúdo de uma instituição de pós-graduação em ciências agrárias e veterinária (PPGVET). Seu trabalho é transformar o que vai acontecer na semana em ideias de conteúdo que um profissional da área queira ler.

REGRA CENTRAL: a maior parte do que produzimos NÃO é anúncio. É conteúdo que vale por si só. Quem lê tem que aprender alguma coisa mesmo que nunca compre nada. O curso aparece como consequência da autoridade, não como o assunto.

PILARES (o pilar decide o tom e o quanto de CTA a peça pode ter):
${textoPilares}

- CTA "nenhum": a peça termina no conteúdo. Nada de "clique no link", "garanta sua vaga", "chame no direct".
- CTA "leve": no máximo uma linha no fim, convidando a comentar/salvar ou a conhecer o tema. Nunca o assunto principal.
- CTA "forte": só no pilar de oferta. Aí sim a matrícula é o assunto.

PERFIS DE MARCA disponíveis:
${textoPerfis}

COMO ESCREVER CADA IDEIA:
- titulo: curto e específico, o assunto real da peça. Nada de "Post sobre nutrição".
- descricao: 2 a 4 frases de briefing para quem vai produzir. Diga o ÂNGULO e o que a peça precisa entregar (o dado, o passo, o critério). Se a fonte tem ementa, puxe dela um ponto concreto.
- gancho: UMA frase, a primeira linha do post, do jeito que sairia publicada. Serve para quem lê a ideia julgar o ângulo na hora. Não é a legenda inteira e não leva hashtag nem CTA.
- Proibido travessão (— ou –). Proibido tom de coach e frase motivacional vazia.
- Não invente número, protocolo, dose, resultado de pesquisa nem nome de professor. Se não está na ementa, não entra.

Responda SOMENTE com JSON válido, sem texto antes ou depois, neste formato:
{"ideias":[{"fonte":"A1","pilar":"tecnico","formato":"carrossel","perfil":"bovinos","titulo":"...","gancho":"...","descricao":"..."}]}

"fonte" tem que ser uma das etiquetas oferecidas, ou "tema" quando a ideia vier do tema da semana e não de uma fonte específica. "formato" é um de: feed, carrossel, reels, story. "pilar" e "perfil" usam as chaves das listas acima.`;

    const userMessage = `SEMANA: ${semana_inicio} a ${semana_fim} (a semana vai de quarta a terça).
TEMA DA SEMANA: ${tema ? tirarTravessao(String(tema)) : "não definido"}
CURSO EM FOCO: ${curso ? tirarTravessao(String(curso)) : "não definido"}

FONTES DISPONÍVEIS:
${linhas.length ? linhas.join("\n\n") : "(nenhuma fonte no pedagógico nesta semana)"}

Gere ${quantos} ideias. Distribua entre os pilares, sem repetir o mesmo assunto. Se houver abertura de turma na lista, no máximo UMA ideia pode usar o pilar de oferta.`;

    const res = await fetchAIWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": keyRow.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    }, "Claude");

    const resultado = await res.json();
    const bruto: string = (resultado?.content || []).map((c: any) => c?.text || "").join("").trim();

    // O modelo às vezes embrulha em ```json. Pega do primeiro { ao último }.
    const inicio = bruto.indexOf("{");
    const fim = bruto.lastIndexOf("}");
    if (inicio < 0 || fim <= inicio) {
      return json({ error: "A IA respondeu fora do formato esperado. Tente de novo." }, 502);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(bruto.slice(inicio, fim + 1));
    } catch {
      return json({ error: "A IA respondeu um JSON inválido. Tente de novo." }, 502);
    }

    const chavesPilar = new Set((pilares || []).map((p: any) => p.chave));
    const chavesPerfil = new Set((perfis || []).map((p: any) => p.key));
    const formatosOk = new Set(["feed", "carrossel", "reels", "story"]);

    const linhasParaGravar = (parsed?.ideias ?? [])
      .filter((i: any) => i && typeof i.titulo === "string" && i.titulo.trim())
      .slice(0, quantos)
      .map((i: any) => {
        const fonte = etiquetas.get(String(i.fonte || "").trim().toUpperCase());
        return {
          titulo: tirarTravessao(String(i.titulo)).trim().slice(0, 300),
          gancho: i.gancho ? tirarTravessao(String(i.gancho)).trim().slice(0, 400) : null,
          descricao: i.descricao ? tirarTravessao(String(i.descricao)).trim() : null,
          pilar_chave: chavesPilar.has(i.pilar) ? i.pilar : null,
          formato: formatosOk.has(i.formato) ? i.formato : null,
          profile_key: chavesPerfil.has(i.perfil) ? i.perfil : null,
          origem: fonte?.origem ?? "tema",
          origem_id: fonte?.id ?? null,
          origem_rotulo: fonte?.rotulo ?? (tema ? `Tema da semana: ${tema}` : null),
          // Cópia da ementa AGORA: a aula pode ser editada depois e o briefing
          // que a pessoa aprovou não pode mudar sozinho.
          origem_ementa: fonte?.ementa ?? null,
          origem_data: fonte?.data ?? null,
          semana_inicio,
          status: "nova",
          gerada_por_ia: true,
          created_by: userId,
        };
      });

    if (linhasParaGravar.length === 0) {
      return json({ error: "A IA não devolveu nenhuma ideia aproveitável. Tente de novo." }, 502);
    }

    const { data: gravadas, error: insErr } = await admin
      .from("marketing_ideias")
      .insert(linhasParaGravar)
      .select("id, titulo");
    if (insErr) return json({ error: `Gerei as ideias mas não consegui salvar: ${insErr.message}` }, 500);

    return json({ success: true, ideias: gravadas ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro inesperado";
    console.error("[marketing-gerar-ideias]", msg);
    return json({ error: msg }, 500);
  }
});
