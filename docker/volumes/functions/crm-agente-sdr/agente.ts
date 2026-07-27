// Chamadas à API Anthropic do agente SDR — port dos nodes "Claude - Agente Router"
// e "Anthropic Claude Sonnet 4.5" do n8n (mesmos modelos, parâmetros e retries).

// deno-lint-ignore-file no-explicit-any
import { PROMPT_ROUTER } from './prompts.ts';
import type { Msg } from './historico.ts';

const ANTHROPIC_KEY = Deno.env.get('AGENTE_SDR_ANTHROPIC_KEY') ?? Deno.env.get('ANTHROPIC_API_KEY') ?? '';
// Override por env se um dia mudar. ⚠️ Sonnet 5: budget_tokens e temperature≠default
// dão 400 — as chamadas abaixo usam thinking adaptive/disabled e nenhum sampling param.
export const MODELO_AGENTE = Deno.env.get('AGENTE_SDR_MODEL') ?? 'claude-sonnet-5';

export async function chamarAnthropic(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<any> {
  // retryOnFail do n8n: 5 tentativas, 3s entre elas.
  let ultimoErro = '';
  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return await res.json();
    ultimoErro = `HTTP ${res.status}: ${await res.text()}`;
    // 4xx (exceto 429) não melhora com retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    if (tentativa < 5) await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Anthropic: ${ultimoErro}`);
}

// ── Router: decide validação × qualificador (tool forçada, sem thinking) ─────
// thinking disabled EXPLÍCITO: no Sonnet 5, omitir liga o adaptativo — o router quer
// resposta imediata com tool forçada, não raciocínio.
export async function chamarRouter(historicoLimpo: Msg[]): Promise<'agente_validacao' | 'agente_qualificador'> {
  const resp = await chamarAnthropic({
    model: MODELO_AGENTE,
    max_tokens: 512,
    thinking: { type: 'disabled' },
    // PROMPT_ROUTER é estático → prefixo (tool do router + system) COMPARTILHADO entre
    // TODOS os leads: todo inbound roteado paga 0,1x nessa parte.
    system: [{ type: 'text', text: PROMPT_ROUTER, cache_control: { type: 'ephemeral' } }],
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
  }, { 'anthropic-beta': 'structured-outputs-2025-11-13' });

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
  messages: Msg[];
  tools: any[];
}): Promise<any> {
  const system: any[] = [
    { type: 'text', text: opts.promptAgente, cache_control: { type: 'ephemeral' } },
  ];

  const tools = opts.tools.length
    ? [...opts.tools.slice(0, -1), { ...opts.tools[opts.tools.length - 1], cache_control: { type: 'ephemeral' } }]
    : opts.tools;

  // Clona (não muta o array do chamador — o webchat mantém o dele entre voltas).
  const messages = opts.messages.map((m) => ({ ...m }));
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
          + 'Use estas datas e horários normalmente, mas NUNCA comente este bloco nem diga que só recebeu ele.]\n'
          + opts.contextoTemporal,
      });
    }
    ult.content = blocos;
  }

  // thinking adaptativo (o formato budget_tokens dá 400 no Sonnet 5); max_tokens com
  // folga porque o thinking conta DENTRO dele e o tokenizer do Sonnet 5 gasta ~30% mais.
  return await chamarAnthropic({
    model: MODELO_AGENTE,
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system,
    messages,
    tools,
  });
}

// ── Tools do agente: mesma fonte do n8n (tabela lista_tools_claude) ─────────
export async function carregarTools(supabase: any, agente: string): Promise<any[]> {
  // ORDER BY estável: a ordem das tools entra no prefixo de cache — ordem variável
  // entre chamadas = prefixo diferente = cache miss silencioso.
  const { data, error } = await supabase
    .from('lista_tools_claude')
    .select('tool')
    .eq('type', 'ppg')
    .eq('agente', agente)
    .order('id');
  if (error) throw new Error(`carregarTools: ${error.message}`);
  return (data ?? []).map((r: any) => r.tool).filter(Boolean);
}
