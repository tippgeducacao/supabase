// Pipeline de TRANSCRIÇÃO + RESUMO DE REUNIÃO (áudio longo) — substitui o Plaud.
// Fila (assistente_transcricoes) + worker chamado por cron. Usa o Gemini File API
// (aguenta áudio de horas; o Whisper tem teto ~25MB e o inline do Gemini ~20MB).
// Roda em BACKGROUND porque a transcrição leva minutos (webhook não pode segurar).
//
// ⚠️ REUNIÃO EM ÁUDIO = DOIS JOBS encadeados (mesmo upload no bucket/Gemini):
//   1) tipo='transcricao' → TRANSCRIÇÃO verbatim FATIADA em janelas de 15min, LOTE de 3 em
//                           paralelo por tick (flash; acumulada em `resultado`, cursor
//                           `prox_janela_min`). Roda PRIMEIRO (inserida antes; claim é FIFO).
//   2) tipo='audio'       → ATA EXECUTIVA escrita pelo OPUS 4.8 a partir da transcrição do
//                           irmão (checklist por pessoa, decisões, pendências). Enquanto o
//                           irmão roda, DEFERE sem queimar tentativa; irmão morto → fallback
//                           Gemini 2.5-pro direto do áudio.
// O worker é máquina de 1 PASSO POR TICK (cron 1/min, isolate vive ~2min): upload → janelas →
// ata. Passo concluído volta pra 'fila' DESCONTANDO a tentativa (progresso ≠ falha).
// Histórico dos bugs (2026-07-21): 8k tokens truncava; thinking dinâmico do flash comia o budget
// (ata cortada + loop "Doenças do Sistema..."); verbatim de 1h numa chamada só passa de 290s;
// flash degenera na SÍNTESE mesmo com thinkingBudget (por isso ata = Opus/pro, nunca flash).
import { carregarLinha, enviarTexto, enviarDocumento, type LinhaWa } from "./wa.ts";
import { extDeMime } from "./transcrever.ts";
import { gerarPdf } from "./documento.ts";
import { logMensagem } from "./db.ts";
import { chamarOpus, getAnthropicKey } from "./anthropic.ts";

const BUCKET = "gt-doc-assets";
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);
// ⚠️ MODELO POR TAREFA (validado na API real com a reunião de 65MB/1h em 2026-07-21):
// - ATA/VÍDEO (compreensão + síntese) = gemini-2.5-PRO. O flash DEGENERA em loop de repetição
//   nesse trabalho MESMO com thinkingBudget explícito ("Doenças do Sistema..." repetido até
//   estourar 16k tokens), e `frequencyPenalty` não existe pra ele ("Penalty is not enabled for
//   models/gemini-2.5-flash"). O pro fez a mesma ata em 40s, finish=STOP, zero repetição.
// - TRANSCRIÇÃO verbatim (ditado literal) = flash (rápido/barato; sem síntese não há loop de tema).
const GEMINI_MODEL = Deno.env.get("ASSIST_GEMINI_MODEL") || "gemini-2.5-flash";
const GEMINI_MODEL_ATA = Deno.env.get("ASSIST_GEMINI_MODEL_ATA") || "gemini-2.5-pro";

// ATA ESCRITA PELO OPUS 4.8 A PARTIR DA TRANSCRIÇÃO (pedido do dono 2026-07-21: "sejam
// inteligentes, usem o Opus 4.8 pra esse trabalho"). O Opus não lê áudio — a cadeia é
// Gemini transcreve (janelas paralelas) → Opus escreve a ata do TEXTO. Qualidade muito acima
// do resumo áudio→texto do Gemini, e o formato de saída é o MESMO (o documento.ts renderiza).
const PROMPT_ATA_OPUS = (transcricao: string, instrucao?: string | null) =>
`Você é o chefe de gabinete dos donos da PPGVET Educação (educação/pós-graduação em veterinária).
Abaixo está a TRANSCRIÇÃO de uma reunião interna (com marcação de falantes quando foi possível
reconhecer). Escreva a ATA EXECUTIVA dessa reunião, em português do Brasil — o material que um
diretor lê em 5 minutos e sabe tudo que importa: contexto, o que foi decidido, o que ficou em
aberto e o CHECKLIST do que cada pessoa vai fazer.

TAMANHO: proporcional à reunião — o equivalente a 2 a 3 folhas para uma reunião longa (1h+),
1 a 2 folhas para uma curta. Denso e útil, nunca prolixo.

FORMATO (obrigatório — títulos numa linha própria, entre *asteriscos*):

*Identificação*
Assunto: <título curto e específico, máx. 90 caracteres>
Participantes: <quem participou — use os nomes das falas e do contexto; inclua o papel quando dedutível, ex.: "Adriane (pedagógico)">
Data citada: <data/dia mencionado; senão "não citada">
Pauta principal: <uma linha>

*Resumo executivo*
1 parágrafo denso (4 a 7 linhas), texto corrido: por que a reunião aconteceu, o que se decidiu
no geral e qual é o próximo movimento.

*Pauta e discussões*
Agrupe por TEMA (máx. 8). Nome do tema numa linha em *negrito* (ex.: *1. Escola de Especialistas*)
e, abaixo, 2 a 6 bullets contando o que se discutiu — com substância: quem defendeu o quê, números
citados, alternativas descartadas. Atribua posições às pessoas quando a transcrição permitir
("Adriane apontou que...", "Rafael decidiu que...").

*Decisões*
- Uma linha por decisão FECHADA, com quem bateu o martelo quando identificável. Se nada foi fechado, escreva "- Nada foi fechado nesta reunião.".

*Pendências (em aberto)*
- Uma linha por assunto sem definição e de quem depende. Se não houver, escreva "- Nada ficou em aberto.".

*Tarefas por responsável*
O CHECKLIST da reunião, agrupado POR PESSOA. Nome numa linha em *negrito* e as tarefas em lista
numerada (1., 2., 3.), objetivas e acionáveis, com prazo/data quando citado. Sub-tarefas do mesmo
tema viram UMA linha inteligente. Tarefa sem dono vai sob *A definir responsável*.

*Prazos e datas*
- Datas e eventos com data citados. Omita a seção se não houver nenhum.

REGRAS:
- FIDELIDADE TOTAL: só o que está na transcrição. Não invente nomes, números, decisões nem prazos.
  Trecho ambíguo → "(não ficou claro)". Nomes com grafia incerta → use a forma mais provável uma vez e mantenha.
- Cada ponto/decisão/tarefa aparece UMA vez (consolide repetições da conversa).
- Sem introdução, comentário seu ou despedida — comece direto em *Identificação*.${
  instrucao?.trim() ? `\n- O dono pediu especificamente: "${instrucao.trim()}" — priorize isso.` : ""}

TRANSCRIÇÃO:
"""
${transcricao}
"""`;

