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

// Garantia em código da regra de ouro de humanização do prompt ("antes de
// enviar, remova qualquer ! e qualquer travessão"): o modelo vaza de vez em
// quando, então a régua é aplicada aqui, onde nenhum balão escapa.
//   — / – / " - " (pontuação)  → vírgula (ou ponto no fim da frase)
//   !                          → ponto
// Hífen DENTRO de palavra (pós-graduação, segunda-feira) é preservado.
export function humanizarTexto(texto: string): string {
  let t = removerRaciocinioVazado(texto);
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

export async function fracionarResposta(texto: string): Promise<string[]> {
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

// Port do "Calcula Delay": 45 wpm (0.75 palavra/s), variação ±20%, 2 a 12s.
export function calcularDelaySegundos(mensagem: string): number {
  const palavras = mensagem.split(/\s+/).filter((w) => w.length > 0).length;
  let delay = palavras / 0.75;
  const variacao = (Math.random() * 0.4) - 0.2;
  delay = delay * (1 + variacao);
  delay = Math.max(2, Math.min(delay, 12));
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
  // Só raciocínio, sem resposta ao lead (ex.: <thinking> truncado por max_tokens):
  // silêncio é melhor que vazar o pensamento — a rodada fica registrada no Debug.
  if (!textoLimpo) {
    tel?.registrar('raciocinio_removido', {
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
  });
  let enviados = 0;
  for (const chunk of chunks) {
    const delay = calcularDelaySegundos(chunk);
    await new Promise((r) => setTimeout(r, delay * 1000));
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
