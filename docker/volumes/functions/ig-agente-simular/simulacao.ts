// Peças PURAS do harness do Instagram (testáveis sem rede): validar o cenário, rodar a
// conversa turno a turno pelo MESMO pensarRodada da produção e conferir o esperado.
import type { EtapaFluxo } from "../ig-agente/fluxo.ts";
import type { LinhaIg } from "../ig-agente/historico.ts";
import {
  ESTADO_INICIAL,
  type EstadoRoteiro,
  pensarRodada,
  type PlanoWhatsapp,
  type ResultadoRodada,
  separarNovas,
} from "../ig-agente/rodada.ts";

// Cada turno custa uma chamada ao modelo (até ~27 s no pior caso: Luna 15 s + Claude
// 12 s). 8 turnos cabem folgados no tempo de uma requisição; o roteiro inteiro, do
// "tudo bem?" ao WhatsApp, tem 4.
export const MAX_TURNOS = 8;
export const MAX_MENSAGENS_POR_TURNO = 5;
export const MAX_CARACTERES_MENSAGEM = 1_000;
/** A boas-vindas do ManyChat (25/09/2026): chega como eco antes da 1ª resposta da pessoa. */
export const ABERTURA_MANYCHAT = "Oii, tudo bem?";

const ETAPAS: readonly EtapaFluxo[] = [
  "boas_vindas",
  "pergunta_formacao",
  "pergunta_data_formacao",
  "pergunta_interesse",
  "pergunta_whatsapp",
  "escola_enviada",
  "whatsapp_enviado",
  "encerrada",
];

/** O que o cenário promete. Todo campo é opcional; ausente = não confere. */
export type Esperado = {
  /** A etapa DEPOIS de cada turno, na ordem; "*" = qualquer uma. */
  etapas?: string[];
  etapa_final?: EtapaFluxo;
  situacao?: string | null;
  data_formacao?: string | null;
  telefone?: string | null;
  /** Etapa do funil 1.5 INSTAGRAM do plano do WhatsApp; null = não pode capturar. */
  etapa_crm?: string | null;
  /** Trechos que precisam aparecer em alguma fala da IA (sem diferenciar maiúsculas). */
  ia_contem?: string[];
  /** Trechos que NÃO podem aparecer em fala nenhuma da IA. */
  ia_nao_contem?: string[];
  /** Turnos (1, 2…) em que a IA tem de ficar calada. */
  silencio_nos_turnos?: number[];
};

export type Cenario = {
  id: string;
  nomePerfil: string | null;
  abertura: string | null;
  estadoInicial: EstadoRoteiro;
  turnos: string[][];
  esperado: Esperado | null;
};

export type TurnoSimulado = {
  n: number;
  pessoa: string[];
  etapa_antes: EtapaFluxo;
  classificacao: ResultadoRodada["classificacao"];
  modelo: string | null;
  erro_classificador: string | null;
  ia: string[];
  etapa_depois: EtapaFluxo;
  tentativas: number;
  whatsapp: PlanoWhatsapp | null;
  ms: number;
};

export type Veredito = { passou: boolean; falhas: string[] };

export type Simulacao = {
  id: string;
  turnos: TurnoSimulado[];
  final: EstadoRoteiro;
  whatsapp: PlanoWhatsapp | null;
  veredito: Veredito | null;
  ms: number;
};

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function listaDeTextos(v: unknown, campo: string): string[] | { erro: string } {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return { erro: `${campo} deve ser uma lista de textos` };
  return v as string[];
}

