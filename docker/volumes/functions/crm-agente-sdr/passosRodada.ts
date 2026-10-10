// Motor da rodada POR PASSOS (30/09/2026) — o loop do agente (NÓ 8 → 11 do index.ts) cortado em
// pedidos independentes, para o agente no n8n desenhar o loop: cada passo recebe o ESTADO da rodada
// (JSON, que o n8n carrega de nó em nó) e devolve a próxima AÇÃO com nome.
//
//   montarVolta      → { chamar_ia, pedido }            o n8n chama a Luna com este pedido
//   lerResposta      → { ferramentas, chamadas }        o n8n executa cada uma (executarFerramenta)
//                    → { corrigir_canal, pedido }       a fala não veio pelo canal: chama a Luna de novo
//                    → { corrigir, pedido, motivo }     trava (horário/valor/reunião), silêncio ou bastidor
//                    → { enviar, tipo, texto }          fala conferida (ou confirmação em código)
//                    → { fim }                          nada a enviar
//   executarFerramenta → { output, efeitos }            uma ferramenta, com o ctx da rodada
//   gravarResultados → { chamar_ia } | { enviar: despedida }
//   enviar           → { fim, enviado }                 acabamentos + WhatsApp
//
// CADA REGRA É A DO rodadaAgente (index.ts), na mesma ordem, com os mesmos textos (regrasDaRodada.ts).
// Enquanto a produção roda no rodadaAgente, mudança de regra lá precisa vir para cá também — até a
// produção passar a usar este motor (docs/Agente SDR — Mapa de execução.md).
// deno-lint-ignore-file no-explicit-any
import type { Telemetria } from './eventos.ts';
import { resumir } from './eventos.ts';
import {
  decisaoDoCanal, montarPedidoPrincipal, pedidoCorrecaoDoCanal, respostaDepoisDaCorrecao, respostaSemModelo,
  chamarAgentePrincipal, type DecisaoCanal, type OpcoesPedidoPrincipal, type ProvedorIA,
} from './agente.ts';
import { normalizarRespostaCanal } from './canalResposta.ts';
import { hidratarRaciocinio, paraPedidoOpenai, paraRespostaAnthropic, registrarRaciocinio, type MemoriaRaciocinio } from './provedorOpenai.ts';
import type { ConjuntoPrompt } from './conjuntoPrompt.ts';
import {
  atualizarLead, avaliarFimDoHistorico, carregarHistorico, comEntradaPendente, gravarMensagem, sanitizarHistorico, type Msg,
} from './historico.ts';
import { type CtxConversa, executarTool, montarToolResults } from './tools.ts';
import { carregarStatusMateriais } from './envioMateriais.ts';
import { aplicarDeclaracaoNaJornada, carregarFicha, declaracaoDeConclusao, marcarPerguntasDaFicha, registrarNaJornada } from './fichaAtendimento.ts';
import { blocoDaLeitura, efeitosDaLeitura, type ConfigLeituraJev, type LeituraLead } from './leituraJev.ts';
import { blocoPerguntasRecentes, falasDoLead } from './perguntasRecentes.ts';
import { alertaFatoSemFonte } from './fatoSemFonte.ts';
import { alertaSaudacao, garantirSaudacao } from './saudacao.ts';
import { INSTRUCAO_AULA_PILOTO } from './contextoAulaPiloto.ts';
import { PRAZO_MODELO_PILOTO_MS, RESPOSTA_MODELO_INDISPONIVEL } from './prazoModelo.ts';
import { AVISO_CONSULTA_REPETIDA, MemoriaDeConsultas } from './consultaRepetida.ts';
import { respostaDoEncerramento, toolConcluida, type Encerramento } from './encerramento.ts';
import { confirmacaoDoResultado, falaEntregaConfirmacao, textoConfirmacaoAgendamento, type ConfirmacaoAgendamento } from './confirmacaoAgendamento.ts';
import { comLinkPedido, comPresenteNaDespedida, jaTemOPresente } from './escolaGratuita.ts';
import { semCertificadoAntesDoFim } from './prompts-aula.ts';
import { conversaTexto, enviarResposta, horariosInventados, humanizarTexto, type ResultadoEnvioResposta } from './saida.ts';
import { enviarComAberturaNumero } from './aberturaTrocaNumero.ts';
import { afirmaReuniaoSemCriar, correcaoDaFala, horariosNaoOfertados, valoresInventados } from './travasDeterministicas.ts';
import {
  CORRECAO_SILENCIO, CORRECAO_VAZIO, ehLevaSoReacao, instrucaoPosPausa, INSTRUCAO_POS_RETORNO, INSTRUCAO_REACAO, RE_RETENCAO,
  semRaciocinioNoTexto, TOOLS_QUE_ENCERRAM, TOOLS_QUE_PAUSAM,
} from './regrasDaRodada.ts';
import { ctxDeJson, ctxParaJson } from './rotasN8n.ts';
import { agendamentoFeito, reunioesAgora, trocarNotaDasReunioes } from './reunioesDoLead.ts';

export const MAX_VOLTAS = 8; // o mesmo MAX_RODADAS_TOOLS do index.ts

/** Tudo o que a rodada precisa lembrar entre um pedido e outro. JSON puro. */
export type EstadoRodada = {
  versao: 1;
  rodadaId: string;
  remotejid: string;
  telefone: string;
  inicioRodada: number;
  conteudo: string;
  msgIdUltimo: string | null;
  registrarFalaAposEnvio: boolean;
  conjuntoPrompt: ConjuntoPrompt;
  ctx: Record<string, unknown>;
  leadAgendado: boolean;
  pedidoPorPalavraChave: 'botao' | 'texto' | null;
  aberturaControlada: boolean;
  aplicarTroca: boolean;
  sinalTroca: any;
  desdeLimpeza: string | null;
  aulaPiloto: boolean;
  aulaDaCampanha: any;
  configLeitura: ConfigLeituraJev | null;
  leitura: LeituraLead | null;
  promptAgente: string;
  tools: any[];
  contextoEfetivo: string;
  agenteEfetivo: string;
  estaNaEscola: boolean;
  // ── o loop ──
  volta: number;
  /** A Luna falhou nesta rodada: o resto dela é no Claude, chamado pelo próprio sistema. */
  usarClaude: boolean;
  respostaOperacional: boolean;
  pausouPorTool: boolean;
  encerrouPorTool: boolean;
  retornoPorFormatura: boolean;
  encerramento: Encerramento | null;
  corrigiuHorario: boolean;
  corrigiuTrava: ('valor' | 'reuniao')[];
  corrigiuVazio: boolean;
  corrigiuSilencio: boolean;
  confirmacaoPendente: ConfirmacaoAgendamento | null;
  consultas: string[];
  avisosDaLeitura: string[];
  ferramentasDaVolta: string[];
  inicioLlm: number;
  raciocinios: [string, unknown][];
  /** Resposta que pediu correção de canal: espera a segunda chamada. */
  canalPendente: { resposta: any; decisao: DecisaoCanal } | null;
  /** A agenda (lida no preparo) tem reunião futura de pé? null = não deu para ler (reunioesDoLead.ts). */
  reuniaoMarcadaNaAgenda: boolean | null;
  /** Reunião criada ou remarcada NESTA rodada (a agenda lida no preparo ainda não a conhece). */
  agendouNestaRodada: boolean;
  /** A nota das reuniões que está dentro de contextoEfetivo (para trocá-la quando a rodada agenda). */
  notaReunioes: string;
};

