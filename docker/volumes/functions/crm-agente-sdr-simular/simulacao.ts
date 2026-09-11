// Núcleo do harness sem cliente de banco, credenciais ou transporte de mensagens.
// 08/09/2026: o histórico inicial reproduz a retomada após atendimento humano.
// Somente texto externo é aceito: tool_use/result e thinking só podem nascer do modelo.
import { sanitizarHistorico, type Msg } from '../crm-agente-sdr/historico.ts';
import type { Telemetria } from '../crm-agente-sdr/eventos.ts';

export const MAX_TURNOS_SIMULACAO = 100;
export const MAX_CARACTERES_SIMULACAO = 200_000;
export type Persona = 'validacao' | 'qualificador' | 'campanha_direta';
export type AgenteRouter = 'agente_validacao' | 'agente_qualificador';
export type MensagemTextual = { role: 'user' | 'assistant'; content: string };
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
};

export function validarEntradaSimulacao(valor: unknown): EntradaSimulacao {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw new Error('payload inválido');
  if (JSON.stringify(valor).length > MAX_CARACTERES_SIMULACAO) throw new Error('limite de 200000 caracteres excedido');
  const body = valor as Record<string, unknown>;
  const modo = body.modo ?? 'principal';
  if (modo !== 'principal' && modo !== 'followup') throw new Error('modo inválido');
  const persona = body.persona ?? 'campanha_direta';
  if (typeof persona !== 'string' || !['validacao', 'qualificador', 'campanha_direta'].includes(persona)) throw new Error('persona inválida');
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
    for (let volta = 0; volta < 6; volta++) {
      const resp = await deps.chamarPrincipal({ ...rodada, messages: sanitizarHistorico(messages) });
      chamadas.push({ turno, volta: volta + 1, agente, modelo: resp.model ?? null, usage: extrairUso(resp.usage), stop_reason: resp.stop_reason ?? null });
      const blocos = resp.content ?? [];
      const textoCru = blocos.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const texto = deps.humanizar(textoCru);
      const toolUses = blocos.filter((b): b is BlocoModelo & { id: string; name: string } =>
        b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string');
      // Thinking permanece só na memória necessária para a cadeia ativa de tools.
      messages.push({ role: 'assistant', content: blocos });
      if (texto || texto !== textoCru) transcript.push({
        quem: 'joao', texto, turno,
        ...(texto !== textoCru ? { saida_filtrada: true, silenciado: !texto } : {}),
      });
      if (!toolUses.length) break;

      const results = [];
      for (const tu of toolUses) {
        const resultado = await deps.mockTool(tu.name, tu.input);
        transcript.push({ quem: 'tool', nome: tu.name, input: tu.input, resultado, simulado: true, turno });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: resultado });
      }
      messages.push({ role: 'user', content: results });
      // Mantém o contrato legado: pausa encerra esta rodada, sem efetuar pausa real.
      if (toolUses.some((tu) => tu.name === 'pausa_ia')) break;
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