export function validarCenario(body: unknown): { cenario: Cenario } | { erro: string } {
  // deno-lint-ignore no-explicit-any
  const b = (body ?? {}) as any;
  if (!Array.isArray(b.turnos) || b.turnos.length === 0) return { erro: "turnos: informe ao menos um turno" };
  if (b.turnos.length > MAX_TURNOS) return { erro: `turnos: no máximo ${MAX_TURNOS}` };

  const turnos: string[][] = [];
  for (const [i, t] of b.turnos.entries()) {
    const msgs = (Array.isArray(t) ? t : [t]).map(texto);
    if (msgs.length === 0 || msgs.length > MAX_MENSAGENS_POR_TURNO || msgs.some((m) => !m)) {
      return { erro: `turnos[${i}]: de 1 a ${MAX_MENSAGENS_POR_TURNO} mensagens, nenhuma vazia` };
    }
    if (msgs.some((m) => m.length > MAX_CARACTERES_MENSAGEM)) {
      return { erro: `turnos[${i}]: mensagem acima de ${MAX_CARACTERES_MENSAGEM} caracteres` };
    }
    turnos.push(msgs);
  }

  // deno-lint-ignore no-explicit-any
  const ini = (b.estado_inicial ?? {}) as any;
  const etapa = ini.etapa ?? ESTADO_INICIAL.etapa;
  if (!ETAPAS.includes(etapa)) return { erro: `estado_inicial.etapa inválida: ${etapa}` };
  const estadoInicial: EstadoRoteiro = {
    etapa,
    tentativas: Number.isInteger(ini.tentativas) && ini.tentativas >= 0 ? ini.tentativas : 0,
    situacao: ini.situacao === "formado" || ini.situacao === "estudante" ? ini.situacao : null,
    area: texto(ini.area) || null,
    dataFormacao: /^\d{4}-\d{2}-\d{2}$/.test(texto(ini.data_formacao)) ? texto(ini.data_formacao) : null,
    telefone: null,
  };

  // deno-lint-ignore no-explicit-any
  const e = b.esperado as any;
  let esperado: Esperado | null = null;
  if (e !== undefined && e !== null) {
    if (typeof e !== "object" || Array.isArray(e)) return { erro: "esperado deve ser um objeto" };
    for (const campo of ["etapas", "ia_contem", "ia_nao_contem"]) {
      const l = listaDeTextos(e[campo], `esperado.${campo}`);
      if ("erro" in l) return l;
    }
    const silencio = e.silencio_nos_turnos;
    if (silencio !== undefined && (!Array.isArray(silencio) || silencio.some((n) => !Number.isInteger(n) || n < 1))) {
      return { erro: "esperado.silencio_nos_turnos deve ser uma lista de números de turno (1, 2…)" };
    }
    esperado = e as Esperado;
  }

  return {
    cenario: {
      id: texto(b.id) || "sem-id",
      nomePerfil: texto(b.nome_perfil) || null,
      abertura: b.abertura === null ? null : texto(b.abertura) || ABERTURA_MANYCHAT,
      estadoInicial,
      turnos,
      esperado,
    },
  };
}

type Pensar = typeof pensarRodada;

/**
 * Roda o cenário turno a turno. O histórico é montado como a produção monta: linhas de
 * ig_mensagens (inbound da pessoa, outbound da IA) e o corte em "respondido até a última
 * mensagem da pessoa" — o `separarNovas` é o mesmo de index.ts.
 */