export type Chamada = { id: string; name: string; input: any };

/**
 * O pedido da volta EM PEDAÇOS, para o n8n mostrar cada um num nó e juntar à vista (montarDasPecas):
 * persona (o prompt da persona), regras (os blocos fixos: memória, fatos, agenda, eventos, ficha, voz,
 * canal), historico (a conversa, já no formato da Responses API), contexto (relógio, materiais, ficha
 * — vão no fim da última mensagem), ferramentas e config (modelo, esforço, limites).
 */
export type PecasDoPedido = {
  persona: string;
  regras: string;
  historico: any[];
  contexto: string[];
  ferramentas: any[];
  config: Record<string, unknown>;
};

export type Saida =
  | { acao: 'chamar_ia' | 'corrigir_canal' | 'corrigir'; estado: EstadoRodada; pecas: PecasDoPedido; motivo?: string; texto_barrado?: string }
  | { acao: 'ferramentas'; estado: EstadoRodada; chamadas: Chamada[] }
  | { acao: 'enviar'; estado: EstadoRodada; tipo: 'fala' | 'despedida' | 'confirmacao'; texto: string; motivo?: string }
  | { acao: 'fim'; estado: EstadoRodada; respondeu: boolean; motivo?: string; enviado?: string };

export type DepsPassos = {
  supabase: any;
  tel: Telemetria;
  /** A Luna da rodada (com a chave), montada pelo sistema; null = a rodada começou no Claude. */
  provedor: ProvedorIA | null;
  iaPausada: () => Promise<boolean>;
  renovar: () => Promise<void>;
};

// ── utilitários do estado ────────────────────────────────────────────────────
function ctxDo(e: EstadoRodada): CtxConversa {
  const ctx = ctxDeJson(e.ctx);
  if (!ctx) throw new Error('estado sem ctx');
  return ctx;
}

/** O histórico da conversa não viaja no estado (é grande e é relido do banco a cada passo). */
function guardarCtx(e: EstadoRodada, ctx: CtxConversa): void {
  const { historicoConversa: _h, ...resto } = ctx;
  e.ctx = ctxParaJson(resto as CtxConversa);
}

function lunaAtiva(e: EstadoRodada, deps: DepsPassos): boolean {
  return !e.usarClaude && deps.provedor?.formato === 'openai';
}

function memoriaDe(e: EstadoRodada, deps: DepsPassos): MemoriaRaciocinio | undefined {
  const p = deps.provedor;
  if (p?.formato !== 'openai' || p.raciocinio !== true) return undefined;
  return new Map(e.raciocinios as [string, any][]);
}

function fracionamento(e: EstadoRodada, deps: DepsPassos, ctx: CtxConversa): 'codigo' | 'modelo' {
  return e.respostaOperacional || (ctx.ficha && lunaAtiva(e, deps)) ? 'codigo' : 'modelo';
}

function fim(deps: DepsPassos, e: EstadoRodada, respondeu: boolean, extra: Record<string, unknown> = {}): Saida {
  deps.tel.registrar('rodada_fim', { voltas_llm: e.volta, respondeu, ...extra }, Date.now() - e.inicioRodada);
  return { acao: 'fim', estado: e, respondeu, ...(typeof extra.motivo === 'string' ? { motivo: extra.motivo } : {}) };
}

async function enviarNoWhatsapp(
  deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa, texto: string, voz?: any,
): Promise<{ texto: string; envio: ResultadoEnvioResposta }> {
  return await enviarComAberturaNumero({
    banco: deps.supabase, telefone: e.telefone, interacaoId: e.rodadaId, texto,
    sinal: e.aberturaControlada && e.aplicarTroca ? e.sinalTroca : null,
    registrar: (tipo, dados) => deps.tel.registrar(tipo, dados),
    enviar: (fala, controle) => enviarResposta(ctx, fala, deps.renovar, deps.tel,
      e.pausouPorTool ? undefined : deps.iaPausada, voz,
      e.aberturaControlada ? 'codigo' : fracionamento(e, deps, ctx), controle),
  });
}

// Confirmação da reunião em código (24/09/2026, confirmacaoAgendamento.ts): mesma do rodadaAgente.
async function enviarConfirmacaoEmCodigo(deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa, motivo: string): Promise<boolean> {
  const pendente = e.confirmacaoPendente;
  e.confirmacaoPendente = null;
  if (!pendente) return false;
  if (!e.pausouPorTool && await deps.iaPausada()) {
    deps.tel.registrar('envio_abortado_pausa', { onde: 'confirmacao_agendamento', motivo: 'IA pausada durante a geração' });
    return false;
  }
  const textoConfirmacao = textoConfirmacaoAgendamento(pendente);
  deps.tel.registrar('confirmacao_agendamento_em_codigo', { motivo, com_link: Boolean(pendente.link) });
  if (!e.aberturaControlada) await gravarMensagem(deps.supabase, e.remotejid, { role: 'assistant', content: textoConfirmacao });
  const enviada = await enviarNoWhatsapp(deps, e, ctx, humanizarTexto(textoConfirmacao));
  if (e.aberturaControlada && enviada.envio.aceitos) {
    await gravarMensagem(deps.supabase, e.remotejid, { role: 'assistant', content: enviada.texto });
  }
  return true;
}

