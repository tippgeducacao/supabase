// Tradutor Anthropic Messages ⇄ OpenAI Responses. O agente inteiro (router, loop
// principal, correção do canal) continua montando o pedido no formato da Anthropic; aqui
// ele é convertido na ida e a resposta é convertida na volta, para que NADA acima de
// `chamarAnthropic` precise saber qual provedor respondeu. Quem decide o provedor é quem
// chama (harness: campo "provedor"; produção: canário por telefone em crm_agente_sdr_config).
//
// Decisões que não são óbvias:
// - Responses API, não Chat Completions: a doc da OpenAI trata a segunda como
//   compatibilidade e o GPT-6 já exige a primeira para tool calling.
// - `function_call` vai SEM `id`: é o `id` que amarra o item ao raciocínio que o gerou
//   (e o João relê o histórico do banco a cada volta, sem raciocínio). Só `call_id`.
// - `strict` vem da PRÓPRIA tool e é sempre explícito (a referência não documenta o padrão):
//   as linhas de `lista_tools_openai` nascem com false (têm campo opcional, e o modo estrito
//   exige todos em required); `responder_ao_cliente` é true e cumpre as exigências — é o que
//   garante que a fala ao lead chega como {mensagem: string}.
// - `store: false`: a conversa do lead não fica guardada no provedor.
// - `cache_control` é descartado: o cache deles é automático (TTL 30 min).

// deno-lint-ignore-file no-explicit-any

export type ConfigOpenai = { modelo: string; esforco: string };

const textoDe = (conteudo: unknown): string => {
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return conteudo == null ? '' : JSON.stringify(conteudo);
  return conteudo
    .map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : typeof b === 'string' ? b : JSON.stringify(b)))
    .join('\n');
};

function itensDaMensagem(m: any): any[] {
  const blocos: any[] = Array.isArray(m.content) ? m.content : [];
  // `phase` (GPT-5.4+): a doc da OpenAI avisa que, ao reenviar o histórico à mão, mensagem
  // do assistant SEM fase degrada a conversa — o modelo passa a tratar preâmbulo como
  // resposta final. O histórico do João não guarda esse campo, mas ele se deduz por
  // construção: fala que o lead RECEBEU é mensagem só de texto (final_answer); texto
  // que acompanha chamada de tool é preâmbulo (commentary). Nunca vai em mensagem do user.
  const fase = m.role !== 'assistant' ? {}
    : { phase: blocos.some((b) => b?.type === 'tool_use') ? 'commentary' : 'final_answer' };
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content, ...fase }];
  const itens: any[] = [];
  // Resultado de tool vem ANTES de qualquer texto do mesmo turno: na Anthropic o
  // contexto temporal é anexado depois do tool_result, e a ordem precisa ser mantida.
  const partes: any[] = [];
  // Mensagem do assistant vai com `content` em STRING: na referência de `responses.create`
  // as partes tipadas de uma mensagem de entrada são só input_* — `output_text` pertence ao
  // item de SAÍDA (que exige id/status do provedor, e o histórico do João não tem).
  const descarregar = () => {
    if (!partes.length) return;
    const lote = partes.splice(0);
    itens.push({ role: m.role, content: m.role === 'assistant' ? lote.map((p) => p.text).join('\n') : lote, ...fase });
  };
  for (const b of blocos) {
    if (b?.type === 'text') {
      if (String(b.text ?? '') === '') continue;
      partes.push({ type: 'input_text', text: String(b.text) });
    } else if (b?.type === 'image' && m.role === 'user') {
      const url = b.source?.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source?.url;
      if (url) partes.push({ type: 'input_image', image_url: url });
    } else if (b?.type === 'tool_use') {
      descarregar();
      itens.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    } else if (b?.type === 'tool_result') {
      descarregar();
      itens.push({ type: 'function_call_output', call_id: b.tool_use_id, output: textoDe(b.content) });
    }
    // thinking / redacted_thinking: raciocínio de outro provedor não atravessa.
  }
  descarregar();
  return itens;
}

export function paraPedidoOpenai(body: Record<string, any>, cfg: ConfigOpenai): Record<string, unknown> {
  const pedido: Record<string, unknown> = {
    model: cfg.modelo,
    store: false,
    input: (body.messages ?? []).flatMap(itensDaMensagem),
    max_output_tokens: body.max_tokens,
    // thinking desligado na origem (router, correção) = sem raciocínio aqui também.
    reasoning: { effort: body.thinking?.type === 'disabled' ? 'none' : cfg.esforco },
  };
  const instrucoes = textoDe(body.system);
  if (instrucoes) pedido.instructions = instrucoes;
  if (Array.isArray(body.tools) && body.tools.length) {
    pedido.tools = body.tools.map((t: any) => ({
      type: 'function', name: t.name, description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} }, strict: t.strict === true,
    }));
  }
  const escolha = body.tool_choice;
  if (escolha?.type === 'tool') pedido.tool_choice = { type: 'function', name: escolha.name };
  else if (escolha?.type === 'any') pedido.tool_choice = 'required';
  else if (escolha?.type === 'none') pedido.tool_choice = 'none';
  if (escolha?.disable_parallel_tool_use === true) pedido.parallel_tool_calls = false;
  return pedido;
}

export function paraRespostaAnthropic(resp: any): Record<string, unknown> {
  const content: any[] = [];
  let recusou = false;
  for (const item of resp?.output ?? []) {
    if (item?.type === 'message') {
      for (const parte of item.content ?? []) {
        if (parte?.type === 'output_text' && parte.text) content.push({ type: 'text', text: parte.text });
        if (parte?.type === 'refusal') recusou = true;
      }
    } else if (item?.type === 'function_call') {
      // Argumento que não é JSON segue CRU: a validação do canal já trata "JSON em
      // string" como resposta a corrigir — engolir o erro aqui esconderia a falha.
      let input: unknown = item.arguments;
      try { input = JSON.parse(item.arguments); } catch { /* segue cru */ }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
    }
  }
  const motivoIncompleto = resp?.incomplete_details?.reason;
  const stop_reason = recusou || motivoIncompleto === 'content_filter' ? 'refusal'
    : resp?.status === 'incomplete' ? 'max_tokens'
    : content.some((b) => b.type === 'tool_use') ? 'tool_use'
    : 'end_turn';

  // Na OpenAI `input_tokens` é o TOTAL (cache incluído); na Anthropic é só o que não
  // veio do cache. O painel de custo soma os três campos, então separa-se aqui.
  const u = resp?.usage ?? {};
  const lido = Number(u.input_tokens_details?.cached_tokens ?? 0);
  const escrito = Number(u.input_tokens_details?.cache_write_tokens ?? 0);
  return {
    id: resp?.id, model: resp?.model, role: 'assistant', type: 'message', content, stop_reason,
    usage: {
      input_tokens: Math.max(0, Number(u.input_tokens ?? 0) - lido - escrito),
      cache_read_input_tokens: lido,
      cache_creation_input_tokens: escrito,
      output_tokens: Number(u.output_tokens ?? 0),
      output_tokens_details: { thinking_tokens: Number(u.output_tokens_details?.reasoning_tokens ?? 0) },
    },
  };
}
