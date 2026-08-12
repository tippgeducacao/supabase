// Saída humanizada do agente SDR — port do trecho final do n8n:
//   resposta do Claude → chunks de 2-3 frases (gpt-4o-mini, json_schema)
//   → delay de "digitação" por chunk (palavras/0.75 ±20%, 2 a 12s)
//   → POST crm-whatsapp-send por chunk.
// Se o chunking falhar, manda o texto inteiro num balão só (resposta > silêncio).

// deno-lint-ignore-file no-explicit-any
import { CHUNKING_SYSTEM } from './prompts.ts';
import type { CtxConversa } from './tools.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const OPENAI_KEY = Deno.env.get('AGENTE_SDR_OPENAI_KEY') ?? Deno.env.get('OPENAI_API_KEY') ?? '';
const SEND_URL = (Deno.env.get('AGENTE_SDR_SEND_URL') ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, '');

// Schema idêntico ao do node "Chat Completions OpenIA - Fraciona Resposta IA".
const CHUNKING_SCHEMA = {
  name: 'message_chunks',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      chunks: {
        type: 'array',
        description: 'An array of message chunks, where each chunk is a separate paragraph.',
        items: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'An exact extraction from the original message. Each chunk must strictly reflect a coherent segment of the input, matching the original format and content without alteration. Links and media must appear in exclusive chunks, isolated, never duplicated, and never omitted.',
            },
            sequence_number: { type: 'number', description: 'The order of this chunk in the original message.' },
          },
          required: ['message', 'sequence_number'],
          additionalProperties: false,
        },
      },
    },
    required: ['chunks'],
    additionalProperties: false,
  },
} as const;

// ── RACIOCÍNIO NUNCA CHEGA AO LEAD ──────────────────────────────────────────
// O thinking NATIVO vem em blocos `type:'thinking'` (que o loop já ignora, ele só
// junta os `type:'text'`). Mas de vez em quando o modelo SIMULA o raciocínio DENTRO
// do bloco de texto, embrulhado em <thinking>…</thinking> — e aí o texto inteiro ia
// pro chunker e pro lead. Foi o caso Susana (2026-07-21, 09:55): a volta pós-tool
// voltou com um único bloco `text` = "<thinking> …raciocínio em inglês… </thinking>
// a pós é online com aulas ao vivo…" → 13 balões de raciocínio entregues no WhatsApp
// (a resposta de verdade só saía no fim). Ocorreu 5x em 30 dias, desde 2026-06-30.
// A régua vive aqui, no funil por onde TODO balão passa (agente SDR, follow-up e
// webchat chamam humanizarTexto), e não no prompt: instrução o modelo desobedece.
const RE_TAG_RACIOCINIO = /<\/?(?:antml:)?(?:thinking|thought|thoughts|scratchpad|reasoning|reflection)\b/i;
const TAGS_RACIOCINIO = '(?:antml:)?(?:thinking|thoughts|thought|scratchpad|reasoning|reflection)';