// ── a volta: o que a IA lê ───────────────────────────────────────────────────
type BaseDaVolta = { historico: Msg[]; messages: Msg[]; opts: OpcoesPedidoPrincipal; ficha: any };

/** Monta o pedido da volta SEM efeitos no banco (relido igual para a correção de canal e o Claude de reserva). */
async function baseDaVolta(deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa, primeira: boolean): Promise<BaseDaVolta> {
  const { supabase } = deps;
  const [historico, contextoEntregaMateriais, ficha] = await Promise.all([
    carregarHistorico(supabase, e.remotejid),
    carregarStatusMateriais(supabase, ctx, e.desdeLimpeza),
    ctx.ficha ? carregarFicha(supabase, ctx) : Promise.resolve(null),
  ]);
  let messages = sanitizarHistorico(historico);
  if (primeira && avaliarFimDoHistorico(messages) === 'entrada_antes_da_ultima_fala') messages = comEntradaPendente(messages, e.conteudo);
  ctx.historicoConversa = historico;
  const levaSoReacao = ehLevaSoReacao(e.conteudo);
  const instrucaoEncerramento = e.retornoPorFormatura ? INSTRUCAO_POS_RETORNO : instrucaoPosPausa(e.estaNaEscola);
  const baseFicha = e.aulaPiloto ? `DADOS COLETADOS (não são um roteiro): ${JSON.stringify(ficha?.entrada ?? {})}` : ficha?.texto;
  const opts: OpcoesPedidoPrincipal = {
    promptAgente: e.promptAgente,
    contextoEntregaMateriais,
    contextoFicha: baseFicha
      ? [baseFicha, blocoDaLeitura(e.avisosDaLeitura), blocoPerguntasRecentes(messages), alertaFatoSemFonte(falasDoLead(messages).at(-1)), alertaSaudacao(e.conteudo)]
        .filter(Boolean).join('\n\n')
      : undefined,
    comFicha: Boolean(ficha) || e.aulaPiloto,
    ...(e.aulaPiloto ? { instrucaoFicha: INSTRUCAO_AULA_PILOTO } : {}),
    conjunto: e.conjuntoPrompt,
    contextoTemporal: e.encerrouPorTool
      ? `${e.contextoEfetivo}\n\n${instrucaoEncerramento}`
      : levaSoReacao ? `${e.contextoEfetivo}\n\n${INSTRUCAO_REACAO}` : e.contextoEfetivo,
    messages,
    tools: e.encerrouPorTool || (ctx.ficha && (ctx.compatibilidadeIndisponivel || ctx.perguntaFormacaoPendente)) ? [] : e.tools,
  };
  return { historico, messages, opts, ficha };
}

/** Uma vez por rodada, na 1ª volta: a ficha completada pelo que o lead disse (palavra-chave e Jev). */
async function efeitosDaPrimeiraVolta(deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa): Promise<void> {
  const { supabase, tel } = deps;
  if (!ctx.ficha) return;
  let ficha = await carregarFicha(supabase, ctx);
  if (ficha && !ficha.entrada.jornada.coleta?.graduacao_concluida) {
    const trecho = declaracaoDeConclusao(falasDoLead(await carregarHistorico(supabase, e.remotejid)));
    if (trecho) {
      try {
        await registrarNaJornada(supabase, ctx.telefone, (j) => aplicarDeclaracaoNaJornada(j));
        ficha = (await carregarFicha(supabase, ctx)) ?? ficha;
        tel.registrar('ficha_conclusao_do_historico', { trecho });
      } catch (err) {
        console.error('[crm-agente-sdr] conclusão do histórico na ficha:', (err as Error)?.message ?? err);
      }
    }
  }
  if (e.configLeitura && e.leitura) {
    const leitura = e.leitura;
    const efeitos = efeitosDaLeitura(leitura, e.configLeitura.limiar, ficha?.entrada.jornada ?? {},
      { pedidoMaterial: Boolean(e.pedidoPorPalavraChave) });
    const ativo = e.configLeitura.modo === 'ativo' && Boolean(ficha);
    if (ativo) {
      const coleta = efeitos.coleta as Record<string, unknown>;
      if (Object.keys(coleta).length || efeitos.pedidoMaterial) {
        try {
          const agora = new Date().toISOString();
          await registrarNaJornada(supabase, ctx.telefone, (j) => {
            const atual = (j.coleta ?? {}) as Record<string, unknown>;
            const novos = Object.fromEntries(Object.entries(coleta).filter(([k]) => !String(atual[k] ?? '').trim()));
            return {
              ...j,
              ...(Object.keys(novos).length ? { coleta: { ...j.coleta, ...(novos as typeof j.coleta), atualizado_em: agora } } : {}),
              ...(efeitos.pedidoMaterial ? { cronograma: { ...(j.cronograma ?? {}), pedido_em: agora, pedido_por: 'texto' as const } } : {}),
            };
          });
          ficha = (await carregarFicha(supabase, ctx)) ?? ficha;
        } catch (err) {
          tel.registrar('erro', { onde: 'leitura_jev_jornada' }, undefined, String((err as Error)?.message ?? err));
        }
      }
      if (efeitos.dorFinanceira) ctx.leituraJev = { dorFinanceira: true };
      e.avisosDaLeitura = efeitos.avisos;
    }
    tel.registrar('leitura_jev', {
      ...leitura, modo: e.configLeitura.modo, limiar: e.configLeitura.limiar,
      [ativo ? 'aplicado' : 'faria']: efeitos.aplicado,
      palavra_chave: { pedido_cronograma: e.pedidoPorPalavraChave },
    }, leitura.ms);
  }
  if (ficha) {
    tel.registrar('ficha_atendimento', {
      grupo: ficha.avaliacao.grupo, cadastro: ficha.entrada.cadastro,
      falta: ficha.avaliacao.faltaParaCronograma, libera_cronograma: ficha.avaliacao.liberaCronograma,
      ja_perguntou: ficha.avaliacao.jaPerguntou, coleta: ficha.entrada.jornada.coleta ?? null,
      objecoes: ficha.entrada.jornada.objecoes ?? null, cronograma: ficha.entrada.jornada.cronograma ?? null,
      proximo_passo: ficha.avaliacao.proximoPasso,
    });
  } else {
    tel.registrar('ficha_atendimento', { disponivel: false, motivo: 'leitura falhou; a volta seguiu sem a ficha' });
  }
}

