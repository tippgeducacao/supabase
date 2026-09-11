export class ErroTranscricao extends Error {
  constructor(public readonly codigo: string) { super(codigo); this.name = 'ErroTranscricao'; }
}
const CODIGOS_SEGUROS = new Set([
  'URL_AUDIO_INVALIDA', 'MIME_AUDIO_INVALIDO', 'AUDIO_MUITO_GRANDE', 'AUDIO_VAZIO',
  'TEMPO_ESGOTADO', 'TRANSCRICAO_VAZIA', 'TRANSCRICAO_FALHOU', 'CHAVE_NAO_CONFIGURADA',
  'FALHA_REIVINDICAR', 'LOTE_INVALIDO', 'FALHA_CONCLUIR', 'FALHA_REGISTRAR_ERRO',
  'WHISPER_TEMPO_ESGOTADO', 'GEMINI_RESPOSTA_INVALIDA', 'GEMINI_RESPOSTA_INCOMPLETA',
  'GEMINI_BLOQUEADO', 'GEMINI_UPLOAD_INVALIDO', 'GEMINI_ARQUIVO_INDISPONIVEL',
]);
// Nunca colocar corpo, URL assinada ou chave de uma dependência na fila ou nos logs.
export function codigoErroSeguro(erro: unknown): string {
  if (erro instanceof ErroTranscricao && (CODIGOS_SEGUROS.has(erro.codigo)
    || /^(DOWNLOAD|WHISPER|GEMINI|GEMINI_UPLOAD|GEMINI_ARQUIVO)_HTTP_[1-5]\d{2}$/.test(erro.codigo))) return erro.codigo;
  return 'TRANSCRICAO_FALHOU';
}
