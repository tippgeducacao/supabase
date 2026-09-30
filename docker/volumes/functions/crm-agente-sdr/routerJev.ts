// Router pelo Jev (TypeSafe) — 28/09/2026, só no canário da Luna (o agente na Responses API).
//
// O router decide UMA coisa: o lead já escolheu um horário concreto? No Sonnet isso custava
// ~US$ 0,0066 e ~1,7 s por rodada (o histórico inteiro, ~12k tokens, a cada inbound). O Jev é
// um classificador: devolve a probabilidade de cada opção, não texto, por ~US$ 0,00005 e ~0,4 s.
//
// Modos (crm_agente_sdr_config.router_jev_modo; só vale para quem já está no canário):
//  · off    = o router de sempre, sem chamar o Jev;
//  · sombra = os dois em paralelo; quem decide é o router de sempre, o Jev só é registrado;
//  · ativo  = o Jev decide quando está seguro (p ≥ limiar ou p ≤ 1 − limiar); na dúvida, erro
//             ou sem chave, chama o router de sempre — ele segue sendo a rede de proteção.
// Promover ao qualificador é o erro caro (o ratchet não deixa voltar), por isso o limiar vale
// para os dois lados e o meio do caminho nunca é decidido pelo Jev.
import type { Msg } from './historico.ts';
import { chamarJev, conversaParaJev, corpoJev, PRAZO_JEV_MS, type RespostaJev } from './jev.ts';

export type AgenteRouter = 'agente_validacao' | 'agente_qualificador';
export type ModoRouterJev = 'off' | 'sombra' | 'ativo';
export interface ConfigRouterJev { modo: ModoRouterJev; limiar: number }

/** O que vai para a telemetria (router_decisao.jev). Nunca carrega texto da conversa. */
export interface LeituraJev {
  modo: Exclude<ModoRouterJev, 'off'>;
  limiar: number;
  /** Probabilidade de "horário escolhido" (null = o Jev não respondeu). */
  p: number | null;
  confianca: number | null;
  /** O que o Jev decidiria sozinho com este limiar; 'incerto' = cairia no router de sempre. */
  decisao: AgenteRouter | 'incerto' | 'erro';
  /** true = no modo ativo, o Jev decidiu e o router de sempre nem foi chamado. */
  decidiu_sozinho: boolean;
  modelo: string | null;
  tokens_entrada: number | null;
  ms: number;
  erro?: string;
}

export const LIMIAR_PADRAO = 0.9;
export const JANELA_TURNOS = 16;
export { PRAZO_JEV_MS };

// Mesma régua do PROMPT_ROUTER, reescrita como pergunta + regras. Medido em 28/09/2026 contra
// 30 cenários inventados: 30/30, 90% com p ≥ 0,90; as 4 perguntas sim/não combinadas deram 28/30.
export const PERGUNTA_ROUTER = {
  type: 'choice',
  instructions: {
    pergunta: 'Na conversa entre o SDR e o lead, o lead JÁ escolheu um horário concreto para a reunião (videochamada com o monitor)?',
    regras: [
      "Conta como escolhido: o lead aceitou uma opção específica oferecida pelo SDR ou pelo vendedor (ex.: SDR ofereceu 9h30, 10h ou 10h30 e o lead disse '10h' ou 'pode ser às 9h30').",
      "Conta como escolhido: o próprio lead propôs dia e hora concretos (ex.: 'amanhã às 13h pode ser?'), mesmo que ninguém tenha oferecido.",
      "Não conta: só interesse, período vago ('de tarde', 'amanhã', 'qualquer dia'), hora solta ambígua, negação ('às 13h não posso'), rotina ('trabalho até as 13h') ou citação de uma oferta antiga sem aceite.",
      'A escolha precisa estar valendo: se depois o lead recusou ou pediu outro horário sem fechar um novo, não conta.',
      'Olhe principalmente as mensagens mais recentes.',
    ],
  },
  criteria: {
    horario_escolhido: 'O lead já fechou um horário concreto para a reunião e ele segue valendo.',
    ainda_nao: 'O lead ainda não escolheu um horário concreto (abrindo conversa, tirando dúvida, objeção, vendo opções, período vago, recusou).',
  },
} as const;

/**
 * Histórico JÁ limpo pelo `limparParaRouter` → estado do Jev: `{ conversa: [{de, texto}] }`,
 * só os últimos turnos (o Jev perde precisão com contexto que não importa). A nota de troca
 * de número, que o `comNotaParaRouter` funde na fala do lead, sai do texto e vira campo próprio.
 */
export function estadoParaJev(historicoLimpo: readonly Msg[], opts: { nota?: string | null; janela?: number } = {}) {
  const recorte = conversaParaJev(historicoLimpo, { nota: opts.nota, janela: opts.janela ?? JANELA_TURNOS });
  return {
    conversa: recorte.length ? recorte : [{ de: 'lead', texto: '[início de conversa]' }],
    ...(opts.nota ? { nota_do_sistema: opts.nota } : {}),
  };
}

export function decisaoPorLimiar(p: number, limiar: number): AgenteRouter | 'incerto' {
  if (p >= limiar) return 'agente_qualificador';
  if (p <= 1 - limiar) return 'agente_validacao';
  return 'incerto';
}

