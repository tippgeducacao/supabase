export const CABECALHO_CAPACIDADE_CAMPANHAS = "X-Email-Campanhas-Capacidade";
export const PROTOCOLO_CAMPANHAS_AB = "ab-snapshot-v1";
export interface CapacidadesCampanhasEmail { versao: 1; campanhas_ab: boolean }

/** OPTIONS termina antes da autenticação e do processamento nos dois workers,
 * inclusive nas versões antigas. Nunca sondar o dispatcher com GET ou POST:
 * versões anteriores iniciavam campanhas em qualquer método não OPTIONS. */
export function respostaOpcoesCampanhas(headers: Record<string, string>): Response {
  return new Response("ok", { headers: { ...headers, "Cache-Control": "no-store", [CABECALHO_CAPACIDADE_CAMPANHAS]: PROTOCOLO_CAMPANHAS_AB } });
}

export async function consultarCapacidadesCampanhas(opcoes: {
  url: string; authorization: string; apikey?: string; buscar?: typeof fetch;
}): Promise<CapacidadesCampanhasEmail> {
  const buscar = opcoes.buscar ?? fetch;
  const compativeis = await Promise.all(["email-campaign-dispatcher", "email-send"].map(async nome => {
    try {
      const resposta = await buscar(`${opcoes.url.replace(/\/$/, "")}/functions/v1/${nome}`, {
        method: "OPTIONS", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
        headers: { Authorization: opcoes.authorization, ...(opcoes.apikey ? { apikey: opcoes.apikey } : {}) },
      });
      return resposta.ok && resposta.headers.get(CABECALHO_CAPACIDADE_CAMPANHAS) === PROTOCOLO_CAMPANHAS_AB;
    } catch { return false; }
  }));
  return { versao: 1, campanhas_ab: compativeis.every(Boolean) };
}
