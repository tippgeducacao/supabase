// Consulta curta, cache por conteúdo e reserva compartilhada entre isolates.
// Os documentos já foram indexados no piloto: nunca reindexar no caminho do lead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Banco = any;
export type AbordagemSpin = {
  id: string; tema: string; pergunta: string; termos: string[]; abertura: boolean;
  fonte: { aulas: string[]; [campo: string]: unknown }; [campo: string]: unknown;
};
export function normalizarSpin(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
export function vetorValido(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 1024 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v.some(n => n !== 0);
}
export function similaridadeSpin(a: number[], b: number[]): number {
  if (!vetorValido(a) || !vetorValido(b)) return -1;
  return a.reduce((s, v, i) => s + v * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
}
export function decodificarVetorSpin(base64: string): number[] {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  if (bytes.length !== 4096) return [];
  const vista = new DataView(bytes.buffer);
  return Array.from({ length: 1024 }, (_, i) => vista.getFloat32(i * 4, true));
}
export function selecionarSpin(abordagens: AbordagemSpin[], usadas: string[], assunto = '', scores: Record<string, number> = {}) {
  const livres = abordagens.filter(a => a.abertura && !usadas.includes(a.id));
  const texto = normalizarSpin(assunto);
  const temVetor = Object.values(scores).some(n => Number.isFinite(n) && n > 0);
  if (texto) {
    // "matriz" e "matrizes" no mesmo item não valem duas evidências sobre a
    // palavra matrizes. Contar o termo repetido desviava vacinação para manejo.
    const palavras = [...new Set(texto.split(/\s+/).filter(p => p.length > 2))];
    const ranking = livres.map(a => ({ abordagem: a, nota: temVetor ? scores[a.id] ?? -1
      : palavras.filter(p => a.termos.some(t => p.includes(normalizarSpin(t)))).length
        + new Set(a.termos.map(normalizarSpin).filter(t => t.includes(' ') && texto.includes(t))).size
    })).sort((a, b) => b.nota - a.nota);
    if (ranking[0]?.nota > 0) return { abordagem: ranking[0].abordagem, metodo: temVetor ? 'voyage' : 'lexical' };
  }
  return { abordagem: livres[0] ?? null, metodo: livres.length ? 'repertorio_sem_resposta' : 'repertorio_esgotado' };
}
export async function recuperarScoresSpin(
  supabase: Banco, assunto: string, abordagens: AbordagemSpin[],
  deps: { chave?: string; transporte?: typeof fetch } = {},
): Promise<{ scores: Record<string, number>; motivo: string }> {
  const consulta = normalizarSpin(assunto)
    .replace(/\S+@\S+\.\S+/g, '').replace(/\+?[\d ()-]{8,}/g, '').slice(0, 400).trim();
  if (consulta.length < 12) return { scores: {}, motivo: 'sem_assunto_para_busca' };
  const chaveApi = deps.chave ?? (typeof Deno !== 'undefined'
    ? Deno.env.get('AGENTE_SDR_VOYAGE_KEY') ?? Deno.env.get('VOYAGE_API_KEY') ?? '' : '');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('voyage-4-large:1024:' + consulta));
  const chave = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  let vetor: number[] | null = null;
  let motivo = 'cache';
  try {
    const { data, error } = await supabase.from('crm_sdr_spin_voyage_cache').select('vetor,criado_em').eq('chave', chave).maybeSingle();
    if (error) return { scores: {}, motivo: 'cache_indisponivel' };
    if (vetorValido(data?.vetor) && Date.parse(data.criado_em) > Date.now() - 7 * 86400_000) vetor = data.vetor;
    if (!vetor) {
      if (!chaveApi) return { scores: {}, motivo: 'voyage_sem_chave' };
      const reserva = await supabase.rpc('crm_sdr_spin_reservar_voyage');
      if (reserva.error || reserva.data !== true) return { scores: {}, motivo: 'limite_compartilhado' };
      const res = await (deps.transporte ?? fetch)('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + chaveApi, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'voyage-4-large', input: [consulta], input_type: 'query', output_dimension: 1024, truncation: false }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) { await res.body?.cancel(); return { scores: {}, motivo: 'voyage_http_' + res.status }; }
      const json = await res.json();
      if (!vetorValido(json.data?.[0]?.embedding)) return { scores: {}, motivo: 'voyage_vetor_invalido' };
      vetor = json.data[0].embedding;
      motivo = 'voyage';
      // Falha no cache não invalida uma resposta válida do provedor nesta tentativa.
      await supabase.from('crm_sdr_spin_voyage_cache').upsert({ chave, vetor, criado_em: new Date().toISOString() }, { onConflict: 'chave' });
    }
    const { VETORES_SPIN } = await import('./spinVetores.ts');
    return { motivo, scores: Object.fromEntries(abordagens.map(a => [a.id,
      VETORES_SPIN[a.id] ? similaridadeSpin(vetor!, decodificarVetorSpin(VETORES_SPIN[a.id])) : -1])) };
  } catch {
    return { scores: {}, motivo: 'voyage_indisponivel' };
  }
}