/** O pedido do router ao Jev (o agente no n8n faz a chamada com este corpo). */
export function pedidoJevRouter(historicoLimpo: readonly Msg[], nota?: string | null) {
  return corpoJev(estadoParaJev(historicoLimpo, { nota }), { agente: PERGUNTA_ROUTER });
}

/** Resposta do Jev → probabilidade de "horário escolhido". Sem probabilidade = erro. */
export function probabilidadeDoRouter(r: RespostaJev): { p: number; confianca: number | null; modelo: string | null; tokens_entrada: number | null } {
  const resposta = r.answers.agente;
  const p = resposta?.probabilities?.horario_escolhido;
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error('Jev: resposta sem probabilidade');
  return {
    p,
    confianca: typeof resposta?.confidence === 'number' ? resposta.confidence : null,
    modelo: r.modelo,
    tokens_entrada: r.tokens_entrada,
  };
}

export async function perguntarAoJev(
  estado: unknown,
  chave: string,
  fetchFn: typeof fetch = fetch,
  prazoMs = PRAZO_JEV_MS,
): Promise<{ p: number; confianca: number | null; modelo: string | null; tokens_entrada: number | null }> {
  return probabilidadeDoRouter(await chamarJev(estado, { agente: PERGUNTA_ROUTER }, chave, fetchFn, prazoMs));
}

/** A leitura do router pelo Jev (telemetria + decisão), a partir de uma resposta já obtida (agente no n8n). */
export function leituraDoRouter(r: RespostaJev | null, config: ConfigRouterJev, ms: number, erro?: string): LeituraJev {
  const modo = config.modo === 'off' ? 'ativo' : config.modo;
  const { limiar } = config;
  try {
    if (!r) throw new Error(erro ?? 'Jev: sem resposta');
    const x = probabilidadeDoRouter(r);
    const decisao = decisaoPorLimiar(x.p, limiar);
    return { modo, limiar, p: x.p, confianca: x.confianca, decisao,
      decidiu_sozinho: modo === 'ativo' && decisao !== 'incerto', modelo: x.modelo, tokens_entrada: x.tokens_entrada, ms };
  } catch (e) {
    return { modo, limiar, p: null, confianca: null, decisao: 'erro', decidiu_sozinho: false, modelo: null,
      tokens_entrada: null, ms, erro: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/**
 * Decide validação × qualificador com o Jev na frente (ativo) ou ao lado (sombra).
 * Erro do router de sempre PROPAGA, igual a chamar `chamarRouter` direto: quem chama mantém o
 * fallback que já tinha. A leitura do Jev chega por `aoLerJev` mesmo quando o outro falha.
 */
export async function rotearComJev(
  historicoLimpo: readonly Msg[],
  config: ConfigRouterJev | null,
  chamarRouterDeSempre: () => Promise<AgenteRouter>,
  opts: { nota?: string | null; chave?: string; fetchFn?: typeof fetch; aoLerJev?: (l: LeituraJev) => void; prazoMs?: number } = {},
): Promise<AgenteRouter> {
  const chave = opts.chave ?? Deno.env.get('TYPESAFE_API_KEY') ?? '';
  if (!config || config.modo === 'off' || !chave) return chamarRouterDeSempre();
  const { modo, limiar } = config;
  const inicio = Date.now();
  const lerJev = async (): Promise<LeituraJev> => {
    try {
      const r = await perguntarAoJev(estadoParaJev(historicoLimpo, { nota: opts.nota }), chave, opts.fetchFn, opts.prazoMs);
      return { modo, limiar, p: r.p, confianca: r.confianca, decisao: decisaoPorLimiar(r.p, limiar), decidiu_sozinho: false,
        modelo: r.modelo, tokens_entrada: r.tokens_entrada, ms: Date.now() - inicio };
    } catch (e) {
      return { modo, limiar, p: null, confianca: null, decisao: 'erro', decidiu_sozinho: false, modelo: null,
        tokens_entrada: null, ms: Date.now() - inicio, erro: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  };

  if (modo === 'sombra') {
    const leitura = lerJev();
    try {
      return await chamarRouterDeSempre();
    } finally {
      opts.aoLerJev?.(await leitura);
    }
  }

  const leitura = await lerJev();
  if (leitura.decisao === 'agente_validacao' || leitura.decisao === 'agente_qualificador') {
    opts.aoLerJev?.({ ...leitura, decidiu_sozinho: true });
    return leitura.decisao;
  }
  opts.aoLerJev?.(leitura);
  return chamarRouterDeSempre();
}

/** Config do banco. Qualquer falha = 'off' (o router de sempre), nunca uma rodada parada. */
export async function carregarConfigRouterJev(supabase: any): Promise<ConfigRouterJev | null> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('router_jev_modo, router_jev_limiar').eq('id', 1).maybeSingle();
    if (error || !data) return null;
    const modo = data.router_jev_modo;
    if (modo !== 'sombra' && modo !== 'ativo') return null;
    const limiar = Number(data.router_jev_limiar);
    return { modo, limiar: Number.isFinite(limiar) && limiar >= 0.5 && limiar < 1 ? limiar : LIMIAR_PADRAO };
  } catch {
    return null;
  }
}
