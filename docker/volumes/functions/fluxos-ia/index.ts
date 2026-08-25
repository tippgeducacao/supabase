/**
 * fluxos-ia — o cérebro da tela "Fluxos".
 *
 * Duas ações:
 *   · `analisar`            — lê o GRAFO do banco, manda pro Claude e devolve
 *                             diagnósticos + perguntas + fluxo revisado + o PROMPT
 *                             DE IMPLEMENTAÇÃO. Responde em SSE.
 *   · `gerar-por-descricao` — texto livre → Mermaid, para nascer um fluxo do zero.
 *                             Responde JSON simples (é rápido).
 *
 * ⚠️ POR QUE `analisar` É STREAMING mesmo devolvendo um resultado só no fim.
 * A análise leva de 30 a 120 segundos. Uma resposta HTTP que fica esse tempo SEM
 * enviar byte nenhum é exatamente o que o proxy à frente (Cloudflare/Kong) corta por
 * ociosidade — e o corte volta como 502/504 sem cabeçalho CORS, ou seja, o navegador
 * mostra "erro de rede" e o usuário não faz ideia do que aconteceu. Consumindo o
 * stream da Anthropic aqui e reemitindo eventos nossos, a conexão nunca fica ociosa,
 * e de quebra a tela mostra progresso de verdade em vez de um spinner mudo.
 *
 * ⚠️ O GRAFO VEM DO BANCO, NUNCA DO CORPO DA REQUISIÇÃO. É o autosave do editor que
 * grava `grafo`/`grafo_hash`; aceitar um grafo do cliente permitiria analisar uma
 * coisa e cachear sob o hash de outra, envenenando o cache do próprio usuário.
 *
 * Deploy: git push na main (deploy-edges.yml). NUNCA o botão "Deploy" do Dokploy.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { grafoParaMermaid, type Grafo } from './mermaid.ts';
import {
  FERRAMENTA_ANALISE, FERRAMENTA_DESENHAR, montarMensagem, montarSystem, SISTEMA_DESENHAR,
} from './prompt.ts';
import { limparMermaid, mermaidParecePlausivel, zAnalise, zDesenho } from './validar.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = Deno.env.get('FLUXOS_MODEL') || 'claude-sonnet-5';
const MAX_TOKENS = 16000;

/** Teto por usuário/hora. Análise é a operação cara da tela; um loop no front
 *  (ou um F5 nervoso) queimaria crédito sem ninguém perceber. */
const LIMITE_POR_HORA = 30;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// ─────────────────────────────────────────────────────────────────────────────

async function chaveAnthropic(admin: ReturnType<typeof createClient>): Promise<string | null> {
  const env = Deno.env.get('FLUXOS_ANTHROPIC_KEY');
  if (env) return env;
  const { data } = await admin
    .from('ai_api_keys')
    .select('api_key')
    .eq('provider', 'anthropic')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  return (data as { api_key?: string } | null)?.api_key ?? null;
}

/**
 * Uma chamada ao Claude com `stream: true`, consumida aqui.
 *
 * Devolve o input da ferramenta (montado a partir dos `input_json_delta`) e o uso de
 * token. `aoProgredir` é chamado a cada pedaço, e é o que mantém a conexão viva.
 *
 * Parâmetros: `thinking: adaptive` + `effort: high` porque achar o ramo que FALTA num
 * processo é justamente o tipo de raciocínio que se beneficia disso. Sem
 * `temperature`/`top_p`/`budget_tokens` — a família 4.6+ rejeita os três com 400.
 * Sem `tool_choice` forçado: com thinking ligado, forçar ferramenta é recusado.
 */
