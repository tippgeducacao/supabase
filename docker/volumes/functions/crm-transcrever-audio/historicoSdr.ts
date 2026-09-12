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

/**
 * As duas filas de transcrição do sistema têm o MESMO contrato (reivindicar com lease,
 * concluir com a tentativa, falhar com código seguro), então o worker é um só e o que muda é
 * o nome das funções:
 *   SDR   saída HUMANA na linha comercial, para a memória do João (08/09/2026).
 *   ALUNO entrada do aluno na linha do assistente pedagógico (12/09/2026). Fila própria
 *         porque a trigger da fila do SDR APAGA da fila tudo que não é outbound humano.
 */
export type NomesDaFila = { reivindicar: string; concluir: string; falhar: string };
export const FILA_SDR: NomesDaFila = {
  reivindicar: 'crm_sdr_historico_audio_reivindicar',
  concluir: 'crm_sdr_historico_audio_concluir',
  falhar: 'crm_sdr_historico_audio_falhar',
};
export const FILA_ALUNO: NomesDaFila = {
  reivindicar: 'onb_agente_audio_reivindicar',
  concluir: 'onb_agente_audio_concluir',
  falhar: 'onb_agente_audio_falhar',
};

export function acessoWorkerAutorizado(metodo: string, recebido: string | null, segredo: unknown): boolean {
  if (metodo !== "POST" || typeof segredo !== "string" || !segredo || !recebido) return false;
  if (recebido.length !== segredo.length) return false;
  let diferenca = 0;
  for (let i = 0; i < segredo.length; i++) diferenca |= recebido.charCodeAt(i) ^ segredo.charCodeAt(i);
  return diferenca === 0;
}

export type ResumoDaFila = {
  reivindicados: number; concluidos: number; falhas: number; obsoletos: number; erros_registro: number;
};

/** O worker da memória do SDR: a fila do histórico humano, com os nomes dela. */
export function processarHistoricoSdr(deps: {
  rpc: RpcHistorico;
  transcrever: (url: string, mime: string | null) => Promise<string>;
}): Promise<ResumoDaFila> {
  return processarFilaAudio({ ...deps, fila: FILA_SDR });
}

export async function processarFilaAudio(deps: {
  rpc: RpcHistorico;
  transcrever: (url: string, mime: string | null) => Promise<string>;
  fila: NomesDaFila;
}): Promise<ResumoDaFila> {
  const claim = await deps.rpc(deps.fila.reivindicar, { p_limite: 3 });
  if (claim.error) throw new ErroTranscricao("FALHA_REIVINDICAR");
  if (!Array.isArray(claim.data)) throw new ErroTranscricao("LOTE_INVALIDO");

  // O cron espera a conclusão no self-hosted. Não há waitUntil nem chamada ao agente e nem
  // envio de mensagem: este worker só grava texto. Quem decide responder é o agente, no turno
  // dele, lendo a transcrição de onde ela foi gravada.
  const resultados = await Promise.allSettled((claim.data as TrabalhoAudio[]).map(async (trabalho) => {
    try {
      const cache = typeof trabalho.transcricao_cache === "string" ? trabalho.transcricao_cache.trim() : "";
      const transcricao = cache || (await deps.transcrever(trabalho.audio_url, trabalho.mime_type)).trim();
      if (!transcricao) throw new ErroTranscricao("TRANSCRICAO_VAZIA");
      const conclusao = await deps.rpc(deps.fila.concluir, {
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
      const falha = await deps.rpc(deps.fila.falhar, {
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
