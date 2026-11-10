// Que arquivo do nosso storage a Biblioteca Didática pode receber por link assinado (10/11/2026).
//
// A biblioteca (outro sistema) aponta para o link público do bucket `gt-doc-assets`, que é
// privado desde 30/10/2026. A edge `biblioteca-arquivo` troca esse link por um assinado, mas
// só para o que foi MANDADO à biblioteca. O resto do bucket (TCC, CEUA, anexos de tarefa,
// lista de presença) continua fechado.
//
// Sem import por URL: carrega no vitest.

export const BUCKET_BIBLIOTECA = "gt-doc-assets";

/**
 * - "carga": pasta das cargas do Drive, feita só para a biblioteca (Cannabis, livros
 *   didáticos, GCC...). Sai sem mais conferência.
 * - "anexo": anexo de aula. Só sai se existir em `ped_aula_anexos` COM `biblioteca_tag`
 *   (é o que a fila entrega; anexo sem tag nunca foi para a biblioteca).
 * - null: fora da biblioteca, recusado.
 *
 * Recebe o caminho já validado por `objetoDoStorage` (sem `..`, sem barra inicial).
 */
export type OrigemArquivoBiblioteca = "carga" | "anexo" | null;

export function origemDoArquivo(bucket: string, caminho: string): OrigemArquivoBiblioteca {
  if (bucket !== BUCKET_BIBLIOTECA) return null;
  if (caminho.startsWith("pedagogico-biblioteca/") && caminho.length > "pedagogico-biblioteca/".length) {
    return "carga";
  }
  if (caminho.startsWith("pedagogico-aulas/") && caminho.length > "pedagogico-aulas/".length) {
    return "anexo";
  }
  return null;
}