async function chamarClaude(
  chave: string,
  opcoes: {
    system: string;
    mensagens: { role: 'user' | 'assistant'; content: string }[];
    ferramenta: unknown;
    nomeFerramenta: string;
    stream: boolean;
    aoProgredir?: (evento: { fase: string; caracteres: number }) => void;
  },
): Promise<{ input: Record<string, unknown> | null; texto: string; uso: Record<string, number> }> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': chave,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: opcoes.system,
      tools: [opcoes.ferramenta],
      messages: opcoes.mensagens,
      ...(opcoes.stream ? { stream: true } : {}),
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('[fluxos-ia] anthropic', res.status, txt.slice(0, 500));
    throw new Error(`IA respondeu ${res.status}. ${txt.slice(0, 200)}`);
  }

  if (!opcoes.stream) {
    const data = await res.json();
    const blocos: Record<string, unknown>[] = Array.isArray(data?.content) ? data.content : [];
    const uso = data?.usage ?? {};
    const tool = blocos.find((b) => b.type === 'tool_use' && b.name === opcoes.nomeFerramenta);
    const texto = blocos.filter((b) => b.type === 'text').map((b) => (b.text as string) ?? '').join('\n').trim();
    return { input: (tool?.input as Record<string, unknown>) ?? null, texto, uso };
  }

  // ── Stream ────────────────────────────────────────────────────────────────
  // O input da ferramenta chega em pedaços de JSON (`input_json_delta`) que só viram
  // objeto quando o último chega. Acumulamos a string e damos UM parse no fim.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let jsonDaFerramenta = '';
  let texto = '';
  let fase = 'lendo o fluxo';
  let uso: Record<string, number> = {};
  let dentroDaFerramenta = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const linhas = buffer.split('\n');
    buffer = linhas.pop() ?? '';

    for (const linha of linhas) {
      const t = linha.trim();
      if (!t.startsWith('data:')) continue;
      const bruto = t.slice(5).trim();
      if (!bruto || bruto === '[DONE]') continue;
      let ev: Record<string, any>;
      try { ev = JSON.parse(bruto); } catch { continue; }

      if (ev.type === 'content_block_start') {
        if (ev.content_block?.type === 'thinking') fase = 'analisando o processo';
        if (ev.content_block?.type === 'tool_use') { fase = 'escrevendo o resultado'; dentroDaFerramenta = true; }
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'input_json_delta' && dentroDaFerramenta) {
          jsonDaFerramenta += ev.delta.partial_json ?? '';
        } else if (ev.delta?.type === 'text_delta') {
          texto += ev.delta.text ?? '';
        }
      } else if (ev.type === 'content_block_stop') {
        dentroDaFerramenta = false;
      } else if (ev.type === 'message_delta') {
        if (ev.usage) uso = { ...uso, ...ev.usage };
      } else if (ev.type === 'message_start') {
        if (ev.message?.usage) uso = { ...uso, ...ev.message.usage };
      } else if (ev.type === 'error') {
        throw new Error(ev.error?.message ?? 'Erro no stream da IA.');
      }
      opcoes.aoProgredir?.({ fase, caracteres: jsonDaFerramenta.length });
    }
  }

  let input: Record<string, unknown> | null = null;
  if (jsonDaFerramenta) {
    // ⚠️ Sempre JSON.parse — nunca casar string na saída bruta. Os modelos 4.6+ variam
    // o escape (unicode, barra) dentro do input da ferramenta.
    try { input = JSON.parse(jsonDaFerramenta); }
    catch (e) { console.error('[fluxos-ia] input da ferramenta não parseou', e); }
  }
  return { input, texto: texto.trim(), uso };
}

// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // ── Autenticação ────────────────────────────────────────────────────────
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'Não autenticado.' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'Sessão inválida.' }, 401);
    const usuario = userData.user;

    // ── Autorização: a MESMA allowlist da tela e da RLS ─────────────────────
    // O service_role passa por cima da RLS, então sem esta checagem qualquer usuário
    // logado do sistema conseguiria mandar analisar (e pagar) o fluxo de outro.
    const { data: permitido } = await admin.rpc('fluxos_dev_email_de', { p_email: usuario.email });
    if (permitido !== true) return json({ error: 'Sem acesso aos Fluxos.' }, 403);

    const corpo = await req.json().catch(() => ({}));
    const acao = String(corpo?.acao ?? 'analisar');

    const chave = await chaveAnthropic(admin);
    if (!chave) return json({ error: 'IA indisponível: nenhuma chave Anthropic ativa configurada.' }, 503);

    if (acao === 'gerar-por-descricao') return await gerarPorDescricao(chave, corpo);
    if (acao === 'analisar') {
      // Rate limit SÓ aqui: `analisar` é a operação cara e é a única que grava na
      // tabela que serve de contador. O gerador por descrição é uma chamada curta.
      const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await admin
        .from('fluxo_diagrama_analises')
        .select('id', { count: 'exact', head: true })
        .eq('criado_por', usuario.id)
        .gte('criado_em', umaHoraAtras);
      if ((count ?? 0) >= LIMITE_POR_HORA) {
        return json({ error: `Limite de ${LIMITE_POR_HORA} análises por hora atingido. Tente daqui a pouco.` }, 429);
      }
      return await analisar(admin, chave, corpo, usuario.id);
    }
    return json({ error: `Ação desconhecida: ${acao}` }, 400);
  } catch (e) {
    console.error('[fluxos-ia]', e);
    // 422 e nunca 5xx: o proxy engole 502/504 da origem sem cabeçalho CORS, e o
    // navegador mostra "erro de rede" em vez da mensagem real.
    return json({ error: (e as Error)?.message ?? 'Erro desconhecido' }, 422);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

async function gerarPorDescricao(chave: string, corpo: Record<string, unknown>): Promise<Response> {
  const texto = String(corpo?.texto ?? '').trim();
  if (texto.length < 10) return json({ error: 'Descreva o processo com um pouco mais de detalhe.' }, 400);
  if (texto.length > 8000) return json({ error: 'Descrição longa demais (máx. 8.000 caracteres).' }, 400);

  const { input } = await chamarClaude(chave, {
    system: SISTEMA_DESENHAR,
    mensagens: [{ role: 'user', content: texto }],
    ferramenta: FERRAMENTA_DESENHAR,
    nomeFerramenta: 'desenhar_fluxo',
    stream: false,
  });

  const parse = zDesenho.safeParse(input);
  if (!parse.success) return json({ error: 'A IA não devolveu um fluxo utilizável. Tente descrever de outro jeito.' }, 422);

  const mermaid = limparMermaid(parse.data.mermaid);
  if (!mermaidParecePlausivel(mermaid)) {
    return json({ error: 'A IA devolveu um diagrama inválido. Tente descrever de outro jeito.' }, 422);
  }
  return json({ mermaid, resumo: parse.data.resumo, titulo: parse.data.titulo });
}

async function analisar(
  admin: ReturnType<typeof createClient>,
  chave: string,
  corpo: Record<string, unknown>,
  usuarioId: string,
): Promise<Response> {
  const fluxoId = String(corpo?.fluxoId ?? '');
  if (!fluxoId) return json({ error: 'fluxoId é obrigatório.' }, 400);
  const forcar = corpo?.forcar === true;

  const { data: fluxo } = await admin
    .from('fluxo_diagramas')
    .select('id, nome, descricao, grafo, grafo_hash')
    .eq('id', fluxoId)
    .maybeSingle();
  if (!fluxo) return json({ error: 'Fluxo não encontrado.' }, 404);

  const grafo = (fluxo as { grafo?: Grafo }).grafo;
  const hash = (fluxo as { grafo_hash?: string }).grafo_hash ?? '';
  if (!grafo || !Array.isArray(grafo.nodes) || grafo.nodes.length === 0) {
    return json({ error: 'Desenhe pelo menos uma etapa antes de pedir a análise.' }, 400);
  }
  if (grafo.edges.length === 0) {
    return json({ error: 'Ligue as etapas com setas — sem ligação não há fluxo para analisar.' }, 400);
  }

  // ── Cache ────────────────────────────────────────────────────────────────
  if (!forcar && hash) {
    const { data: cache } = await admin
      .from('fluxo_diagrama_analises')
      .select('saida, modelo, criado_em')
      .eq('fluxo_id', fluxoId)
      .eq('grafo_hash', hash)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cache) {
      return json({
        analise: (cache as { saida: unknown }).saida,
        doCache: true,
        criadoEm: (cache as { criado_em: string }).criado_em,
        modelo: (cache as { modelo: string }).modelo,
      });
    }
  }

  // ── Stream ───────────────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enviar = (evento: string, dados: unknown) => {
        controller.enqueue(encoder.encode(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`));
      };
      try {
        enviar('progresso', { fase: 'lendo o fluxo', caracteres: 0 });

        const system = montarSystem();
        const mensagens: { role: 'user' | 'assistant'; content: string }[] = [
          { role: 'user', content: montarMensagem(grafo, (fluxo as { nome: string }).nome, (fluxo as { descricao: string | null }).descricao) },
        ];

        let { input, uso } = await chamarClaude(chave, {
          system, mensagens,
          ferramenta: FERRAMENTA_ANALISE,
          nomeFerramenta: 'entregar_analise',
          stream: true,
          aoProgredir: (p) => enviar('progresso', p),
        });

        let parse = zAnalise.safeParse(input);

        // ── Uma correção, e só uma ────────────────────────────────────────
        // Se a saída não validou (ou o Mermaid veio quebrado), vale pedir de novo
        // apontando o erro — o modelo quase sempre acerta na segunda. Uma vez só:
        // a terceira tentativa custa o mesmo e quase nunca muda o resultado.
        const mermaidRuim = parse.success && !mermaidParecePlausivel(parse.data.fluxo_sugerido_mermaid);
        if (!parse.success || mermaidRuim) {
          enviar('progresso', { fase: 'corrigindo a resposta', caracteres: 0 });
          const problema = !parse.success
            ? `A resposta não bateu com o schema: ${parse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
            : 'O campo fluxo_sugerido_mermaid não é um flowchart válido (precisa começar com "flowchart TD" e ter pelo menos uma seta "-->").';
          // ⚠️ NÃO reencena o turno do assistente. Com thinking ligado, devolver um
          // turno de assistente forjado (sem os blocos de thinking originais) é
          // rejeitado pela API — e aí a "correção" falharia com 400 em vez de
          // corrigir. Refazemos como UMA pergunta nova, com a tentativa anterior
          // citada como texto.
          const mensagensCorrecao: typeof mensagens = [
            mensagens[0],
            {
              role: 'user',
              content: [
                'Sua tentativa anterior de chamar "entregar_analise" veio assim:',
                '```json',
                JSON.stringify(input).slice(0, 6000),
                '```',
                '',
                `Problema: ${problema}`,
                '',
                'Refaça a chamada de "entregar_analise" corrigindo APENAS isso e mantendo o resto do conteúdo igual.',
              ].join('\n'),
            },
          ];

          const segunda = await chamarClaude(chave, {
            system, mensagens: mensagensCorrecao,
            ferramenta: FERRAMENTA_ANALISE,
            nomeFerramenta: 'entregar_analise',
            stream: true,
            aoProgredir: (p) => enviar('progresso', p),
          });
          input = segunda.input;
          uso = { ...uso, ...segunda.uso };
          parse = zAnalise.safeParse(input);
        }

        if (!parse.success) {
          enviar('erro', { mensagem: 'A IA não devolveu uma análise no formato esperado. Tente de novo.' });
          controller.close();
          return;
        }

        const analise = { ...parse.data, fluxo_sugerido_mermaid: limparMermaid(parse.data.fluxo_sugerido_mermaid) };

        const { data: gravada } = await admin
          .from('fluxo_diagrama_analises')
          .insert({
            fluxo_id: fluxoId,
            grafo_hash: hash,
            entrada: { grafo, mermaid: grafoParaMermaid(grafo) },
            saida: analise,
            modelo: MODELO,
            tokens_entrada: uso.input_tokens ?? null,
            tokens_saida: uso.output_tokens ?? null,
            criado_por: usuarioId,
          })
          .select('id, criado_em')
          .maybeSingle();

        enviar('resultado', {
          analise,
          doCache: false,
          id: (gravada as { id?: string } | null)?.id,
          criadoEm: (gravada as { criado_em?: string } | null)?.criado_em,
          modelo: MODELO,
          tokens: { entrada: uso.input_tokens ?? null, saida: uso.output_tokens ?? null },
        });
      } catch (e) {
        console.error('[fluxos-ia] analisar', e);
        enviar('erro', { mensagem: (e as Error)?.message ?? 'Erro desconhecido na análise.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      // Sem isto o nginx/Kong bufferiza e entrega tudo de uma vez no fim — matando
      // exatamente o motivo de existir do streaming aqui.
      'X-Accel-Buffering': 'no',
    },
  });
}