/**
 * Junta os pedaços no pedido da Responses API — o MESMO que o sistema montaria inteiro (teste em
 * passosRodada.test.ts). O nó "Monta o pedido" do n8n roda esta mesma lógica, em JavaScript puro.
 */
export function montarDasPecas(p: PecasDoPedido): Record<string, unknown> {
  const input = structuredClone(p.historico);
  if (p.contexto.length) {
    const partes = p.contexto.map((text) => ({ type: 'input_text', text }));
    const ultimo = input[input.length - 1];
    if (ultimo?.role === 'user' && Array.isArray(ultimo.content)) ultimo.content.push(...partes);
    else input.push({ role: 'user', content: partes });
  }
  return { ...p.config, input, instructions: p.regras ? `${p.persona}\n${p.regras}` : p.persona, ...(p.ferramentas.length ? { tools: p.ferramentas } : {}) };
}

/** Pedido da Responses API montado SEM os blocos de contexto → pedaços (puro; testado contra o pedido inteiro). */
export function pecasDe(pedidoSemContexto: Record<string, any>, contexto: string[], persona: string): PecasDoPedido {
  const { instructions, input, tools, ...config } = pedidoSemContexto;
  const texto = String(instructions ?? '');
  if (texto !== persona && !texto.startsWith(`${persona}\n`)) throw new Error('pedido sem o prompt da persona no começo');
  return { persona, regras: texto.slice(persona.length + 1), historico: input ?? [], contexto, ferramentas: tools ?? [], config };
}

/** O pedido da volta em pedaços (correcaoCanal: o pedido de correção do canal da resposta). */
function pecasDoPedido(deps: DepsPassos, e: EstadoRodada, opts: OpcoesPedidoPrincipal, correcaoCanal = false): PecasDoPedido {
  const { pedido, contexto } = montarPedidoPrincipal({ ...opts, semBlocosDeContexto: true });
  return pecasDe(pedidoOpenaiDe(deps, e, correcaoCanal ? pedidoCorrecaoDoCanal(pedido) : pedido), contexto, opts.promptAgente);
}

function pedidoOpenaiDe(deps: DepsPassos, e: EstadoRodada, pedido: Record<string, any>): Record<string, unknown> {
  const p = deps.provedor;
  if (p?.formato !== 'openai') throw new Error('rodada sem a Luna');
  const memoria = memoriaDe(e, deps);
  return paraPedidoOpenai(memoria ? { ...pedido, messages: hidratarRaciocinio((pedido.messages ?? []) as Msg[], memoria) } : pedido,
    { modelo: p.modelo, esforco: p.esforco, raciocinio: p.raciocinio, memoriaRaciocinio: memoria });
}

/** PASSO · monta a volta: devolve o pedido para a Luna (ou já o resultado, sem modelo / no Claude). */
export async function montarVolta(deps: DepsPassos, e: EstadoRodada): Promise<Saida> {
  const ctx = ctxDo(e);
  if (e.volta >= MAX_VOLTAS) {
    await enviarConfirmacaoEmCodigo(deps, e, ctx, 'limite_de_voltas');
    deps.tel.registrar('erro', { onde: 'loop' }, Date.now() - e.inicioRodada, `limite de ${MAX_VOLTAS} rodadas de tools atingido`);
    guardarCtx(e, ctx);
    return { acao: 'fim', estado: e, respondeu: false, motivo: 'limite_de_voltas' };
  }
  const primeira = e.volta === 0;
  if (primeira) {
    if (ehLevaSoReacao(e.conteudo)) deps.tel.registrar('leva_so_reacao', { conteudo: e.conteudo.slice(0, 40) });
    await efeitosDaPrimeiraVolta(deps, e, ctx);
    const fimHistorico = avaliarFimDoHistorico(sanitizarHistorico(await carregarHistorico(deps.supabase, e.remotejid)));
    if (fimHistorico === 'humano_respondeu') {
      deps.tel.registrar('humano_respondeu_antes', { motivo: 'a última fala do histórico é de um atendente' });
      guardarCtx(e, ctx);
      return fim(deps, e, false, { motivo: 'humano_respondeu_antes' });
    }
    if (fimHistorico === 'entrada_antes_da_ultima_fala') {
      deps.tel.registrar('entrada_reapresentada', { motivo: 'lead escreveu enquanto a fala anterior da IA era gravada' });
    }
  }
  const base = await baseDaVolta(deps, e, ctx, primeira);
  e.volta += 1;
  e.inicioLlm = Date.now();
  const { ferramentasDisponiveis } = montarPedidoPrincipal(base.opts);
  e.ferramentasDaVolta = [...ferramentasDisponiveis];
  deps.tel.registrar('llm_inicio', { volta: e.volta, provedor: lunaAtiva(e, deps) ? 'openai' : 'anthropic' });
  const semModelo = respostaSemModelo(base.opts);
  if (semModelo) return await processarResposta(deps, e, ctx, base, semModelo);
  if (!lunaAtiva(e, deps)) return await processarResposta(deps, e, ctx, base, await chamarClaude(deps, e, ctx, base));
  guardarCtx(e, ctx);
  return { acao: 'chamar_ia', estado: e, pecas: pecasDoPedido(deps, e, base.opts) };
}

