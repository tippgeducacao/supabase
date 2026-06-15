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

// Garantia em código da regra de ouro de humanização do prompt ("antes de
// enviar, remova qualquer ! e qualquer travessão"): o modelo vaza de vez em
// quando, então a régua é aplicada aqui, onde nenhum balão escapa.
//   — / – / " - " (pontuação)  → vírgula (ou ponto no fim da frase)
//   !                          → ponto
// Hífen DENTRO de palavra (pós-graduação, segunda-feira) é preservado.
export function humanizarTexto(texto: string): string {
  let t = texto;
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

async function enviarChunk(ctx: CtxConversa, conteudo: string): Promise<void> {
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
    console.error(`[crm-agente-sdr] crm-whatsapp-send HTTP ${res.status}: ${await res.text()}`);
  }
}

// Envia a resposta completa: fraciona, espera o "tempo de digitação" e manda.
export async function enviarResposta(
  ctx: CtxConversa,
  texto: string,
  renovarLock: () => Promise<void>,
  tel?: { registrar: (tipo: string, dados?: Record<string, unknown>, duracaoMs?: number, erro?: string) => void },
): Promise<void> {
  const textoLimpo = humanizarTexto(texto);
  const chunks = await fracionarResposta(textoLimpo);
  tel?.registrar('resposta_chunks', { total: chunks.length, sanitizado: textoLimpo !== texto });
  for (const chunk of chunks) {
    const delay = calcularDelaySegundos(chunk);
    await new Promise((r) => setTimeout(r, delay * 1000));
    await enviarChunk(ctx, chunk);
    tel?.registrar('chunk_enviado', { texto: chunk.length > 300 ? chunk.slice(0, 300) + '…' : chunk, delay_s: delay });
    await renovarLock(); // rodada longa não pode perder o lock pro TTL
  }
}
