// Chamadas à API Anthropic do agente SDR — port dos nodes "Claude - Agente Router"
// e "Anthropic Claude Sonnet 4.5" do n8n (mesmos modelos, parâmetros e retries).

// deno-lint-ignore-file no-explicit-any
import { PROMPT_ROUTER } from './prompts.ts';
import type { Msg } from './historico.ts';
import { INSTRUCAO_MEMORIA_HUMANA } from './memoriaHumana.ts';
import { INSTRUCAO_DISPONIBILIDADE_CONTATO } from './disponibilidadeContato.ts';
import { INSTRUCAO_EVENTOS } from './instrucaoEventos.ts';
import { descreverToolsSdr } from './descricoesTools.ts';
import { respostaParaFalhaCatalogo } from './falhaCatalogo.ts';
import { INSTRUCAO_FALHA_COMPATIBILIDADE, respostaAoAceiteAposFalha, ultimaCompatibilidadeFalhou } from './falhaCompatibilidade.ts';
import { comPrazoModelo, PRAZO_MODELO_PILOTO_MS } from './prazoModelo.ts';
import { INSTRUCAO_FATOS_DO_LEAD } from './fatosLead.ts';
import { INSTRUCAO_FICHA } from './fichaAtendimento.ts';
import { INSTRUCAO_VOZ } from './vozDoJoao.ts';
import { contemMeta, contemRaciocinioVazado } from './saida.ts';
import {
  avaliarCanalResposta, INSTRUCAO_CANAL_RESPOSTA, NOME_TOOL_RESPOSTA,
  normalizarRespostaCanal, somarUsoModelo, TOOL_RESPONDER_AO_CLIENTE,
} from './canalResposta.ts';
import { paraPedidoOpenai, paraRespostaAnthropic } from './provedorOpenai.ts';

const ANTHROPIC_KEY = Deno.env.get('AGENTE_SDR_ANTHROPIC_KEY') ?? Deno.env.get('ANTHROPIC_API_KEY') ?? '';
// Override por env se um dia mudar. ⚠️ Sonnet 5: budget_tokens e temperature≠default
// dão 400 — as chamadas abaixo usam thinking adaptive/disabled e nenhum sampling param.
export const MODELO_AGENTE = Deno.env.get('AGENTE_SDR_MODEL') ?? 'claude-sonnet-5';

// ── Provedor da chamada ─────────────────────────────────────────────────────
// `null` = Anthropic (o padrão de sempre). O provedor é um ARGUMENTO de cada chamada,
// nunca estado do módulo: a mesma instância da edge atende vários leads ao mesmo tempo,
// e um "provedor atual" global faria a conversa de um lead sair pelo modelo de outro.
//  · formato 'anthropic' = endpoint compatível (ex.: DeepSeek em /anthropic): mesmo corpo,
//    outra base e outra chave; `cache_control` e `anthropic-beta` são ignorados do lado de lá.
//  · formato 'openai' = o pedido é TRADUZIDO para a Responses API (provedorOpenai.ts) e a
//    resposta volta no formato da Anthropic; quem chama não percebe a diferença.
export type ProvedorIA =
  | { nome: string; formato: 'anthropic'; base: string; chave: string }
  | { nome: string; formato: 'openai'; base: string; chave: string; modelo: string; esforco: string };
export function provedorDeepseek(): ProvedorIA | null {
  const chave = Deno.env.get('AGENTE_SDR_DEEPSEEK_KEY') ?? '';
  return chave ? { nome: 'deepseek', formato: 'anthropic', base: 'https://api.deepseek.com/anthropic', chave } : null;
}
// Esforço 'high' por padrão: é o nível em que a Luna empata com o Sonnet 5 (high) no
// índice da Artificial Analysis; o padrão da OpenAI ('medium') fica abaixo.
export function provedorOpenai(): ProvedorIA | null {
  const chave = Deno.env.get('AGENTE_SDR_OPENAI_KEY') ?? '';
  if (!chave) return null;
  return {
    nome: 'openai', formato: 'openai', base: 'https://api.openai.com', chave,
    modelo: Deno.env.get('AGENTE_SDR_OPENAI_MODEL') || 'gpt-5.6-luna',
    esforco: Deno.env.get('AGENTE_SDR_OPENAI_EFFORT') || 'high',
  };
}

