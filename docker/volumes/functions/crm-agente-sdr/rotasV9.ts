// Endpoints do agente no n8n em FORMATO v9 (01/10/2026). O Gustavo quer o esqueleto do "SDR v9.0
// multi-agent Claude (Production)" nó por nó: cada nó Postgres/Supabase do v9 vira uma chamada
// aqui, o Claude vira a Luna (por `luna`, que devolve a resposta no formato do Claude para os nós
// de depois não mudarem) e o router vira o Jev (o pedido sai de `router_pedido`).
// Autorização: a mesma do resto das rotas do n8n (segredo do desvio + telefone na lista de teste),
// feita no index.ts antes de chegar aqui. Lead de verdade não passa por estas rotas.

import { atualizarAgenteComRatchet, atualizarLead, buscarLead, carregarHistorico, criarLead, jidsDoTelefone } from './historico.ts';
import { pausaVigente } from './pausa.ts';
import { extrairPrimeiroNome, montarContextoTemporal, notaDoCurso } from './contexto.ts';
import { notaDoNome } from './nomeDoLead.ts';
import { contextoEspecialidadeCannabis } from './especialidadeCannabis.ts';
import { carregarReunioesDoLead, notaDasReunioes } from './reunioesDoLead.ts';
import { contextoAulaPiloto } from './contextoAulaPiloto.ts';
import { blocoElegibilidadeFormatura, limiteFormaturaFormatado } from './elegibilidadeFormatura.ts';
import {
  carregarCarreiraPorNome, linhaDoPerfil, objecaoDaPos, perguntasDaLinha, sobreDaObjecaoDeTempo, toolBuscaCarreira, VINCULOS_TRABALHO,
} from './carreiraPos.ts';
import { type AulaParaPrompt, montarVarsAula } from './prompts-aula.ts';
import { cursoDaConversa } from './ganchoLote.ts';
import { carregarTools, chamarAnthropic, type ProvedorIA } from './agente.ts';
import { TOOL_RESPONDER_AO_CLIENTE } from './canalResposta.ts';
import { comDescricoesDaAulaV9 } from './ferramentasAulaV9.ts';
import { type CtxConversa, executarTool } from './tools.ts';
import { contaDoLead } from './conta.ts';
import { limparConversaDeTeste } from './limparTeste.ts';
import { carregarConfigRouterJev, pedidoJevRouter } from './routerJev.ts';

// A busca do perfil (ideia do Wellinton): coletada a atuação, a IA diz o perfil e recebe só as
// perguntas daquele perfil. Desde 06/10/2026 os perfis são os da pós da aula (toolBuscaCarreira);
// esta é a versão genérica, para a pós sem perfis próprios.
export const TOOL_BUSCA_CARREIRA = toolBuscaCarreira(null);

