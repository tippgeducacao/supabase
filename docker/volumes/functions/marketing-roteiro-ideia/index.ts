import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { tirarTravessao } from "../_shared/limparSaidaIA.ts";

/**
 * ROTEIRO DE UMA IDEIA DO BANCO — um FORMATO por chamada.
 *
 * Recebe `{ ideia_id, formato, instrucao?, ig_handle? }` e devolve o passo a passo daquele
 * formato: slide a slide (carrossel), cena a cena (reels), tela a tela (story) ou a arte
 * (feed), com o que escrever, o que evitar, o que mais colocar, o briefing da arte e a
 * legenda. Grava em `marketing_ideias.roteiro[formato]` pela RPC que mescla no banco.
 *
 * Por que um formato por chamada: `api.ppgeducacao.site` está atrás do Cloudflare, que corta
 * a resposta em ~100 s com 524 SEM CORS (o navegador vê erro genérico e a Anthropic cobra
 * mesmo assim — ver docs/Pedagógico.md). O front pede os formatos em paralelo; cada chamada
 * tem um AbortController de 85 s que devolve um 504 nosso, com mensagem, antes do corte.
 *
 * O que muda em relação à ideia: o contexto. Além do título e da ementa, entra o que o
 * professor DISSE na aula (base de conhecimento das transcrições), via
 * `marketing_conhecimento_para_ideia`, e as imagens de referência que a pessoa subiu.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MODELO = "claude-opus-5";
const PRAZO_MS = 85_000;
const MAX_IMAGENS = 4;
/** A API recusa imagem acima de 5 MB; com folga para o base64 não passar. */
const MAX_BYTES_IMAGEM = 3_700_000;

const FORMATOS = ["feed", "carrossel", "reels", "story"] as const;
type Formato = typeof FORMATOS[number];

const COMO_E_CADA_FORMATO: Record<Formato, string> = {
  carrossel: `CARROSSEL de 6 a 10 slides.
- Slide 1 é a capa: o gancho, em no máximo 10 palavras, que faz parar de rolar.
- Cada slide do meio carrega UMA ideia, com no máximo 35 palavras na arte.
- O último slide fecha conforme o pilar (salvar/compartilhar, ou a chamada se o pilar for de oferta).
- Em "estrutura", uma etapa por slide: "etapa" = "Slide N · função", "texto" = exatamente o que vai escrito na arte, "visual" = o que a designer coloca (foto, ícone, gráfico, destaque de número, layout).`,
  reels: `REELS de 30 a 60 segundos.
- Os 3 primeiros segundos decidem: comece pelo gancho, nunca por "olá, pessoal".
- Em "estrutura", uma etapa por trecho: "etapa" = tempo + função (ex.: "0 a 3 s · gancho"), "texto" = a fala ou o texto que aparece na tela, "visual" = o que aparece (quem fala, enquadramento, imagem de apoio, texto na tela).
- Diga em "incluir" quem deveria gravar (professor, apresentador, aluno) e se precisa de imagem de campo.`,
  story: `SEQUÊNCIA DE STORIES com 3 a 6 telas.
- Use pelo menos um recurso de interação (enquete, caixa de pergunta, quiz ou controle deslizante) ligado ao conteúdo técnico.
- Em "estrutura", uma etapa por tela: "etapa" = "Tela N · função", "texto" = o texto da tela (e, se tiver enquete/quiz, a pergunta e as opções), "visual" = fundo, imagem e o recurso usado.`,
  feed: `POST DE FEED com UMA arte.
- A arte tem pouco texto: um título forte e, no máximo, uma linha de apoio. O conteúdo vai na legenda.
- Em "estrutura", as partes da arte: "etapa" = "Arte · título", "Arte · apoio", "Arte · elemento visual"…, "texto" = o que vai escrito, "visual" = a orientação para a designer.`,
};

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objetivo", "resumo", "estrutura", "legenda", "escrever", "evitar", "incluir", "briefing_arte", "uso_das_imagens", "fontes"],
  properties: {
    objetivo: { type: "string" },
    resumo: { type: "string" },
    estrutura: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["etapa", "texto", "visual"],
        properties: { etapa: { type: "string" }, texto: { type: "string" }, visual: { type: "string" } },
      },
    },
    legenda: { type: "string" },
    escrever: { type: "array", items: { type: "string" } },
    evitar: { type: "array", items: { type: "string" } },
    incluir: { type: "array", items: { type: "string" } },
    briefing_arte: { type: "string" },
    uso_das_imagens: { type: "string" },
    fontes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["ref", "como_usou"],
        properties: { ref: { type: "string" }, como_usou: { type: "string" } },
      },
    },
  },
};