/** O Claude de reserva (a Luna falhou nesta rodada); se ele também falhar, a frase operacional. */
async function chamarClaude(deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa, base: BaseDaVolta): Promise<any> {
  try {
    return await chamarAgentePrincipal({ ...base.opts, provedor: null, ...(ctx.ficha ? { prazoModeloMs: PRAZO_MODELO_PILOTO_MS } : {}) });
  } catch (err) {
    if (!ctx.ficha) throw err;
    e.respostaOperacional = true;
    deps.tel.registrar('modelo_indisponivel', { volta: e.volta, resposta_operacional: true });
    return { content: [{ type: 'text', text: RESPOSTA_MODELO_INDISPONIVEL }], stop_reason: 'end_turn',
      origem: 'indisponibilidade_modelo', usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

/**
 * PASSO · lê a resposta da Luna (o JSON cru da Responses API, como o n8n recebeu) ou a falha dela.
 * `correcao`: esta é a resposta ao pedido de correção de canal.
 */
export async function lerResposta(
  deps: DepsPassos, e: EstadoRodada, entrada: { resposta?: any; erro?: string; correcao?: boolean; rascunho?: string[] },
): Promise<Saida> {
  // Pedaço do pedido trocado por um rascunho no n8n (teste sem deploy): fica marcado na telemetria.
  const rascunho = Array.isArray(entrada.rascunho) ? entrada.rascunho.filter((r) => typeof r === 'string') : [];
  const ctx = ctxDo(e);
  const base = await baseDaVolta(deps, e, ctx, e.volta === 1);
  const p = deps.provedor;
  const memoria = memoriaDe(e, deps);
  const traduzir = (bruto: any) => {
    if (memoria) registrarRaciocinio(memoria, bruto);
    const r = paraRespostaAnthropic(bruto, p?.formato === 'openai' ? { raciocinio: p.raciocinio, memoriaRaciocinio: memoria } : undefined);
    if (memoria) e.raciocinios = [...memoria.entries()];
    return r;
  };
  const respostaValida = (bruto: any) => bruto && typeof bruto === 'object' && Array.isArray(bruto.output) && !bruto.error;

  if (entrada.correcao) {
    const pendente = e.canalPendente;
    e.canalPendente = null;
    if (!pendente) throw new Error('correção de canal sem resposta pendente');
    const corrigida = respostaValida(entrada.resposta) ? traduzir(entrada.resposta) : null;
    return await processarResposta(deps, e, ctx, base, respostaDepoisDaCorrecao(pendente.resposta, pendente.decisao, corrigida), rascunho);
  }

  if (!respostaValida(entrada.resposta)) {
    // A Luna falhou (HTTP, prazo, corpo inválido): a MESMA volta é refeita no Claude, e o resto da rodada fica nele.
    const motivo = String(entrada.erro ?? entrada.resposta?.error?.message ?? 'resposta inválida').slice(0, 500);
    deps.tel.registrar('provedor_ia_fallback', { de: 'openai', para: 'anthropic', volta: e.volta, motivo });
    e.usarClaude = true;
    return await processarResposta(deps, e, ctx, base, await chamarClaude(deps, e, ctx, base));
  }

  const resposta = traduzir(entrada.resposta);
  const decisao = decisaoDoCanal(resposta, new Set(e.ferramentasDaVolta));
  if (decisao.tipo === 'corrigir') {
    e.canalPendente = { resposta, decisao };
    deps.tel.registrar('canal_correcao_pedida', { volta: e.volta, motivo: (decisao as { motivo?: string }).motivo ?? null });
    guardarCtx(e, ctx);
    return { acao: 'corrigir_canal', estado: e, pecas: pecasDoPedido(deps, e, base.opts, true),
      motivo: (decisao as { motivo?: string }).motivo };
  }
  return await processarResposta(deps, e, ctx, base, normalizarRespostaCanal(resposta, decisao), rascunho);
}

/** O que a IA respondeu (já no formato interno): telemetria, memória e as checagens da fala. */
async function processarResposta(
  deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa, base: BaseDaVolta, resp: any, rascunho: string[] = [],
): Promise<Saida> {
  const { supabase, tel } = deps;
  const blocosResp = (resp.content ?? []) as any[];
  const iaTexto = blocosResp.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const iaPensamento = blocosResp.filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('\n').trim();
  const iaTools = blocosResp.filter((b) => b.type === 'tool_use').map((b) => ({ nome: b.name, input: resumir(b.input, 600) }));
  tel.registrar('llm_chamada', {
    volta: e.volta,
    provedor: lunaAtiva(e, deps) ? 'openai' : 'anthropic',
    agente: e.agenteEfetivo,
    modelo: resp.model ?? null,
    raciocinio_encadeado: resp.raciocinio_encadeado === true,
    raciocinios_reenviados: resp.raciocinios_reenviados ?? 0,
    stop_reason: resp.stop_reason ?? null,
    canal_resposta: resp.canal_resposta ?? null,
    tokens_entrada: resp.usage?.input_tokens ?? null,
    tokens_saida: resp.usage?.output_tokens ?? null,
    tokens_pensamento: resp.usage?.output_tokens_details?.thinking_tokens ?? null,
    cache_lido: resp.usage?.cache_read_input_tokens ?? null,
    cache_escrito: resp.usage?.cache_creation_input_tokens ?? null,
    blocos: blocosResp.map((b) => b.type),
    pensamento: iaPensamento ? resumir(iaPensamento, 2000) : undefined,
    texto: iaTexto ? resumir(iaTexto, 2000) : undefined,
    tools_decididas: iaTools.length ? iaTools : undefined,
    agente_pelo_n8n: true,
    ...(rascunho.length ? { rascunho_n8n: rascunho } : {}),
  }, Date.now() - e.inicioLlm);
  if (blocosResp.length && (!e.registrarFalaAposEnvio || blocosResp.some((b) => b.type === 'tool_use'))) {
    await gravarMensagem(supabase, e.remotejid, { role: 'assistant', content: semRaciocinioNoTexto(resp.content) });
  }

  // ═══ a IA pediu ferramentas → o n8n executa cada uma (04 Ferramentas) ═══
  const toolUses = blocosResp.filter((b) => b.type === 'tool_use');
  if (toolUses.length) {
    guardarCtx(e, ctx);
    return { acao: 'ferramentas', estado: e, chamadas: toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input })) };
  }

  // ═══ a IA escreveu texto → checagens antes de enviar ═══
  const texto = iaTexto;
  const messages = base.messages;
  const levaSoReacao = ehLevaSoReacao(e.conteudo);
  if (!texto && e.confirmacaoPendente) {
    guardarCtx(e, ctx);
    return { acao: 'enviar', estado: e, tipo: 'confirmacao', texto: '', motivo: 'silencio_apos_agendamento' };
  }
  if (!texto && !e.encerrouPorTool && !levaSoReacao && !e.corrigiuSilencio) {
    e.corrigiuSilencio = true;
    tel.registrar('silencio_indevido_reinstruido', { canal: resp.canal_resposta ?? null, volta: e.volta });
    await gravarMensagem(supabase, e.remotejid, { role: 'user', content: CORRECAO_SILENCIO });
    return await corrigir(deps, e, ctx, 'silencio', '');
  }
  if (!texto) {
    guardarCtx(e, ctx);
    return fim(deps, e, false);
  }
  // Horário que não veio da agenda (canário: conferência estrita, travasDeterministicas.ts).
  const inventados = ctx.ficha ? horariosNaoOfertados(texto, messages) : horariosInventados(texto, conversaTexto(messages));
  if (inventados.length && !e.corrigiuHorario) {
    e.corrigiuHorario = true;
    tel.registrar('horario_inventado', { horarios: inventados, acao: 'reinstruido', texto: resumir(texto, 600) });
    await gravarMensagem(supabase, e.remotejid, {
      role: 'user',
      content: '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada ao lead: ela oferece horário(s) ' +
        `(${inventados.join(', ')}) que não vieram de consulta_disponibilidade nesta conversa — é proibido inventar ` +
        (ctx.ficha ? 'horário.' : 'horário (Regra de ouro nº 2).') + ' O texto barrado foi:\n' +
        `"""\n${resumir(texto, 600)}\n"""\n` +
        'Refaça agora PRESERVANDO todo o conteúdo dele que não é horário — em especial a quebra de objeção, o ' +
        'acolhimento e o argumento que você já tinha construído. A ÚNICA coisa que muda são os horários: rode ' +
        'consulta_disponibilidade e ofereça SÓ o que ela devolver, ou repita a mesma mensagem sem citar horário ' +
        'específico. Não corte a mensagem pra "só perguntar o horário", e não mencione esta correção ao lead.',
    });
    return await corrigir(deps, e, ctx, 'horario_inventado', texto);
  }
  if (inventados.length) {
    tel.registrar('horario_inventado', { horarios: inventados, acao: 'descartado', texto: resumir(texto, 600) });
    return descartar(deps, e, ctx, 'horario_inventado');
  }
  if (ctx.ficha) {
    const valores = valoresInventados(texto, messages);
    const motivoTrava = valores.length ? 'valor' as const
      : afirmaReuniaoSemCriar(texto, messages, e.leadAgendado,
        { marcadaNaAgenda: e.reuniaoMarcadaNaAgenda, agendouNestaRodada: e.agendouNestaRodada }) ? 'reuniao' as const : null;
    if (motivoTrava && !e.corrigiuTrava.includes(motivoTrava)) {
      e.corrigiuTrava.push(motivoTrava);
      tel.registrar('trava_fala', { motivo: motivoTrava, acao: 'reinstruido', valores, texto: resumir(texto, 600) });
      await gravarMensagem(supabase, e.remotejid, { role: 'user', content: correcaoDaFala(motivoTrava, texto, valores.join(', ')) });
      return await corrigir(deps, e, ctx, motivoTrava === 'valor' ? 'valor_inventado' : 'reuniao_sem_criar', texto);
    }
    if (motivoTrava) {
      tel.registrar('trava_fala', { motivo: motivoTrava, acao: 'descartado', valores, texto: resumir(texto, 600) });
      return descartar(deps, e, ctx, motivoTrava);
    }
  }
  if (!humanizarTexto(texto) && !e.corrigiuVazio) {
    e.corrigiuVazio = true;
    tel.registrar('resposta_vazia_reinstruida', { onde: 'resposta', texto: resumir(texto, 600) });
    await gravarMensagem(supabase, e.remotejid, { role: 'user', content: CORRECAO_VAZIO.replace('%TEXTO%', String(resumir(texto, 600))) });
    return await corrigir(deps, e, ctx, 'so_bastidor', texto);
  }
  guardarCtx(e, ctx);
  return { acao: 'enviar', estado: e, tipo: 'fala', texto };
}

