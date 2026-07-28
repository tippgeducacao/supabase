// crm-agente-sdr-simular — HARNESS DE TESTE do agente SDR. Roda o prompt REAL e as
// tools REAIS (os mesmos schemas que o modelo vê em produção) contra um roteiro de
// mensagens do lead, e devolve o transcript: o que o João diria e quais tools chamou.
//
// ⚠️ NADA É ENVIADO AO LEAD e NADA É GRAVADO no histórico de produção:
//   • os tool_results são MOCKADOS aqui (o cenário decide se a matriz aprova, etc.);
//   • não há POST no crm-whatsapp-send, não há insert em cliente_ppg_mensagens_sdr;
//   • o telefone é fictício.
// Serve pra validar COMPORTAMENTO do prompt (ordem da coleta, trava do cronograma,
// encerramentos) sem queimar número, sem custo de WhatsApp e sem esperar debounce.
//
// Uso (POST, header x-followup-key = crm_agente_sdr_config.followup_secret):
//   { "persona": "campanha_direta",
//     "mensagens": ["Quero saber mais sobre a PÓS EM ...", "Carlos, sou med vet"],
//     "mocks": { "compatibilidade": "aprovado" | "reprovado" | "alternativa" } }

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from '../crm-agente-sdr/prompts.ts';
import { AGENTE_CAMPANHA_DIRETA } from '../crm-agente-sdr/prompts-campanha-direta.ts';
import { carregarTools, chamarAgentePrincipal } from '../crm-agente-sdr/agente.ts';
import { montarContextoTemporal, montarPerguntaFormacao, renderPrompt } from '../crm-agente-sdr/contexto.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

async function autorizado(req: Request): Promise<boolean> {
  const { data } = await supabase.from('crm_agente_sdr_config').select('followup_secret').eq('id', 1).maybeSingle();
  const segredo = data?.followup_secret ?? '';
  return Boolean(segredo) && req.headers.get('x-followup-key') === segredo;
}

// Catálogo + resolução de pós: espelha o executor real (tools.ts), usando as MESMAS
// fontes — a tabela cursos e a RPC fn_sdr_api_resolver_pos_graduacao. É isso que faz o
// teste valer pra "o lead pediu uma pós que não existe".
async function resolverPos(alvo: string): Promise<string> {
  const { data: cursos } = await supabase
    .from('cursos').select('nome').eq('ativo', true).eq('modalidade', 'Pós-Graduação').order('nome');
  const lista = ((cursos ?? []) as { nome: string }[]).map((c) => `- ${c.nome}`).join('\n');
  if (!alvo) {
    return `Pós-graduações ATIVAS da PPG:\n${lista}\nCite só as relevantes (máx. 3-4), sem os prefixos "PÓS |"/"MBA |".`;
  }
  const { data: resolved } = await supabase.rpc('fn_sdr_api_resolver_pos_graduacao', { p_valor: alvo });
  // ⚠️ O resolver ECOA o texto buscado no campo `nome` mesmo quando NÃO acha nada
  // ({"id": null, "nome": "equinos"}). Quem decide é o **id** — é assim que o executor
  // real (tools.ts) faz. Checar o nome dava "achou" pra qualquer coisa e fazia o agente
  // confirmar pós inexistente no teste (falso positivo do harness).
  const cursoId = (resolved as any)?.id ?? null;
  const nomeOficial = String((resolved as any)?.nome ?? '').trim();
  if (!cursoId) {
    return `Não achei uma pós correspondente a "${alvo}". Catálogo ativo:\n${lista}\n` +
      `Confirme com o lead qual dessas ele quer (cite as 2-3 mais próximas, sem os prefixos).`;
  }
  const nomeConversa = nomeOficial.replace(/^p[oó]s\s*\|\s*/i, '').replace(/^mba\s*\|\s*/i, 'MBA ').trim();
  return `Interesse do lead ATUALIZADO para: ${nomeConversa} (nome oficial: ${nomeOficial}). ` +
    `Daqui em diante use "${nomeConversa}" em TODAS as chamadas.`;
}