const REGRA_CTA: Record<string, string> = {
  nenhum: "Esta peça NÃO leva chamada de venda. Termina no conteúdo. Proibido \"clique no link\", \"garanta sua vaga\", \"chame no direct\", \"inscrições abertas\".",
  leve: "No máximo UMA linha de chamada no final, e ela nunca é o assunto. Pode convidar a salvar, comentar ou seguir o tema. Nada de anúncio do curso.",
  forte: "Aqui a matrícula É o assunto: turma, prazo e condição com clareza, e uma chamada direta no fim. Ainda assim, entregue pelo menos uma informação técnica de valor.",
};

function limpar(v: any): any {
  if (typeof v === "string") return tirarTravessao(v).trim();
  if (Array.isArray(v)) return v.map(limpar);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limpar(x)]));
  return v;
}

/**
 * Tipo pela ASSINATURA do arquivo, não pela extensão: um JPEG salvo como ".png" fazia a
 * Anthropic responder 400 e derrubava o formato inteiro (revisão de 29/09/2026).
 */
function tipoDaImagem(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 2 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

function paraBase64(bytes: Uint8Array): string {
  let bin = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    bin += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(bin);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Sessão inválida." }, 401);

    // Cliente do USUÁRIO: a RLS de `marketing_ideias` e o gate das RPCs decidem quem pode.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await userClient.auth.getUser(token);
    if (!u?.user) return json({ error: "Sessão inválida." }, 401);

    const { ideia_id, formato, instrucao, ig_handle } = await req.json();
    if (!ideia_id) return json({ error: "Ideia não informada." }, 400);
    if (!FORMATOS.includes(formato)) return json({ error: `Formato inválido: ${formato}` }, 400);

    const { data: ideia } = await userClient.from("marketing_ideias").select("*").eq("id", ideia_id).maybeSingle();
    if (!ideia) return json({ error: "Ideia não encontrada (ou sem permissão)." }, 404);

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // 1) O que os professores disseram sobre isso.
    const { data: conhecimento, error: errK } = await userClient.rpc("marketing_conhecimento_para_ideia", {
      _ideia_id: ideia_id, _limite: 4,
    });
    if (errK) console.warn("[marketing-roteiro-ideia] base de conhecimento:", errK.message);
    const fontes: any[] = Array.isArray(conhecimento) ? conhecimento : [];

    // 2) Pilar (dosa o CTA) e perfil de marca (tom, público, termos proibidos).
    const [{ data: pilar }, { data: perfis }] = await Promise.all([
      ideia.pilar_chave
        ? admin.from("marketing_pilares").select("chave, rotulo, descricao, peso_cta").eq("chave", ideia.pilar_chave).maybeSingle()
        : Promise.resolve({ data: null } as any),
      admin.from("brand_profiles").select("*").eq("is_active", true),
    ]);
    const norm = (s: any) => (s ?? "").toString().replace(/^@/, "").trim().toLowerCase();
    let bp: any = null;
    if (ig_handle) {
      const doMesmoArroba = (perfis || []).filter((b: any) => norm(b.instagram_handle) === norm(ig_handle));
      bp = doMesmoArroba.find((b: any) => norm(b.account_name) === norm(b.brand_name) && (b.brand_name || "").length <= 12)
        || doMesmoArroba[0] || null;
    }
    if (!bp) bp = (perfis || []).find((b: any) => norm(b.brand_name) === "ppgvet") || (perfis || [])[0] || null;
    const s = (v: any) => (v === null || v === undefined ? "" : tirarTravessao(String(v)));
    const pesoCta: string = pilar?.peso_cta || "leve";

    // 3) Imagens de referência que a pessoa subiu (vão junto para a IA).
    const imagens: any[] = Array.isArray(ideia.imagens) ? ideia.imagens.slice(0, MAX_IMAGENS) : [];
    const blocosImagem: any[] = [];
    const imagensIgnoradas: string[] = [];
    for (const img of imagens) {
      if (!img?.path) continue;
      const nome = img?.nome ?? img.path;
      const { data: arquivo } = await admin.storage.from("marketing-ideias").download(img.path);
      if (!arquivo) { imagensIgnoradas.push(nome); continue; }
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      const tipo = tipoDaImagem(bytes);
      // Toda imagem que fica de fora é DITA na tela (antes, sem extensão sumia calada).
      if (!tipo || bytes.length > MAX_BYTES_IMAGEM) { imagensIgnoradas.push(nome); continue; }
      blocosImagem.push({ type: "image", source: { type: "base64", media_type: tipo, data: paraBase64(bytes) } });
    }

    const { data: keyRow } = await admin
      .from("ai_api_keys").select("api_key").eq("provider", "anthropic").eq("is_active", true).limit(1).maybeSingle();
    if (!keyRow) return json({ error: "Chave da Anthropic não configurada." }, 500);

    // As fontes entram etiquetadas (K1, K2…). O modelo cita a etiqueta; o id real é
    // resolvido aqui. Modelo escrevendo UUID é erro garantido.
    const blocoFontes = fontes.map((f, i) => {
      const ficha = f?.ficha ? JSON.stringify(f.ficha).slice(0, 7000) : "";
      const trechos = (f?.trechos ?? []).map((t: string) => `  « ${String(t).slice(0, 1500)} »`).join("\n");
      // "Mesma aula" = mesmo blueprint ou título quase igual. O resto é aula de OUTRO
      // assunto/professor que a busca por palavras trouxe: serve de apoio, nunca como "o
      // que foi dito nesta aula".
      const relacao = f?.mesma_aula
        ? "MESMA AULA (outra turma)"
        : f?.mesma_pos
          ? "MESMO CURSO (outra aula)"
          : `AULA RELACIONADA DE OUTRO CURSO (${f?.curso ?? "outro curso"})`;
      return [
        `[K${i + 1}] ${relacao} · ${f.titulo}${f.professor ? ` · prof. ${f.professor}` : ""}${f.data_aula ? ` · ${f.data_aula}` : ""}${f.curso ? ` · ${f.curso}` : ""}`,
        ficha ? `  FICHA: ${ficha}` : `  RESUMO: ${String(f?.resumo ?? "").slice(0, 3000)}`,
        trechos ? `  TRECHOS DA FALA:\n${trechos}` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const roteiroAnterior = ideia?.roteiro?.[formato];

    const sistema = `Você é o planejador de conteúdo da PPGVET, uma pós-graduação em medicina veterinária e zootecnia. Seu trabalho é entregar para a equipe (redatora e designer) um roteiro tão claro que ela produza a peça sem precisar perguntar nada.

O conteúdo vem das AULAS: use o que os professores de fato disseram (fontes K). Um post bom aqui ensina alguma coisa aplicável: um número, um critério, um passo, um erro comum. O curso aparece como consequência da autoridade, não como o assunto.

${COMO_E_CADA_FORMATO[formato as Formato]}

OBJETIVO DA PEÇA (pilar): ${pilar ? `${pilar.rotulo}. ${s(pilar.descricao)}` : "conteúdo de valor, não anúncio."}
CHAMADA: ${REGRA_CTA[pesoCta] ?? REGRA_CTA.leve}

${bp ? `MARCA: ${s(bp.brand_name || bp.account_name)}${bp.instagram_handle ? ` (@${norm(bp.instagram_handle)})` : ""}
TOM: ${s(bp.tom_de_voz)}${bp.tom_descricao ? `. ${s(bp.tom_descricao)}` : ""}
PÚBLICO: ${s(bp.publico_alvo)}
${bp.termos_proibidos ? `TERMOS PROIBIDOS: ${s(bp.termos_proibidos)}` : ""}
${bp.alertas_nao_usar ? `NÃO USAR: ${s(bp.alertas_nao_usar)}` : ""}
${bp.regras_estilo ? `REGRAS DE ESTILO: ${s(bp.regras_estilo)}` : ""}` : ""}

REGRAS
- Número, dose, idade, prazo, índice: só se estiver nas fontes K ou na ementa, e do jeito que está lá. Se precisar de um dado que não existe nas fontes, escreva [CONFERIR COM O PROFESSOR] no lugar.
- Fonte "MESMA AULA" é o conteúdo desta aula dado em outra turma, e "MESMO CURSO" é outra aula do mesmo curso: use à vontade, e o professor DAQUELA fonte pode ser citado pelo nome.
- Fonte "AULA RELACIONADA DE OUTRO CURSO" só serve se tratar do MESMO assunto técnico da ideia. Mesmo quando usar, NUNCA escreva no post o nome do professor nem o nome dessa aula ou desse curso: é de outro produto e confunde quem lê. Se ela não for do mesmo assunto, ignore e não a coloque em "fontes".
- Nunca atribua uma fala a outra pessoa. Nunca cite nome de aluno ou participante.
- "escrever": o que a peça PRECISA dizer (os pontos obrigatórios, na ordem).
- "evitar": o que NÃO escrever nesta peça, específico (termos, promessas, exageros, erros técnicos comuns sobre este tema). Nada genérico como "evite erros de português".
- "incluir": o que mais colocar para a peça ficar completa (dado de apoio, exemplo de campo, recurso visual, marcação de professor, trilha).
- "briefing_arte": a orientação visual inteira em um parágrafo: estilo, hierarquia, o que destacar, que tipo de imagem.
- "uso_das_imagens": como usar as imagens de referência enviadas (em qual slide/tela, recorte, o que evitar nelas). Sem imagens, escreva "Nenhuma imagem de referência enviada."
- "legenda": pronta para publicar, até 2.200 caracteres, sem hashtag no meio do texto (no máximo 5 no fim).
- "fontes": as etiquetas K que você usou e para quê. Se não usou nenhuma, lista vazia.
- Sem travessão (— ou –). Sem tom de coach, sem frase motivacional vazia.`;

    const pedido = [
      `IDEIA: ${ideia.titulo}`,
      ideia.gancho ? `GANCHO APROVADO: ${ideia.gancho}` : "",
      ideia.descricao ? `BRIEFING: ${ideia.descricao}` : "",
      ideia.origem_rotulo ? `ORIGEM: ${ideia.origem_rotulo}` : "",
      ideia.origem_ementa ? `EMENTA DA AULA: ${String(ideia.origem_ementa).slice(0, 2500)}` : "",
      "",
      fontes.length
        ? `FONTES DA BASE DE CONHECIMENTO (o que os professores disseram em aula):\n${blocoFontes}`
        : "FONTES DA BASE DE CONHECIMENTO: nenhuma aula da base casou com esta ideia. Trabalhe só com a ementa e o briefing, sem inventar dado técnico.",
      blocosImagem.length ? `\n${blocosImagem.length} imagem(ns) de referência anexada(s) acima.` : "",
      roteiroAnterior && instrucao ? `\nROTEIRO ANTERIOR DESTE FORMATO (ajuste conforme o pedido, mantenha o que estava bom):\n${JSON.stringify(roteiroAnterior).slice(0, 8000)}` : "",
      instrucao ? `\nPEDIDO DE AJUSTE DA EQUIPE: ${tirarTravessao(String(instrucao))}` : "",
      "",
      `Escreva o roteiro do formato: ${formato.toUpperCase()}.`,
    ].filter((l) => l !== "").join("\n");

    const conteudo: any[] = [...blocosImagem, { type: "text", text: pedido }];

    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), PRAZO_MS);
    const t0 = Date.now();
    let resposta: any;
    try {
      const chamar = (comFallback: boolean, semFormato = false) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-api-key": keyRow.api_key,
          "anthropic-version": "2023-06-01",
        };
        const body: Record<string, unknown> = {
          model: MODELO,
          max_tokens: 8000,
          system: sistema,
          output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
          messages: [{ role: "user", content: conteudo }],
        };
        if (semFormato) {
          // Plano B quando o compilador do JSON garantido da Anthropic cai (503 "Grammar
          // compilation is temporarily unavailable" — ~6 min em 29/09/2026): o mesmo pedido
          // com o formato descrito no texto, para a pessoa não ver erro por isso.
          body.output_config = { effort: "low" };
          body.system = `${sistema}\n\nResponda SOMENTE com um objeto JSON válido, sem nada antes ou depois, seguindo exatamente este esquema:\n${JSON.stringify(ESQUEMA)}`;
        }
        // Tema de sanidade (zoonose, patógeno) pode esbarrar no classificador; o
        // fallback refaz a recusa em outro modelo dentro da mesma chamada.
        if (comFallback) {
          headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
          body.fallbacks = "default";
        }
        return fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers, body: JSON.stringify(body), signal: controle.signal,
        });
      };
      let res = await chamar(true);
      if (res.status === 400) {
        const t = await res.text();
        if (!/fallback/i.test(t)) throw new Error(`Claude 400: ${t.slice(0, 300)}`);
        res = await chamar(false);
      }
      if (!res.ok && [503, 529].includes(res.status)) {
        const t = await res.text();
        if (!/grammar/i.test(t)) throw new Error(`Claude ${res.status}: ${t.slice(0, 300)}`);
        res = await chamar(true, true);
      }
      if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
      resposta = await res.json();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return json({ error: "A IA passou do tempo limite. Tente de novo; se repetir, gere um formato por vez." }, 504);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (resposta?.stop_reason === "refusal") {
      return json({ error: "A IA recusou este tema. Reescreva o título da ideia de forma mais técnica e tente de novo.", recusado: true }, 422);
    }
    if (resposta?.stop_reason === "max_tokens") {
      return json({ error: "O roteiro saiu cortado. Tente de novo." }, 502);
    }
    const texto = (resposta?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
    let roteiro: any;
    try {
      // Do primeiro { ao último }: no plano B (sem JSON garantido) pode vir texto em volta.
      roteiro = limpar(JSON.parse(texto.slice(texto.indexOf("{"), texto.lastIndexOf("}") + 1)));
    } catch {
      return json({ error: "A IA respondeu fora do formato. Tente de novo." }, 502);
    }

    // Etiqueta K → aula real. Uma referência pode vir com várias ("K1, K3"): antes o
    // "K1, K3" virava 13 e as duas se perdiam.
    const vistas = new Set<string>();
    const usadas: any[] = [];
    for (const f of roteiro.fontes ?? []) {
      for (const m of String(f?.ref ?? "").matchAll(/\d+/g)) {
        const k = fontes[Number(m[0]) - 1];
        if (!k || vistas.has(k.id)) continue;
        vistas.add(k.id);
        usadas.push({ id: k.id, titulo: k.titulo, professor: k.professor ?? null, data_aula: k.data_aula ?? null, curso: k.curso ?? null, como_usou: f.como_usou });
      }
    }
    const conteudoFinal = {
      ...roteiro,
      fontes: usadas,
      gerado_em: new Date().toISOString(),
      modelo: resposta?.model ?? MODELO,
      imagens_usadas: blocosImagem.length,
      imagens_ignoradas: imagensIgnoradas,
    };

    const { data: gravado, error: errSalvar } = await userClient.rpc("marketing_ideia_salvar_roteiro", {
      _ideia_id: ideia_id,
      _formato: formato,
      _conteudo: conteudoFinal,
      _conhecimento_ids: usadas.map((x: any) => x.id),
      _instrucao: instrucao ? String(instrucao).slice(0, 2000) : null,
    });
    if (errSalvar) return json({ error: `Gerei o roteiro mas não consegui salvar: ${errSalvar.message}` }, 500);

    console.log("[marketing-roteiro-ideia] ok", JSON.stringify({
      ideia_id, formato, ms: Date.now() - t0, fontes: fontes.length, imagens: blocosImagem.length, uso: resposta?.usage,
    }));
    return json({ success: true, formato, roteiro: conteudoFinal, todos: gravado });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro inesperado";
    console.error("[marketing-roteiro-ideia]", msg);
    return json({ error: msg }, 500);
  }
});
