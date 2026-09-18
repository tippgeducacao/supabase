// Guarda da decisão de 18/09/2026: transcrição de áudio é SÓ Gemini, sem reserva.
// Varre o código de todas as edge functions; se o endpoint de áudio da OpenAI, o modelo
// Whisper ou a variável dele reaparecerem em qualquer uma, o `vitest run` falha.
// Comentário histórico citando "Whisper" pelo nome não quebra: o alvo é a chamada.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROIBIDO = /api\.openai\.com\/v1\/audio|audio\/transcriptions|audio\/translations|whisper-1|gpt-4o(-mini)?-transcribe|OPENAI_TRANSCRIBE_MODEL/i;

function arquivosDeCodigo(pasta: string): string[] {
  return fs.readdirSync(pasta, { withFileTypes: true }).flatMap(item => {
    const caminho = path.join(pasta, item.name);
    if (item.isDirectory()) return item.name === 'node_modules' ? [] : arquivosDeCodigo(caminho);
    return /\.(ts|tsx|js|mjs)$/.test(item.name) && !/\.(test|spec)\./.test(item.name) ? [caminho] : [];
  });
}

describe('nenhuma edge function manda áudio para a OpenAI', () => {
  it('não existe chamada ao endpoint de áudio da OpenAI nem ao modelo Whisper', () => {
    const arquivos = arquivosDeCodigo(RAIZ);
    expect(arquivos.length).toBeGreaterThan(100); // a varredura achou mesmo a pasta das functions
    const infratores = arquivos.filter(arquivo => PROIBIDO.test(fs.readFileSync(arquivo, 'utf8')))
      .map(arquivo => path.relative(RAIZ, arquivo).replaceAll('\\', '/'));
    expect(infratores).toEqual([]);
  });
});
