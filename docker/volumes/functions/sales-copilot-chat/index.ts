import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mimosa (Copiloto de Vendas) roda na Anthropic — a "API do Cloud" já cadastrada.
// Sonnet = qualidade (coaching nuance); Haiku = velocidade/custo (perguntas simples).
const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const ANTHROPIC_MODEL_FAST = "claude-haiku-4-5-20251001";
const ANTHROPIC_KEY_NAME = "ANTHROPIC_API_KEY";

const json = (obj: unknown, status: number) =>
  new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Resolução de chave Anthropic: 1) ai_api_keys (provider=anthropic, ativa) →
// 2) env ANTHROPIC_API_KEY → 3) legacy ped_configuracoes.
async function getAnthropicKey(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("ai_api_keys").select("api_key")
      .eq("provider", "anthropic").eq("is_active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data?.api_key) return data.api_key as string;
  } catch (_) { /* fallback */ }
  const envKey = Deno.env.get(ANTHROPIC_KEY_NAME);
  if (envKey) return envKey;
  try {
    const { data } = await supabase
      .from("ped_configuracoes").select("valor").eq("chave", ANTHROPIC_KEY_NAME).maybeSingle();
    return (data?.valor as string) || null;
  } catch { /* */ }
  return null;
}

function buildSystem(context: string | undefined, live: string, vendedorNome?: string): string {
  const ctx = [context, live].filter(Boolean).join("\n\n");
  const primeiroNome = (vendedorNome ?? "").trim().split(/\s+/)[0] || "";
  return `Você é a Mimosa, a inteligência de vendas da PPGVet Educação — instituição brasileira de pós-graduações veterinárias com nota 5 no MEC, +12.000 alunos formados, +265 professores e 16 pós-graduações ativas.

QUEM VOCÊ AJUDA: o vendedor/SDR da PPGVet. Você é o braço direito dele.
${primeiroNome ? `Você está falando agora com **${primeiroNome}** — trate-o pelo primeiro nome, de forma próxima e direta, como uma colega de time.` : ""}

PARA QUE VOCÊ SERVE (responda a qualquer uma dessas necessidades):
- Tirar dúvidas sobre PRODUTO (pra que serve a pós, como funciona, o que o aluno aprende, professores, módulos práticos).
- Explicar o PÚBLICO/ICP de cada produto.
- Ajudar a PREPARAR uma reunião (o que falar, por onde começar, o que destacar).
- Orientar a CONDUÇÃO da conversa (descoberta SPIN, implicação, demonstração).
- Sugerir FOLLOW-UPS (mensagens de retomada, naturais e humanas).
- Apoiar o FECHAMENTO (ancorar valor, parcelamento, próximos passos).
- QUEBRAR OBJEÇÕES: quando o vendedor trouxer "o lead falou X", devolva 1–2 formas naturais de contornar, reconhecendo a fala do lead antes de reposicionar.

COMO VOCÊ FALA (inegociável):
- Sempre HUMANA e NATURAL — nada robótico, nada de jargão agressivo. Fale como uma colega experiente ajudando.
- Sempre puxe GERAÇÃO DE VALOR: o foco não é "vender um curso", é o quanto aquilo TRANSFORMA a vida e a carreira do aluno.
- Venda a VERDADE: nunca invente dado, preço, professor, módulo ou número. Se a informação não estiver no CONTEXTO abaixo, diga que não tem certeza e oriente o vendedor a confirmar — NUNCA chute.
- Seja direta e prática, em português brasileiro. Use markdown (títulos ##, negrito, listas) e dê exemplos de fala prontos ("você pode dizer: ...").

CITE A FONTE COM PARCIMÔNIA: você NÃO precisa repetir "segundo o material da PPGVet" a cada frase — isso cansa e soa repetitivo. No MÁXIMO uma vez por resposta, e só quando der peso a um dado concreto (um preço, uma condição). No resto, fale com naturalidade, como quem já domina o conteúdo. Continue NUNCA inventando — o que não está no contexto, você diz que precisa confirmar.

SEMPRE TERMINE COM UMA MENSAGEM PRONTA PRO WHATSAPP (inegociável):
Ao final de TODA resposta, gere um bloco separado com uma mensagem que o vendedor possa COPIAR E COLAR direto no WhatsApp do lead. Formato exato:
## 📱 Mensagem pra enviar no WhatsApp
> escreva a mensagem aqui (pode usar várias linhas com ">")

Regras dessa mensagem (siga à risca):
- CURTA e natural (2 a 5 linhas), SEM textão, SEM markdown/negrito dentro dela, tom de conversa real de WhatsApp.
- MUITA conexão e humanidade: fale com a PESSOA, não com um cargo. Nada de discurso de venda pesado nem formalidade.
- Se você souber o nome do lead (aparece em "Lead em foco" no contexto), comece chamando ELE PELO NOME. Se NÃO souber, comece com "[nome do lead]" pro vendedor preencher na hora.
- Feche com uma pergunta leve que convida o lead a responder — abre conversa, não pressiona.

RECOMENDAR A PÓS CERTA (importante): quando o vendedor pedir qual pós indicar pra um lead — principalmente em transição de carreira (ex.: "trabalha com reprodução e virou gerente de fazenda") — recomende SEMPRE pelos NOMES REAIS do catálogo da PPGVet que está no contexto ("Catálogo de pós-graduações"). Cite o nome EXATO do produto. NUNCA diga "se a PPGVet tiver algo nessa linha" nem invente nome de pós — você TEM a lista, use-a. Se a ÁREA/espécie do lead não estiver clara (bovinos de corte, leite, aves, suínos, pet, segurança de alimentos, gestão/MBA...), FAÇA 1 ou 2 perguntas curtas pro vendedor ANTES de recomendar (ex.: "ele atua com qual espécie — bovinos de corte, leite, aves?") e só então traga a indicação, relacionando cada pós ao que ela entrega (ementa, módulos, resultado de carreira). Quando a área já estiver clara no que o vendedor disse, deduza e siga (ex.: "reprodução + gerente de fazenda" ⇒ bovinos/gestão), sem perguntar à toa.

FONTE DA VERDADE: baseie as respostas no CONTEXTO abaixo (materiais reais: frases, SPIN, habilidades, técnicas e preços do produto). Esse conteúdo vale mais que seu conhecimento genérico.

${ctx ? `=== CONTEXTO (materiais da apresentação + dados ao vivo do sistema) ===\n${ctx}` : "Nenhum produto selecionado — responda de forma geral e sugira ao vendedor escolher o produto pra você trazer as frases, o roteiro, os módulos, os professores e os preços daquela pós."}`;
}

