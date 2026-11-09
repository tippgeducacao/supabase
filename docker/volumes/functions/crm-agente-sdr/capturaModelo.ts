// 09/11/2026: pedidos do modelo e ferramentas ficam no histórico automaticamente.
// Webhook e etapas extras continuam opt-in. Sem credenciais ou pensamento privado.
// O corpo canônico permite repetir o ensaio; `enviado` mostra a tradução entregue ao provedor.
export type RegistroModelo = {
  tipo?: 'modelo' | 'ferramenta' | 'entrada' | 'etapa';
  pedido: Record<string, unknown>;
  enviado: Record<string, unknown>;
  resposta?: Record<string, unknown>;
  provedor: string;
  erro?: string;
  origens?: { system?: string[]; ferramentas?: string; mensagens_entrada?: string[] };
};
export type ObservadorModelo = (
  registro: RegistroModelo,
) => Promise<void> | void;

// Diagnóstico não pode segurar uma trava nem atrasar a confirmação de um envio.
// O banco pode continuar concluindo a gravação, mas o atendimento segue após o teto.
async function comPrazoCaptura<T>(operacao: PromiseLike<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve(operacao),
      new Promise<never>((_, rejeitar) => { timer = setTimeout(() => rejeitar(new Error('prazo da captura')), 1500); }),
    ]);
  } finally { clearTimeout(timer!); }
}

export function semDadosPrivados<T>(valor: T): T {
  if (Array.isArray(valor))
    return valor
      .filter(
        (v) =>
          ![
            "thinking",
            "redacted_thinking",
            "reasoning",
            "raciocinio_openai",
          ].includes(v?.type),
      )
      .map(semDadosPrivados) as T;
  // Links de mídia podem carregar credenciais na query. O caminho ainda permite
  // identificar a mídia; o token não pertence a uma captura de diagnóstico.
  if (typeof valor === 'string') {
    // A Meta entrega respostas de Flow como JSON dentro de uma string.
    if (/^\s*[\[{]/.test(valor) && /"(?:flow_token|access_token|authorization|api_key|token)"\s*:/i.test(valor)) {
      try { return JSON.stringify(semDadosPrivados(JSON.parse(valor))) as T; } catch { /* Texto comum. */ }
    }
    return valor.replace(/([?&](?:token|access_token|api_key|apikey|key|secret|signature|sig)=)[^&\s"<>]+/gi, '$1[omitido]') as T;
  }
  if (!valor || typeof valor !== "object") return valor;
  return Object.fromEntries(
    Object.entries(valor)
      .filter(
        ([k]) =>
          !/^(authorization|cookie|set-cookie|x-api-key|x-hub-signature-256|x-ppg-sdr-segredo|api_?key|access_token|refresh_token|token|flow_token|password|secret|chave|segredo|signature|encrypted_content|reasoning_content)$/i.test(
            k,
          ),
      )
      .map(([k, v]) => [k, semDadosPrivados(v)]),
  ) as T;
}

export async function observarSemInterromper(
  observador: ObservadorModelo | undefined,
  registro: RegistroModelo,
) {
  if (!observador) return;
  try {
    await comPrazoCaptura(observador(semDadosPrivados(registro)));
  } catch {
    console.log("[sdr] falha ao guardar captura de diagnóstico");
  }
}

/** Etapas do atendimento usam o mesmo opt-in, sanitização e retenção do pedido. */
export function capturarEtapa(observador: ObservadorModelo | undefined, etapa: string, entrada: Record<string, unknown>, saida: Record<string, unknown>) {
  return observarSemInterromper(observador, { tipo: 'etapa', provedor: 'sistema',
    pedido: entrada, enviado: { etapa }, resposta: saida });
}

type BancoCaptura = {
  from: (tabela: string) => {
    select: (colunas: string) => {
      eq: (
        coluna: string,
        valor: string,
      ) => {
        maybeSingle: () => PromiseLike<{
          data: { capturar_ate: string } | null;
          error?: unknown;
        }>;
      };
    };
    insert: (
      dados: Record<string, unknown>,
    ) => PromiseLike<{ error?: unknown }>;
  };
};
export async function observadorDaRodada(
  banco: BancoCaptura,
  remotejid: string,
  rodadaId: string,
  agente: string,
  mensagensEntrada: string[] = [],
): Promise<ObservadorModelo | undefined> {
  let detalhesAtivos = false;
  try {
    const { data, error } = await comPrazoCaptura(banco
      .from("crm_sdr_laboratorio_config")
      .select("capturar_ate")
      .eq("remotejid", remotejid)
      .maybeSingle());
    detalhesAtivos = !error && !!data && Date.parse(data.capturar_ate) > Date.now();
  } catch {
    // Falha na configuração do diagnóstico não desliga o histórico dos modelos.
  }
  return async ({ pedido, enviado, resposta, provedor, erro, origens, tipo }) => {
      if (!detalhesAtivos && tipo && tipo !== 'modelo' && tipo !== 'ferramenta') return;
      const { error: falha } = await banco
        .from("crm_sdr_laboratorio_capturas")
        .insert({
          remotejid,
          rodada_id: rodadaId,
          agente,
          tipo: tipo ?? 'modelo',
          pedido,
          enviado,
          resposta: resposta ?? null,
          provedor,
          erro: erro ?? null,
          origens: mensagensEntrada.length ? { ...origens, mensagens_entrada: mensagensEntrada } : origens ?? null,
        });
      if (falha) throw new Error("captura indisponível");
  };
}