/** Correção gravada no histórico: a próxima volta já sai montada, com o motivo à vista no n8n. */
async function corrigir(deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa, motivo: string, textoBarrado: string): Promise<Saida> {
  guardarCtx(e, ctx);
  const proxima = await montarVolta(deps, e);
  return proxima.acao === 'chamar_ia'
    ? { ...proxima, acao: 'corrigir', motivo, ...(textoBarrado ? { texto_barrado: String(resumir(textoBarrado, 600)) } : {}) }
    : proxima;
}

/** Reincidência da trava: a fala não sai; se havia reunião criada, a confirmação sai em código. */
function descartar(deps: DepsPassos, e: EstadoRodada, ctx: CtxConversa, motivo: string): Saida {
  guardarCtx(e, ctx);
  if (e.confirmacaoPendente) return { acao: 'enviar', estado: e, tipo: 'confirmacao', texto: '', motivo: 'fala_descartada_apos_agendamento' };
  return fim(deps, e, false, { motivo: `descartado_${motivo}` });
}

// ── ferramentas ──────────────────────────────────────────────────────────────
// O que uma ferramenta pode mudar no ctx (o mesmo MUTAVEIS de rotasN8n.ts) + a reunião criada.
export type EfeitosFerramenta = { ctx: Record<string, unknown>; confirmacao?: ConfirmacaoAgendamento | null };

/**
 * PASSO · executa UMA ferramenta (o 04 do n8n chama uma vez por ferramenta). `anteriores` = as
 * chamadas que vieram antes desta na MESMA resposta: a trava de consulta repetida conta com elas.
 */
export async function executarFerramenta(
  deps: DepsPassos, e: EstadoRodada, chamada: Chamada, anteriores: Chamada[] = [],
): Promise<{ output: Record<string, unknown>; efeitos: EfeitosFerramenta; repetida: boolean }> {
  const ctx = ctxDo(e);
  ctx.historicoConversa = await carregarHistorico(deps.supabase, e.remotejid);
  const memoria = ctx.ficha ? MemoriaDeConsultas.deJson(e.consultas) : null;
  for (const a of anteriores) memoria?.repetida(a.name, a.input);
  const inicio = Date.now();
  const repetida = memoria?.repetida(chamada.name, chamada.input) ?? false;
  const output = repetida
    ? { id: chamada.id, resultado: AVISO_CONSULTA_REPETIDA }
    : await executarTool(deps.supabase, chamada, ctx, { comDados: true });
  deps.tel.registrar('tool_exec', {
    tool: chamada.name, input: resumir(chamada.input, 800), output: resumir(output, 1200),
    ...(repetida ? { repetida: true } : {}), agente_pelo_n8n: true,
  }, Date.now() - inicio);
  const { enviosMateriais, compatibilidadeIndisponivel, perguntaFormacaoPendente, ultimaElegibilidade } = ctx;
  const mutaveis = ctxParaJson({ enviosMateriais, compatibilidadeIndisponivel, perguntaFormacaoPendente, ultimaElegibilidade } as CtxConversa);
  return {
    output, repetida,
    efeitos: {
      ctx: mutaveis,
      ...(chamada.name === 'confirmar_agendamento' ? { confirmacao: confirmacaoDoResultado(output) ?? null } : {}),
    },
  };
}

