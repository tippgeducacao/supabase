/**
 * A régua da RECONCILIAÇÃO de estado das conversas de e-mail: dado o que o
 * servidor (Gmail ou IMAP) diz que está não lido / favoritado / na caixa de
 * entrada, o que exatamente muda no banco.
 *
 * Mora aqui, fora das edges, pelos mesmos dois motivos do `imap/marcacao.ts`:
 *  1. é lógica pura — dá para testar sem socket, sem Deno e sem falar com o Google;
 *  2. é o pedaço de MAIOR consequência do sync. Um erro de sinal aqui não deixa a
 *     tela feia: marca a caixa inteira como lida e some da frente da pessoa o
 *     e-mail que ela ainda não viu. Um lugar só, com teste em cima.
 */

/** Uma linha de `email_threads` do ponto de vista da reconciliação. */
export interface LinhaThread {
  /** Chave primária da thread no nosso banco — é por ela que o UPDATE vai. */
  id: string;
  /** Como o servidor chama esta conversa (`gmail_thread_id`, ou o próprio id no IMAP). */
  chave: string;
}

export interface DiferencaSinalizador {
  /** Está marcado no banco e o servidor não confirma ⇒ desligar. */
  desmarcar: string[];
  /** O servidor confirma e o banco não tem ⇒ ligar. */
  marcar: string[];
}

/**
 * Diferença entre o que o banco acha e o que o servidor diz, para uma coluna
 * booleana (`nao_lido`, `favoritado`).
 *
 * `marcadasNoBanco` deve conter APENAS as linhas com a coluna já em `true` — é o
 * que mantém o custo proporcional ao que está pendente, e não ao tamanho da caixa.
 *
 * ⚠️ `desmarcar` sai em IDs do banco e `marcar` sai em CHAVES do servidor, e a
 * assimetria é proposital: o que precisa ser ligado o banco ainda não localizou
 * (é justamente o que não está na lista lida), então só a chave do servidor
 * existe para procurá-lo.
 */
export function diferencaDeSinalizador(
  marcadasNoBanco: LinhaThread[],
  verdadeirasNoServidor: Set<string> | Iterable<string>,
): DiferencaSinalizador {
  const verdadeiras = verdadeirasNoServidor instanceof Set
    ? verdadeirasNoServidor
    : new Set(verdadeirasNoServidor);
  const jaMarcadas = new Set((marcadasNoBanco ?? []).map((t) => t.chave));

  return {
    desmarcar: (marcadasNoBanco ?? [])
      .filter((t) => !verdadeiras.has(t.chave))
      .map((t) => t.id),
    marcar: [...verdadeiras].filter((chave) => !jaMarcadas.has(chave)),
  };
}

export interface LinhaArquivavel extends LinhaThread {
  arquivado: boolean;
}

export interface DiferencaArquivadas {
  paraArquivar: string[];
  paraDesarquivar: string[];
}

/**
 * Diferença de `arquivado` contra a caixa de entrada do servidor.
 *
 * Aqui o conjunto verdadeiro é o COMPLEMENTO ("não está na inbox"), então não dá
 * para comparar só o lado marcado como nas outras colunas — é preciso a lista
 * inteira das threads da caixa. É por isso que esta varredura é a cara, e por isso
 * que ela não roda a cada rodada do cron.
 */
export function diferencaDeArquivadas(
  todasAsThreads: LinhaArquivavel[],
  naInboxDoServidor: Set<string> | Iterable<string>,
): DiferencaArquivadas {
  const naInbox = naInboxDoServidor instanceof Set
    ? naInboxDoServidor
    : new Set(naInboxDoServidor);
  const paraArquivar: string[] = [];
  const paraDesarquivar: string[] = [];

  for (const t of todasAsThreads ?? []) {
    const arquivadaNoServidor = !naInbox.has(t.chave);
    if (arquivadaNoServidor === t.arquivado) continue;
    (arquivadaNoServidor ? paraArquivar : paraDesarquivar).push(t.id);
  }
  return { paraArquivar, paraDesarquivar };
}

/** Fatia uma lista em lotes — PostgREST não aceita um `IN` de tamanho ilimitado. */
export function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}
