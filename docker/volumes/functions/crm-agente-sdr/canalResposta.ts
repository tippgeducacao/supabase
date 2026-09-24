// 14/09/2026: texto livre do modelo é bastidor, inclusive ao lado de uma tool.
// Só o conteúdo escolhido explicitamente para este canal pode virar conversa.
export const NOME_TOOL_RESPOSTA = 'responder_ao_cliente';

export const INSTRUCAO_CANAL_RESPOSTA = `CANAL OBRIGATÓRIO DE RESPOSTA AO CLIENTE
Publique toda resposta ao cliente exclusivamente pela ferramenta responder_ao_cliente, no campo mensagem.
Todo texto fora dessa ferramenta é interno e NÃO será enviado, mesmo quando pareça uma resposta final.
O campo mensagem contém somente a fala direta ao cliente: nunca raciocínio, análise do histórico, justificativa de ferramentas, classificação de recusa/retenção, notas internas, XML ou comentário sobre instruções.
Chame responder_ao_cliente uma única vez e sozinha, depois de concluir as ferramentas de negócio necessárias e ler seus resultados. Nunca junto de consulta, envio, pausa, arquivamento ou outra ação.
Se uma instrução da persona pedir resposta junto de uma ferramenta de negócio, conclua a ferramenta primeiro; este contrato de canal tem precedência.
Quando nenhuma resposta for necessária, chame responder_ao_cliente com mensagem vazia (""). Não narre o silêncio.`;

export const TOOL_RESPONDER_AO_CLIENTE = {
  name: NOME_TOOL_RESPOSTA,
  description: 'Canal exclusivo para a fala final ao cliente, sem análise interna. Use uma única vez, sem outras ferramentas na mesma resposta. mensagem vazia significa silêncio.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { mensagem: { type: 'string', description: 'Somente a mensagem direta ao cliente, ou string vazia para não responder.' } },
    required: ['mensagem'],
    additionalProperties: false,
  },
} as const;

type Bloco = Record<string, unknown>;
export type RespostaModelo = { content?: unknown; stop_reason?: unknown; model?: unknown; usage?: unknown;
  raciocinio_encadeado?: unknown; raciocinios_reenviados?: unknown };
export type DecisaoCanal =
  | { tipo: 'resposta'; mensagem: string; motivo: 'resposta_validada' | 'silencio_explicito' }
  | { tipo: 'tools'; content: Bloco[]; motivo: 'ferramentas_de_negocio' | 'resposta_concorrente_descartada' }
  | { tipo: 'corrigir' | 'bloquear'; motivo: string };

const ehObjeto = (valor: unknown): valor is Record<string, unknown> =>
  valor !== null && typeof valor === 'object' && !Array.isArray(valor);

// 15-16/09/2026: 21 mensagens a 17 leads saíram com "</mensagem>" no fim (caso Andressa).
// O modelo fecha o parâmetro da tool como se fosse XML e o rótulo vaza dentro do campo.
// A tag nunca é fala ao cliente: sai antes da validação (e de novo na saída, por garantia).
const RE_TAG_CANAL = /<\s*\/?\s*mensagem\b[^<>]*>/gi;
export function limparTagsDoCanal(texto: string): string {
  return texto.replace(RE_TAG_CANAL, '').trim();
}