// RESUMO/ATA direto do ÁUDIO (Gemini 2.5-pro) — hoje é só o FALLBACK quando a transcrição
// falhou de vez (a ata boa vem do Opus sobre o texto). Estruturado, FIEL e ANTI-REPETIÇÃO.
// ⚠️ O formato é o do WhatsApp (*Seção*, "- bullet", "1. item") porque o MESMO texto vai pro
// chat quando é curto e pro PDF quando é longo — o `documento.ts` traduz isso pro layout de ata.
const PROMPT_RESUMO =
`Você recebeu o ÁUDIO de uma reunião interna da PPGVET Educação (educação/pós-graduação em veterinária).
Produza, em português do Brasil, uma ATA DE REUNIÃO formal, organizada e FIEL ao áudio: quem lê precisa
entender o CONTEXTO, o que foi DECIDIDO, o que ficou EM ABERTO e exatamente o que cada pessoa vai FAZER.

Use *asterisco* nos títulos (negrito no WhatsApp). Estruture EXATAMENTE nesta ordem, com estes nomes:

*Identificação*
Assunto: <título curto e específico da reunião, no máximo 90 caracteres>
Participantes: <nomes citados no áudio, separados por vírgula; se ninguém for nomeado, escreva "não identificados no áudio">
Data citada: <data/dia mencionado na reunião; se não mencionarem, escreva "não citada">
Pauta principal: <em uma linha, o eixo central do que foi tratado>

*Resumo executivo*
3 a 6 linhas corridas (sem bullets) contando a reunião pra quem não estava lá: por que aconteceu,
o que se decidiu no geral e qual é o próximo movimento.

*Pauta e discussões*
Agrupe por TEMA (no MÁXIMO 8 temas). Para cada tema, escreva o nome do tema numa linha em *negrito*
(ex.: *1. Escola de Especialistas*) e, abaixo, de 2 a 5 bullets explicando o que se falou — com contexto,
não só o título. Junte no mesmo tema tudo que for do mesmo assunto, mesmo que tenha sido falado em
momentos diferentes do áudio.

*Decisões*
- Um bullet por decisão FECHADA na reunião. Se nada foi fechado, escreva "- Nada foi fechado nesta reunião.".

*Pendências (em aberto)*
- Um bullet por assunto que ficou sem definição, e (quando der) de quem depende. Se não houver, escreva "- Nada ficou em aberto.".

*Tarefas por responsável*
Agrupe as ações POR PESSOA. Nome da pessoa numa linha em *negrito* e, abaixo, as tarefas dela em lista
NUMERADA (1., 2., 3.), cada uma com o prazo/data QUANDO citado. Exemplo:
*Adriane*
1. <tarefa objetiva> (prazo: <quando>, se houver)
2. <outra tarefa>
Tarefa sem responsável claro vai agrupada sob o nome *A definir responsável* (escrito assim, entre asteriscos, sem aspas).

*Prazos e datas*
- Datas e eventos com data mencionados (ex.: "05/08 - Dia do Médico Veterinário"). Omita a seção inteira se não houver nenhum.

REGRAS (siga à risca):
- FIDELIDADE: não invente nomes, números, decisões, tarefas nem prazos. Se algo não ficou claro/audível, escreva "(não ficou claro no áudio)".
- SEM REPETIÇÃO: cada ponto, decisão ou tarefa aparece UMA ÚNICA VEZ. Se o assunto voltou várias vezes no
  áudio, CONSOLIDE numa linha só. NUNCA repita a mesma frase/linha. Se a seção acabou, ENCERRE-A e siga pra próxima.
- Se uma pessoa recebeu VÁRIAS sub-tarefas do mesmo tema, agrupe em uma ou poucas linhas inteligentes.
- Escreva frases completas e objetivas. Nada de introdução, despedida ou comentário seu — comece direto em *Identificação*.`;

