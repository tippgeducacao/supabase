// Núcleo do harness sem cliente de banco, credenciais ou transporte de mensagens.
// 08/09/2026: o histórico inicial reproduz a retomada após atendimento humano.
// Somente texto externo é aceito: tool_use/result e thinking só podem nascer do modelo.
import { sanitizarHistorico, type Msg } from '../crm-agente-sdr/historico.ts';
import type { Telemetria } from '../crm-agente-sdr/eventos.ts';
import { avaliarEvidenciaSemGraduacao, bloqueioSemEvidenciaGraduacao } from '../crm-agente-sdr/evidenciaFormacao.ts';
import { respostaDoEncerramento, toolConcluida, type Encerramento } from '../crm-agente-sdr/encerramento.ts';
import { comPresenteNaDespedida } from '../crm-agente-sdr/escolaGratuita.ts';

export const MAX_TURNOS_SIMULACAO = 100;
export const MAX_CARACTERES_SIMULACAO = 200_000;
import type { AulaParaPrompt } from '../crm-agente-sdr/prompts-aula.ts';

// 16/09/2026: 'aula' = persona da aula gratuita (PRD — Persona por disparo). No harness
// ela substitui a abertura como a campanha direta; o fechamento segue com o qualificador.
export type Persona = 'validacao' | 'qualificador' | 'campanha_direta' | 'aula';
export type AgenteRouter = 'agente_validacao' | 'agente_qualificador';
export type MensagemTextual = { role: 'user' | 'assistant'; content: string };
/** 14/09/2026: o lead responde por OUTRO número da PPGVET (trocaDeNumero.ts). Só o 1º turno recebe a nota. */
export type TrocaDeNumeroSimulada = {
  /** Texto do template que saiu por este número antes da resposta (null = o lead escreveu por conta própria). */
  template: string | null;
  gap_min: number | null;
  conta_anterior: string | null;
  conta_atual: string | null;
  agendado: boolean;
};
export type EntradaSimulacao = {
  modo: 'principal' | 'followup';
  followup_stage: number;
  persona: Persona;
  mensagens: string[];
  historico_inicial: MensagemTextual[];
  usar_router: boolean;
  agente_atual: AgenteRouter | null;
  nome_lead: string;
  curso: string;
  formacao_academica: string;
  mocks: Record<string, unknown>;
  agente_override: string;
  sem_presente_escola: boolean;
  /** A pessoa JÁ tem a tag da Escola: o prompt leva o aviso (NOTA_JA_ESTA_NA_ESCOLA) no lugar do convite. */
  esta_na_escola: boolean;
  prompt_extra: string;
  troca_de_numero: TrocaDeNumeroSimulada | null;
  /** Dados da aula do convite (persona 'aula'); o "quando ocorre" é calculado pelo relógio real. */
  aula: AulaParaPrompt | null;
  /** Quem responde nesta simulação. 'deepseek' usa o endpoint compatível; a produção não tem essa chave. */
  provedor: 'anthropic' | 'deepseek' | 'openai';
  /** Nível de raciocínio do provedor openai nesta simulação (compara high × xhigh no mesmo deploy). */
  esforco: string | null;
};

