// Chamadas à API Anthropic do agente SDR — port dos nodes "Claude - Agente Router"
// e "Anthropic Claude Sonnet 4.5" do n8n (mesmos modelos, parâmetros e retries).

// deno-lint-ignore-file no-explicit-any
import { PROMPT_ROUTER } from './prompts.ts';
import type { Msg } from './historico.ts';

const ANTHROPIC_KEY = Deno.env.get('AGENTE_SDR_ANTHROPIC_KEY') ?? Deno.env.get('ANTHROPIC_API_KEY') ?? '';
// Mesmo modelo do n8n (Credenciais.model); override por env se um dia mudar.
export const MODELO_AGENTE = Deno.env.get('AGENTE_SDR_MODEL') ?? 'claude-sonnet-4-6';

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

// ── Router: decide validação × qualificador (tool forçada, temp 0) ──────────
export async function chamarRouter(historicoLimpo: Msg[]): Promise<'agente_validacao' | 'agente_qualificador'> {
  const resp = await chamarAnthropic({
    model: MODELO_AGENTE,
    max_tokens: 512,
    temperature: 0,
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

  return await chamarAnthropic({
    model: MODELO_AGENTE,
    max_tokens: 4096,
    temperature: 1,
    thinking: { type: 'enabled', budget_tokens: 3000 },
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
