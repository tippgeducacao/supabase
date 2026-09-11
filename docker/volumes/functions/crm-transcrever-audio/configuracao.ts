import { type ConfigGemini, MODELO_GEMINI_TRANSCRICAO } from './gemini.ts';

// A tela Configuração IA é a fonte preferencial; ambiente atende instalações
// legadas ou indisponibilidade temporária do banco. Não imprime a credencial.
export async function resolverGemini(
  banco: { from: (tabela: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  env: (nome: string) => string | undefined,
): Promise<ConfigGemini | null> {
  if (env('CRM_AUDIO_GEMINI_FALLBACK') === 'false') return null;
  let chave = '';
  try {
    const r = await banco.from('ai_api_keys').select('api_key').eq('provider', 'google').eq('is_active', true)
      .order('created_at', { ascending: false }).limit(1).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (!r.error && typeof r.data?.api_key === 'string') chave = r.data.api_key.trim();
  } catch { /* usa configuração de ambiente abaixo */ }
  chave ||= env('AGENTE_SDR_GEMINI_KEY') || env('GOOGLE_API_KEY') || env('GEMINI_API_KEY') || '';
  return chave ? { chave, modelo: env('GEMINI_TRANSCRIBE_MODEL') || MODELO_GEMINI_TRANSCRICAO } : null;
}