/** O detector semântico é o mesmo da saída; o protocolo continua testável sem Deno. */
export function avaliarCanalResposta(
  resposta: RespostaModelo,
  contemBastidor: (texto: string) => boolean,
  somenteResposta = false,
  ferramentasDisponiveis: ReadonlySet<string> = new Set(),
): DecisaoCanal {
  // Nem um JSON aparentemente completo torna segura uma geração interrompida.
  if (resposta.stop_reason !== 'tool_use' && resposta.stop_reason !== 'end_turn') {
    return { tipo: 'bloquear', motivo: 'geracao_nao_concluida' };
  }
  if (!Array.isArray(resposta.content) || !resposta.content.every(ehObjeto)) {
    return { tipo: 'corrigir', motivo: 'conteudo_invalido' };
  }
  const blocos = resposta.content as Bloco[];
  const ferramentas = blocos.filter((bloco) => bloco.type === 'tool_use');
  const finais = ferramentas.filter((bloco) => bloco.name === NOME_TOOL_RESPOSTA);
  const negocio = ferramentas.filter((bloco) => bloco.name !== NOME_TOOL_RESPOSTA);
  if (negocio.length) {
    if (somenteResposta) return { tipo: 'bloquear', motivo: 'ferramenta_na_correcao' };
    // Uma tool vista no histórico não ganha autorização para esta chamada. Em
    // especial, tools: [] após encerramento permite somente a resposta local.
    if (negocio.some((tool) => typeof tool.name !== 'string' || !ferramentasDisponiveis.has(tool.name))) {
      return { tipo: 'bloquear', motivo: 'ferramenta_nao_disponivel' };
    }
    if (resposta.stop_reason !== 'tool_use') return { tipo: 'bloquear', motivo: 'ferramenta_fora_de_turno' };
    // Mantém os blocos nativos assinados, necessários ao replay de tool_result,
    // e os ids das tools de negócio. A tool local e todo texto ficam fora do banco.
    // `raciocinio_openai` = o equivalente cifrado da Luna (provedorOpenai.ts).
    return {
      tipo: 'tools',
      content: blocos.filter((bloco) => bloco.type === 'thinking' || bloco.type === 'redacted_thinking'
        || bloco.type === 'raciocinio_openai'
        || (bloco.type === 'tool_use' && bloco.name !== NOME_TOOL_RESPOSTA)),
      motivo: finais.length ? 'resposta_concorrente_descartada' : 'ferramentas_de_negocio',
    };
  }
  if (finais.length !== 1) return {
    tipo: 'corrigir', motivo: finais.length ? 'multiplas_respostas' : 'texto_sem_canal',
  };
  if (resposta.stop_reason !== 'tool_use') return { tipo: 'corrigir', motivo: 'resposta_fora_de_turno' };
  const final = finais[0];
  const input = final.input;
  if (typeof final.id !== 'string' || !final.id.trim() || !ehObjeto(input)
    || Object.keys(input).length !== 1 || typeof input.mensagem !== 'string') {
    return { tipo: 'corrigir', motivo: 'mensagem_invalida' };
  }
  const mensagem = limparTagsDoCanal(input.mensagem);
  if (contemBastidor(mensagem)) return { tipo: 'corrigir', motivo: 'bastidor_no_canal' };
  return { tipo: 'resposta', mensagem, motivo: mensagem ? 'resposta_validada' : 'silencio_explicito' };
}

/** Soma também cache/thinking para a correção não desaparecer do custo observado. */
export function somarUsoModelo(...usos: unknown[]): Record<string, unknown> {
  const total: Record<string, unknown> = {};
  for (const uso of usos) {
    if (!ehObjeto(uso)) continue;
    for (const [chave, valor] of Object.entries(uso)) {
      if (typeof valor === 'number' && Number.isFinite(valor)) {
        total[chave] = (typeof total[chave] === 'number' ? total[chave] as number : 0) + valor;
      } else if (ehObjeto(valor)) total[chave] = somarUsoModelo(total[chave], valor);
    }
  }
  return total;
}

/** Nenhum campo arbitrário da resposta bruta cruza a fronteira para os consumidores. */
export function normalizarRespostaCanal(
  resposta: RespostaModelo,
  decisao: DecisaoCanal,
  motivoCorrecao?: string,
) {
  const paradasConhecidas = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal', 'model_context_window_exceeded'];
  return {
    model: typeof resposta.model === 'string' ? resposta.model : undefined,
    usage: somarUsoModelo(resposta.usage),
    // Só contagem local e flag atravessam; o Map e o item cifrado nunca saem do adaptador.
    ...(resposta.raciocinio_encadeado === true ? {
      raciocinio_encadeado: true,
      raciocinios_reenviados: typeof resposta.raciocinios_reenviados === 'number'
        && Number.isSafeInteger(resposta.raciocinios_reenviados) && resposta.raciocinios_reenviados >= 0
        ? resposta.raciocinios_reenviados : 0,
    } : {}),
    content: decisao.tipo === 'tools' ? decisao.content
      : decisao.tipo === 'resposta' && decisao.mensagem ? [{ type: 'text', text: decisao.mensagem }] : [],
    stop_reason: decisao.tipo === 'tools' ? 'tool_use' : 'end_turn',
    canal_resposta: {
      motivo: decisao.motivo,
      stop_reason_modelo: typeof resposta.stop_reason === 'string' && paradasConhecidas.includes(resposta.stop_reason)
        ? resposta.stop_reason : 'desconhecido',
      ...(motivoCorrecao ? { motivo_correcao: motivoCorrecao } : {}),
    },
  };
}