// TRANSCRIÇÃO verbatim — palavra por palavra, POR JANELA DE TEMPO (medido: 1h inteira numa
// chamada só passa de 290s e nenhum isolate sobrevive; a janela de ~15min cabe num tick).
const FIM_AUDIO = "[FIM DO AUDIO]";
const JANELA_MIN = 15;          // tamanho da janela transcrita por tick
const JANELA_TETO_MIN = 240;    // trava de segurança (4h) — nunca fatia pra sempre

const promptTranscricaoJanela = (iniMin: number, fimMin: number) =>
`Transcreva SOMENTE o trecho do ÁUDIO entre ${iniMin}:00 e ${fimMin}:00 (minutos:segundos desde o início),
em português do Brasil, palavra por palavra — SEM resumir, SEM comentar e SEM adicionar seções ou títulos.
- Identifique quem fala quando der pra reconhecer pela voz/contexto (ex.: "Rafael:", "Adri:"); se não der, use "Falante 1:", "Falante 2:".
- Quebre em parágrafos por fala/assunto, pra ficar legível.
- Se algum trecho estiver inaudível, marque "[inaudível]". NÃO invente conteúdo.
- NÃO repita frases: transcreva cada fala UMA única vez.
- PARE EXATAMENTE ao chegar em ${fimMin}:00 — NÃO continue além disso, mesmo que a conversa siga.
- Se o áudio TERMINAR dentro desse trecho, transcreva até o fim e escreva na ÚLTIMA linha, sozinho: ${FIM_AUDIO}
- Se o áudio já tiver terminado ANTES de ${iniMin}:00 (não há fala nesse trecho), escreva APENAS: ${FIM_AUDIO}
Comece direto pela transcrição.`;

const PROMPT_VIDEO =
`Você recebeu um VÍDEO enviado por um dos donos da PPGVET Educação (educação/pós-graduação em veterinária).
Analise em português do Brasil, de forma clara e FIEL ao que aparece. Estruture em 3 seções, e o título de
cada seção fica NUMA LINHA SOZINHA, entre *asteriscos* (negrito no WhatsApp), com o conteúdo nas linhas de baixo:

*O que é o vídeo*
2 a 4 linhas: tipo de vídeo (criativo/anúncio, gravação de reunião/aula, depoimento, clipe…) e o que mostra.

*Conteúdo*
O que acontece: cenas, pessoas, texto na tela, produto. Transcreva as falas relevantes se houver áudio.

*Análise*
Se for CRIATIVO/anúncio: avalie gancho, clareza da mensagem, CTA e ritmo, e dê sugestões de melhoria.
Se for reunião/aula/fala: resuma pontos principais, decisões e ações (com responsável/prazo quando citados).

Seja fiel: NÃO invente. Se algo não estiver claro/audível, diga. Sem introdução nem despedida — comece direto na 1ª seção.`;

// generationConfig por tipo.
// ⚠️ `thinkingBudget` NÃO é firula: no gemini-2.5-flash o "pensamento" é DINÂMICO por padrão e os
// tokens de pensamento SAEM DO MESMO maxOutputTokens. Em reunião de 1h ele torrava ~22k dos 24k
// pensando e sobrava ~1,2k pro texto → a ata saía CORTADA no meio da frase (o PDF de 21/07) e a
// transcrição verbatim voltava VAZIA (finish=MAX_TOKENS). Com o teto explícito, o orçamento é do texto.
// Menos pensamento também deixa a geração MUITO mais rápida — é o que faz caber no tick de 100s.
const CFG_RESUMO = { temperature: 0.45, topP: 0.9, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 2048 } };
const CFG_TRANSCRICAO = { temperature: 0.1, topP: 0.5, maxOutputTokens: 12000, thinkingConfig: { thinkingBudget: 0 } }; // por JANELA de 15min
const CFG_VIDEO = { temperature: 0.4, topP: 0.9, maxOutputTokens: 12000, thinkingConfig: { thinkingBudget: 1024 } };

const MAX_TENTATIVAS = 5;          // upload e geração são passos separados → cabe mais retry
const URI_VALIDA_MS = 40 * 3600e3; // arquivo no Gemini expira em 48h; usamos folga de 40h