/* Puxa do banco (RPCs do comercial) módulos/aulas, professores+currículo e turmas
   abertas do produto selecionado — para a Mimosa responder com dado vivo, não só estático. */
async function buildLiveContext(supabase: ReturnType<typeof createClient>, posId: string): Promise<string> {
  const partes: string[] = [];

  // Grade do curso (módulos → aulas → ementa → professor TITULAR), do blueprint pedagógico.
  // comercial_grade_do_curso é a fonte rica (com professor); cai p/ comercial_modulos_do_curso
  // (sem professor) se a RPC nova ainda não existir. Em curso GRAVADO cada aula é fatiada em
  // PARTES (1 linha por parte) → colapsamos por aula_numero usando aula_titulo como rótulo.
  try {
    let grade: any[] | null = null;
    try {
      const r = await supabase.rpc("comercial_grade_do_curso", { p_pos_graduacao_id: posId });
      if (Array.isArray(r.data) && r.data.length) grade = r.data as any[];
    } catch (_) { /* RPC nova ainda não migrada → fallback abaixo */ }
    if (!grade) {
      const r = await supabase.rpc("comercial_modulos_do_curso", { p_pos_graduacao_id: posId });
      if (Array.isArray(r.data) && r.data.length) grade = r.data as any[];
    }
    if (grade && grade.length) {
      const mods: { label: string; aulas: Map<string, { label: string; prof: string; ementa: string }> }[] = [];
      const idx: Record<string, number> = {};
      let row = 0;
      for (const a of grade) {
        row++;
        const modNum = a.modulo_numero ?? null;
        const modNome = String(a.modulo_nome ?? a.modulo ?? "").trim();
        const modKey = `${modNum ?? "x"}|${modNome}`;
        if (idx[modKey] === undefined) {
          const label = modNum != null && modNum > 0
            ? `Módulo ${modNum}${modNome ? ` — ${modNome}` : ""}`
            : (modNome || "Outras aulas");
          idx[modKey] = mods.length;
          mods.push({ label, aulas: new Map() });
        }
        const mod = mods[idx[modKey]];
        // colapsa partes da MESMA aula (gravado) por aula_numero; ao vivo (NULL) = 1 aula/linha
        const aulaKey = a.aula_numero != null ? `${modKey}#a${a.aula_numero}` : `${modKey}#r${row}`;
        const aulaLabel = (a.aula_titulo && String(a.aula_titulo).trim())
          || (a.titulo && String(a.titulo).trim()) || "Aula";
        if (!mod.aulas.has(aulaKey)) mod.aulas.set(aulaKey, { label: aulaLabel, prof: "", ementa: "" });
        const aula = mod.aulas.get(aulaKey)!;
        if (!aula.prof && a.professor_titular) aula.prof = String(a.professor_titular).trim();
        if (!aula.ementa && a.ementa) aula.ementa = String(a.ementa).trim().slice(0, 400);
      }
      const linhas: string[] = [];
      for (const mod of mods) {
        linhas.push(`**${mod.label}**`);
        const aulas = [...mod.aulas.values()];
        for (const a of aulas.slice(0, 30)) {
          let ln = `- ${a.label}${a.prof ? ` (prof. ${a.prof})` : ""}`;
          if (a.ementa) ln += `\n  Ementa: ${a.ementa}`;
          linhas.push(ln);
        }
        if (aulas.length > 30) linhas.push(`- … (+${aulas.length - 30} aulas neste módulo)`);
      }
      partes.push("## Grade do curso — módulos, aulas, ementa e professor titular (ao vivo do pedagógico)\n" + linhas.join("\n"));
    }
  } catch (e) { console.warn("grade rpc", e); }

  // Módulos práticos / presenciais (têm ementa própria + professores das ofertas).
  try {
    const { data: praticos } = await supabase.rpc("comercial_praticos_do_curso", { p_pos_graduacao_id: posId });
    if (Array.isArray(praticos) && praticos.length) {
      const linhas = (praticos as any[]).map((m) => {
        let ln = `- ${(m.titulo && String(m.titulo).trim()) || "Módulo prático"}${m.professores ? ` (prof. ${m.professores})` : ""}`;
        if (m.ementa) ln += `\n  Ementa: ${String(m.ementa).trim().slice(0, 400)}`;
        return ln;
      });
      partes.push("## Módulos práticos / presenciais (ao vivo do pedagógico)\n" + linhas.join("\n"));
    }
  } catch (e) { console.warn("praticos rpc", e); }

  try {
    const { data: profs } = await supabase.rpc("comercial_professores_do_curso", { p_pos_graduacao_id: posId });
    if (Array.isArray(profs) && profs.length) {
      const linhas = (profs as any[]).slice(0, 20).map((p) => {
        const top = Array.isArray(p.curriculo_topicos)
          ? p.curriculo_topicos.map((t: any) => `${t.titulo}: ${String(t.texto ?? "").slice(0, 140)}`).join(" · ")
          : "";
        const bio = top || (p.mini_bio ? String(p.mini_bio).slice(0, 220) : "");
        return `- **${p.nome}**${p.titulacao ? ` (${p.titulacao})` : ""}${p.area_expertise ? ` — ${p.area_expertise}` : ""}${bio ? `\n  ${bio}` : ""}`;
      });
      partes.push("## Professores do curso (ao vivo, com currículo)\n" + linhas.join("\n"));
    }
  } catch (e) { console.warn("professores rpc", e); }

  try {
    const { data: turmas } = await supabase.rpc("comercial_turmas_do_curso", { p_pos_graduacao_id: posId });
    if (Array.isArray(turmas) && turmas.length) {
      const linhas = (turmas as any[]).map((t) =>
        `- ${t.nome} (${t.situacao === "em_andamento" ? "em andamento" : "próxima"})${t.data_inicio ? ` — início ${t.data_inicio}` : ""}${t.aulas_restantes != null ? ` · ${t.aulas_restantes} aulas restantes` : ""}`,
      );
      partes.push("## Turmas abertas (ao vivo) — use pra criar urgência real\n" + linhas.join("\n"));
    }
  } catch (e) { console.warn("turmas rpc", e); }

  return partes.join("\n\n");
}