export function removerRaciocinioVazado(texto: string): string {
  let t = texto ?? '';
  if (!RE_TAG_RACIOCINIO.test(t)) return t; // caso comum: nada a fazer
  // 1. par completo <thinking>…</thinking> (várias ocorrências, multilinha)
  t = t.replace(new RegExp(`<(${TAGS_RACIOCINIO})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  // 2. abertura SEM fechamento: resposta cortada no meio do raciocínio (max_tokens)
  //    ⇒ do <thinking> até o fim é raciocínio, nada dali serve ao lead.
  t = t.replace(new RegExp(`<${TAGS_RACIOCINIO}\\b[^>]*>[\\s\\S]*$`, 'i'), '');
  // 3. fechamento órfão: o raciocínio começou sem tag ⇒ tudo ANTES do </thinking> é dele.
  t = t.replace(new RegExp(`^[\\s\\S]*?<\\/${TAGS_RACIOCINIO}\\s*>`, 'i'), '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// ── RELATÓRIO AO SISTEMA NUNCA CHEGA AO LEAD (2026-07-27) ───────────────────
// Irmã do removerRaciocinioVazado, e pelo mesmo motivo: a "Regra de ouro nº 1"
// já proíbe verbatim ("nunca escreva seu raciocínio... 'o lead disse'") e o
// modelo desobedece assim mesmo. Aqui o vazamento tem forma própria: em vez de
// PENSAR alto, o agente RELATA o estado do atendimento pro sistema — e o relato
// vira balão de WhatsApp ("Não há nova mensagem do lead para responder.",
// "*sem resposta necessária*", "Ele já foi pausado e marcado como sem interesse").
// Padrão medido: 67 de 69 casos caem na volta SEGUINTE a uma `pausa_ia` chamada
// SEM texto junto — o modelo, sem nada a dizer ao lead, responde ao sistema. E o
// recheck de pausa não salva: `pausouPorTool` (index.ts) desliga o recheck
// justamente nessa volta, de propósito, pra não engolir a despedida legítima
// (caso Claudia 2026-07-06). 212 balões em 45 dias, 192 deles nos últimos 3.
//
// ⚠️ Régua CONSERVADORA, validada contra as 126.277 respostas reais da IA dos
// últimos 45 dias: barra 225 (0,18%), zero falso positivo. TRÊS armadilhas que o
// corpus revelou e que NÃO podem voltar — cada uma barrava fala legítima ao lead:
//   (a) envoltório `*…*` sem exigir `[^*]` nas pontas pega o **NEGRITO**, que o
//       chunker usa em balão próprio: "**14h, 14h30 ou 15h**" (oferta de horário!);
//   (b) "sem mensagens" sem o "nova" pega a RETENÇÃO ("te chamar quando abrir a
//       próxima turma, sem mensagens no meio tempo");
//   (c) "nenhuma mensagem" / "aguardando" sem exigir "do lead" pega a despedida de
//       OPT-OUT ("não receberá mais nenhuma mensagem nossa") e "fico te aguardando".
// Por isso todo sinal exige a forma COMPLETA do relatório, e a 3ª pessoa ("do
// lead") é o discriminador central: o João falando COM o lead nunca diz "lead".
// Mexeu aqui → revalide contra o corpus (query no CLAUDE.md) ANTES de subir.
const RE_META: RegExp[] = [
  // Envoltório de ITÁLICO SIMPLES: *sem resposta necessária*, *aguardando resposta do lead*.
  // ⚠️ `[^*]` nas duas pontas é o que separa do **NEGRITO**, que é legítimo e comum
  // (o chunker isola "**14h, 14h30 ou 15h**" e "**Sanidade Avícola**" em balão próprio).
  /^\*[^*].*[^*]\*$/,
  /\bsem\s+(?:uma\s+)?(?:nova|novas)\s+mensage(?:m|ns)\b/i,
  /\bn[ãa]o\s+h[áa]\s+(?:(?:uma|nenhuma|nova|novas)\s+)*mensage(?:m|ns)\b/i,
  // ⚠️ "nenhuma mensagem" EXIGE "do lead": sem isso barra a despedida de opt-out
  // ("não receberá mais nenhuma mensagem nossa"), que é fala legítima ao lead.
  /\bnenhuma\s+mensagem\s+(?:nova\s+)?d[oa]\s+lead\b/i,
  // ⚠️ Regra de FAMÍLIA, não de frase: o modelo TROCA o molde quando um é barrado.
  // "nenhuma AÇÃO" passou a ser barrada em 27/07 e ele migrou pra "nenhuma RESPOSTA
  // necessária" — 35 casos em 15 dias, o último em 06/08 (caso Peterson), sempre
  // com o lead tendo só REAGIDO com emoji. Cobre {nenhum|sem} + {resposta | ação |
  // mensagem | retorno} … "necessária". Validado contra 45 dias de outbound da IA:
  // 55 casamentos, TODOS relatório, zero falso positivo.
  /\b(?:nenhum[ao]|sem)\s+(?:outr[ao]\s+)?(?:resposta|a[çc][ãa]o|mensagem|retorno)\b[^.!?]{0,40}\bnecess[áa]ri/i,
  /\bsem\s+resposta\s+necess/i,
  /\bsem\s+necessidade\s+de\s+resposta\b/i,
  /\b(?:nenhuma|sem)\s+a[çc][ãa]o\b/i,
  /\bn[ãa]o\s+h[áa]\s+a[çc][ãa]o\b/i,
  /\bn[ãa]o\s+(?:vou|irei)\s+(?:enviar|mandar|responder|iniciar)\b/i,
  /\batendimento\s+(?:j[áa]\s+)?(?:est[áa]|foi|permanece|segue)?\s*pausad/i,
  /\batendimento\b.{0,30}\bfoi\s+encerrado\b/i,
  /\bconversa\s+(?:j[áa]\s+)?(?:est[áa]|foi)\s+(?:pausad|encerrad)/i,
  // ⚠️ "aguardando" EXIGE "do lead" (3ª pessoa): "fico te aguardando", "o monitor já
  // está te aguardando" e "Estamos te aguardando" são fala legítima ao lead.
  /\baguardand[oa]\b[^.!?]{0,30}\bd[oa]\s+lead\b/i,
  /^(?:o|a)\s+lead\b/i,
  /^lead\b/i,
  /^(?:ele|ela)\s+j[áa]\s+(?:foi|est[áa]|optou|pediu|solicitou|confirmou|recebeu)\b/i,
  /^devo\s+(?:informar|dizer|perguntar|responder|avisar)\b/i,
  /^olhando\s+o\s+hist[óo]rico\b/i,
  /\b(?:o\s+)?lead\s+(?:reiterou|confirmou|disse|respondeu|mandou|pediu|solicitou|optou)\b/i,
  /\bn[ãa]o\s+(?:é|e)\s+(?:uma\s+)?(?:mensagem|resposta)\s+real\b/i,
  /\bthe\s+(?:lead|user)\b/i, // raciocínio em inglês que escapou sem tag
  /\bn[ãa]o\s+veio\s+do\s+lead\b/i,
  // ── NARRAÇÃO DE INTENÇÃO e RELATÓRIO DE ESTADO DO FLUXO (2026-08-11, caso Kelen) ──
  // Irmãs mais novas do relatório pós-pausa: com o Sonnet 5 o modelo passou a
  // ANUNCIAR o que vai fazer ("Vou apenas responder de forma natural à mensagem do
  // lead, sem repetir agendamento nem comentar o contexto temporal.") e a RESUMIR o
  // estado do fluxo ("A reunião já foi confirmada anteriormente, então não há mais
  // fluxo de agendamento a seguir aqui.") como se falasse com o sistema — e o balão
  // vai pro WhatsApp. Validado contra 45 dias de outbound da IA: 17 casamentos,
  // TODOS meta, zero falso positivo. ⚠️ O verbo é o discriminador, não o "vou":
  // "vou confirmar com o time e já te retorno" e "vou explicar rapidinho" são fala
  // LEGÍTIMA e frequente do João — por isso a família cobre só "responder" e
  // "(seguir|continuar|ficar) aguardando". "A reunião já foi" também é seguro: o
  // João falando COM o lead diz "já está confirmada"/"já tá marcada", nunca "já foi".
  // Mexeu aqui → revalide contra o corpus (query no CLAUDE.md) ANTES de subir.
  /^vou\s+(?:apenas\s+)?responder\b/i,
  /^vou\s+(?:seguir|continuar|ficar)\s+aguardando\b/i,
  /^a\s+reuni[aã]o\s+j[aá]\s+foi\b/i,

  // ── RELATÓRIO DE PROGRESSO DO FUNIL, em vocabulário INTERNO (2026-08-12, caso
  // Carolina) ──────────────────────────────────────────────────────────────────
  // A lead objetou preço ("é uma parcela que não consigo assumir") e recebeu, em
  // dois balões: "Carolina, já foi feita a segunda tentativa de contorno nessa
  // objeção, e o lead segue firme dizendo que não consegue se comprometer agora
  // por estar entre empregos." + "Vou encerrar respeitando a posição dela e mandar
  // o presente da escola." Nenhuma régua pegou, por DOIS motivos:
  //   (a) as famílias de 27/07 e 11/08 cobrem "não há resposta" e "vou responder";
  //       aqui o molde é outro — RELATO de progresso, na 3ª pessoa, com o nome
  //       interno de cada peça do fluxo ("tentativa de contorno", "presente da
  //       escola", "sem link de reunião", e a chamada CRUA da tool);
  //   (b) o detector rodava por LINHA e o modelo escreve a narração no MEIO do
  //       parágrafo, então tudo que é ancorado em ^ nunca casava. Agora roda por
  //       FRASE (ver `trechosDe`), e por isso as famílias antigas também passaram
  //       a pegar narração colada depois de uma frase legítima.
  // Medido no corpus (45 dias de outbound real da IA, 225.808 frases): "lead" na
  // cara do lead 227×, "tentativa de contorno" 12×, brinde pelo nome interno 7×,
  // chamada crua de tool 2× — nada disso é caso raro, é vazamento contínuo.
  // ⚠️ "lead" é o discriminador mais forte que existe (o João falando COM a pessoa
  // nunca a chama de "lead") — mas o corpus achou DUAS falas legítimas que citam a
  // palavra, e elas viram exceção em RE_META_EXCECAO, não pattern mais frouxo.
  // Mexeu aqui → revalide contra o corpus (query no CLAUDE.md) ANTES de subir.
  /\bleads?\b/i,
  /\btentativas?\s+de\s+contorno\b/i,
  /\bpresente\s+d[ao]\s+(?:escola|biblioteca)\b/i,
  /\bsem\s+link\s+de\s+reuni[ãa]o\b/i,
  // nome de ferramenta e chamada crua ("pausa_ia({"motivo": …})") — o modelo
  // escreveu a tool como TEXTO em vez de emitir o bloco tool_use.
  /\b(?:consulta_objecoes|consulta_disponibilidade|consulta_pos_disponiveis|envia_informacoes|pausa_ia|agendar_reuniao|agendar_retorno|atualizar_dados_lead|verificar_compatibilidade_curso)\b/i,
  /^\w+\(\s*\{/,
  // "atendimento" é o nome INTERNO do card; o João falando com a pessoa diz "vou
  // pausar por aqui" / "vou encerrar por aqui" (dezenas de casos legítimos), nunca
  // "vou pausar o atendimento". 2 casamentos no corpus, ambos relatório.
  /^vou\s+(?:pausar|encerrar|finalizar)\s+(?:o\s+)?atendimento\b/i,
  // CLASSIFICAR a mensagem que chegou ("Essa é uma resposta automática do
  // WhatsApp Business", "Ainda é a mesma resposta automática, então mantenho:")
  // é análise, não conversa. ⚠️ Exige a forma COPULATIVA (demonstrativo + é/foi/
  // parece + "resposta automática"): sem isso pega o PEDIDO DE DESCULPA legítimo
  // por um disparo torto ("essa mensagem automática deve ter subido sem querer",
  // "isso foi só uma mensagem automática que passou torta por aqui"), em que o
  // adjetivo vem colado no substantivo, antes de qualquer cópula.
  /^(?:essa|esse|esta|este|isso|ainda|a\s+mensagem|a\s+resposta)\b[^.!?]{0,40}\b(?:é|foi|era|parece(?:\s+ser)?)\b[^.!?]{0,30}\b(?:resposta|mensagem)s?\s+autom[áa]tic/i,

  // ── RESÍDUO MEDIDO NO HARNESS (50 rodadas do cenário Carolina, 2026-08-12) ──
  // Com as famílias acima no ar, 2 de 50 rodadas AINDA entregaram bastidor — a
  // narração sem nenhuma das palavras internas ("lead", "contorno", "presente"):
  //   "Não vou insistir mais, respeito e sigo o roteiro de despedida com o presente."
  //   "Vou reconhecer a dificuldade dele com respeito e não forçar mais, sem agendar."
  // O que sobrou é o modelo falando do PRÓPRIO ROTEIRO e do lead na 3ª pessoa por
  // PRONOME (dele/dela) em vez do substantivo. Validado no corpus de 45 dias: os
  // quatro padrões somam 6 casamentos, TODOS relatório, zero falso positivo.
  // ⚠️ "não VOU insistir mais" fica de fora de propósito — é fala legítima e comum
  // na despedida; o que denuncia bastidor é o "devo/posso" (o modelo comentando a
  // regra que recebeu), não a intenção.
  /\b(?:sigo|seguir|segue)\s+o\s+roteiro\b/i,
  /\broteiro\s+de\s+despedida\b/i,
  /^vou\s+(?:reconhecer|acolher|respeitar|encerrar|seguir|manter|evitar|for[çc]ar|deixar)\b[^.!?]*\bd(?:ele|ela)\b/i,
  /\bsem\s+agendar\b/i,
  /\bn[ãa]o\s+(?:devo|posso)\s+insistir\b/i,
];

// Só valem quando a frase NÃO fala com o lead em 2ª pessoa: "não uma mensagem real
// da Alice" é relatório; "vou aguardar sua resposta real por aqui" é fala legítima
// (2 casos no corpus, ambos com "seu/sua"). Mesma lógica para o encerramento
// narrado na 3ª pessoa ("respeitando a posição dela").
const RE_META_SE_3A_PESSOA: RegExp[] = [
  /\b(?:mensagem|resposta)s?\s+(?:real|reais|leg[íi]tima)\b/i,
  /\brespeitando\s+a\s+(?:posi[çc][ãa]o|decis[ãa]o)\s+d(?:ele|ela)\b/i,
];

const RE_2A_PESSOA = /\b(?:voc[êe]|vc|seu|sua|seus|suas|te|ti|contigo)\b/i;

// Fugas validadas no corpus: as ÚNICAS frases lead-facing que citam "lead".
// Sem elas, `\bleads?\b` engoliria a regra de elegibilidade e a abertura de
// campanha — que são a mensagem inteira, não um detalhe dela.
const RE_META_EXCECAO: RegExp[] = [
  /\b(?:exige|exigem|pede|pedem)\s+que\s+o\s+lead\b/i,
  /\blista\s+de\s+leads\b/i,
];

// Grão do detector: LINHA quebrada em FRASES. O modelo cola a narração de bastidor
// no fim de um parágrafo que começa lead-facing ("Carolina, …objeção. Vou encerrar
// …"), então cortar por linha deixava tudo passar OU derrubava a fala legítima
// junto. Por frase, sai só o que é relatório.
export function trechosDe(texto: string): string[] {
  return (texto ?? '')
    .split('\n')
    .flatMap((linha) => linha.split(/(?<=[.!?])\s+/))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const trechoEhMeta = (trecho: string): boolean => {
  const t = trecho.trim();
  if (!t) return false;
  if (RE_META_EXCECAO.some((re) => re.test(t))) return false;
  if (RE_META.some((re) => re.test(t))) return true;
  return !RE_2A_PESSOA.test(t) && RE_META_SE_3A_PESSOA.some((re) => re.test(t));
};

export function contemMeta(texto: string): boolean {
  return trechosDe(texto).some(trechoEhMeta);
}

// Remove o TRECHO que é relatório (grão do removerRaciocinioVazado): na maioria
// dos casos reais a mensagem é inteiramente meta, então sobra vazio e o
// enviarResposta cai no silêncio. Quando o relatório vem junto de uma despedida
// de verdade, só o relatório sai e a despedida segue pro lead.
// ⚠️ O grão é a FRASE, não a linha (caso Carolina 2026-08-12): a narração vinha
// colada no mesmo parágrafo da fala, e cortar por linha era tudo-ou-nada.
export function removerLinhasMeta(texto: string): string {
  if (!contemMeta(texto)) return texto ?? '';
  return (texto ?? '')
    .split('\n')
    .map((linha) =>
      linha
        .split(/(?<=[.!?])\s+/)
        .filter((frase) => !trechoEhMeta(frase))
        .join(' ')
        .trim()
    )
    .filter((linha) => linha.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Garantia em código da regra de ouro de humanização do prompt ("antes de
// enviar, remova qualquer ! e qualquer travessão"): o modelo vaza de vez em
// quando, então a régua é aplicada aqui, onde nenhum balão escapa.
//   — / – / " - " (pontuação)  → vírgula (ou ponto no fim da frase)
//   !                          → ponto
// Hífen DENTRO de palavra (pós-graduação, segunda-feira) é preservado.
export function humanizarTexto(texto: string): string {
  let t = removerRaciocinioVazado(texto);
  t = removerLinhasMeta(t);
  t = t.replace(/\s*[—–]\s*/g, ', ');        // travessão tipográfico vira vírgula
  t = t.replace(/(^|\s)-(\s|$)/gm, '$1, ');  // hífen solto usado como travessão
  t = t.replace(/([?])!+/g, '$1');           // "?!" vira só "?"
  t = t.replace(/!+/g, '.');                 // exclamação nunca chega ao lead
  t = t.replace(/,\s*([.,;:?])/g, '$1');     // ", ." acidental → "."
  t = t.replace(/\.{2,}/g, '.');             // ".." acidental
  t = t.replace(/,\s*$/gm, '.');             // vírgula pendurada no fim da linha
  t = t.replace(/[ \t]+([,.;:?])/g, '$1');   // espaço antes de pontuação ("aí ," → "aí,")
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t.trim();
}

// ── CONFIRMAÇÃO DE REUNIÃO VAI EM UM BALÃO SÓ (2026-07-27, caso Fran Lopes) ──
// O dribble roda em BACKGROUND (EdgeRuntime.waitUntil) e o supervisor do edge
// runtime mata o isolate no meio da espera: 7-14% das respostas saem truncadas.
// Quando isso pega a confirmação do agendamento, o lead recebe "Horário reservado
// pra você:" e MAIS NADA — a data, o monitor e o LINK DO MEET ficam nos balões
// 2-4 que nunca saem (Fran Lopes 26/07: 1 de 4 balões; ela só recebeu o link 13h
// depois, na mão de uma atendente; 5 casos em 7 dias). A mensagem com link de
// reunião é a mais cara do fluxo inteiro, então ela NÃO é fracionada: um balão só
// não tem "entre balões", logo não há janela em que o worker possa morrer.
// ⚠️ A guarda vive aqui, dentro do fracionador, para valer também no follow-up e
// no webchat (que importam esta função direto). Não resolve o truncamento geral —
// esse é estrutural (tirar o dribble do background / enfileirar os chunks).
// ⚠️ Desde 2026-08-05 a mesma guarda cobre o PRESENTE DA ESCOLA (a biblioteca gratuita
// mandada na despedida de quem encerra sem reunião): é a ÚLTIMA mensagem daquele lead, e
// o link vem no fim dela — exatamente a posição que o truncamento come. Sem balão único,
// o presente viraria "tranquilo, agradeço sua preferência" e mais nada.
const RE_LINK_REUNIAO = /https?:\/\/(?:meet\.google\.com|[\w.-]*\bzoom\.us|teams\.(?:live|microsoft)\.com)\/\S+/i;
const RE_LINK_ESCOLA = /escoladeespecializacao\.ppgvet\.com\.br/i;

export function contemLinkReuniao(texto: string): boolean {
  return RE_LINK_REUNIAO.test(texto ?? '');
}

/** Link que não pode se perder num balão truncado ⇒ a mensagem vai inteira, num balão só. */
export function contemLinkCritico(texto: string): boolean {
  return contemLinkReuniao(texto) || RE_LINK_ESCOLA.test(texto ?? '');
}

export async function fracionarResposta(texto: string): Promise<string[]> {
  if (contemLinkCritico(texto)) return [texto];
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-2024-07-18',
        messages: [
          { role: 'system', content: CHUNKING_SYSTEM },
          { role: 'user', content: JSON.stringify(texto) },
        ],
        response_format: { type: 'json_schema', json_schema: CHUNKING_SCHEMA },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const parsed = JSON.parse(json.choices[0].message.content);
    const chunks = (parsed.chunks ?? [])
      .sort((a: any, b: any) => a.sequence_number - b.sequence_number)
      .map((c: any) => String(c.message ?? '').trim())
      .filter((c: string) => c.length > 0);
    return chunks.length ? chunks : [texto];
  } catch (e) {
    console.log(`[crm-agente-sdr] chunking falhou, enviando balão único: ${(e as Error).message}`);
    return [texto];
  }
}

// Port do "Calcula Delay": 45 wpm (0.75 palavra/s), variação ±20%, 2 a 6s.
// ⚠️ O teto caiu de 12s para 6s em 2026-07-25. O dribble roda em BACKGROUND
// (EdgeRuntime.waitUntil) e o supervisor do edge runtime mata o isolate sob carga
// ("CPU time hard limit reached" / "early termination"): quanto mais tempo o loop
// passa dormindo, maior a chance de a resposta sair pela METADE. Medido no dia:
// 56 de 408 rodadas (13,7%) truncadas em 6h, 85 balões perdidos — o lead recebia
// só o primeiro balão e a conversa "travava". Mexer aqui é o botão mais barato:
// 3 balões passaram de ~36s de exposição para ~12s.
export function calcularDelaySegundos(mensagem: string): number {
  const palavras = mensagem.split(/\s+/).filter((w) => w.length > 0).length;
  let delay = palavras / 0.75;
  const variacao = (Math.random() * 0.4) - 0.2;
  delay = delay * (1 + variacao);
  delay = Math.max(2, Math.min(delay, 6));
  return Math.round(delay * 10) / 10;
}

async function enviarChunk(ctx: CtxConversa, conteudo: string): Promise<{ ok: boolean; status: number; erro?: string }> {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone: ctx.telefone,
      tipo: 'text',
      conteudo,
      wa_account_id: ctx.waAccountId,
      lead_id: ctx.leadId,
      oportunidade_id: ctx.oportunidadeId,
    }),
  });
  if (!res.ok) {
    const corpo = await res.text();
    console.error(`[crm-agente-sdr] crm-whatsapp-send HTTP ${res.status}: ${corpo}`);
    return { ok: false, status: res.status, erro: `HTTP ${res.status}: ${corpo.slice(0, 500)}` };
  }
  return { ok: true, status: res.status };
}

// Envia a resposta completa: fraciona, espera o "tempo de digitação" e manda.
// `pausada` (opcional): rechecagem FRESCA da pausa da IA — os chunks pingam ao longo
// de 2-12s CADA, então entre um balão e outro o atendente pode ter pausado a IA. Antes
// de cada envio relê o flag e ABORTA os chunks restantes (a pausa precisa valer "em voo").
export async function enviarResposta(
  ctx: CtxConversa,
  texto: string,
  renovarLock: () => Promise<void>,
  tel?: { registrar: (tipo: string, dados?: Record<string, unknown>, duracaoMs?: number, erro?: string) => void },
  pausada?: () => Promise<boolean>,
): Promise<void> {
  const textoLimpo = humanizarTexto(texto);
  const raciocinioRemovido = RE_TAG_RACIOCINIO.test(texto);
  const metaRemovida = contemMeta(texto);
  // Nada sobrou pro lead: ou era só raciocínio (<thinking> truncado por
  // max_tokens), ou era só relatório ao sistema ("sem nova mensagem do lead").
  // Silêncio é melhor que vazar — a rodada fica registrada no Debug do Agente.
  if (!textoLimpo) {
    tel?.registrar(metaRemovida && !raciocinioRemovido ? 'meta_descartada' : 'raciocinio_removido', {
      restou_vazio: true,
      original: texto.length > 600 ? texto.slice(0, 600) + '…' : texto,
    });
    return;
  }
  const chunks = await fracionarResposta(textoLimpo);
  tel?.registrar('resposta_chunks', {
    total: chunks.length,
    sanitizado: textoLimpo !== texto,
    raciocinio_removido: raciocinioRemovido || undefined,
    meta_removida: metaRemovida || undefined,
    // balão único proposital (link crítico: reunião ou presente da Escola) — não
    // confundir com chunking que falhou, que também devolve 1 chunk
    balao_unico_link_reuniao: contemLinkReuniao(textoLimpo) || undefined,
    balao_unico_link_escola: (!contemLinkReuniao(textoLimpo) && contemLinkCritico(textoLimpo)) || undefined,
  });
  let enviados = 0;
  let primeiro = true;
  for (const chunk of chunks) {
    // ⚠️ O "tempo de digitação" vale ENTRE os balões, NUNCA antes do primeiro: o lead
    // já esperou o debounce + a geração do LLM, então essa espera extra só atrasava a
    // resposta e alargava a janela em que o supervisor pode matar o worker — deixando
    // a conversa muda depois de UM balão (caso 2026-07-25). O 1º balão sai na hora.
    const delay = primeiro ? 0 : calcularDelaySegundos(chunk);
    primeiro = false;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
    // Pausou durante o "tempo de digitação"? Não manda este nem os próximos balões.
    if (pausada && (await pausada())) {
      tel?.registrar('envio_abortado_pausa', {
        onde: 'entre_chunks',
        enviados,
        abortados: chunks.length - enviados,
      });
      break;
    }
    const env = await enviarChunk(ctx, chunk);
    if (env.ok) enviados++;
    tel?.registrar(
      'chunk_enviado',
      { texto: chunk.length > 300 ? chunk.slice(0, 300) + '…' : chunk, delay_s: delay, ok: env.ok, status: env.status },
      undefined,
      env.ok ? undefined : env.erro,
    );
    await renovarLock(); // rodada longa não pode perder o lock pro TTL
  }
}

// ── Guarda de HORÁRIO INVENTADO (2026-07-23, caso Marcello) ─────────────────
// Regra de ouro nº 2 em CÓDIGO: horário específico OFERECIDO ao lead precisa
// ter aparecido antes na conversa (retorno de consulta_disponibilidade, fala
// do próprio lead ou turno anterior). O Sonnet 5 violou a regra do prompt em
// resposta-reflexo sem thinking ("15h, 16h ou 17h30 funcionam pra vc?" sem
// NENHUMA consulta — 15h e 16h já tinham passado). Só age em mensagem com
// cara de OFERTA (contém '?'), pra não falso-positivar confirmações/infos.
const RE_HORA = /\b(\d{1,2})(?::(\d{2})|h(\d{2})?)\b/gi;

function extrairHorarios(texto: string): Set<string> {
  const out = new Set<string>();
  for (const m of texto.matchAll(RE_HORA)) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2] ?? m[3] ?? '0', 10);
    if (h > 23 || min > 59) continue;
    out.add(`${h}:${String(min).padStart(2, '0')}`);
  }
  return out;
}

// Texto "conhecido" da conversa: falas, tool_use/tool_result — NUNCA thinking
// (a signature é base64 e conteria "12h" por acaso, poluindo o conjunto).
export function conversaTexto(messages: { role: string; content: unknown }[]): string {
  const partes: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { partes.push(m.content); continue; }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Record<string, unknown>[]) {
      if (b?.type === 'text' && typeof b.text === 'string') partes.push(b.text);
      else if (b?.type === 'tool_result') partes.push(JSON.stringify(b.content ?? ''));
      else if (b?.type === 'tool_use') partes.push(JSON.stringify(b.input ?? ''));
    }
  }
  return partes.join('\n');
}

// Horários que a resposta OFERECE mas que não existem em lugar nenhum da
// conversa ⇒ inventados. Durações não são oferta ("2h de antecedência", "24h").
export function horariosInventados(resposta: string, conversa: string): string[] {
  if (!resposta.includes('?')) return [];
  const semDuracao = resposta
    .replace(/\b\d{1,2}h\s+de\s+anteced\w*/gi, '')
    .replace(/\b(24|48)h\b/gi, '');
  const oferecidos = extrairHorarios(semDuracao);
  if (!oferecidos.size) return [];
  const conhecidos = extrairHorarios(conversa);
  return [...oferecidos].filter((h) => !conhecidos.has(h));
}