// Retornos plausíveis das tools — texto no MESMO espírito dos executores reais
// (tools.ts), porque é o texto que guia a próxima decisão do modelo.
async function mockTool(nome: string, input: any, mocks: any): Promise<string> {
  switch (nome) {
    case 'atualizar_dados_lead': {
      const partes = ['nome', 'formacao', 'tempo_formacao']
        .filter((k) => input?.[k]).map((k) => `${k}="${input[k]}"`);
      return partes.length
        ? `Registrado no cadastro: ${partes.join(', ')}. NUNCA comente com o lead que registrou os dados.`
        : 'Nada a atualizar.';
    }
    // ⚠️ Este mock NÃO pode confirmar qualquer curso: a 1ª versão devolvia
    // "Interesse ATUALIZADO para: <o que o modelo pediu>" e o agente, confiando na
    // ferramenta (comportamento CORRETO), dizia "temos sim a pós de equinos" — um
    // falso positivo do harness, não um erro do agente. Aqui usamos o RESOLVER REAL
    // (fn_sdr_api_resolver_pos_graduacao), o mesmo de produção.
    case 'consulta_pos_disponiveis':
      return await resolverPos(String(input?.trocar_para ?? '').trim());
    case 'envia_informacoes':
      return `Cronograma enviado ao lead no WhatsApp (conteudo="${input?.conteudo ?? '?'}"). Valor integral: R$ 4.200,00.`;
    case 'verificar_compatibilidade_curso': {
      const m = mocks?.compatibilidade ?? 'aprovado';
      if (m === 'reprovado') {
        return 'REPROVADO. A formação do lead não é compatível com esta pós e NÃO há curso alternativo. Encerre com respeito e chame pausa_ia.';
      }
      if (m === 'alternativa') {
        return 'REPROVADO para esta pós (exclusiva de médico veterinário). curso_alternativo: "Gestão de Pessoas e Extensão Rural". Ofereça a alternativa.';
      }
      if (m === 'prazo') {
        return 'REPROVADO_PRAZO. O lead conclui a graduação fora do prazo. NÃO agende reunião: encerre com respeito e chame pausa_ia.';
      }
      return 'APROVADO. A formação do lead é compatível com a pós de interesse.';
    }
    case 'consulta_disponibilidade':
      return '- 15:00 de quinta, dia 30/07 (vendedor_id: v1, nome: Ana)\n- 16:30 de quinta, dia 30/07 (vendedor_id: v1, nome: Ana)';
    case 'consulta_objecoes':
      return 'resposta_objecao: "a conversa com o monitor é rápida, uns 15 minutos, e é onde vc vê a condição especial". Adapte ao contexto e reconduza pro agendamento.';
    case 'pausa_ia':
      // Espelha o executor real: tipo="nao_perturbe" arquiva o lead (opt-out).
      return input?.tipo === 'nao_perturbe'
        ? `Atendimento em Pausa e lead ARQUIVADO (opt-out, motivo: ${input?.motivo ?? '-'}). Ele sai de todos os disparos.`
        : `Atendimento em Pausa (motivo: ${input?.motivo ?? '-'}).`;
    case 'temporizador_proxima_turma':
      return 'Recontato agendado para a próxima turma. IA pausada.';
    case 'agendar_retorno': {
      // Espelha o clamp DURO do banco (crm_agente_timer_retorno): 1..7.
      const pedidos = Number(input?.dias ?? 3);
      const aplicados = Math.min(Math.max(Number.isFinite(pedidos) ? pedidos : 3, 1), 7);
      const d = new Date();
      d.setDate(d.getDate() + aplicados);
      const br = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return `Retorno agendado para ${br} (${aplicados} dia(s))`
        + (aplicados !== pedidos ? ` — o pedido de ${pedidos} dias foi limitado ao teto de 7.` : '')
        + `. O lead fica fora dos disparos até lá e o time o retoma no dia. `
        + `Confirme a data com ele e despeça-se. NÃO chame pausa_ia.`;
    }
    default:
      return `Tool ${nome} executada.`;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await autorizado(req))) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'payload inválido' }, 400); }

  const persona: string = body?.persona ?? 'campanha_direta';
  const mensagensLead: string[] = Array.isArray(body?.mensagens) ? body.mensagens : [];
  const mocks = body?.mocks ?? {};
  if (!mensagensLead.length) return json({ error: 'mensagens[] obrigatório' }, 400);

  // agente_override: permite carregar as tools de uma persona de TESTE
  // (ex.: agente_teste_analise) sem tocar nas 4 personas de produção.
  const agente = String(body?.agente_override ?? '').trim()
    || (persona === 'campanha_direta' ? 'agente_campanha_direta'
        : persona === 'qualificador' ? 'agente_qualificador' : 'agente_validacao');
  const promptBase = persona === 'campanha_direta'
    ? AGENTE_CAMPANHA_DIRETA
    : persona === 'qualificador' ? AGENTE_QUALIFICADOR : AGENTE_VALIDACAO;

  const vars = {
    nome: String(body?.nome_lead ?? ''),
    curso_interesse_original: String(body?.curso ?? ''),
    pergunta_formacao: montarPerguntaFormacao(''),
  };
  // prompt_extra: bloco anexado ao FIM do prompt real, só nesta simulação.
  // Serve pra validar redação nova ANTES de commitá-la em prompts.ts (que é
  // código e, uma vez deployado, já vale pra produção).
  const promptExtra = String(body?.prompt_extra ?? '').trim();
  const promptAgente = renderPrompt(promptBase, vars) + (promptExtra ? `\n\n${promptExtra}` : '');
  const contextoTemporal = montarContextoTemporal();
  const tools = await carregarTools(supabase, agente);

  const messages: any[] = [];
  const transcript: any[] = [];

  for (const msgLead of mensagensLead) {
    messages.push({ role: 'user', content: msgLead });
    transcript.push({ quem: 'lead', texto: msgLead });

    // Loop agêntico igual ao de produção, com teto baixo (é teste).
    for (let volta = 0; volta < 6; volta++) {
      const resp: any = await chamarAgentePrincipal({ promptAgente, contextoTemporal, messages, tools });
      const blocos = (resp.content ?? []) as any[];
      const texto = blocos.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const toolUses = blocos.filter((b) => b.type === 'tool_use');

      messages.push({ role: 'assistant', content: resp.content });

      if (toolUses.length) {
        for (const tu of toolUses) {
          transcript.push({ quem: 'tool', nome: tu.name, input: tu.input });
        }
        const results = [];
        for (const tu of toolUses) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: await mockTool(tu.name, tu.input, mocks),
          });
        }
        messages.push({ role: 'user', content: results });
        if (texto) transcript.push({ quem: 'joao', texto });
        // pausa_ia encerra o atendimento — nada mais é dito.
        if (toolUses.some((tu: any) => tu.name === 'pausa_ia')) { volta = 99; break; }
        continue;
      }

      if (texto) transcript.push({ quem: 'joao', texto });
      break;
    }
  }

  const toolsChamadas = transcript.filter((t) => t.quem === 'tool').map((t) => t.nome);
  return json({ ok: true, persona, agente, transcript, tools_chamadas: toolsChamadas });
});
