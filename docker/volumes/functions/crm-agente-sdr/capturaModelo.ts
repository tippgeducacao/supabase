// 06/11/2026: captura opt-in do pedido efetivo, sem cabeçalhos, credenciais ou pensamento privado.
// O corpo canônico permite repetir o ensaio; `enviado` mostra a tradução entregue ao provedor.
export type RegistroModelo = {
  tipo?: 'modelo' | 'ferramenta';
  pedido: Record<string, unknown>;
  enviado: Record<string, unknown>;
  resposta?: Record<string, unknown>;
  provedor: string;
  erro?: string;
  origens?: { system: string[]; ferramentas: string };
};
export type ObservadorModelo = (
  registro: RegistroModelo,
) => Promise<void> | void;

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
  if (!valor || typeof valor !== "object") return valor;
  return Object.fromEntries(
    Object.entries(valor)
      .filter(
        ([k]) =>
          !/^(authorization|x-api-key|api_key|chave|segredo|signature|encrypted_content|reasoning_content)$/i.test(
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
    await observador(semDadosPrivados(registro));
  } catch {
    console.log("[sdr] falha ao guardar captura de diagnóstico");
  }
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
): Promise<ObservadorModelo | undefined> {
  try {
    const { data, error } = await banco
      .from("crm_sdr_laboratorio_config")
      .select("capturar_ate")
      .eq("remotejid", remotejid)
      .maybeSingle();
    if (error || !data || Date.parse(data.capturar_ate) <= Date.now())
      return undefined;
    return async ({ pedido, enviado, resposta, provedor, erro, origens, tipo }) => {
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
          origens: origens ?? null,
        });
      if (falha) throw new Error("captura indisponível");
    };
  } catch {
    return undefined;
  }
}