/**
 * PASSO · grava os resultados das ferramentas (já tratados pelo n8n) e decide: próxima volta, ou —
 * se uma ferramenta ENCERROU o atendimento — a despedida determinística.
 */
export async function gravarResultados(
  deps: DepsPassos, e: EstadoRodada, chamadas: Chamada[], resultados: { output: Record<string, unknown>; efeitos?: EfeitosFerramenta }[],
): Promise<Saida> {
  const ctx = ctxDo(e);
  if (chamadas.length !== resultados.length) throw new Error('chamadas e resultados não batem');
  const memoria = ctx.ficha ? MemoriaDeConsultas.deJson(e.consultas) : null;
  const outputs: Record<string, unknown>[] = [];
  chamadas.forEach((c, i) => {
    memoria?.repetida(c.name, c.input);
    const r = resultados[i];
    // O id é o da chamada, venha o que vier do tratamento: é ele que casa o resultado com o pedido.
    // `dados` é só para o n8n montar o texto (05 Ferramentas): não entra na conversa que a Luna relê.
    const { dados: _dados, ...output } = (r.output ?? {}) as Record<string, unknown>;
    outputs.push({ ...output, id: c.id });
    const depois = ctxDeJson({ remotejid: ctx.remotejid, telefone: ctx.telefone, ...(r.efeitos?.ctx ?? {}) });
    if (depois) {
      for (const campo of ['compatibilidadeIndisponivel', 'perguntaFormacaoPendente', 'ultimaElegibilidade', 'enviosMateriais'] as const) {
        if (depois[campo] !== undefined) (ctx as Record<string, unknown>)[campo] = depois[campo];
      }
    }
    if (c.name === 'confirmar_agendamento') e.confirmacaoPendente = r.efeitos?.confirmacao ?? e.confirmacaoPendente;
  });
  if (memoria) e.consultas = memoria.paraJson();
  await deps.renovar();
  await gravarMensagem(deps.supabase, e.remotejid, { role: 'user', content: montarToolResults(outputs) });
  const concluidas = chamadas.filter((_, i) => toolConcluida(outputs[i]));
  if (chamadas.some((c, i) => agendamentoFeito(c.name, outputs[i]))) {
    e.agendouNestaRodada = true;
    // A nota lida no começo ficou velha (reunioesDoLead.ts, trocarNotaDasReunioes): relê a agenda.
    const agora = await reunioesAgora(deps.supabase, e.telefone, ctx.leadId);
    e.contextoEfetivo = trocarNotaDasReunioes(e.contextoEfetivo, e.notaReunioes, agora.nota);
    e.notaReunioes = agora.nota;
    e.reuniaoMarcadaNaAgenda = agora.marcada;
  }
  if (concluidas.some((c) => TOOLS_QUE_ENCERRAM.has(c.name))) {
    e.encerrouPorTool = true;
    if (concluidas.some((c) => TOOLS_QUE_PAUSAM.has(c.name))) e.pausouPorTool = true;
    e.retornoPorFormatura = concluidas.some((c) => c.name === 'agendar_retorno' && c.input?.tipo === 'formatura');
    const cFim = concluidas.find((c) => TOOLS_QUE_ENCERRAM.has(c.name));
    if (cFim) e.encerramento = { tool: cFim.name, input: (cFim.input ?? {}) as Record<string, unknown> };
    if (!outputs.some((o) => !toolConcluida(o))) {
      const despedida = respostaDoEncerramento(e.encerramento);
      if (despedida) {
        guardarCtx(e, ctx);
        return { acao: 'enviar', estado: e, tipo: 'despedida', texto: despedida };
      }
    }
  }
  guardarCtx(e, ctx);
  return await montarVolta(deps, e);
}

// ── saída ────────────────────────────────────────────────────────────────────
/** O histórico como estava ANTES da fala desta volta (a fala já pode ter sido gravada). */
function semAFalaAtual(historico: Msg[], texto: string): Msg[] {
  const ultimo = historico.at(-1);
  if (ultimo?.role !== 'assistant') return historico;
  const conteudo = typeof ultimo.content === 'string' ? ultimo.content
    : (ultimo.content as any[]).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return conteudo.trim() && texto.includes(conteudo.trim().slice(0, 80)) ? historico.slice(0, -1) : historico;
}

