// O "pensar" de UMA rodada do direct: o que a pessoa mandou → classificador → roteiro →
// balões e estado seguinte. Sem banco e sem Instagram: quem lê e grava é o chamador.
//
// Dois chamadores, de propósito o MESMO código:
//   • index.ts (produção) — lê ig_mensagens/ig_conversa_ia, envia pela API do Instagram;
//   • ig-agente-simular (harness) — roda um roteiro de conversa em memória, com o
//     classificador REAL. Se o harness tivesse o próprio loop, ele passaria a provar outra
//     coisa que não a produção (foi o que escondeu o caso Matheus no harness do João).
import { classificar, type ResultadoClassificacao } from "./classificador.ts";
import { CLASSIFICACAO_NEUTRA, decidirPasso, etapaCrmInstagram, type EtapaFluxo, type Passo } from "./fluxo.ts";
import { type LinhaIg, montarHistoricoIg, soMidiaSemTexto, type TurnoHistorico } from "./historico.ts";
import { dividirPorBytes } from "../_shared/igMensageria.ts";

/** O que ig_conversa_ia guarda do roteiro (e o simulador guarda em memória). */
export type EstadoRoteiro = {
  etapa: EtapaFluxo;
  tentativas: number;
  situacao: string | null;
  area: string | null;
  dataFormacao: string | null;
  telefone: string | null;
};

export const ESTADO_INICIAL: EstadoRoteiro = {
  etapa: "boas_vindas",
  tentativas: 0,
  situacao: null,
  area: null,
  dataFormacao: null,
  telefone: null,
};

/** O que a fase 2 faria ao capturar o WhatsApp (hoje só registrado — ver index.ts). */
export type PlanoWhatsapp = {
  simulado: true;
  situacao: string | null;
  data_formacao: string | null;
  etapa_crm: string;
};

export type ResultadoRodada = ResultadoClassificacao & {
  passo: Passo;
  /** O que sai no direct, já quebrado no limite de bytes da Meta. */
  baloes: string[];
  estadoDepois: EstadoRoteiro;
  whatsapp: PlanoWhatsapp | null;
  /** A IA escolheu não responder (e o modelo nem foi chamado): o motivo. */
  calada?: "midia_sem_texto";
};

function instante(v: string | null | undefined): number {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Separa a conversa em "o que já foi respondido" e "o que esta rodada responde": as
 * mensagens da pessoa depois do corte (última resposta da IA ou /reset).
 */
export function separarNovas(
  linhas: LinhaIg[],
  respondidoAte: string | null | undefined,
  historicoDesde: string | null | undefined,
): { historico: TurnoHistorico[]; novas: string[]; semFala: boolean } {
  const corte = Math.max(instante(respondidoAte), instante(historicoDesde));
  const ehNova = (l: LinhaIg) => l.direcao === "inbound" && instante(l.created_at) > corte;
  const linhasNovas = linhas.filter(ehNova);
  return {
    historico: montarHistoricoIg(linhas.filter((l) => !ehNova(l))),
    novas: montarHistoricoIg(linhasNovas).map((t) => t.text),
    semFala: soMidiaSemTexto(linhasNovas),
  };
}

export function planoWhatsapp(passo: Passo, antes: EstadoRoteiro): PlanoWhatsapp {
  const situacao = passo.situacao ?? antes.situacao;
  const dataFormacao = passo.dataFormacao ?? antes.dataFormacao;
  return { simulado: true, situacao, data_formacao: dataFormacao, etapa_crm: etapaCrmInstagram(situacao, dataFormacao) };
}

/** O estado depois do passo — o mesmo que index.ts grava em ig_conversa_ia. */
export function estadoDepois(antes: EstadoRoteiro, passo: Passo): EstadoRoteiro {
  return {
    etapa: passo.proximaEtapa,
    tentativas: passo.tentativas,
    situacao: passo.situacao ?? antes.situacao,
    area: passo.area ?? antes.area,
    dataFormacao: passo.dataFormacao ?? antes.dataFormacao,
    telefone: passo.telefone ?? antes.telefone,
  };
}

export async function pensarRodada(entrada: {
  estado: EstadoRoteiro;
  historico: TurnoHistorico[];
  novas: string[];
  nomePerfil: string | null;
  /** Link do WhatsApp do recibo; sem ele, o do número padrão. */
  linkWhatsapp?: string;
  /** A leva só tem mídia sem texto (`separarNovas`). */
  semFala?: boolean;
}): Promise<ResultadoRodada> {
  const { estado, historico, novas } = entrada;
  // Mídia sem texto no meio do roteiro não é resposta (12/11/2026): a IA fica calada, a
  // etapa e as tentativas ficam como estão e o modelo nem é chamado. Antes, cada reel
  // gastava uma tentativa da pergunta de formação e a pessoa recebia "Você não possui
  // graduação?" por ter compartilhado um vídeo. Na ABERTURA (boas_vindas) a IA segue
  // puxando a conversa: ali não há pergunta pendente para a mídia "não responder".
  if (entrada.semFala && estado.etapa !== "boas_vindas") {
    const passo: Passo = { mensagens: [], proximaEtapa: estado.etapa, tentativas: estado.tentativas };
    return {
      classificacao: CLASSIFICACAO_NEUTRA,
      erro: null,
      modelo: null,
      passo,
      baloes: [],
      estadoDepois: estadoDepois(estado, passo),
      whatsapp: null,
      calada: "midia_sem_texto",
    };
  }
  const resultado = await classificar(estado.etapa, historico, novas);
  const passo = decidirPasso(estado.etapa, resultado.classificacao, {
    nomePerfil: entrada.nomePerfil,
    textoNovo: novas.join("\n"),
    tentativas: estado.tentativas,
    situacaoSalva: estado.situacao,
    areaSalva: estado.area,
    dataSalva: estado.dataFormacao,
    linkWhatsapp: entrada.linkWhatsapp,
  });
  return {
    ...resultado,
    passo,
    baloes: passo.mensagens.flatMap((m) => dividirPorBytes(m)),
    estadoDepois: estadoDepois(estado, passo),
    whatsapp: passo.enviarWhatsapp ? planoWhatsapp(passo, estado) : null,
  };
}