// ── Fila ─────────────────────────────────────────────────────────────────────
/** REUNIÃO em áudio: sobe o áudio no bucket UMA vez e cria 2 jobs (resumo + transcrição). */
export async function enfileirarReuniaoAudio(
  admin: any,
  opts: { canon: string; numero: string; linhaId: string | null; bytes: Uint8Array; mime: string },
): Promise<void> {
  const path = `assistente/audio/${opts.canon}/${Date.now()}.${extDeMime(opts.mime)}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, opts.bytes, {
    contentType: opts.mime || "audio/ogg", upsert: true,
  });
  if (error) throw new Error(`upload audio: ${error.message}`);
  const mb = (opts.bytes.length / (1024 * 1024)).toFixed(0);
  const base = {
    canon: opts.canon, numero: opts.numero, linha_id: opts.linhaId,
    storage_path: path, mime: opts.mime, duracao_hint: `${mb} MB`, status: "fila", instrucao: null,
  };
  // TRANSCRIÇÃO PRIMEIRO (criado_em anterior → o claim [order by criado_em] prioriza ela):
  // a ata agora é escrita pelo OPUS a partir do texto, então depende da transcrição pronta.
  await admin.from("assistente_transcricoes").insert({ ...base, tipo: "transcricao" });
  await admin.from("assistente_transcricoes").insert({ ...base, tipo: "audio" });
}

/** VÍDEO (ou uso genérico): 1 job só. */
export async function enfileirarTranscricao(
  admin: any,
  opts: {
    canon: string; numero: string; linhaId: string | null; bytes: Uint8Array; mime: string;
    tipo?: "audio" | "video" | "transcricao"; instrucao?: string | null;
  },
): Promise<void> {
  const tipo = opts.tipo ?? "audio";
  const path = `assistente/${tipo}/${opts.canon}/${Date.now()}.${extDeMime(opts.mime)}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, opts.bytes, {
    contentType: opts.mime || (tipo === "video" ? "video/mp4" : "audio/ogg"), upsert: true,
  });
  if (error) throw new Error(`upload ${tipo}: ${error.message}`);
  const mb = (opts.bytes.length / (1024 * 1024)).toFixed(0);
  await admin.from("assistente_transcricoes").insert({
    canon: opts.canon, numero: opts.numero, linha_id: opts.linhaId,
    storage_path: path, mime: opts.mime, duracao_hint: `${mb} MB`, status: "fila",
    tipo, instrucao: opts.instrucao ?? null,
  });
}

