// A pendência pertence ao INBOUND consumido, não à posição do último balão.
// Em 04/09/2026, B chegava durante a resposta de A e era esquecida porque o último
// registro virava outbound. A reserva e a publicação agora são atômicas no banco.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type { responderWebchat, WebchatToolChamada } from "./agente.ts";

export type ClienteRodada = Pick<SupabaseClient, "from" | "rpc">;
export type SessaoDaRodada = {
  nome: string | null;
  telefone: string | null;
  curso: string | null;
  estagio: "validacao" | "qualificador" | null;
  lead_id: string | null;
  produto: string | null;
  modo_teste: boolean;
};
type Mensagem = { id: number; direcao: string; conteudo: string | null };
type JanelaDaRodada = {
  ultimo_inbound_id: number;
  ultimo_mensagem_id: number;
  cursor_anterior: number;
};
export type PublicacaoDaRodada = {
  status: string;
  mensagens?: { id: number; conteudo: string; criado_em: string }[];
  ha_pendencia?: boolean;
};
export type ResultadoDaRodada = PublicacaoDaRodada & {
  tools: WebchatToolChamada[];
  estagio: "validacao" | "qualificador";
  erro: string | null;
};

export async function carregarHistoricoRecente(
  supabase: ClienteRodada,
  sessaoId: string,
  janela: JanelaDaRodada,
) {
  const { data, error } = await supabase.from("webchat_mensagens")
    .select("id, direcao, conteudo")
    .eq("sessao_id", sessaoId)
    .lte("id", janela.ultimo_mensagem_id)
    .order("id", { ascending: false })
    .limit(40);
  if (error) throw new Error(`Histórico do Webchat: ${error.message}`);
  // A janela de 40 é só do contexto antigo. Não podemos consumir 60 inbounds tendo
  // mostrado apenas os últimos 40 ao modelo. PostgREST limita 1000 linhas sem erro,
  // então pendências são buscadas à parte e paginadas até completar o teto reservado.
  const pendentes: Mensagem[] = [];
  const tamanhoPagina = 1000;
  for (let inicio = 0; ; inicio += tamanhoPagina) {
    const { data: pagina, error: erroPendentes } = await supabase.from("webchat_mensagens")
      .select("id, direcao, conteudo")
      .eq("sessao_id", sessaoId)
      .eq("direcao", "inbound")
      .gt("id", janela.cursor_anterior)
      .lte("id", janela.ultimo_inbound_id)
      .order("id", { ascending: true })
      .range(inicio, inicio + tamanhoPagina - 1);
    if (erroPendentes) throw new Error(`Pendências do Webchat: ${erroPendentes.message}`);
    pendentes.push(...((pagina ?? []) as Mensagem[]));
    if (!pagina || pagina.length < tamanhoPagina) break;
  }

  // A, B, resposta de A: B chegou durante a geração. A fotografia inclui a resposta
  // já publicada, mas B continua sendo a pergunta atual. Sem reposicionar só os
  // inbounds pendentes, o modelo vê uma conversa encerrada em assistant ou repete A.
  const idsPendentes = new Set(pendentes.map((m) => m.id));
  const anteriores = ((data ?? []) as Mensagem[]).slice().reverse()
    .filter((m) => !idsPendentes.has(m.id));
  return [...anteriores, ...pendentes].map((m) => ({
    role: (m.direcao === "inbound" ? "user" : "assistant") as "user" | "assistant",
    text: String(m.conteudo ?? ""),
  })).filter((m) => m.text);
}

export async function processarRodadaWebchat(
  supabase: ClienteRodada,
  sessaoId: string,
  sessao: SessaoDaRodada,
  responder: typeof responderWebchat,
): Promise<ResultadoDaRodada> {
  const token = crypto.randomUUID();
  const { data: reserva, error: erroReserva } = await supabase.rpc("webchat_ia_reservar", {
    p_sessao_id: sessaoId, p_token: token,
  });
  if (erroReserva) throw new Error(`Reserva do Webchat: ${erroReserva.message}`);
  const estagioSalvo = sessao.estagio === "qualificador" ? "qualificador" : "validacao";
  if (reserva?.status !== "reservado") {
    return { status: reserva?.status ?? "reserva_invalida", tools: [], estagio: estagioSalvo, erro: null };
  }

  try {
    let resposta: Awaited<ReturnType<typeof responderWebchat>>;
    let erro: string | null = null;
    try {
      const historico = await carregarHistoricoRecente(supabase, sessaoId, reserva);
      resposta = await responder(
        sessao.nome ?? "", sessao.telefone ?? "", sessao.curso, historico,
        estagioSalvo, sessao.lead_id, sessao.produto === "escola" ? "escola" : "pos",
        sessao.modo_teste, sessaoId,
      );
    } catch (e) {
      erro = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      resposta = {
        chunks: ["Desculpa, tive um problema aqui e não consegui responder. Pode mandar de novo? 🙏"],
        tools: [], estagio: estagioSalvo,
      };
    }

    // O commit confere token, validade da reserva e humano/bloqueio NOVAMENTE.
    // Todos os balões e o cursor avançam juntos; falha SQL não queima o inbound.
    try {
      const { data, error } = await supabase.rpc("webchat_ia_publicar", {
        p_sessao_id: sessaoId,
        p_token: token,
        p_ultimo_inbound_id: reserva.ultimo_inbound_id,
        p_chunks: resposta.chunks,
        p_estagio: resposta.estagio,
        p_tools: resposta.tools,
        p_erro: erro,
      });
      if (error) throw new Error(`Publicação do Webchat: ${error.message}`);
      return {
        ...(data as PublicacaoDaRodada),
        tools: resposta.tools, estagio: resposta.estagio, erro,
      };
    } catch (e) {
      // O envio externo pode ter dado certo antes do erro ao publicar os balões.
      // Preservar tools permite semear a continuidade desse envio, sem confundi-lo
      // com nova tentativa. O cursor permanece pendente para retomada pelo widget.
      const erroPublicacao = e instanceof Error ? e.message : String(e);
      return {
        status: "falha_publicacao", ha_pendencia: true,
        tools: resposta.tools, estagio: resposta.estagio,
        erro: [erro, erroPublicacao].filter(Boolean).join("; ").slice(0, 500),
      };
    }
  } finally {
    // Só o dono libera: uma execução antiga nunca apaga a reserva de outra.
    try {
      const { error } = await supabase.rpc("webchat_ia_liberar", { p_sessao_id: sessaoId, p_token: token });
      if (error) console.error(`[crm-webchat] liberar reserva: ${error.message}`);
    } catch (e) {
      console.error("[crm-webchat] liberar reserva:", e instanceof Error ? e.message : String(e));
    }
  }
}