export const ACOES_V9 = [
  'lead', 'criar_lead', 'tocar_lead', 'mensagens', 'gravar_mensagem', 'apagar_mensagem', 'agente',
  'contexto', 'tools', 'luna', 'router_pedido', 'tool', 'enviar_texto', 'limpar', 'carreira',
] as const;
export type AcaoV9 = typeof ACOES_V9[number];
export function ehAcaoV9(v: unknown): v is AcaoV9 {
  return (ACOES_V9 as readonly string[]).includes(String(v));
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SEND_URL = (Deno.env.get('AGENTE_SDR_SEND_URL') ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, '');

type Deps = { supabase: any; provedorDoLead: (telefone: string) => Promise<ProvedorIA | null> };

const soDigitos = (v: unknown) => String(v ?? '').split('@')[0].replace(/\D/g, '');

async function carregarAula(supabase: any, aulaId: string): Promise<AulaParaPrompt | null> {
  const { data, error } = await supabase.from('crm_aulas')
    .select('titulo, tema, inicio_em, link, certificado_link, certificado_instrucoes, monitor_nome, cursos(nome)')
    .eq('id', aulaId).eq('ativo', true).maybeSingle();
  if (error || !data) return null;
  return {
    titulo: data.titulo, tema: data.tema ?? null, inicio_em: data.inicio_em, link: data.link ?? null,
    certificado_instrucoes: data.certificado_instrucoes ?? null, monitor_nome: data.monitor_nome ?? null,
    certificado_link: data.certificado_link ?? null, curso_nome: data.cursos?.nome ?? null,
  };
}

/** O ctx das ferramentas, montado a partir do lead (no v9 não existe o estado da rodada). */
async function ctxDoLead(supabase: any, corpo: any, lead: any): Promise<CtxConversa> {
  const remotejid = String(corpo.remotejid);
  const telefone = soDigitos(corpo.telefone ?? remotejid);
  const campanha = lead?.contexto_campanha ?? null;
  return {
    remotejid, telefone,
    waAccountId: corpo.wa_account_id || await contaDoLead(supabase, telefone, { direcao: 'inbound', incluirRecontato: true }),
    leadId: corpo.lead_id || null, oportunidadeId: corpo.oportunidade_id || null,
    nome: lead?.nome ?? null,
    ficha: { inicioRodada: new Date().toISOString() },
    // As travas leem a conversa (a agenda consultada, a evidência de formação): sem o histórico,
    // o confirmar_agendamento recusava com "nenhuma consulta de agenda foi feita" (teste de 02/10/2026).
    historicoConversa: await carregarHistorico(supabase, remotejid),
    // A IA de aula v2 lê ferramentas que só informam (soInformar).
    ...(campanha?.persona === 'aula' ? { soInformar: true } : {}),
  };
}

export async function rotaV9(acao: AcaoV9, corpo: any, deps: Deps): Promise<{ status: number; corpo: unknown }> {
  const { supabase } = deps;
  const remotejid = String(corpo?.remotejid ?? '');
  const ok = (c: unknown) => ({ status: 200, corpo: c });

  switch (acao) {
    // SF Busca o Lead / Verredura no BD / busca status da pausa / get agente: o mesmo SELECT do lead.
    case 'lead': {
      const lead = await buscarLead(supabase, remotejid);
      return ok({ existe: Boolean(lead), ia_pausada: pausaVigente(lead), ...(lead ?? {}) });
    }
    case 'criar_lead': {
      if (!(await buscarLead(supabase, remotejid))) await criarLead(supabase, remotejid);
      return ok(await buscarLead(supabase, remotejid));
    }
    // Atualiza timeStamp BD Leads: o lead respondeu, a régua de follow-up recomeça (igual ao sistema).
    case 'tocar_lead': {
      await atualizarLead(supabase, remotejid, {
        timestamp_mensagem: new Date().toISOString(), follow_up: null,
        template_1_dia: false, template_2_dia: false, template_3_dia: false, template_4_dia: false,
        template_5_dia: false, template_6_dia: false, template_7_dia: false, template_followup_em: null,
      });
      return ok(await buscarLead(supabase, remotejid));
    }
    // pegar as mensagens por Remotejid / Puxar todo histórico / pega as mensagens: uma linha por mensagem.
    case 'mensagens': {
      const { data, error } = await supabase.from('cliente_ppg_mensagens_sdr')
        .select('id, remotejid, conversation_history, timestamp')
        .in('remotejid', jidsDoTelefone(remotejid)).order('id', { ascending: true });
      if (error) throw new Error(`mensagens: ${error.message}`);
      return ok(data ?? []);
    }
    // inclui mensagem do usuario / do Agente / resposta da function / arquivo: grava conversation_history.
    case 'gravar_mensagem': {
      const historico = corpo?.conversation_history;
      if (!historico?.role) return { status: 400, corpo: { error: 'conversation_history.role obrigatório' } };
      const { data, error } = await supabase.from('cliente_ppg_mensagens_sdr')
        .insert({ remotejid, conversation_history: historico, timestamp: new Date().toISOString() })
        .select('id, remotejid, conversation_history, timestamp').maybeSingle();
      if (error) throw new Error(`gravar_mensagem: ${error.message}`);
      return ok(data);
    }
    // deletar o file data: só uma mensagem do PRÓPRIO lead.
    case 'apagar_mensagem': {
      const { error } = await supabase.from('cliente_ppg_mensagens_sdr').delete()
        .eq('id', corpo?.id).in('remotejid', jidsDoTelefone(remotejid));
      if (error) throw new Error(`apagar_mensagem: ${error.message}`);
      return ok({ apagada: corpo?.id ?? null });
    }
    // Execute a SQL query1 / Atualiza o Agente: o ratchet (quem é qualificador não volta).
    case 'agente': {
      const lead = await buscarLead(supabase, remotejid);
      const proximo = corpo?.next_agent === 'agente_qualificador' ? 'agente_qualificador' : 'agente_validacao';
      await atualizarAgenteComRatchet(supabase, remotejid, lead?.agente_atual ?? null, proximo);
      return ok(await buscarLead(supabase, remotejid));
    }
    // normalizador de Curso e Contexto Temporal: o contexto que o sistema monta para a IA.
    case 'contexto': {
      const lead = await buscarLead(supabase, remotejid);
      const telefone = soDigitos(corpo?.telefone ?? remotejid);
      const campanha = lead?.contexto_campanha ?? null;
      const aula = campanha?.persona === 'aula' && campanha.aula_id ? await carregarAula(supabase, campanha.aula_id) : null;
      const persona = lead?.modo_recontato === true ? 'recontato' : aula ? 'aula' : 'qualificador';
      // Na aula, o curso é o da aula em TUDO (vars, nota do curso, Cannabis). Até 02/10/2026 o
      // contexto levava o do cadastro (Bovinos) junto com o da aula (Cannabis), e a IA usava o do
      // cadastro nas ferramentas. Sem aula, segue o do cadastro.
      const curso = aula ? (aula.curso_nome ?? '') : (lead?.curso_interesse_original ?? '');
      const vars: Record<string, string> = {
        nome: extrairPrimeiroNome(lead?.nome), curso_interesse_original: curso,
        curso_com_artigo: cursoDaConversa(curso),
        ...(aula ? montarVarsAula(aula) : {}),
      };
      const agora = new Date();
      const reunioes = await carregarReunioesDoLead(supabase, telefone, corpo?.lead_id ?? null);
      // Na aula, o bloco de ELEGIBILIDADE da venda (régua de estudante com ordens: "pergunte mês e ano
      // antes de decidir qualquer coisa") vira um dado só. Com ele, "me formei em janeiro" virou a
      // pergunta do ano (teste do Gustavo, 01/10/2026). A trava de verdade é a do verificar_compatibilidade.
      const relogio = aula
        ? montarContextoTemporal().replace(blocoElegibilidadeFormatura(),
          `DATA-LIMITE PARA QUEM AINDA CURSA A GRADUAÇÃO (interna, não cite): conclui até ${limiteFormaturaFormatado()}, segue; depois, retorno perto da formatura.`)
        : montarContextoTemporal();
      // Com aula, a pós é a da aula e já está no catálogo: a nota do cadastro (que manda revalidar no
      // catálogo e chama o curso de "dado do cadastro") confundia a IA com o curso do formulário.
      const notaCurso = aula
        ? '\n\n[PÓS DA AULA] ' + JSON.stringify({ pos_da_aula: curso }) + ' (já confirmada no catálogo; é esta a pós da conversa)'
        : notaDoCurso(curso);
      let contexto = relogio + notaDoNome(vars.nome) + notaCurso
        + contextoEspecialidadeCannabis(curso) + notaDasReunioes(reunioes, agora);
      // O que o cadastro e a conversa já registraram do lead (o v9 não tem a ficha do sistema).
      // Formação do formulário NÃO é confirmação: estudante também marca "Médico Veterinário".
      const dados = {
        formacao_no_cadastro: lead?.formacao_academica ?? null,
        atuacao: lead?.situacao_trabalho_atual ?? null,
        vinculo_trabalho: lead?.vinculo_trabalho ? (VINCULOS_TRABALHO[lead.vinculo_trabalho] ?? lead.vinculo_trabalho) : null,
        experiencia: lead?.experiencia_area ?? null,
        objetivos: lead?.objetivos_profissionais ?? null,
      };
      contexto += '\n\nDADOS COLETADOS (cadastro e conversa; dados, não roteiro)\n' + JSON.stringify(dados)
        + '\nA formação do cadastro vem do formulário e não foi confirmada pelo lead: muitos ainda na graduação marcam a profissão.';
      if (aula) {
        contexto += contextoAulaPiloto(aula, agora, { semFichaAntiga: true });
        // As perguntas da pós chegam pela busca_carreira, só a linha do perfil dele (ideia do Wellinton).
      }
      // As variáveis vão também soltas: o prompt no n8n as lê como {{ $json.nome }}.
      return ok({ ...vars, persona, agente_atual: lead?.agente_atual ?? null, vars, contexto, aula });
    }
    // puxa tools do bd: as ferramentas da Luna para o agente, no formato do Claude, + o canal de resposta.
    case 'tools': {
      const provedor = await deps.provedorDoLead(soDigitos(corpo?.telefone ?? remotejid));
      const agente = String(corpo?.agente ?? 'agente_validacao');
      const base = await carregarTools(supabase, agente, provedor);
      if (agente !== 'agente_aula') return ok({ agente, tools: [...base, TOOL_RESPONDER_AO_CLIENTE] });
      // Na aula, as descrições enxutas (ferramentasAulaV9.ts): só os textos mudam, o contrato não. A busca_carreira
      // entra depois, montada com os perfis próprios da pós da aula (sem eles, os genéricos).
      const lead = await buscarLead(supabase, remotejid);
      const campanha = lead?.contexto_campanha ?? null;
      const aula = campanha?.persona === 'aula' && campanha.aula_id ? await carregarAula(supabase, campanha.aula_id) : null;
      const carreira = await carregarCarreiraPorNome(supabase, aula?.curso_nome ?? '');
      const enxutas = comDescricoesDaAulaV9([...base, TOOL_RESPONDER_AO_CLIENTE]);
      return ok({ agente, tools: [...enxutas.slice(0, -1), toolBuscaCarreira(carreira?.linhas), enxutas.at(-1)] });
    }
    // Anthropic Claude Sonnet 4.5 → a Luna. Entra e sai no formato do Claude.
    case 'luna': {
      const provedor = await deps.provedorDoLead(soDigitos(corpo?.telefone ?? remotejid));
      if (provedor?.formato !== 'openai') return { status: 409, corpo: { error: 'telefone fora do canário da Luna' } };
      const pedido = corpo?.pedido ?? {};
      const resposta = await chamarAnthropic(
        { model: provedor.modelo, max_tokens: pedido.max_tokens ?? 8192, system: pedido.system, messages: pedido.messages, tools: pedido.tools },
        {}, provedor);
      return ok(resposta);
    }
    // Claude - Agente Router → Jev: o pedido no formato dele + o limiar da config.
    case 'router_pedido': {
      const config = await carregarConfigRouterJev(supabase);
      return ok({ pedido: pedidoJevRouter(corpo?.messages ?? []), limiar: config?.limiar ?? 0.8, modo: config?.modo ?? 'off' });
    }
    // Roteamento das Functions → subworkflow → aqui: executa a ferramenta com o ctx do lead.
    case 'tool': {
      const chamada = corpo?.chamada;
      if (!chamada?.id || !chamada?.name) return { status: 400, corpo: { error: 'chamada_invalida' } };
      const lead = await buscarLead(supabase, remotejid);
      // IA de aula: a objeção vem primeiro da tabela da pós (Ebook). A base geral é a da venda e, para
      // "to sem dinheiro", devolvia a resposta de condição especial já oferecendo horário (02/10/2026).
      if (chamada.name === 'consulta_objecoes' && lead?.contexto_campanha?.persona === 'aula' && lead.contexto_campanha.aula_id) {
        const aula = await carregarAula(supabase, lead.contexto_campanha.aula_id);
        let sobre: 'conversa' | 'pos' | null = null;
        if (chamada.input?.tipo_objecao === 'objecao_tempo') {
          const historico = await carregarHistorico(supabase, remotejid);
          const ultimaDoAgente = [...historico].reverse().find((m: any) => m?.role === 'assistant'
            && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'text'))));
          const texto = typeof ultimaDoAgente?.content === 'string' ? ultimaDoAgente.content
            : (ultimaDoAgente?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ');
          sobre = sobreDaObjecaoDeTempo(String(chamada.input?.mensagem_lead ?? ''), texto);
        }
        const daPos = await objecaoDaPos(supabase, aula?.curso_nome, chamada.input?.tipo_objecao, sobre);
        if (daPos) {
          const resposta = daPos.resposta.replace(/\{nome\}/g, extrairPrimeiroNome(lead?.nome) || '').replace(/,\s*\?/g, '?');
          return ok({ output: { id: String(chamada.id), resposta_objecao: resposta, fonte: 'pós da aula', ...(sobre ? { sobre } : {}) } });
        }
      }
      const ctx = await ctxDoLead(supabase, corpo, lead);
      const output = await executarTool(supabase, { id: String(chamada.id), name: String(chamada.name), input: chamada.input ?? {} }, ctx, { comDados: true });
      return ok({ output: { id: String(chamada.id), ...output } });
    }
    // Envia Mensagem CRM: um balão de texto pelo crm-whatsapp-send (a chave fica no sistema).
    case 'enviar_texto': {
      const texto = String(corpo?.texto ?? '').trim();
      if (!texto) return { status: 400, corpo: { error: 'texto vazio' } };
      const lead = await buscarLead(supabase, remotejid);
      if (pausaVigente(lead)) return ok({ enviado: false, motivo: 'ia_pausada' });
      const telefone = soDigitos(corpo?.telefone ?? remotejid);
      const res = await fetch(SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telefone, tipo: 'text', origem: 'ia', conteudo: texto,
          wa_account_id: corpo?.wa_account_id || await contaDoLead(supabase, telefone, { direcao: 'inbound', incluirRecontato: true }),
          lead_id: corpo?.lead_id || null, oportunidade_id: corpo?.oportunidade_id || null,
        }),
      });
      const retorno = await res.json().catch(() => null);
      return { status: res.ok ? 200 : 502, corpo: { enviado: res.ok, status: res.status, retorno } };
    }
    // busca_carreira: a linha da tabela de carreira da pós da aula para o perfil que a IA leu do lead.
    case 'carreira': {
      const perfil = String(corpo?.perfil ?? '');
      const lead = await buscarLead(supabase, remotejid);
      const campanha = lead?.contexto_campanha ?? null;
      const aula = campanha?.persona === 'aula' && campanha.aula_id ? await carregarAula(supabase, campanha.aula_id) : null;
      const nomePos = aula?.curso_nome ?? '';
      const c = await carregarCarreiraPorNome(supabase, nomePos);
      // Perfil sem linha nesta pós: cai em quem ainda não atua no tema (linhaDoPerfil, carreiraPos.ts).
      const linha = linhaDoPerfil(c?.linhas, perfil);
      if (!linha) return ok({ encontrado: false, perfil, pos: nomePos || null, resultado: 'Sem pergunta cadastrada para este perfil nesta pós.' });
      return ok({
        encontrado: true, perfil: linha.perfil, ...(linha.nome ? { quem_e: linha.nome } : {}), pos: nomePos,
        perguntas: perguntasDaLinha(linha), ponte_convite: linha.ponte_convite, observacao: linha.observacao,
        objecoes: c!.objecoes,
      });
    }
    // reset da conversa (/excluirdados) → Deleta o Lead + Deleta mensagens: a limpeza de teste do sistema.
    case 'limpar': {
      const telefone = soDigitos(corpo?.telefone ?? remotejid);
      return ok(await limparConversaDeTeste(supabase, remotejid, telefone, corpo?.wa_account_id ?? null));
    }
  }
}