// ── Worker (chamado pelo cron, 1 PASSO por tick) ─────────────────────────────
// Máquina de estado de 2 passos, porque download(65MB) + upload(65MB) + geração NÃO cabem juntos
// nos 100s do tick (era isso que fazia o job estourar tentativa e morrer):
//   passo 1 → sobe o áudio pro Gemini e GRAVA a uri (volta pra fila SEM contar tentativa)
//   passo 2 → gera o texto, com o tick inteiro só pra isso
// O job irmão (resumo ↔ transcrição do mesmo áudio) REUSA a uri: só um dos dois sobe o arquivo.
export async function processarTranscricoes(admin: any): Promise<{ processado: number; etapa?: string; erro?: string }> {
  const { data: jobs, error } = await admin.rpc("assistente_transcricao_claim");
  if (error) throw new Error(`claim: ${error.message}`);
  const job = (jobs ?? [])[0];
  if (!job) return { processado: 0 };

  const tipo: string = job.tipo || "audio";
  let linha: LinhaWa | null = null;
  try {
    // Dentro do try DE PROPÓSITO: um blip aqui deixava o job 'processando' órfão pra sempre
    // (throw fora do try não passa pelo caminho de refila — achado da revisão adversarial).
    linha = await carregarLinha(admin);
    if ((job.tentativas ?? 1) > MAX_TENTATIVAS) throw new Error("excedeu tentativas");

    const key = await googleKey(admin);
    if (!key) throw new Error("sem chave Google (Gemini)");

    const mime = job.mime || (tipo === "video" ? "video/mp4" : "audio/ogg");

    // ── passo 1: arquivo no Gemini ──
    let uri = uriAindaVale(job) ? job.gemini_file_uri : await uriDoJobIrmao(admin, job);
    if (!uri) {
      uri = await subirParaGemini(admin, key, job, mime);
      await admin.from("assistente_transcricoes").update({
        status: "fila",
        // desconta o claim: subir o arquivo é progresso, não falha.
        tentativas: Math.max(0, (job.tentativas ?? 1) - 1),
        atualizado_em: new Date().toISOString(),
      }).eq("id", job.id);
      return { processado: 0, etapa: "upload" };
    }
    if (uri !== job.gemini_file_uri) {
      await admin.from("assistente_transcricoes")
        .update({ gemini_file_uri: uri, gemini_uri_em: new Date().toISOString() }).eq("id", job.id);
    }

    // ── passo 2: geração ──
    // Transcrição verbatim = FATIADA (janelas de tempo em paralelo; a íntegra de 1h numa chamada
    // só passa de 290s e nenhum isolate sobrevive — medido na API real em 2026-07-21).
    if (tipo === "transcricao") return await transcreverJanela(admin, linha, job, key, uri, mime);

    // ATA de reunião = OPUS 4.8 sobre a transcrição do job irmão (pedido do dono). O caminho
    // Gemini áudio→ata fica como FALLBACK (irmão falhou de vez / job avulso sem irmão).
    if (tipo === "audio") {
      const irmao = await irmaoTranscricao(admin, job);
      if (irmao?.status === "pronto" && irmao.resultado) {
        const ata = await ataViaOpus(admin, irmao.resultado, job.instrucao);
        if (ata) {
          await entregar(admin, linha, job, ata); // entrega ANTES de marcar (falhou → refila/retry)
          await admin.from("assistente_transcricoes")
            .update({ status: "pronto", resultado: ata, erro: null, atualizado_em: new Date().toISOString() })
            .eq("id", job.id);
          return { processado: 1, etapa: "ata via opus" };
        }
        // Opus indisponível → segue pro fallback Gemini abaixo.
      } else if (irmao && irmao.status !== "erro") {
        // Transcrição ainda rodando → aguarda SEM queimar tentativa (o claim prioriza o irmão,
        // que é mais antigo; se ele morrer de vez, cai no fallback na próxima passada).
        await admin.from("assistente_transcricoes").update({
          status: "fila", tentativas: Math.max(0, (job.tentativas ?? 1) - 1),
          atualizado_em: new Date().toISOString(),
        }).eq("id", job.id);
        return { processado: 0, etapa: "aguardando transcricao" };
      }
    }

    const promptBase = tipo === "video" ? PROMPT_VIDEO : PROMPT_RESUMO;
    const cfg = tipo === "video" ? CFG_VIDEO : CFG_RESUMO;
    const prompt = job.instrucao && String(job.instrucao).trim()
      ? `${promptBase}\n\nO dono pediu especificamente: "${String(job.instrucao).trim()}" — priorize isso na análise.`
      : promptBase;

    let resultado = await gerarComGemini(key, GEMINI_MODEL_ATA, uri, mime, prompt, cfg);
    resultado = tirarPreambulo(resultado);
    // Rede de segurança anti-degeneração: melhor retentar do que entregar um PDF de lixo repetido.
    const loop = linhaMaisRepetida(resultado);
    if (loop.vezes >= 15) throw new Error(`saída degenerada (linha repetida ${loop.vezes}x: "${loop.linha.slice(0, 60)}")`);

    await entregar(admin, linha, job, resultado); // entrega ANTES de marcar (falhou → refila/retry)
    await admin.from("assistente_transcricoes")
      .update({ status: "pronto", resultado, erro: null, atualizado_em: new Date().toISOString() })
      .eq("id", job.id);
    return { processado: 1, etapa: "gerado" };
  } catch (e) {
    const msg = String(e);
    // Arquivo sumiu/expirou no Gemini → esquece a uri (TAMBÉM a do job irmão, que compartilha o
    // mesmo upload — senão o retry re-herda a uri morta dele) e a próxima tentativa sobe de novo.
    const patch: Record<string, unknown> = { erro: msg, atualizado_em: new Date().toISOString() };
    if (/\b(403|404)\b|PERMISSION_DENIED|NOT_FOUND|File .* not found/i.test(msg)) {
      patch.gemini_file_uri = null; patch.gemini_uri_em = null;
      try {
        await admin.from("assistente_transcricoes")
          .update({ gemini_file_uri: null, gemini_uri_em: null })
          .eq("storage_path", job.storage_path);
      } catch { /* best-effort */ }
    }
    const desistir = (job.tentativas ?? 1) >= MAX_TENTATIVAS;
    patch.status = desistir ? "erro" : "fila";
    await admin.from("assistente_transcricoes").update(patch).eq("id", job.id);
    if (desistir && linha && job.numero) {
      await enviarTexto(linha, job.numero, msgErro(tipo)).catch(() => {});
    }
    return { processado: 0, erro: msg };
  }
}

// Quantas janelas rodam EM PARALELO num tick (velocidade — pedido do dono: "15-20min é lento").
// 3 × ~80s em paralelo ≈ 1 tick; 1h de reunião = 4 janelas = 2 ticks; 2h15 = 9 janelas = 3 ticks.
const LOTE_JANELAS = 3;

