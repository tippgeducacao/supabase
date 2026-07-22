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
    system: PROMPT_ROUTER,
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

// ── Loop principal: prompt cacheado + contexto temporal fresh + thinking ────
export async function chamarAgentePrincipal(opts: {
  promptAgente: string;
  contextoTemporal: string;
  messages: Msg[];
  tools: any[];
}): Promise<any> {
  const system: any[] = [
    { type: 'text', text: opts.promptAgente, cache_control: { type: 'ephemeral' } },
  ];
  if (opts.contextoTemporal && opts.contextoTemporal.trim() !== '') {
    system.push({ type: 'text', text: opts.contextoTemporal });
  }

  // thinking adaptativo (o formato budget_tokens dá 400 no Sonnet 5); max_tokens com
  // folga porque o thinking conta DENTRO dele e o tokenizer do Sonnet 5 gasta ~30% mais.
  return await chamarAnthropic({
    model: MODELO_AGENTE,
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system,
    messages: opts.messages,
    tools: opts.tools,
  });
}

// ── Tools do agente: mesma fonte do n8n (tabela lista_tools_claude) ─────────
export async function carregarTools(supabase: any, agente: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('lista_tools_claude')
    .select('tool')
    .eq('type', 'ppg')
    .eq('agente', agente);
  if (error) throw new Error(`carregarTools: ${error.message}`);
  return (data ?? []).map((r: any) => r.tool).filter(Boolean);
}
