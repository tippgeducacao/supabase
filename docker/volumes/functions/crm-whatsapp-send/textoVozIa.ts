type OrigemTextoVoz = {
  tipo: unknown;
  origem: unknown;
  conteudo: unknown;
  chamadaServico: boolean;
  enviadoPorId?: string | null;
};

// 22/09/2026: o SDR já conhece o texto que sintetizou. Guardá-lo no MESMO
// registro do áudio associa a fala ao anexo/wamid sem depender da telemetria ou
// retranscrever como se fosse áudio humano. Não é legenda enviada ao provedor.
export function textoVozIaParaPersistir(origem: OrigemTextoVoz): string {
  if (origem.tipo !== 'audio' || origem.origem !== 'ia' || !origem.chamadaServico
    || origem.enviadoPorId || typeof origem.conteudo !== 'string') return '';
  const texto = origem.conteudo;
  const caracteres = Array.from(texto);
  const temControle = caracteres.some((caractere) => {
    const codigo = caractere.charCodeAt(0);
    return (codigo < 32 && codigo !== 9 && codigo !== 10 && codigo !== 13) || codigo === 127;
  });
  // Nunca truncar: um texto parcial deixaria de corresponder ao áudio aprovado.
  // Contagem Unicode igual à preparação da voz, preservando o texto EXATO.
  if (!texto.trim() || caracteres.length > 600 || temControle) return '';
  return texto;
}