/** Transcreve um LOTE de janelas em paralelo por tick e ACUMULA; fecha quando aparece o fim. */
async function transcreverJanela(
  admin: any, linha: LinhaWa | null, job: any, key: string, uri: string, mime: string,
): Promise<{ processado: number; etapa?: string }> {
  const ini = job.prox_janela_min ?? 0;
  const janelas = Array.from({ length: LOTE_JANELAS }, (_, k) => ({
    ini: ini + k * JANELA_MIN, fim: ini + (k + 1) * JANELA_MIN,
  })).filter((j) => j.ini < JANELA_TETO_MIN);

  const brutos = await Promise.all(janelas.map((j) =>
    gerarComGemini(key, GEMINI_MODEL, uri, mime, promptTranscricaoJanela(j.ini, j.fim), CFG_TRANSCRICAO)
  ));

  let acumulado = job.resultado ?? "";
  let acabou = janelas.length === 0 || (janelas.at(-1)!.fim >= JANELA_TETO_MIN);
  for (let k = 0; k < brutos.length; k++) {
    const bruto = brutos[k];
    const loop = linhaMaisRepetida(bruto);
    if (loop.vezes >= 15) throw new Error(`janela ${janelas[k].ini}-${janelas[k].fim}min degenerada (linha repetida ${loop.vezes}x)`);
    // ⚠️ Medido na API real: às vezes o modelo IGNORA o fim da janela e segue transcrevendo (a
    // janela 120-135min devolveu ~34min de fala até o teto de tokens). Sobreposição na emenda é
    // esperada — `apararSobreposicao` corta. Buraco não acontece: no ritmo medido (~1,2k chars/min)
    // o teto de 12k tokens nunca corta ANTES do fim da janela.
    const trecho = apararSobreposicao(acumulado, bruto.replaceAll(FIM_AUDIO, "").trim());
    if (trecho) acumulado = [acumulado, trecho].filter(Boolean).join("\n\n");
    if (bruto.includes(FIM_AUDIO)) { acabou = true; break; }
  }

  if (!acabou) {
    await admin.from("assistente_transcricoes").update({
      resultado: acumulado, prox_janela_min: janelas.at(-1)!.fim,
      // lote concluído = progresso: volta pra fila SEM queimar tentativa (como o passo de upload).
      status: "fila", tentativas: Math.max(0, (job.tentativas ?? 1) - 1),
      erro: null, atualizado_em: new Date().toISOString(),
    }).eq("id", job.id);
    return { processado: 0, etapa: `janelas ${ini}-${janelas.at(-1)!.fim}min` };
  }

  if (!acumulado) throw new Error("transcrição terminou vazia"); // glitch → retry
  // ⚠️ ENTREGA ANTES de marcar pronto (achado da revisão): se o envio falhar (linha caiu), o
  // throw manda o job de volta pra fila e o retry re-tenta — antes ficava 'pronto' em silêncio
  // e o dono nunca recebia. (Trade-off aceito: update falhar depois do envio = reentrega rara.)
  await entregar(admin, linha, job, acumulado);
  await admin.from("assistente_transcricoes")
    .update({ status: "pronto", resultado: acumulado, erro: null, atualizado_em: new Date().toISOString() })
    .eq("id", job.id);
  return { processado: 1, etapa: "transcricao completa" };
}