/** PASSO · envia no WhatsApp: a fala conferida, a despedida de encerramento ou a confirmação em código. */
export async function enviar(
  deps: DepsPassos, e: EstadoRodada, entrada: { tipo: 'fala' | 'despedida' | 'confirmacao'; texto?: string; motivo?: string },
): Promise<Saida> {
  const { supabase, tel } = deps;
  const ctx = ctxDo(e);
  const saida = (respondeu: boolean, enviado?: string, extra: Record<string, unknown> = {}): Saida => {
    guardarCtx(e, ctx);
    const f = fim(deps, e, respondeu, extra);
    return enviado ? { ...f, enviado } as Saida : f;
  };

  if (entrada.tipo === 'confirmacao') {
    const enviou = await enviarConfirmacaoEmCodigo(deps, e, ctx, entrada.motivo ?? 'confirmacao');
    return saida(enviou);
  }

  const historicoTodo = await carregarHistorico(supabase, e.remotejid);
  const historico = semAFalaAtual(historicoTodo, entrada.texto ?? '');
  const messages = sanitizarHistorico(historico);

  if (entrada.tipo === 'despedida') {
    const comPresente = comPresenteNaDespedida(entrada.texto ?? '', e.encerramento, conversaTexto(messages), e.estaNaEscola);
    if (comPresente.anexou) tel.registrar('presente_escola_anexado', { onde: 'despedida_com_tool' });
    tel.registrar('despedida_deterministica', { tool: e.encerramento?.tool });
    if (!e.aberturaControlada) await gravarMensagem(supabase, e.remotejid, { role: 'assistant', content: comPresente.texto });
    const enviada = await enviarNoWhatsapp(deps, e, ctx, humanizarTexto(comPresente.texto));
    if (e.aberturaControlada && enviada.envio.aceitos) {
      await gravarMensagem(supabase, e.remotejid, { role: 'assistant', content: enviada.texto });
    }
    return saida(true, enviada.texto);
  }

  // Fala conferida (NÓ 10 do rodadaAgente).
  const texto = entrada.texto ?? '';
  if (!e.pausouPorTool && await deps.iaPausada()) {
    tel.registrar('envio_abortado_pausa', { onde: 'antes_envio', motivo: 'IA pausada durante a geração' });
    return saida(Boolean(texto));
  }
  if (RE_RETENCAO.test(texto)) {
    await atualizarLead(supabase, e.remotejid, { followup_ativado: false, followup_desligado_motivo: 'retencao_pendente' });
    tel.registrar('esteiras_suspensas', { motivo: 'retencao_pendente' });
  }
  const comPresente = comPresenteNaDespedida(texto, e.encerramento, conversaTexto(messages), e.estaNaEscola);
  if (comPresente.anexou) tel.registrar('presente_escola_anexado', { onde: 'despedida_pos_pausa' });
  const comLink = comLinkPedido(comPresente.texto, e.conteudo, e.estaNaEscola || jaTemOPresente(conversaTexto(messages)));
  if (comLink.anexou) tel.registrar('link_escola_reenviado', { pedido: resumir(e.conteudo, 200) });
  const semCertificado = semCertificadoAntesDoFim(comLink.texto, e.aulaDaCampanha);
  if (semCertificado.removido) tel.registrar('certificado_retido', { motivo: 'aula_nao_terminou' });
  const fala = ctx.ficha && !e.aberturaControlada
    ? garantirSaudacao(humanizarTexto(semCertificado.texto), e.conteudo)
    : { texto: humanizarTexto(semCertificado.texto), acrescentou: null };
  if (fala.acrescentou) tel.registrar('saudacao_garantida', { prefixo: fala.acrescentou });
  // Sem voz (ElevenLabs) na persona AULA: pedido do Gustavo em 30/09/2026 — só texto.
  const voz = e.encerrouPorTool || e.aulaPiloto || e.aulaDaCampanha ? undefined : {
    supabase, origem: 'conversa' as const, historico, iniciadaEm: e.inicioRodada,
    provedorResposta: lunaAtiva(e, deps) ? 'openai' as const : 'anthropic' as const,
    interacaoId: e.rodadaId,
    referenciaMensagemId: e.msgIdUltimo ?? undefined,
    interrompido: deps.iaPausada,
  };
  const { envio, texto: textoEnviado } = await enviarNoWhatsapp(deps, e, ctx, fala.texto, voz);
  if (e.registrarFalaAposEnvio && envio?.aceitos) {
    await gravarMensagem(supabase, e.remotejid, { role: 'assistant', content: textoEnviado });
  }
  if (e.registrarFalaAposEnvio && !envio?.aceitos) return saida(false, undefined, { motivo: envio?.estado ?? 'envio_sem_aceite' });
  if (e.confirmacaoPendente && !falaEntregaConfirmacao(textoEnviado ?? comLink.texto, e.confirmacaoPendente)) {
    await enviarConfirmacaoEmCodigo(deps, e, ctx, 'fala_sem_link');
  }
  e.confirmacaoPendente = null;
  if (ctx.ficha) {
    const ficha = await carregarFicha(supabase, ctx);
    if (ficha) {
      try {
        const marcas = await marcarPerguntasDaFicha(supabase, e.telefone, ficha, comLink.texto);
        if (marcas.length) tel.registrar('ficha_pergunta_feita', { marcas });
      } catch (err) {
        console.error('[crm-agente-sdr] jornada (perguntas):', (err as Error)?.message ?? err);
      }
    }
  }
  return saida(true, textoEnviado ?? fala.texto);
}

// ── início ───────────────────────────────────────────────────────────────────
/** O estado da rodada a partir do preparo (index.ts: prepararAntesDoRouter + definirAgente). */
export function estadoInicial(
  pre: {
    remotejid: string; telefone: string; inicioRodada: number; conteudo: string; itens: any[]; registrarFalaAposEnvio: boolean;
    conjuntoPrompt: ConjuntoPrompt; ctx: CtxConversa; lead: any; pedidoPorPalavraChave: 'botao' | 'texto' | null;
    aberturaControlada: boolean; aplicarTroca: boolean; sinalTroca: any; desdeLimpeza: string | null; aulaPiloto: boolean;
    aulaDaCampanha: any; configLeitura: ConfigLeituraJev | null; reuniaoMarcadaNaAgenda?: boolean | null; notaReunioes?: string;
  },
  depois: { promptAgente: string; tools: any[]; contextoEfetivo: string; agenteEfetivo: string; estaNaEscola: boolean },
  rodadaId: string,
  leitura: LeituraLead | null,
): EstadoRodada {
  const ultimoMsgId = [...pre.itens].reverse().find((i: any) => i?.msg_id != null)?.msg_id ?? null;
  const { historicoConversa: _h, ...ctx } = pre.ctx;
  return {
    versao: 1, rodadaId,
    remotejid: pre.remotejid, telefone: pre.telefone, inicioRodada: pre.inicioRodada, conteudo: pre.conteudo,
    msgIdUltimo: ultimoMsgId, registrarFalaAposEnvio: pre.registrarFalaAposEnvio, conjuntoPrompt: pre.conjuntoPrompt,
    ctx: ctxParaJson(ctx as CtxConversa), leadAgendado: pre.lead?.agendado === true, pedidoPorPalavraChave: pre.pedidoPorPalavraChave,
    aberturaControlada: pre.aberturaControlada, aplicarTroca: pre.aplicarTroca, sinalTroca: pre.sinalTroca,
    desdeLimpeza: pre.desdeLimpeza, aulaPiloto: pre.aulaPiloto, aulaDaCampanha: pre.aulaDaCampanha,
    configLeitura: pre.configLeitura, leitura,
    promptAgente: depois.promptAgente, tools: depois.tools, contextoEfetivo: depois.contextoEfetivo,
    agenteEfetivo: depois.agenteEfetivo, estaNaEscola: depois.estaNaEscola,
    volta: 0, usarClaude: false, respostaOperacional: false, pausouPorTool: false, encerrouPorTool: false,
    retornoPorFormatura: false, encerramento: null, corrigiuHorario: false, corrigiuTrava: [], corrigiuVazio: false,
    corrigiuSilencio: false, confirmacaoPendente: null, consultas: [], avisosDaLeitura: [], ferramentasDaVolta: [],
    inicioLlm: 0, raciocinios: [], canalPendente: null,
    reuniaoMarcadaNaAgenda: pre.reuniaoMarcadaNaAgenda ?? null, agendouNestaRodada: false, notaReunioes: pre.notaReunioes ?? '',
  };
}