export async function executarCenario(cenario: Cenario, pensar: Pensar = pensarRodada): Promise<Simulacao> {
  const inicio = Date.now();
  let relogio = inicio - 60 * 60 * 1000;
  const carimbo = () => new Date((relogio += 1_000)).toISOString();

  const linhas: LinhaIg[] = [];
  if (cenario.abertura) linhas.push({ direcao: "outbound", tipo: "text", conteudo: cenario.abertura, created_at: carimbo() });

  let estado = cenario.estadoInicial;
  let respondidoAte: string | null = null;
  let whatsapp: PlanoWhatsapp | null = null;
  const turnos: TurnoSimulado[] = [];

  for (const [i, mensagens] of cenario.turnos.entries()) {
    let ultimoInbound = "";
    for (const m of mensagens) {
      ultimoInbound = carimbo();
      linhas.push({ direcao: "inbound", tipo: "text", conteudo: m, created_at: ultimoInbound });
    }
    const t0 = Date.now();
    const { historico, novas } = separarNovas(linhas, respondidoAte, null);
    const r = await pensar({ estado, historico, novas, nomePerfil: cenario.nomePerfil });
    for (const balao of r.baloes) linhas.push({ direcao: "outbound", tipo: "text", conteudo: balao, created_at: carimbo() });
    respondidoAte = ultimoInbound;
    if (r.whatsapp) whatsapp = r.whatsapp;
    turnos.push({
      n: i + 1,
      pessoa: mensagens,
      etapa_antes: estado.etapa,
      classificacao: r.classificacao,
      modelo: r.modelo,
      erro_classificador: r.erro,
      ia: r.baloes,
      etapa_depois: r.estadoDepois.etapa,
      tentativas: r.estadoDepois.tentativas,
      whatsapp: r.whatsapp,
      ms: Date.now() - t0,
    });
    estado = r.estadoDepois;
  }

  const base = { id: cenario.id, turnos, final: estado, whatsapp, ms: Date.now() - inicio };
  return { ...base, veredito: cenario.esperado ? avaliar(cenario.esperado, base) : null };
}

/** Confere o esperado contra o que aconteceu. Cada divergência vira uma linha legível. */
export function avaliar(
  esperado: Esperado,
  s: Pick<Simulacao, "turnos" | "final" | "whatsapp">,
): Veredito {
  const falhas: string[] = [];
  const mostrar = (v: unknown) => (v === null || v === undefined ? "∅" : JSON.stringify(v));

  if (esperado.etapas) {
    const reais = s.turnos.map((t) => t.etapa_depois);
    const bate = esperado.etapas.length === reais.length &&
      esperado.etapas.every((e, i) => e === "*" || e === reais[i]);
    if (!bate) falhas.push(`etapas: esperado ${esperado.etapas.join(" → ")} | veio ${reais.join(" → ")}`);
  }
  if (esperado.etapa_final !== undefined && esperado.etapa_final !== s.final.etapa) {
    falhas.push(`etapa final: esperado ${esperado.etapa_final} | veio ${s.final.etapa}`);
  }
  const campos: [keyof Esperado, unknown][] = [
    ["situacao", s.final.situacao],
    ["data_formacao", s.final.dataFormacao],
    ["telefone", s.final.telefone],
  ];
  for (const [campo, real] of campos) {
    if (esperado[campo] !== undefined && (esperado[campo] ?? null) !== (real ?? null)) {
      falhas.push(`${campo}: esperado ${mostrar(esperado[campo])} | veio ${mostrar(real)}`);
    }
  }
  if (esperado.etapa_crm !== undefined) {
    const real = s.whatsapp?.etapa_crm ?? null;
    if ((esperado.etapa_crm ?? null) !== real) {
      falhas.push(`etapa do CRM: esperado ${mostrar(esperado.etapa_crm)} | veio ${mostrar(real)}`);
    }
  }
  const falas = s.turnos.flatMap((t) => t.ia).join("\n").toLowerCase();
  for (const trecho of esperado.ia_contem ?? []) {
    if (!falas.includes(trecho.toLowerCase())) falhas.push(`a IA não disse "${trecho}"`);
  }
  for (const trecho of esperado.ia_nao_contem ?? []) {
    if (falas.includes(trecho.toLowerCase())) falhas.push(`a IA disse "${trecho}", que não podia`);
  }
  for (const n of esperado.silencio_nos_turnos ?? []) {
    const t = s.turnos[n - 1];
    if (!t) falhas.push(`silêncio no turno ${n}: o cenário não tem esse turno`);
    else if (t.ia.length) falhas.push(`turno ${n}: a IA devia ficar calada e disse "${t.ia.join(" ⏎ ")}"`);
  }
  return { passou: falhas.length === 0, falhas };
}