export function validarEntradaSimulacao(valor: unknown): EntradaSimulacao {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('payload inválido');
  if (JSON.stringify(valor).length > MAX_CARACTERES_SIMULACAO) throw new Error('limite de 200000 caracteres excedido');
  const body = valor as Record<string, unknown>;
  const modo = body.modo ?? 'principal';
  if (modo !== 'principal' && modo !== 'followup') throw new Error('modo inválido');
  const persona = body.persona ?? 'campanha_direta';
  if (typeof persona !== 'string' || !['validacao', 'qualificador', 'campanha_direta', 'aula'].includes(persona)) throw new Error('persona inválida');
  const provedor = body.provedor ?? 'anthropic';
  if (provedor !== 'anthropic' && provedor !== 'deepseek' && provedor !== 'openai') throw new Error('provedor inválido');
  const esforco = body.esforco ?? null;
  if (esforco !== null && (provedor !== 'openai' || !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(esforco as string))) {
    throw new Error('esforco só vale com provedor openai: none, low, medium, high, xhigh ou max');
  }
  let aulaSimulada: AulaParaPrompt | null = null;
  if (body.aula !== undefined && body.aula !== null) {
    const a = body.aula as Record<string, unknown>;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('aula deve ser um objeto');
    if (typeof a.titulo !== 'string' || !a.titulo.trim()) throw new Error('aula.titulo deve conter texto não vazio');
    if (typeof a.inicio_em !== 'string' || Number.isNaN(new Date(a.inicio_em).getTime())) throw new Error('aula.inicio_em deve ser uma data ISO válida');
    const opcional = (v: unknown, campo: string): string | null => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') throw new Error(`aula.${campo} deve ser texto`);
      return v;
    };
    aulaSimulada = {
      titulo: a.titulo, inicio_em: a.inicio_em, tema: opcional(a.tema, 'tema'), link: opcional(a.link, 'link'),
      certificado_instrucoes: opcional(a.certificado_instrucoes, 'certificado_instrucoes'),
      monitor_nome: opcional(a.monitor_nome, 'monitor_nome'), curso_nome: opcional(a.curso_nome, 'curso_nome'),
    };
  }
  if (persona === 'aula' && !aulaSimulada) throw new Error('persona aula exige o objeto aula');
  const mensagens = body.mensagens ?? (modo === 'followup' ? [] : undefined);
  if (!Array.isArray(mensagens) || (modo === 'principal' && !mensagens.length)) throw new Error('mensagens[] obrigatório');
  if (body.historico_inicial !== undefined && !Array.isArray(body.historico_inicial)) throw new Error('historico_inicial deve ser um array');
  const historico = (body.historico_inicial ?? []) as unknown[];
  if (historico.length + mensagens.length > MAX_TURNOS_SIMULACAO) throw new Error('limite de 100 turnos excedido');
  const stage = body.followup_stage ?? 1;
  if (!Number.isInteger(stage) || Number(stage) < 1 || Number(stage) > 7) throw new Error('followup_stage deve ser inteiro de 1 a 7');
  if (modo === 'followup') {
    if (!historico.length || mensagens.length) throw new Error('followup exige histórico inicial e nenhuma nova mensagem');
    if (body.usar_router || body.agente_override || body.prompt_extra || body.sem_presente_escola || body.esta_na_escola) {
      throw new Error('followup não aceita router, override ou alteração de prompt');
    }
  }
  const texto = (v: unknown, campo: string, obrigatorio = false): string => {
    if (v === undefined && !obrigatorio) return '';
    if (typeof v !== 'string' || (obrigatorio && !v.trim())) throw new Error(`${campo} deve conter texto não vazio`);
    return v;
  };
  const historicoInicial = historico.map((v): MensagemTextual => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('turno inválido no histórico');
    const m = v as Record<string, unknown>;
    if (m.role !== 'user' && m.role !== 'assistant') throw new Error('role deve ser user ou assistant');
    // Não aceitar metadados/blocos de API trazidos por quem chamou o endpoint.
    if (Object.keys(m).some((k) => k !== 'role' && k !== 'content')) throw new Error('histórico aceita somente role e content');
    return { role: m.role, content: texto(m.content, 'content', true) };
  });
  for (const campo of ['usar_router', 'sem_presente_escola', 'esta_na_escola']) {
    if (body[campo] !== undefined && typeof body[campo] !== 'boolean') throw new Error(`${campo} deve ser booleano`);
  }
  if (body.agente_atual != null && body.agente_atual !== 'agente_validacao' && body.agente_atual !== 'agente_qualificador') {
    throw new Error('agente_atual inválido');
  }
  if (body.mocks != null && (typeof body.mocks !== 'object' || Array.isArray(body.mocks))) throw new Error('mocks deve ser objeto');
  let trocaDeNumero: TrocaDeNumeroSimulada | null = null;
  if (body.troca_de_numero != null) {
    const t = body.troca_de_numero;
    if (typeof t !== 'object' || Array.isArray(t)) throw new Error('troca_de_numero deve ser objeto');
    if (modo === 'followup') throw new Error('followup não aceita troca_de_numero');
    const o = t as Record<string, unknown>;
    const chaves = ['template', 'gap_min', 'conta_anterior', 'conta_atual', 'agendado'];
    if (Object.keys(o).some((k) => !chaves.includes(k))) throw new Error(`troca_de_numero aceita somente ${chaves.join(', ')}`);
    if (o.gap_min != null && (typeof o.gap_min !== 'number' || !Number.isFinite(o.gap_min) || o.gap_min < 0)) throw new Error('troca_de_numero.gap_min deve ser número >= 0');
    if (o.agendado !== undefined && typeof o.agendado !== 'boolean') throw new Error('troca_de_numero.agendado deve ser booleano');
    trocaDeNumero = {
      template: texto(o.template ?? undefined, 'troca_de_numero.template').trim() || null,
      gap_min: o.gap_min == null ? null : Number(o.gap_min),
      conta_anterior: texto(o.conta_anterior ?? undefined, 'troca_de_numero.conta_anterior').trim() || null,
      conta_atual: texto(o.conta_atual ?? undefined, 'troca_de_numero.conta_atual').trim() || null,
      agendado: o.agendado === true,
    };
  }
  return {
    modo,
    followup_stage: Number(stage),
    persona: persona as Persona,
    mensagens: mensagens.map((m) => texto(m, 'mensagens[]', true)),
    historico_inicial: historicoInicial,
    usar_router: body.usar_router === true,
    agente_atual: (body.agente_atual as AgenteRouter | null) ?? null,
    nome_lead: texto(body.nome_lead, 'nome_lead'),
    curso: texto(body.curso, 'curso'),
    formacao_academica: texto(body.formacao_academica, 'formacao_academica'),
    mocks: (body.mocks as Record<string, unknown>) ?? {},
    agente_override: texto(body.agente_override, 'agente_override').trim(),
    sem_presente_escola: body.sem_presente_escola === true,
    esta_na_escola: body.esta_na_escola === true,
    prompt_extra: texto(body.prompt_extra, 'prompt_extra').trim(),
    troca_de_numero: trocaDeNumero,
    aula: aulaSimulada,
    provedor,
    esforco: esforco as string | null,
  };
}

