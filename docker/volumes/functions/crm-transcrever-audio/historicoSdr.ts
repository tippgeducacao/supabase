import { codigoErroSeguro, ErroTranscricao } from "./transcricao.ts";

export type TrabalhoAudio = {
  mensagem_id: string;
  tentativa: number;
  audio_url: string;
  mime_type: string | null;
  transcricao_cache: string | null;
};

export type RpcHistorico = (
  nome: string,
  parametros: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

export function acessoWorkerAutorizado(metodo: string, recebido: string | null, segredo: unknown): boolean {
  if (metodo !== "POST" || typeof segredo !== "string" || !segredo || !recebido) return false;
  if (recebido.length !== segredo.length) return false;
  let diferenca = 0;
  for (let i = 0; i < segredo.length; i++) diferenca |= recebido.charCodeAt(i) ^ segredo.charCodeAt(i);
  return diferenca === 0;
}

export async function processarHistoricoSdr(deps: {
  rpc: RpcHistorico;
  transcrever: (url: string, mime: string | null) => Promise<string>;
}): Promise<{ reivindicados: number; concluidos: number; falhas: number; obsoletos: number; erros_registro: number }> {
  const claim = await deps.rpc("crm_sdr_historico_audio_reivindicar", { p_limite: 3 });
  if (claim.error) throw new ErroTranscricao("FALHA_REIVINDICAR");
  if (!Array.isArray(claim.data)) throw new ErroTranscricao("LOTE_INVALIDO");

  // O cron espera a conclusão no self-hosted. Não há waitUntil nem chamada ao
  // agente/envio: a transcrição só enriquece a memória depois da entrega humana.
  const resultados = await Promise.allSettled((claim.data as TrabalhoAudio[]).map(async (trabalho) => {
    try {
      const cache = typeof trabalho.transcricao_cache === "string" ? trabalho.transcricao_cache.trim() : "";
      const transcricao = cache || (await deps.transcrever(trabalho.audio_url, trabalho.mime_type)).trim();
      if (!transcricao) throw new ErroTranscricao("TRANSCRICAO_VAZIA");
      const conclusao = await deps.rpc("crm_sdr_historico_audio_concluir", {
        p_mensagem_id: trabalho.mensagem_id,
        p_tentativa: trabalho.tentativa,
        p_transcricao: transcricao,
      });
      if (conclusao.error) throw new ErroTranscricao("FALHA_CONCLUIR");
      // O botão manual ou outro lease pode ter terminado primeiro. False é uma
      // conclusão obsoleta, não uma nova falha nem mais uma transcrição concluída.
      if (conclusao.data === false) return "obsoleto";
      if (conclusao.data !== true) throw new ErroTranscricao("FALHA_CONCLUIR");
      return "concluido";
    } catch (erro) {
      const falha = await deps.rpc("crm_sdr_historico_audio_falhar", {
        p_mensagem_id: trabalho.mensagem_id,
        p_tentativa: trabalho.tentativa,
        p_erro: codigoErroSeguro(erro),
      });
      if (falha.error) throw new ErroTranscricao("FALHA_REGISTRAR_ERRO");
      if (falha.data === false) return "obsoleto";
      if (falha.data !== true) throw new ErroTranscricao("FALHA_REGISTRAR_ERRO");
      return "falhou";
    }
  }));
  return {
    reivindicados: claim.data.length,
    concluidos: resultados.filter((r) => r.status === "fulfilled" && r.value === "concluido").length,
    falhas: resultados.filter((r) => r.status === "fulfilled" && r.value === "falhou").length,
    obsoletos: resultados.filter((r) => r.status === "fulfilled" && r.value === "obsoleto").length,
    erros_registro: resultados.filter((r) => r.status === "rejected").length,
  };
}
