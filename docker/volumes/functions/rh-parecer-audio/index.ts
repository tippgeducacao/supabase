// Transcreve o áudio do parecer da entrevista e escreve um rascunho do parecer.
//
// Chamado pela seção Entrevista da aba Jornada, com o JWT de quem está logado. Recebe o
// caminho de um áudio JÁ enviado ao bucket privado `rh-parecer`, transcreve com Gemini e
// resume com Claude.
//
// ⚠️ As chaves vêm do BANCO (`ai_api_keys`), não do env. As do container são placeholders
// inválidos de 11 e 12 caracteres, e foi isso que matou o `gt-ai-transcribe` e o
// `crm-transcrever-audio` (esse último ainda pede uma OPENAI_API_KEY que não existe aqui).
//
// O texto que sai daqui é RASCUNHO. Quem entrevistou lê e corrige antes de salvar: nenhuma
// decisão sobre uma pessoa sai de um resumo automático que ninguém leu.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const GEMINI_MODEL = 'gemini-2.5-flash';
const CLAUDE_MODEL = 'claude-sonnet-5';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

async function chave(provider: string): Promise<string> {
  const { data } = await admin.from('ai_api_keys').select('api_key').eq('provider', provider).maybeSingle();
  const k = (data?.api_key ?? '').trim();
  if (!k) throw new Error(`sem chave de ${provider} em ai_api_keys`);
  return k;
}

/** Bytes do storage em base64, em pedaços — `btoa` de um arquivo inteiro estoura a pilha. */
function paraBase64(bytes: Uint8Array): string {
  let bin = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    bin += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(bin);
}

