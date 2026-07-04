// Tratamento de mídia inbound do agente SDR — port do braço de mídia do n8n:
//   áudio        → transcrição (Gemini 2.5 Pro, inline)         → vira a mensagem
//   imagem/vídeo → análise multimodal estruturada (Gemini Flash) → vira uma mensagem
//                  de "arquivo" separada no histórico + a legenda vira a mensagem
// Diferença consciente do n8n: mídia vai inline (base64) em vez do File API com
// upload resumable + waits — mais simples e suficiente pros tamanhos do WhatsApp.

// deno-lint-ignore-file no-explicit-any
import { GEMINI_ANALISE_SCHEMA, GEMINI_ANALISE_SYSTEM } from './prompts.ts';
import { resumir, type Telemetria } from './eventos.ts';

const GEMINI_KEY = Deno.env.get('AGENTE_SDR_GEMINI_KEY') ?? Deno.env.get('GEMINI_API_KEY') ?? '';
// Alias oficial "lite mais recente" (quota própria, maior que a do flash cheio —
// o 429 do caso Danilo 2026-07-03 estourou a quota do gemini-2.5-flash mesmo com
// 5 retries). Alias em vez de ID fixo: ID errado = 404 em TODA transcrição.
const MODELO_TRANSCRICAO = 'gemini-flash-lite-latest';
const MODELO_ANALISE = 'gemini-flash-latest';

export type MensagemTratada = {
  mensagem: string;     // o que entra no acúmulo/concatenação (texto, transcrição ou legenda)
  arquivo?: string;     // descrição estruturada do arquivo (vira mensagem própria no histórico)
};

async function gemini(model: string, body: Record<string, unknown>, tentativas = 5): Promise<any> {
  let ultimoErro = '';
  for (let t = 1; t <= tentativas; t++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (res.ok) return await res.json();
    ultimoErro = `HTTP ${res.status}: ${await res.text()}`;
    if (t < tentativas) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Gemini ${model}: ${ultimoErro}`);
}

async function baixarBase64(url: string): Promise<{ b64: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download da mídia falhou: HTTP ${res.status}`);
  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return { b64: btoa(bin), mime };
}

function urlAnexo(payload: any): { url: string; mime: string } | null {
  const a = payload?.anexos?.[0];
  const url = a?.url ?? a?.publicUrl ?? a?.link ?? null;
  if (!url) return null;
  return { url, mime: a?.mime_type ?? payload?.mime_type ?? 'application/octet-stream' };
}

async function transcreverAudio(payload: any, tel?: Telemetria): Promise<string> {
  const anexo = urlAnexo(payload);
  if (!anexo) {
    tel?.registrar('transcricao', { ok: false, motivo: 'áudio sem anexo disponível' });
    return payload.conteudo || '[áudio sem anexo disponível]';
  }
  // Nó de endpoint: registra acerto/erro da transcrição (Gemini) com o corpo do
  // erro — é aqui que aparece, p.ex., "API key expired". Mantém o throw original
  // (em erro o áudio segue sendo descartado pelo catch do processarInbound).
  const t0 = Date.now();
  try {
    const { b64, mime } = await baixarBase64(anexo.url);
    const resp = await gemini(MODELO_TRANSCRICAO, {
      contents: [{
        parts: [
          { text: 'Transcreva esse audio.' },
          { inlineData: { mimeType: anexo.mime || mime, data: b64 } },
        ],
      }],
    });
    const texto = resp.candidates?.[0]?.content?.parts?.[0]?.text ?? '[transcrição indisponível]';
    tel?.registrar('transcricao', {
      ok: true, modelo: MODELO_TRANSCRICAO, mime: anexo.mime || mime, texto: resumir(texto, 1500),
    }, Date.now() - t0);
    return texto;
  } catch (e) {
    tel?.registrar('transcricao',
      { ok: false, modelo: MODELO_TRANSCRICAO, mime: anexo.mime },
      Date.now() - t0, (e as Error).message);
    throw e;
  }
}