function buildMessages(messages: unknown) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m: { role?: string }) => m && (m.role === "user" || m.role === "assistant"))
    .map((m: { role: string; content: unknown }) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content ?? ""),
    }));
}

async function callAnthropic(apiKey: string, system: string, msgs: unknown[], stream: boolean, model: string) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0.7,
      // system como bloco com cache_control → prompt caching (system+contexto são
      // estáveis na conversa → respostas seguintes ficam mais rápidas/baratas).
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: msgs,
      stream,
    }),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, context, stream, posGraduacaoId, fast, vendedorNome } = await req.json();
    const model = fast ? ANTHROPIC_MODEL_FAST : ANTHROPIC_MODEL;
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const ANTHROPIC_API_KEY = await getAnthropicKey(supabase);
    if (!ANTHROPIC_API_KEY) throw new Error("Chave Anthropic não configurada (ai_api_keys provider=anthropic / env ANTHROPIC_API_KEY).");

    // Dados ao vivo do produto (módulos/professores/turmas) injetados no contexto.
    const live = posGraduacaoId ? await buildLiveContext(supabase, String(posGraduacaoId)) : "";
    const system = buildSystem(context, live, vendedorNome);
    const msgs = buildMessages(messages);

    // ── Modo NÃO-streaming (compat / fallback) ──────────────────────
    if (stream === false) {
      const resp = await callAnthropic(ANTHROPIC_API_KEY, system, msgs, false, model);
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        console.error("Anthropic error:", resp.status, t);
        return json({ error: `IA HTTP ${resp.status}: ${t.slice(0, 300)}` }, resp.status === 429 ? 429 : 500);
      }
      const data = await resp.json();
      const text = (data?.content?.[0]?.text ?? "").trim();
      if (!text) return json({ error: "A IA retornou uma resposta vazia. Tente novamente." }, 500);
      return json({ text }, 200);
    }

    // ── Modo STREAMING (padrão) — repassa os deltas de texto como text/plain ──
    const upstream = await callAnthropic(ANTHROPIC_API_KEY, system, msgs, true, model);
    if (!upstream.ok || !upstream.body) {
      const t = await upstream.text().catch(() => "");
      console.error("Anthropic stream error:", upstream.status, t);
      return json({ error: `IA HTTP ${upstream.status}: ${t.slice(0, 300)}` }, upstream.status === 429 ? 429 : 500);
    }

    const outStream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith("data:")) continue;
              const payload = t.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const ev = JSON.parse(payload);
                if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                  controller.enqueue(encoder.encode(ev.delta.text));
                }
              } catch { /* ignora keep-alive/eventos não-JSON */ }
            }
          }
        } catch (e) {
          console.error("stream pump error", e);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(outStream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        // evita o proxy (nginx/Kong) bufferizar o stream e entregar tudo de uma vez
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    console.error("sales-copilot-chat error:", e);
    return json({ error: e instanceof Error ? e.message : "Erro desconhecido" }, 500);
  }
});