// Somente contagens conhecidas saem no diagnóstico; nunca a resposta crua do provedor.
export function extrairUso(usage: unknown): Record<string, number> {
  const resultado: Record<string, number> = {};
  if (!usage || typeof usage !== 'object') return resultado;
  for (const campo of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const valor = (usage as Record<string, unknown>)[campo];
    if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) resultado[campo] = valor;
  }
  return resultado;
}

type BlocoModelo = { type: string; text?: string; id?: string; name?: string; input?: unknown; [campo: string]: unknown };
type Rodada = { promptAgente: string; contextoTemporal: string; tools: unknown[]; agente: string };
export type DependenciasSimulacao = {
  prepararRodada: (messages: Msg[], turno: number) => Promise<Rodada>;
  chamarPrincipal: (opts: { promptAgente: string; contextoTemporal: string; tools: unknown[]; messages: Msg[] }) => Promise<{
    content?: BlocoModelo[]; model?: string; usage?: unknown; stop_reason?: string;
  }>;
  mockTool: (nome: string, input: unknown) => Promise<string>;
  humanizar: (texto: string) => string;
};

export async function executarSimulacao(entrada: EntradaSimulacao, deps: DependenciasSimulacao) {
  const messages: Msg[] = entrada.historico_inicial.map((m) => ({ ...m }));
  const transcript: Record<string, unknown>[] = [];
  const chamadas: Record<string, unknown>[] = [];
  const limites: { turno: number; motivo: string }[] = [];
  let agente = '';

  for (const [indice, msgLead] of entrada.mensagens.entries()) {
    const turno = indice + 1;
    messages.push({ role: 'user', content: msgLead });
    transcript.push({ quem: 'lead', texto: msgLead, turno });
    const rodada = await deps.prepararRodada(messages, turno);
    agente = rodada.agente;
    let encerrou = false;
    for (let volta = 0; volta < 6; volta++) {
      const resp = await deps.chamarPrincipal({ ...rodada, tools: encerrou ? [] : rodada.tools, messages: sanitizarHistorico(messages) });
      chamadas.push({ turno, volta: volta + 1, agente, modelo: resp.model ?? null, usage: extrairUso(resp.usage), stop_reason: resp.stop_reason ?? null });
      const blocos = resp.content ?? [];
      const textoCru = blocos.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const texto = deps.humanizar(textoCru);
      const toolUses = blocos.filter((b): b is BlocoModelo & { id: string; name: string } =>
        b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string');
      const pausasBloqueadas = new Set(toolUses.filter((tu) => tu.name === 'pausa_ia'
        && (tu.input as Record<string, unknown> | undefined)?.tipo === 'sem_graduacao'
        && !avaliarEvidenciaSemGraduacao(messages).autorizada).map((tu) => tu.id));
      // Thinking permanece só na memória necessária para a cadeia ativa de tools.
      if (blocos.length) messages.push({ role: 'assistant', content: blocos });
      // 14/09/2026: texto junto de tool_use é intermediário, mesmo sem tags de
      // raciocínio. Só a resposta final pode aparecer como fala do João no ensaio.
      if (!toolUses.length && (texto || texto !== textoCru)) transcript.push({
        quem: 'joao', texto, turno,
        ...(texto !== textoCru ? { saida_filtrada: true, silenciado: !texto } : {}),
      });
      if (!toolUses.length) break;

      const results = [];
      const toolsConcluidas: Encerramento[] = [];
      for (const tu of toolUses) {
        const bloqueadoPelaGuarda = pausasBloqueadas.has(tu.id);
        const resultado = bloqueadoPelaGuarda ? JSON.stringify(bloqueioSemEvidenciaGraduacao(tu.id)) : await deps.mockTool(tu.name, tu.input);
        let retornoTool: Record<string, unknown> = { resultado };
        // Retorno estruturado do mock também pode recusar uma ação; tentar pausar
        // não significa que ela foi concluída (mesmo contrato do executor real).
        try {
          const objeto = JSON.parse(resultado);
          if (objeto && typeof objeto === 'object' && !Array.isArray(objeto)) retornoTool = objeto;
        } catch { /* Mocks legados devolvem texto simples. */ }
        const bloqueado = bloqueadoPelaGuarda || retornoTool.status === 'bloqueado';
        transcript.push({ quem: 'tool', nome: tu.name, input: tu.input, resultado, simulado: true, turno, ...(bloqueado ? { bloqueado: true } : {}) });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: resultado });
        if (!bloqueado && toolConcluida(retornoTool)) toolsConcluidas.push({ tool: tu.name, input: (tu.input ?? {}) as Record<string, unknown> });
      }
      messages.push({ role: 'user', content: results });
      encerrou ||= toolsConcluidas.some((tu) => ['pausa_ia', 'temporizador_proxima_turma', 'agendar_retorno'].includes(tu.tool));
      // A despedida conhecida vem da mesma régua pura de produção, nunca do texto
      // intermediário do modelo. Motivo desconhecido ganha outra volta para responder.
      const encerramento = toolsConcluidas.find((tu) => respostaDoEncerramento(tu));
      const despedida = encerramento ? respostaDoEncerramento(encerramento) : null;
      if (despedida && toolsConcluidas.length === toolUses.length) {
        const conversaPublicada = [
          ...entrada.historico_inicial.map((m) => m.content),
          ...transcript.filter((m) => m.quem === 'lead' || m.quem === 'joao').map((m) => String(m.texto ?? '')),
        ].join('\n');
        const comPresente = entrada.sem_presente_escola ? despedida : comPresenteNaDespedida(
          despedida, encerramento!, conversaPublicada, entrada.esta_na_escola,
        ).texto;
        const textoFinal = deps.humanizar(comPresente);
        if (textoFinal) {
          transcript.push({ quem: 'joao', texto: textoFinal, turno });
          messages.push({ role: 'assistant', content: [{ type: 'text', text: textoFinal }] });
        }
        break;
      }
      if (volta === 5) limites.push({ turno, motivo: 'limite de 6 chamadas do agente atingido' });
    }
  }
  return {
    ok: true, modo: 'principal', persona: entrada.persona, agente, transcript,
    tools_chamadas: transcript.filter((t) => t.quem === 'tool').map((t) => t.nome),
    chamadas, limites_atingidos: limites, historico_inicial_turnos: entrada.historico_inicial.length,
  };
}