// Port do "Processa e Formata Arquivo": análise Gemini → descrição legível.
function formatarAnalise(analysis: any, messageType: string, legendaTexto: string): string {
  let descricaoArquivo = `[📎 ARQUIVO RECEBIDO: ${messageType.toUpperCase()}]\n\n`;

  if (analysis.resumo_conteudo) {
    descricaoArquivo += `📋 ${analysis.resumo_conteudo}\n\n`;
  }

  const textoExtraido = analysis.conteudo_texto_audio?.transcricao_audio ||
    analysis.conteudo_texto_audio?.texto_visivel_ocr || '';
  if (textoExtraido.length > 0) {
    descricaoArquivo += `📄 TEXTO DETECTADO:\n${textoExtraido.substring(0, 400)}`;
    if (textoExtraido.length > 400) descricaoArquivo += `\n... (texto truncado)`;
    descricaoArquivo += `\n\n`;
  }

  const dados = analysis.dados_chave_extraidos || {};
  if (dados.nomes_proprios?.length) descricaoArquivo += `👤 Nomes: ${dados.nomes_proprios.join(', ')}\n`;
  if (dados.datas?.length) descricaoArquivo += `📅 Datas: ${dados.datas.join(', ')}\n`;
  if (dados.valores_monetarios?.length) descricaoArquivo += `💰 Valores: ${dados.valores_monetarios.join(', ')}\n`;
  if (dados.telefones_emails?.length) descricaoArquivo += `📧 Contatos: ${dados.telefones_emails.join(', ')}\n`;

  descricaoArquivo += `\n[FIM DO ARQUIVO]`;

  const isUrl = legendaTexto.startsWith('http');
  return (legendaTexto && legendaTexto.trim() !== '' && !isUrl)
    ? `${legendaTexto}\n\n${descricaoArquivo}`
    : descricaoArquivo;
}

async function analisarArquivo(payload: any, tel?: Telemetria): Promise<string> {
  const anexo = urlAnexo(payload);
  const legenda = payload.conteudo && !String(payload.conteudo).startsWith('[') ? String(payload.conteudo) : '';
  if (!anexo) {
    tel?.registrar('analise_midia', { ok: false, tipo: payload.tipo, motivo: 'sem anexo' });
    return formatarAnalise({ resumo_conteudo: 'Não foi possível analisar o arquivo.' }, payload.tipo, legenda);
  }

  const t0 = Date.now();
  try {
    const { b64, mime } = await baixarBase64(anexo.url);
    const resp = await gemini(MODELO_ANALISE, {
      system_instruction: { parts: [{ text: GEMINI_ANALISE_SYSTEM }] },
      contents: [{ parts: [{ inlineData: { mimeType: anexo.mime || mime, data: b64 } }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_ANALISE_SCHEMA,
      },
    }, 3);

    let analysis: any;
    try {
      const texto = resp.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      analysis = JSON.parse(texto.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch {
      analysis = { resumo_conteudo: 'Erro na análise do arquivo.' };
    }
    tel?.registrar('analise_midia', {
      ok: true, modelo: MODELO_ANALISE, tipo: payload.tipo, resumo: resumir(analysis?.resumo_conteudo ?? '', 800),
    }, Date.now() - t0);
    return formatarAnalise(analysis, payload.tipo, legenda);
  } catch (e) {
    tel?.registrar('analise_midia',
      { ok: false, modelo: MODELO_ANALISE, tipo: payload.tipo },
      Date.now() - t0, (e as Error).message);
    console.log(`[crm-agente-sdr] análise de arquivo falhou: ${(e as Error).message}`);
    return formatarAnalise({ resumo_conteudo: 'Não foi possível analisar o arquivo.' }, payload.tipo, legenda);
  }
}

// Trata UMA mensagem do gateway antes de entrar no buffer (port do "Roteador de
// Mensagens" + braços de tratamento).
export async function prepararMensagem(payload: any, tel?: Telemetria): Promise<MensagemTratada> {
  const tipo = payload.tipo;

  if (tipo === 'audio') {
    return { mensagem: await transcreverAudio(payload, tel) };
  }

  if (tipo === 'image' || tipo === 'video') {
    const arquivo = await analisarArquivo(payload, tel);
    // No n8n a "mensagem" do buffer era a linha de legenda (ou espaço quando sem legenda).
    const mensagem = payload.conteudo && !String(payload.conteudo).startsWith('[')
      ? `Legenda do arquivo: ${payload.conteudo}`
      : `Legenda do arquivo: Veja o arquivo que enviei`;
    return { mensagem, arquivo };
  }

  // texto (e qualquer tipo não roteado cai como texto, ex.: document)
  return { mensagem: String(payload.conteudo ?? '') };
}