/** Job irmão (mesmo áudio) de tipo transcricao — é dele que o Opus escreve a ata. */
async function irmaoTranscricao(admin: any, job: any): Promise<any | null> {
  const { data } = await admin.from("assistente_transcricoes")
    .select("id, status, resultado")
    .eq("storage_path", job.storage_path).eq("tipo", "transcricao")
    .neq("id", job.id)
    .order("criado_em", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

/** Ata executiva escrita pelo OPUS 4.8 a partir da transcrição. null = Opus indisponível (fallback). */
async function ataViaOpus(admin: any, transcricao: string, instrucao?: string | null): Promise<string | null> {
  try {
    const key = await getAnthropicKey(admin);
    if (!key) return null;
    const resp = await chamarOpus(key, {
      max_tokens: 8000,
      messages: [{ role: "user", content: PROMPT_ATA_OPUS(transcricao, instrucao) }],
    });
    const txt = (resp?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "").join("").trim();
    return txt ? tirarPreambulo(txt) : null;
  } catch (e) {
    console.error("ataViaOpus falhou (cai no fallback Gemini):", String(e).slice(0, 200));
    return null;
  }
}

/** Apara a emenda entre janelas: remove do INÍCIO do trecho novo as linhas que já estão no FIM
 *  do acumulado (o modelo às vezes transcreve além da janela e a seguinte repete o overlap). */
function apararSobreposicao(acumulado: string, trecho: string): string {
  if (!acumulado || !trecho) return trecho;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  // 500 linhas ≈ 50min de fala no ritmo medido — cobre até um overflow grande da janela anterior.
  const cauda = new Set(
    acumulado.split("\n").map(norm).filter((l) => l.length >= 20).slice(-500),
  );
  const linhas = trecho.split("\n");
  let i = 0;
  while (i < linhas.length) {
    const n = norm(linhas[i]);
    if (!n) { i++; continue; }            // linha vazia na emenda não decide nada
    if (n.length >= 20 && cauda.has(n)) { i++; continue; }
    break;                                 // primeira linha inédita → daqui pra frente é conteúdo novo
  }
  return linhas.slice(i).join("\n").trim();
}

const uriAindaVale = (job: any): boolean =>
  !!job.gemini_file_uri && !!job.gemini_uri_em &&
  (Date.now() - new Date(job.gemini_uri_em).getTime()) < URI_VALIDA_MS;

/** O mesmo áudio gera 2 jobs (resumo + transcrição): o segundo aproveita o upload do primeiro. */
async function uriDoJobIrmao(admin: any, job: any): Promise<string | null> {
  const { data } = await admin.from("assistente_transcricoes")
    .select("gemini_file_uri, gemini_uri_em")
    .eq("storage_path", job.storage_path)
    .not("gemini_file_uri", "is", null)
    .gt("gemini_uri_em", new Date(Date.now() - URI_VALIDA_MS).toISOString())
    .order("gemini_uri_em", { ascending: false })
    .limit(1).maybeSingle();
  return data?.gemini_file_uri ?? null;
}

async function subirParaGemini(admin: any, key: string, job: any, mime: string): Promise<string> {
  const { data: file, error } = await admin.storage.from(BUCKET).download(job.storage_path);
  if (error || !file) throw new Error(`download storage: ${error?.message || "vazio"}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { uri } = await uploadGemini(key, bytes, mime);
  await admin.from("assistente_transcricoes")
    .update({ gemini_file_uri: uri, gemini_uri_em: new Date().toISOString() }).eq("id", job.id);
  return uri;
}

/** Corta preâmbulo do modelo ("Com base no áudio..., segue a ata:") — a ata começa na 1ª *Seção*. */
function tirarPreambulo(txt: string): string {
  const i = txt.search(/^\*[^\n*]+\*\s*$/m);
  return i > 0 ? txt.slice(i) : txt;
}

/** Detector de loop de repetição (a degeneração que virou "checklist repetida" 2x). */
function linhaMaisRepetida(txt: string): { linha: string; vezes: number } {
  const contagem = new Map<string, number>();
  let melhor = { linha: "", vezes: 0 };
  for (const cru of txt.split("\n")) {
    const l = cru.trim();
    if (l.length < 12) continue; // linha curta ("- Sim.") repete legitimamente numa transcrição
    const n = (contagem.get(l) ?? 0) + 1;
    contagem.set(l, n);
    if (n > melhor.vezes) melhor = { linha: l, vezes: n };
  }
  return melhor;
}

const fmtDataHoraSP = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
};

function msgErro(tipo: string): string {
  if (tipo === "video") return "Não consegui analisar esse vídeo 😕. O arquivo pode estar grande demais — tenta reenviar, ou me manda mais curto.";
  if (tipo === "transcricao") return "Não consegui fechar a *transcrição palavra por palavra* dessa reunião 😕 — mas segue o jogo: a *ata* eu monto mesmo assim e te mando em seguida.";
  return "Consegui receber a reunião, mas tropecei pra montar a *ata* 😕. Reenvia que eu tento de novo (reunião grande também funciona).";
}

/** Entrega o resultado no WhatsApp: resumo/vídeo = texto curto ou PDF; transcrição = sempre PDF.
 *  ⚠️ LANÇA se a entrega PRINCIPAL falhar (o provider devolve {ok:false} SEM lançar — checar é
 *  obrigatório): o worker refila e re-tenta. Antes tudo era engolido e o job virava 'pronto'
 *  sem o dono receber nada (achado "alta" da revisão adversarial). */
async function entregar(admin: any, linha: LinhaWa | null, job: any, resultado: string) {
  const tipo: string = job.tipo || "audio";
  const meta = tipo === "video"
    ? { titulo: "🎬 *Análise do vídeo*", pdfNome: "analise-video", pdfTitulo: "Análise do Vídeo",
        avisoPdf: "🎬 Seu vídeo rendeu bastante — mandei a análise completa em *PDF* aqui em cima. 👆", semprePdf: false, histTipo: "video_analise" }
    : tipo === "transcricao"
    ? { titulo: "📝 *Transcrição completa da reunião*", pdfNome: "transcricao-reuniao", pdfTitulo: "Transcrição Completa da Reunião",
        avisoPdf: "📝 A *transcrição completa* (palavra por palavra, com os falantes) está no *PDF* aqui em cima. 👆 Agora tô escrevendo a *ata executiva* — chega em 1-2 min.", semprePdf: true, histTipo: "transcricao" }
    : { titulo: "🎙️ *Ata da reunião*", pdfNome: "ata-reuniao", pdfTitulo: "Ata de Reunião",
        avisoPdf: "🎙️ Pronto! A *ata executiva* — contexto, decisões, pendências e o checklist de tarefas por pessoa — está no *PDF* aqui em cima. 👆", semprePdf: false, histTipo: "transcricao" };

  if (!linha || !job.numero) throw new Error("sem linha/número de WhatsApp para entregar");
  const exigirOk = async (envio: Promise<any>, oQue: string) => {
    const r = await envio; // erro de rede sobe sozinho
    if (r && r.ok === false) throw new Error(`envio do ${oQue} falhou (provider ok:false)`);
  };

  let entregou = false;
  if (meta.semprePdf || resultado.length > 3500) {
    // longo (ou transcrição) → PDF; falha do PDF cai no texto truncado (abaixo)
    try {
      // A Identificação (Assunto/Participantes/…) vem do próprio texto do modelo; aqui só o
      // subtítulo — duplicar data/tamanho do áudio ACIMA do Assunto poluía o cabeçalho.
      const bytes = await gerarPdf(meta.pdfTitulo, resultado, {
        subtitulo: `PPGVET Educacao  ·  reuniao registrada em ${fmtDataHoraSP(job.criado_em)}`,
      });
      const path = `assistente/${job.canon}/${Date.now()}-${meta.pdfNome}.pdf`;
      await admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
      const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
      await exigirOk(
        enviarDocumento(linha, job.numero, toPublicUrl(pub?.publicUrl ?? ""), `${meta.pdfNome}.pdf`, meta.pdfTitulo),
        "PDF",
      );
      await enviarTexto(linha, job.numero, meta.avisoPdf).catch(() => {}); // aviso é secundário
      entregou = true;
    } catch (e) {
      console.error("entrega em PDF falhou, caindo pro texto:", String(e).slice(0, 160));
    }
  }
  if (!entregou) {
    const corpo = resultado.length > 3500 ? `${resultado.slice(0, 3500)}…` : resultado;
    await exigirOk(enviarTexto(linha, job.numero, `${meta.titulo}\n\n${corpo}`), "texto");
  }

  // HISTÓRICO só depois de entregar DE VERDADE (senão o bot "lembra" de algo que nunca chegou).
  // ⚠️ A transcrição VERBATIM é enorme (1h ~15k tokens) → NUNCA vai crua pro histórico (estouraria
  // o contexto do Opus a cada turno). Loga um marcador curto; a ata (curta) vai inteira.
  const histTexto = tipo === "transcricao"
    ? "[Transcrição completa da reunião enviada em PDF]"
    : resultado;
  await logMensagem(admin, job.canon, "outbound", histTexto, meta.histTipo).catch(() => {});
}

// ── Gemini File API ──────────────────────────────────────────────────────────
async function googleKey(admin: any): Promise<string | null> {
  const env = Deno.env.get("ASSIST_GEMINI_KEY") || Deno.env.get("GOOGLE_API_KEY");
  if (env) return env;
  const { data } = await admin.from("ai_api_keys").select("api_key")
    .eq("provider", "google").eq("is_active", true).limit(1).maybeSingle();
  return data?.api_key ?? null;
}

/** Gera o texto a partir de um arquivo JÁ enviado ao Gemini (passo 2 do worker). */
async function gerarComGemini(
  key: string, modelo: string, fileUri: string, mime: string, prompt: string,
  cfg: Record<string, unknown>,
): Promise<string> {
  await esperarAtivo(key, fileUri, 40_000);

  const chamar = async (generationConfig: Record<string, unknown>) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { file_data: { file_uri: fileUri, mime_type: mime } },
            { text: prompt },
          ] }],
          generationConfig,
        }),
      },
    );
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, j };
  };

  let { ok, status, j } = await chamar(cfg);
  // Modelo sem suporte a "thinking" (se trocarem o ASSIST_GEMINI_MODEL) devolve 400 → repete sem o campo.
  if (!ok && status === 400 && "thinkingConfig" in cfg && /thinking/i.test(JSON.stringify(j))) {
    const { thinkingConfig: _drop, ...semThinking } = cfg as Record<string, unknown>;
    ({ ok, status, j } = await chamar(semThinking));
  }
  if (!ok) throw new Error(`gemini generate ${status}: ${JSON.stringify(j).slice(0, 200)}`);

  const cand = j?.candidates?.[0];
  const txt = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
  // Vazio + MAX_TOKENS = o orçamento foi todo pro "pensamento" (era o bug da transcrição).
  // Melhor estourar e retentar do que entregar nada.
  if (!txt) throw new Error(`Gemini não devolveu texto (finish=${cand?.finishReason ?? "?"})`);
  return txt;
}

/** Upload resumable. Espera ACTIVE só um pouco: se demorar, o próximo tick espera o resto. */
async function uploadGemini(key: string, bytes: Uint8Array, mime: string): Promise<{ uri: string }> {
  const base = "https://generativelanguage.googleapis.com";
  const start = await fetch(`${base}/upload/v1beta/files?key=${key}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "reuniao" } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`Gemini upload start falhou (${start.status})`);

  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
  });
  const uj = await up.json().catch(() => ({}));
  const uri = uj?.file?.uri;
  if (!uri) throw new Error(`Gemini upload falhou (${up.status})`);
  await esperarAtivo(key, uri, 20_000).catch(() => {}); // best-effort; quem cobra é o passo 2
  return { uri };
}

/** O Gemini processa o áudio antes de liberar (state PROCESSING → ACTIVE). */
async function esperarAtivo(key: string, fileUri: string, limiteMs: number): Promise<void> {
  const ate = Date.now() + limiteMs;
  let state = "";
  while (Date.now() < ate) {
    const g = await fetch(`${fileUri}?key=${key}`);
    // ⚠️ Arquivo expirado/sumido volta 403/404 — o status TEM que ir na mensagem, é ele que o
    // catch do worker usa pra LIMPAR a uri e re-subir o áudio (achado da revisão adversarial).
    if (g.status === 403 || g.status === 404) {
      throw new Error(`arquivo no Gemini sumiu/expirou (${g.status} NOT_FOUND)`);
    }
    state = (await g.json().catch(() => ({})))?.state ?? "";
    if (state === "ACTIVE") return;
    if (state === "FAILED") throw new Error("Gemini falhou ao processar o arquivo");
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`Gemini ainda processando o arquivo (state=${state || "?"})`);
}