export type DependenciasFollowupSimulado = {
  gerar: (banco: unknown, lead: Record<string, unknown>, stage: number, tel: Telemetria, history: Msg[]) => Promise<{ message: string; final_answer: string }>;
  humanizar: (texto: string) => string;
};

export async function executarFollowupSimulado(entrada: EntradaSimulacao, deps: DependenciasFollowupSimulado) {
  if (entrada.modo !== 'followup') throw new Error('modo followup obrigatório');
  // gerarFollowup hoje só precisa de modelo + histórico. Se ganhar qualquer acesso
  // ao banco no futuro, este ensaio falha fechado antes de ler/gravar dados reais.
  const bancoBloqueado = new Proxy({}, { get() { throw new Error('banco indisponível na simulação de followup'); } });
  const eventos: Record<string, unknown>[] = [];
  const tel: Telemetria = {
    rodadaId: 'simulacao-followup-sem-persistencia',
    registrar(tipo, dados = {}, duracaoMs) {
      if (tipo !== 'llm_chamada') return;
      const evento: Record<string, unknown> = { tipo };
      for (const campo of ['volta', 'stage', 'tentativa', 'tokens_entrada', 'tokens_saida', 'cache_lido', 'cache_escrito']) {
        const valor = dados[campo];
        if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) evento[campo] = valor;
      }
      for (const campo of ['agente', 'modelo', 'stop_reason']) {
        if (typeof dados[campo] === 'string') evento[campo] = dados[campo];
      }
      if (typeof duracaoMs === 'number' && Number.isFinite(duracaoMs) && duracaoMs >= 0) evento.duracao_ms = duracaoMs;
      eventos.push(evento);
    },
  };
  const resultado = await deps.gerar(bancoBloqueado, {
    remotejid: 'simulacao-followup-sem-destino',
    nome: entrada.nome_lead,
    curso_interesse_original: entrada.curso,
    formacao_academica: entrada.formacao_academica,
  }, entrada.followup_stage, tel, entrada.historico_inicial.map((m) => ({ ...m })));
  const message = deps.humanizar(resultado.message);
  return {
    ok: true, modo: 'followup', agente: 'followup',
    message, final_answer: resultado.final_answer,
    transcript: message ? [{ quem: 'joao', texto: message }] : [],
    tools_chamadas: [], routers: [], eventos,
    historico_inicial_turnos: entrada.historico_inicial.length,
    followup_stage: entrada.followup_stage,
    ...(message !== resultado.message ? { saida_filtrada: true } : {}),
  };
}