async function transcrever(base64: string, mime: string): Promise<string> {
  const key = await chave('google');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text:
              'Transcreva este áudio em português do Brasil, palavra por palavra. É a anotação de ' +
              'quem acabou de entrevistar um candidato a uma vaga. Devolva SÓ a transcrição, sem ' +
              'comentar, sem resumir e sem corrigir o que a pessoa disse.' },
            { inlineData: { mimeType: mime, data: base64 } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 16384,
          // ⚠️ `thinkingBudget: 0` é obrigatório no 2.5-flash. Sem isto ele gasta o
          // orçamento de saída "pensando" e devolve `finishReason: MAX_TOKENS` com ZERO
          // texto: a transcrição volta vazia e parece que o áudio estava mudo.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );
  const j = await res.json();
  if (!res.ok) throw new Error(`gemini ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const cand = j?.candidates?.[0];
  const txt = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
  if (!txt) {
    throw new Error(
      cand?.finishReason === 'MAX_TOKENS'
        ? 'o áudio é longo demais para uma transcrição só; grave em partes'
        : 'não consegui entender o áudio',
    );
  }
  return txt;
}

/**
 * A ficha que o RH preenchia no caderno. O modelo preenche SÓ o que foi dito no áudio; o
 * resto volta nulo e a pessoa completa na tela. Inventar uma nota sobre alguém é pior do
 * que deixar o campo vazio.
 */
const FICHA_VAZIA = {
  comunicacao: null, maturidade: null, ambicao: null, fit: null,
  disponibilidade: null, disponibilidade_obs: null,
  experiencia: null, experiencia_obs: null,
  inicio: null, inicio_obs: null,
  onde_conheceu: null,
  trabalhando: null, trabalhando_obs: null,
  locomocao: null,
  positivos: null, negativos: null,
};

async function preencherFicha(transcricao: string): Promise<Record<string, unknown>> {
  const key = await chave('anthropic');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      thinking: { type: 'disabled' },
      system: [
        'Você preenche a ficha de uma entrevista a partir da anotação falada de quem entrevistou.',
        '',
        'Devolva SÓ um objeto JSON, sem texto antes nem depois, com estas chaves:',
        'comunicacao, maturidade, ambicao, fit: número de 0 a 10 (aceita meio ponto) ou null',
        'disponibilidade, experiencia: "sim" | "nao" | "parcial" | null',
        'inicio: "imediato" | "7dias" | "15dias" | "outro" | null',
        'trabalhando, locomocao: "sim" | "nao" | null',
        'disponibilidade_obs, experiencia_obs, inicio_obs, onde_conheceu, trabalhando_obs,',
        'positivos, negativos: texto curto ou null',
        '',
        'REGRA PRINCIPAL: o que a pessoa NÃO disse volta null. Não deduza nota a partir de',
        'elogio genérico, não chute disponibilidade porque o candidato pareceu animado, não',
        'preencha "onde conheceu" com suposição. Ficha com metade em branco é o resultado',
        'correto de um áudio curto.',
      ].join('\n'),
      messages: [{ role: 'user', content: 'Transcrição do áudio:\n\n' + transcricao }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const txt = (j?.content ?? []).map((b: any) => b?.text ?? '').join('').trim();
  const bruto = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return { ...FICHA_VAZIA, ...JSON.parse(bruto) };
  } catch {
    return { ...FICHA_VAZIA };
  }
}

async function redigirParecer(transcricao: string, candidato: string, area: string): Promise<string> {
  const key = await chave('anthropic');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 900,
      thinking: { type: 'disabled' },
      system:
        'Você organiza a anotação falada de quem acabou de entrevistar um candidato, transformando ' +
        'em um parecer curto que outra pessoa da casa vai ler depois.\n\n' +
        'Regras:\n' +
        '- Use SÓ o que está na transcrição. Não invente qualidade, defeito, experiência nem conclusão.\n' +
        '- Se quem falou não disse algo, não preencha: é melhor faltar do que inventar sobre uma pessoa.\n' +
        '- Escreva em português do Brasil, frases curtas, sem travessão e sem tom de consultoria.\n' +
        '- Não repita "o candidato" a cada frase; use o primeiro nome.\n' +
        '- Formato: um parágrafo de impressão geral, depois "Pontos fortes:" e "Pontos de atenção:" ' +
        'como listas curtas, e por fim "Recomendação:" com o que a pessoa disse que pretende fazer. ' +
        'Se ela não disse o que pretende fazer, escreva "Recomendação: não dita no áudio."\n' +
        '- Nunca escreva nada sobre salário, idade, aparência, religião, estado civil ou filhos, mesmo ' +
        'que apareça na transcrição.',
      messages: [{
        role: 'user',
        content:
          `Candidato: ${candidato}\nÁrea da vaga: ${area}\n\nTranscrição do áudio:\n"""\n${transcricao}\n"""`,
      }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return (j?.content ?? []).map((b: any) => b?.text ?? '').join('').trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'use POST' }, 405);

  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json({ ok: false, error: 'não autenticado' }, 401);
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token !== SERVICE_ROLE) {
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data?.user) return json({ ok: false, error: 'sessão inválida' }, 401);
    }

    const { audio_path, oportunidade_id, candidato = 'o candidato', area = 'não informada' } =
      await req.json().catch(() => ({}));
    if (!audio_path || !oportunidade_id) {
      return json({ ok: false, error: 'audio_path e oportunidade_id são obrigatórios' }, 400);
    }

    const { data: arquivo, error: errDl } = await admin.storage.from('rh-parecer').download(audio_path);
    if (errDl || !arquivo) return json({ ok: false, error: 'não achei o áudio no storage' }, 404);

    const mime = arquivo.type || 'audio/webm';
    const base64 = paraBase64(new Uint8Array(await arquivo.arrayBuffer()));

    const transcricao = await transcrever(base64, mime);

    // Resumo e ficha em paralelo: são duas leituras independentes da mesma transcrição, e
    // uma falhar não pode levar a outra junto.
    const [resumo, ficha] = await Promise.allSettled([
      redigirParecer(transcricao, candidato, area),
      preencherFicha(transcricao),
    ]);
    if (resumo.status === 'rejected') console.error('[rh-parecer-audio] resumo:', resumo.reason);
    if (ficha.status === 'rejected') console.error('[rh-parecer-audio] ficha:', ficha.reason);
    const parecer = resumo.status === 'fulfilled' ? resumo.value : '';
    const fichaOk = ficha.status === 'fulfilled' ? ficha.value : { ...FICHA_VAZIA };

    await admin.rpc('rh_entrevista_guardar_audio', {
      p_oportunidade_id: oportunidade_id,
      p_audio_path: audio_path,
      p_transcricao: transcricao,
    });

    return json({ ok: true, transcricao, parecer, ficha: fichaOk });
  } catch (e) {
    console.error('[rh-parecer-audio]', e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