export async function chamarAnthropic(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  provedor: ProvedorIA | null = null,
  prazoMs?: number,
): Promise<any> {
  const alternativo = provedor;
  const base = alternativo?.base ?? 'https://api.anthropic.com';
  const chave = alternativo?.chave ?? ANTHROPIC_KEY;
  const openai = alternativo?.formato === 'openai' ? alternativo : null;
  const executar = async (sinal?: AbortSignal) => {
  // retryOnFail do n8n: até 5 tentativas, dentro do mesmo prazo no piloto.
  let ultimoErro = '';
  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    sinal?.throwIfAborted();
    const res = openai
      ? await fetch(`${base}/v1/responses`, {
        method: 'POST', ...(sinal ? { signal: sinal } : {}),
        headers: { authorization: `Bearer ${chave}`, 'content-type': 'application/json' },
        body: JSON.stringify(paraPedidoOpenai(body, openai)),
      })
      : await fetch(`${base}/v1/messages`, {
        method: 'POST', ...(sinal ? { signal: sinal } : {}),
        headers: {
          'x-api-key': chave,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    sinal?.throwIfAborted();
    if (res.ok) {
      const dados = await res.json();
      sinal?.throwIfAborted();
      return openai ? paraRespostaAnthropic(dados) : dados;
    }
    ultimoErro = `HTTP ${res.status}: ${await res.text()}`;
    sinal?.throwIfAborted();
    // 4xx (exceto 429) não melhora com retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    if (tentativa < 5) await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${alternativo?.nome === 'openai' ? 'OpenAI' : alternativo?.nome ?? 'Anthropic'}: ${ultimoErro}`);
  };
  // 22/09/2026: o piloto parou após tools, com fetch sem limite e sem resposta.
  // O legado conserva seu contrato; OpenAI e fallback explícito têm prazo finito.
  const limite = prazoMs ?? (openai ? PRAZO_MODELO_PILOTO_MS : undefined);
  return limite === undefined ? executar() : comPrazoModelo(executar, limite);
}

// ── Router: decide validação × qualificador (tool forçada, sem thinking) ─────
// thinking disabled EXPLÍCITO: no Sonnet 5, omitir liga o adaptativo — o router quer
// resposta imediata com tool forçada, não raciocínio.
export type MetadadosRespostaRouter = { model?: string; usage?: Record<string, unknown> };

export async function chamarRouter(
  historicoLimpo: Msg[],
  aoResponder?: (metadados: MetadadosRespostaRouter) => void,
  provedor: ProvedorIA | null = null,
): Promise<'agente_validacao' | 'agente_qualificador'> {
  const resp = await chamarAnthropic({
    model: MODELO_AGENTE,
    max_tokens: 512,
    thinking: { type: 'disabled' },
    // PROMPT_ROUTER é estático → prefixo (tool do router + system) COMPARTILHADO entre
    // TODOS os leads: todo inbound roteado paga 0,1x nessa parte.
    system: [
      { type: 'text', text: PROMPT_ROUTER },
      { type: 'text', text: INSTRUCAO_MEMORIA_HUMANA },
      { type: 'text', text: INSTRUCAO_FATOS_DO_LEAD },
      { type: 'text', text: INSTRUCAO_DISPONIBILIDADE_CONTATO },
      { type: 'text', text: INSTRUCAO_EVENTOS, cache_control: { type: 'ephemeral' } },
    ],
    messages: historicoLimpo,
    tools: [{
      name: 'router_output',
      description: 'Seleciona o agente correto para responder a mensagem.',
      input_schema: {
        type: 'object',
        properties: { agent: { type: 'string', enum: ['agente_validacao', 'agente_qualificador'] } },
        required: ['agent'],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: 'tool', name: 'router_output' },
  }, { 'anthropic-beta': 'structured-outputs-2025-11-13' }, provedor);

  // O harness observa modelo/uso sem receber conteúdo ou pensamento do router.
  aoResponder?.({ model: resp.model, usage: resp.usage });

  const bloco = (resp.content ?? []).find((b: any) => b.type === 'tool_use');
  const agente = bloco?.input?.agent;
  if (agente !== 'agente_validacao' && agente !== 'agente_qualificador') {
    throw new Error(`Router retornou agente inválido: ${JSON.stringify(agente)}`);
  }
  return agente;
}

// ── Loop principal: cache em 3 camadas + contexto temporal FORA do prefixo ──
// Breakpoints (máx. 4 na API):
//   (1) última TOOL   → prefixo só-tools COMPARTILHADO entre todos os leads da persona;
//   (2) prompt        → por lead (cobre voltas e respostas rápidas);
//   (3) último bloco REAL da última mensagem → o HISTÓRICO vira cache incremental.
// Antes só existia o (2): o histórico inteiro (~19k tokens) era re-enviado como input
// CHEIO em toda volta — era o grosso do gasto do agente.
// ⚠️ O contexto temporal muda a cada MINUTO: ele entra como bloco de texto no FIM da
// última mensagem, DEPOIS do breakpoint (3) — fresco em toda chamada, sem invalidar o
// cache do histórico. NUNCA voltar com ele pro system (entre o prompt e as messages
// ele estourava qualquer cache de mensagem a cada minuto).
export async function chamarAgentePrincipal(opts: {
  promptAgente: string;
  contextoTemporal: string;
  contextoEntregaMateriais?: string;
  /** Ficha do atendimento (canário): bloco no fim da última mensagem + instrução estática no system. */
  contextoFicha?: string;
  comFicha?: boolean;
  messages: Msg[];
  tools: any[];
  /** null/ausente = Anthropic. */
  provedor?: ProvedorIA | null;
  prazoModeloMs?: number;
}): Promise<any> {
  const falhaCatalogo = respostaParaFalhaCatalogo(opts.messages);
  if (falhaCatalogo) return {
    content: [{ type: 'text', text: falhaCatalogo }], stop_reason: 'end_turn',
    origem: 'falha_catalogo', usage: { input_tokens: 0, output_tokens: 0 },
  };
  const aceiteAposFalha = opts.comFicha ? respostaAoAceiteAposFalha(opts.messages) : null;
  if (aceiteAposFalha) return {
    content: [{ type: 'text', text: aceiteAposFalha }], stop_reason: 'end_turn',
    origem: 'aceite_apos_falha_compatibilidade', usage: { input_tokens: 0, output_tokens: 0 },
  };
  const falhaCompatibilidade = opts.comFicha && ultimaCompatibilidadeFalhou(opts.messages);
  const system: any[] = [
    { type: 'text', text: opts.promptAgente },
    { type: 'text', text: INSTRUCAO_MEMORIA_HUMANA },
    { type: 'text', text: INSTRUCAO_FATOS_DO_LEAD },
    { type: 'text', text: INSTRUCAO_DISPONIBILIDADE_CONTATO },
    { type: 'text', text: INSTRUCAO_EVENTOS },
    // Ficha do atendimento (canário): bloco ESTÁTICO, só para quem tem a ficha — o prefixo
    // desse lead é outro, mas continua idêntico entre as voltas e as rodadas dele.
    // Canário: a ficha (estado) e a VOZ DO JOÃO (persona, 21/09/2026) entram juntas.
    ...(opts.comFicha ? [{ type: 'text', text: INSTRUCAO_FICHA }, { type: 'text', text: INSTRUCAO_VOZ }] : []),
    { type: 'text', text: INSTRUCAO_CANAL_RESPOSTA, cache_control: { type: 'ephemeral' } },
  ];

  // O canal é local e tem definição controlada em código, mesmo que o catálogo
  // traga uma homônima. Um único breakpoint nas tools mantém o total em três.
  const tools = [
    ...opts.tools.filter((tool) => tool.name !== NOME_TOOL_RESPOSTA).map(({ cache_control: _cache, ...tool }) => tool),
    { ...TOOL_RESPONDER_AO_CLIENTE, cache_control: { type: 'ephemeral' } },
  ];
  const ferramentasDisponiveis = new Set<string>(tools.map((tool) => tool.name));

  // Clona (não muta o array do chamador — o webchat mantém o dele entre voltas).
  const messages = opts.messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content)
      ? m.content.map(({ cache_control: _cache, ...bloco }: any) => bloco)
      : m.content,
  }));
  const ult: any = messages[messages.length - 1];
  if (ult) {
    const blocos: any[] = Array.isArray(ult.content)
      ? ult.content.map((b: any) => ({ ...b }))
      : [{ type: 'text', text: String(ult.content) }];
    if (blocos.length) {
      blocos[blocos.length - 1] = { ...blocos[blocos.length - 1], cache_control: { type: 'ephemeral' } };
    }
    // ⚠️ O bloco temporal é ANEXADO ao último turno — que numa volta pós-tool é o
    // `user` com o tool_result. Sem rótulo, o modelo lê "turno do usuário contendo
    // só metadado" e RELATA isso ao lead: em 25/07 ele enviou, literalmente, "Não há
    // uma nova mensagem do lead aqui, apenas o contexto temporal." (o surto de
    // relatórios começou depois que o prompt cache de 3 camadas tirou este bloco do
    // system e o trouxe pra cá). O rótulo diz o que o bloco É; a posição não muda,
    // então o cache segue intacto.
    if (opts.contextoTemporal && opts.contextoTemporal.trim() !== '') {
      blocos.push({
        type: 'text',
        text: '[CONTEXTO TEMPORAL DO SISTEMA — não é mensagem do lead e não é assunto de conversa. '
          + 'AGORA situa esta rodada e os novos pedidos do lead; não é a data de envio do histórico ou das citações. '
          + 'Hoje ou amanhã em um convite se referem ao dia em que ele foi enviado, que pode não estar disponível. '
          + 'Este relógio não confirma que um evento de convite antigo ocorrerá hoje. '
          + 'NUNCA comente este bloco nem diga que só recebeu ele.]\n'
          + opts.contextoTemporal,
      });
    }
    // O webhook pode atualizar o status entre duas voltas. Mantém o estado de
    // entrega fora do prefixo em cache e da memória persistida da conversa.
    if (opts.contextoEntregaMateriais) {
      blocos.push({ type: 'text', text: opts.contextoEntregaMateriais });
    }
    // Ficha do atendimento: estado determinístico, relido a cada volta, fora do cache.
    if (opts.contextoFicha) blocos.push({ type: 'text', text: opts.contextoFicha });
    if (falhaCompatibilidade) blocos.push({ type: 'text', text: '[ESTADO INTERNO DA CONSULTA — não é fala do lead]\n' + INSTRUCAO_FALHA_COMPATIBILIDADE });
    ult.content = blocos;
  }

  // thinking adaptativo (o formato budget_tokens dá 400 no Sonnet 5); max_tokens com
  // folga porque o thinking conta DENTRO dele e o tokenizer do Sonnet 5 gasta ~30% mais.
  const pedido = {
    model: MODELO_AGENTE,
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system,
    messages,
    tools,
  };
  const provedor = opts.provedor ?? null;
  const resposta = await chamarAnthropic(pedido, {}, provedor, opts.prazoModeloMs);
  const contemBastidor = (texto: string) => contemRaciocinioVazado(texto) || contemMeta(texto);
  const decisao = avaliarCanalResposta(resposta, contemBastidor, false, ferramentasDisponiveis);
  if (decisao.tipo !== 'corrigir') return normalizarRespostaCanal(resposta, decisao);

  // Uma única correção, só em memória: não grava rascunho/reinstrução e não executa
  // ações — o tool_choice forçado (sem paralelismo) só deixa sair responder_ao_cliente.
  // ⚠️ CUSTO: as `tools` ficam IDÊNTICAS às do pedido original. Elas são a posição 0 do
  // prefixo de cache: reduzir a lista aqui invalidava tools + prompt + histórico e
  // regravava ~33k tokens a 1,25x em 16–24% das chamadas (US$ 35–55 só em 15/09/2026).
  // O bloco extra do system vem DEPOIS do breakpoint, então tools + prompt são lidos.
  try {
    const corrigida = await chamarAnthropic({
      ...pedido,
      thinking: { type: 'disabled' },
      tool_choice: { type: 'tool', name: NOME_TOOL_RESPOSTA, disable_parallel_tool_use: true },
      system: [...system, {
        type: 'text',
        text: '[CORREÇÃO INTERNA DO CANAL] Nenhuma mensagem do rascunho anterior foi publicada. '
          + 'Responda à conversa exclusivamente por responder_ao_cliente, somente com a fala ao cliente. '
          + 'Os resultados das ferramentas são dados internos; o cliente não leu esses textos. '
          + 'Responda à pergunta concreta com os fatos confirmados nos resultados e no histórico, '
          + 'sem apontar para uma informação que o cliente ainda não recebeu. '
          + 'Consulta de informação não significa envio de mensagem. Preserve os fatos confirmados; '
          + 'não invente valores, condições ou ações realizadas. '
          + 'Não mencione esta correção nem descreva raciocínio, decisões ou ações internas. '
          + 'Use mensagem vazia quando o contexto pedir silêncio. Nenhuma ferramenta de negócio pode ser chamada nesta correção.',
      }],
    }, {}, provedor, opts.prazoModeloMs);
    return normalizarRespostaCanal({
      ...corrigida, usage: somarUsoModelo(resposta.usage, corrigida.usage),
    }, avaliarCanalResposta(corrigida, contemBastidor, true), decisao.motivo);
  } catch {
    // Erro do provedor pode carregar prompt/credencial. Registra-se só o motivo.
    return normalizarRespostaCanal(resposta, { tipo: 'bloquear', motivo: 'falha_na_correcao' }, decisao.motivo);
  }
}

// ── Tools do agente: mesma fonte do n8n (tabela lista_tools_claude) ─────────
export async function carregarTools(supabase: any, agente: string, provedor: ProvedorIA | null = null): Promise<any[]> {
  // OpenAI tem a SUA tabela (lista_tools_openai), no formato nativo da Responses API. O modelo
  // recebe exatamente a linha: `descreverToolsSdr` NÃO roda aqui, de propósito — o que está
  // na tabela é o que ele lê. Por dentro o agente fala um contrato só (name/description/
  // input_schema), então a linha é convertida na entrada e o tradutor a devolve na saída.
  if (provedor?.formato === 'openai') {
    const { data, error } = await supabase
      .from('lista_tools_openai')
      .select('tool')
      .eq('type', 'ppg')
      .eq('agente', agente)
      .order('id');
    if (error) throw new Error(`carregarTools (openai): ${error.message}`);
    const tools = (data ?? []).map((r: any) => r.tool).filter(Boolean);
    // Tabela vazia para a persona NÃO vira "agente sem ferramentas" em silêncio.
    if (!tools.length) throw new Error(`carregarTools (openai): nenhuma tool para ${agente} em lista_tools_openai`);
    return tools.map((t: any) => ({
      name: t.name, description: t.description ?? '', input_schema: t.parameters, ...(t.strict === true ? { strict: true } : {}),
    }));
  }
  // ORDER BY estável: a ordem das tools entra no prefixo de cache — ordem variável
  // entre chamadas = prefixo diferente = cache miss silencioso.
  const { data, error } = await supabase
    .from('lista_tools_claude')
    .select('tool')
    .eq('type', 'ppg')
    .eq('agente', agente)
    .order('id');
  if (error) throw new Error(`carregarTools: ${error.message}`);
  return descreverToolsSdr((data ?? []).map((r: any) => r.tool).filter(Boolean));
}
