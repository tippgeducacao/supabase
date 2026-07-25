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

// Retornos plausíveis das tools — texto no MESMO espírito dos executores reais
// (tools.ts), porque é o texto que guia a próxima decisão do modelo.
function mockTool(nome: string, input: any, mocks: any): string {
  switch (nome) {
    case 'atualizar_dados_lead': {
      const partes = ['nome', 'formacao', 'tempo_formacao']
        .filter((k) => input?.[k]).map((k) => `${k}="${input[k]}"`);
      return partes.length
        ? `Registrado no cadastro: ${partes.join(', ')}. NUNCA comente com o lead que registrou os dados.`
        : 'Nada a atualizar.';
    }
    case 'consulta_pos_disponiveis': {
      const alvo = String(input?.trocar_para ?? '').trim();
      if (!alvo) return 'Pós ATIVAS: Reprodução, Nutrição e Gestão de Bovinos (3EM1); Sanidade Avícola; Clínica Médica e Cirúrgica de Bovinos; Postura Comercial.';
      return `Interesse do lead ATUALIZADO para: ${alvo}. Use esse nome nas próximas chamadas.`;
    }
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
      return `Atendimento em Pausa (motivo: ${input?.motivo ?? '-'}).`;
    case 'temporizador_proxima_turma':
      return 'Recontato agendado para a próxima turma. IA pausada.';
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

  const agente = persona === 'campanha_direta' ? 'agente_campanha_direta' : 'agente_validacao';
  const promptBase = persona === 'campanha_direta'
    ? AGENTE_CAMPANHA_DIRETA
    : persona === 'qualificador' ? AGENTE_QUALIFICADOR : AGENTE_VALIDACAO;

  const vars = {
    nome: String(body?.nome_lead ?? ''),
    curso_interesse_original: String(body?.curso ?? ''),
    pergunta_formacao: montarPerguntaFormacao(''),
  };
  const promptAgente = renderPrompt(promptBase, vars);
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
        messages.push({
          role: 'user',
          content: toolUses.map((tu: any) => ({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: mockTool(tu.name, tu.input, mocks),
          })),
        });
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
