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
import { AGENTE_AULA, montarVarsAula } from '../crm-agente-sdr/prompts-aula.ts';
import { carregarTools, chamarAgentePrincipal, chamarRouter, MODELO_AGENTE, provedorDeepseek, provedorOpenai } from '../crm-agente-sdr/agente.ts';
import { encontrarFormacao, extrairPrimeiroNome, montarContextoTemporal, montarPerguntaFormacao, notaDoCurso, notaDoNome, renderPrompt } from '../crm-agente-sdr/contexto.ts';
import { comBlocoDaEscola, comPresenteEscola } from '../crm-agente-sdr/escolaGratuita.ts';
import {
  decidirPrazoEstudante,
  instrucaoPerguntarConclusao,
} from '../crm-agente-sdr/elegibilidadeFormatura.ts';
import { humanizarTexto } from '../crm-agente-sdr/saida.ts';
import { limparParaRouter } from '../crm-agente-sdr/historico.ts';
import { gerarFollowup } from '../crm-agente-sdr/followup.ts';
import { contextoAulaPiloto, INSTRUCAO_AULA_PILOTO } from '../crm-agente-sdr/contextoAulaPiloto.ts';
import { contextoEspecialidadeCannabis } from '../crm-agente-sdr/especialidadeCannabis.ts';
import { comAberturaNumero, NOTA_ABERTURA_CONTROLADA } from '../crm-agente-sdr/aberturaTrocaNumero.ts';
import { VERSAO_MEMORIA_HUMANA } from '../crm-agente-sdr/memoriaHumana.ts';
import { montarRetornoInformacoes } from '../crm-agente-sdr/envioMateriais.ts';
import { proximoPassoDaColeta } from '../crm-agente-sdr/proximoPassoColeta.ts';
import { instrucaoResultadoMaterial } from '../_shared/resultadoEnvioMaterial.ts';
import { comNotaNoContexto, comNotaParaRouter, notaTrocaDeNumero, sinalInerte } from '../crm-agente-sdr/trocaDeNumero.ts';
import {
  aplicarColetaNaJornada, aplicarDeclaracaoNaJornada, aplicarPerguntasNaJornada, avaliarFicha, declaracaoDeConclusao, bloqueioCronograma, contarObjecaoNaJornada, detectarPedidoDeCronograma,
  INSTRUCAO_TEMPO_FICHA, montarBlocoFicha, ORIENTACAO_NAO_E_FALA, perguntasFeitas, registrarBloqueioNaJornada, registrarEnvioNaJornada, type Jornada,
} from '../crm-agente-sdr/fichaAtendimento.ts';
import { comGanchoDoLote } from '../crm-agente-sdr/ganchoLote.ts';
import { bloqueioProximaTurmaDeEstudante } from '../crm-agente-sdr/tools.ts';
import { blocoConviteAgenda } from '../crm-agente-sdr/contexto.ts';
import { resultadoConfirmacao } from '../crm-agente-sdr/confirmacaoAgendamento.ts';
import { blocoPerguntasRecentes, falasDoLead } from '../crm-agente-sdr/perguntasRecentes.ts';
import { alertaFatoSemFonte } from '../crm-agente-sdr/fatoSemFonte.ts';
import { agendaRealNoDia, diagnosticoDoProvedor, disponibilidadeSimulada, executarFollowupSimulado, executarSimulacao, extrairUso, MAX_CARACTERES_SIMULACAO, validarEntradaSimulacao, type AgenteRouter } from './simulacao.ts';

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

// Ficha do atendimento simulada: mesma régua pura da produção (fichaAtendimento.ts), estado em
// memória. `mocks.cadastro` = resposta do formulário da LP ("Sou formado em outra área", "Médico
// Veterinário (a)", "Na faculdade do 1º ao 8º período"…); `mocks.botao_cronograma: true` faz a
// 1ª mensagem do lead valer como clique no botão do template.
type FichaSimulada = { jornada: Jornada; cadastro: string | null; inicioRodada: string };

// Retornos plausíveis das tools — texto no MESMO espírito dos executores reais
// (tools.ts), porque é o texto que guia a próxima decisão do modelo.
async function mockTool(nome: string, input: any, mocks: any, ficha: FichaSimulada | null = null): Promise<string> {
  // Replay de conversa real (24/09/2026): `mocks.respostas_reais[tool]` é o que a tool REAL
  // devolveu naquela rodada (agenda, matriz, cronograma…). Se o modelo chamar a mesma tool,
  // recebe o mesmo fato; tool que a rodada real não chamou cai no mock sintético abaixo.
  const real = mocks?.respostas_reais?.[nome];
  // A agenda real só vale para o DIA que a rodada real consultou: o replay roda dias depois e
  // "amanhã" já é outra data. Horário de outro dia contradiz o pedido e o modelo repetia a consulta
  // até esgotar as voltas (duelo de 25/09, silêncio). Dia diferente ⇒ agenda sintética abaixo.
  const agendaDeOutroDia = nome === 'consulta_disponibilidade' && typeof real === 'string'
    && Boolean(input?.data_desejada) && !real.includes(String(input.data_desejada));
  if (agendaDeOutroDia) {
    // Os horários REAIS daquele atendimento, no dia pedido (simulacao.ts, agendaRealNoDia).
    const noDia = agendaRealNoDia(real as string, input);
    if (noDia) return noDia;
  }
  if (typeof real === 'string' && real.trim() && !agendaDeOutroDia) {
    // Mesmo acréscimo do executor real no canário: o próximo passo da coleta (proximoPassoColeta.ts).
    if (nome === 'atualizar_dados_lead' && ficha) {
      ficha.jornada = aplicarColetaNaJornada(ficha.jornada, input ?? {});
      const passo = proximoPassoDaColeta(input ?? {});
      return passo ? `${real} ${passo}` : real;
    }
    // Mesmo acréscimo do executor real no canário: orientação da base não vira fala.
    if (nome === 'consulta_objecoes' && ficha) return `${real} ${ORIENTACAO_NAO_E_FALA}`;
    return real;
  }
  switch (nome) {
    case 'atualizar_dados_lead': {
      if (ficha) ficha.jornada = aplicarColetaNaJornada(ficha.jornada, input ?? {});
      const partes = ['nome', 'formacao', 'tempo_formacao', 'area_atuacao', 'atua_na_area', 'graduacao_concluida', 'possui_pos', 'qual_pos']
        .filter((k) => input?.[k]).map((k) => `${k}="${input[k]}"`);
      const passo = ficha ? proximoPassoDaColeta(input ?? {}) : '';
      return partes.length
        ? `Registrado no cadastro: ${partes.join(', ')}.${passo ? ` ${passo}` : ''} NUNCA comente com o lead que registrou os dados.`
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
      // 14/09/2026: consultar preço não envia mensagem nem PDF. O mock antigo
      // dizia "cronograma enviado" até para valor e induzia a pular a informação
      // pedida. Usa o mesmo contrato do executor, com preço sintético do ensaio.
      // Formato da API real (24/09/2026): matrícula e link chegam no mesmo campo.
      if (input?.conteudo === 'valor') return JSON.stringify(montarRetornoInformacoes(true, {
        data: {
          curso: input?.curso_escolhido ?? null, valor_integral: 'R$ 4.200,00 em até 24x no cartão de crédito',
          valor_matricula: 'R$ 200,00 e o link da matrícula https://go.eduq.tec.br/r/harness-simulador',
        },
      }, 'valor', 'harness-consulta-valor', {
        condicao: ficha ? 'a condição do primeiro lote promocional' : 'a condição especial que a secretaria liberou hoje',
        variante: Math.floor(Math.random() * 3),
      }));
      // Ficha: espelho da trava do executor real — sem o dado da coleta o cronograma não sai;
      // bloqueio em turno anterior + lead insistiu ⇒ libera.
      if (ficha) {
        const a = avaliarFicha({ cadastro: ficha.cadastro, jornada: ficha.jornada, inicioRodada: ficha.inicioRodada });
        if (!a.liberaCronograma) {
          if ((ficha.jornada.cronograma?.bloqueado_em ?? '') < ficha.inicioRodada) ficha.jornada = registrarBloqueioNaJornada(ficha.jornada);
          const { id: _id, ...recusa } = bloqueioCronograma('', a);
          return JSON.stringify(recusa);
        }
        ficha.jornada = registrarEnvioNaJornada(ficha.jornada);
      }
      // 16/09/2026, persona aula: aula sem pós manda o PORTFÓLIO da PPGVET (PRD —
      // Persona por disparo). O executor real ainda não tem esse conteúdo; o mock
      // devolve o contrato esperado para o ensaio não confundir portfólio com cronograma.
      if (input?.conteudo === 'portfolio') {
        return 'Portfólio da PPGVET (PDF com todas as pós) enviado ao lead no WhatsApp. Pergunte qual área chamou a atenção dele.';
      }
      // Mesma instrução do executor real depois do aceite ("te enviei o cronograma por aqui"…):
      // sem ela o modelo escrevia "solicitei o envio" só no harness.
      return `Cronograma enviado ao lead no WhatsApp (conteudo="${input?.conteudo ?? '?'}"). ${instrucaoResultadoMaterial('aceito')} Valor integral: R$ 4.200,00.`;
    case 'verificar_compatibilidade_curso': {
      const m = mocks?.compatibilidade ?? 'aprovado';
      // ⚠️ REPROVA POR PRAZO SEM DEPENDER DO MOCK — espelho do executor real (tools.ts),
      // onde `estudante_fora_do_prazo` é reprovado DETERMINISTICAMENTE pelo input, antes de
      // a matriz rodar. Enquanto isso dependia de `mocks.compatibilidade: 'prazo'`, o
      // default ('aprovado') devolvia "APROVADO" para quem o modelo tinha acabado de
      // classificar como fora do prazo — e o agente, confiando na ferramenta (comportamento
      // CORRETO), oferecia horário. O teste reprovava o agente por culpa do mock: é a
      // 3ª ocorrência dessa armadilha (consulta_pos_disponiveis, e o próprio prazo em
      // 2026-07-16). Régua: o que o executor decide em CÓDIGO, o mock decide igual.
      // ⚠️ Mesmo motivo, 2º ato (2026-08-13, caso Edinara): o executor real agora RELÊ a
      // resposta do lead e devolve PRECISA_DATA_CONCLUSAO quando ela é ambígua ("2 semestre"),
      // mesmo com o modelo mandando "estudante_apto". Sem espelhar isso aqui, o harness
      // aprovaria o cenário ambíguo e o teste diria que está tudo bem.
      const decisao = decidirPrazoEstudante(input ?? {});
      if (decisao.acao === 'pergunta_data') {
        return `PRECISA_DATA_CONCLUSAO. ${instrucaoPerguntarConclusao(decisao.porque)}`;
      }
      if (decisao.acao === 'reprova') {
        return 'REPROVADO_PRAZO. O lead ainda está cursando e conclui DEPOIS da data-limite de ' +
          'elegibilidade. NÃO agende reunião, NÃO diga que a formação atende e NÃO empurre a ' +
          'decisão pro monitor. Este lead NÃO está desinteressado: vai poder cursar quando ' +
          'terminar a graduação. Na MESMA resposta, chame agendar_retorno com tipo="formatura" ' +
          'e meses = quantos meses faltam pra ele concluir (o sistema limita ao teto). NÃO ' +
          'chame pausa_ia. A MENSAGEM AO LEAD É OBRIGATÓRIA e precisa deixar DUAS coisas claras, ' +
          'com as suas palavras: (1) a pós é lato sensu e a matrícula exige a GRADUAÇÃO CONCLUÍDA, ' +
          'então agora ainda não dá; (2) vc vai procurá-lo quando ele estiver terminando o curso. ' +
          'Se vc ofereceu ou combinou algum HORÁRIO de reunião nesta conversa, DESFAÇA de forma ' +
          'explícita ("não vou marcar aquele horário que falei") — senão ele fica esperando a ' +
          'reunião. Nunca mencione a data-limite, "prazo" ou "elegibilidade".';
      }
      if (m === 'reprovado') {
        return 'REPROVADO. A formação do lead não é compatível com esta pós e NÃO há curso alternativo. Encerre com respeito e chame pausa_ia.';
      }
      if (m === 'alternativa') {
        return 'REPROVADO para esta pós (exclusiva de médico veterinário). curso_alternativo: "Gestão de Pessoas e Extensão Rural". Ofereça a alternativa.';
      }
      // `mocks.compatibilidade: 'prazo'` continua aceito por compatibilidade com cenários
      // antigos, mas hoje é redundante: quem decide é o contexto_qualificacao, acima.
      if (m === 'prazo') {
        return mockTool('verificar_compatibilidade_curso',
          { ...input, contexto_qualificacao: 'estudante_fora_do_prazo' }, mocks);
      }
      return 'APROVADO. A formação do lead é compatível com a pós de interesse.';
    }
    // ⚠️ Datas FUTURAS calculadas na hora. O mock era fixo em "dia 30/07" e, depois que
    // essa data passou, o agente recebia slots VENCIDOS, reconsultava em loop e nunca
    // agendava — falso negativo do harness (4ª vez que mock estático reprova o agente;
    // antes: consulta_pos_disponiveis e o prazo de formatura). Formato = espelho do
    // executor real (tools.ts): "- 15h de quinta, dia YYYY-MM-DD (vendedor_id:…, nome:…)".
    // ⚠️ UM vendedor só por padrão: desde 2026-08-07 a agenda oferecida é a do DONO do
    // contato (fn_sdr_api_dono_do_contato). mocks.disponibilidade='pool' devolve vários
    // vendedores — é o fallback (dono sem slot na janela) e o webchat, que segue no rodízio.
    // ⚠️ 5ª armadilha (24/09/2026): o mock ignorava data/período e devolvia a tarde para
    // "amanhã de manhã"; a Luna reconsultava com o mesmo input diante da contradição, que a
    // API real não cria. Hoje a janela segue a sdr-api — ver disponibilidadeSimulada.
    case 'consulta_disponibilidade':
      return disponibilidadeSimulada(input, mocks);
    case 'consulta_objecoes': {
      if (ficha) ficha.jornada = contarObjecaoNaJornada(ficha.jornada, String(input?.tipo_objecao ?? ''));
      // Com a ficha, a quebra de TEMPO é a mesma instrução do executor real (com gatilho, sem material).
      if (ficha && input?.tipo_objecao === 'objecao_tempo') return `resposta_objecao: ${JSON.stringify(INSTRUCAO_TEMPO_FICHA)}`;
      if (ficha) return 'resposta_objecao: "a conversa com o monitor é rápida, uns 10 minutos, e é onde vc vê a condição do primeiro lote promocional". Adapte ao contexto e reconduza pro agendamento. ' + ORIENTACAO_NAO_E_FALA;
      return 'resposta_objecao: "a conversa com o monitor é rápida, uns 15 minutos, e é onde vc vê a condição especial". Adapte ao contexto e reconduza pro agendamento.';
    }
    case 'pausa_ia':
      // Espelha o executor real: tipo="nao_perturbe" arquiva o lead (opt-out).
      return input?.tipo === 'nao_perturbe'
        ? `Atendimento em Pausa e lead ARQUIVADO (opt-out, motivo: ${input?.motivo ?? '-'}). Ele sai de todos os disparos.`
        : `Atendimento em Pausa (motivo: ${input?.motivo ?? '-'}).`;
    case 'temporizador_proxima_turma':
      return 'Recontato agendado para a próxima turma. IA pausada.';
    case 'agendar_retorno': {
      // Formatura: espelho do banco (meses 1..12 × 30 dias). O mock devolvia "3 dias" e o João
      // dizia "te procuro no dia 24/09" a um estudante de 2027 (harness do caso Paulo Renato).
      if (String(input?.tipo ?? '').toLowerCase() === 'formatura') {
        const meses = Math.min(Math.max(Number(input?.meses) || 6, 1), 12);
        const quando = new Date(Date.now() + meses * 30 * 86_400_000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        return `Retorno agendado para ${quando} (${meses} meses), perto de ele concluir a graduação. O lead fica fora dos disparos até lá e o time o retoma. Encerre com cordialidade dizendo que vai chamá-lo quando ele estiver concluindo.`;
      }
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
    // Espelho do retorno do executor real (tools.ts, confirmarAgendamento). O genérico
    // "Tool executada." deixava o modelo sem data/monitor/link: nos dois braços do A/B de
    // 24/09/2026 a confirmação saiu com "não recebi um link de meet válido" ou em silêncio.
    case 'confirmar_agendamento': {
      const [ano, mes, dia] = String(input?.data_escolhida ?? '').split('-');
      const hora = String(input?.horario_escolhido ?? '').slice(0, 5);
      if (!ano || !mes || !dia || !/^\d{2}:\d{2}$/.test(hora)) return 'Erro ao agendar: data_escolhida (AAAA-MM-DD) e horario_escolhido (HH:MM) são obrigatórios.';
      const semana = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${ano}-${mes}-${dia}T12:00:00Z`));
      const monitor = ({ v1: 'Ana', v2: 'Bruno', v3: 'Carla' } as Record<string, string>)[String(input?.vendedor_id ?? '')] ?? 'monitor';
      // Mesmo objeto do executor: `confirmacao` alimenta a confirmação em código do ensaio.
      const confirmacao = { data: `${semana}, ${dia}/${mes}/${ano} às ${hora}`, monitor, link: 'https://meet.google.com/ppg-harness-sim' };
      return JSON.stringify({ resultado: resultadoConfirmacao('harness-agendamento', confirmacao), agendamento_id: 'harness-agendamento', confirmacao });
    }
    default:
      return `Tool ${nome} executada.`;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await autorizado(req))) return json({ error: 'unauthorized' }, 401);

  let entrada;
  try {
    const bruto = await req.text();
    if (bruto.length > MAX_CARACTERES_SIMULACAO) return json({ error: 'limite de 200000 caracteres excedido' }, 400);
    entrada = validarEntradaSimulacao(JSON.parse(bruto));
  } catch (e) {
    return json({ error: e instanceof SyntaxError ? 'payload inválido' : (e as Error).message }, 400);
  }

  // Provedor desta simulação: vai como ARGUMENTO de cada chamada (nada de estado global, então
  // duas simulações com provedores diferentes podem rodar ao mesmo tempo sem se misturar).
  let provedorAlternativo = entrada.provedor === 'deepseek' ? provedorDeepseek()
    : entrada.provedor === 'openai' ? provedorOpenai() : null;
  if (provedorAlternativo?.formato === 'openai' && entrada.esforco) provedorAlternativo = { ...provedorAlternativo, esforco: entrada.esforco };
  if (provedorAlternativo?.formato === 'openai' && entrada.modelo_openai) provedorAlternativo = { ...provedorAlternativo, modelo: entrada.modelo_openai };
  if (provedorAlternativo?.formato === 'openai' && entrada.raciocinio_encadeado) provedorAlternativo = { ...provedorAlternativo, raciocinio: true, memoriaRaciocinio: new Map() };
  if (entrada.provedor !== 'anthropic' && !provedorAlternativo) {
    return json({ error: `chave do provedor ${entrada.provedor} ausente no ambiente` }, 400);
  }

  if (entrada.modo === 'followup') {
    try {
      // Não passar supabase real: a geração recebe um banco bloqueado e telemetria
      // em memória. Nenhuma função da esteira, elegibilidade, lock ou envio é chamada.
      const resultado = await executarFollowupSimulado(entrada, { gerar: gerarFollowup, humanizar: humanizarTexto, provedor: provedorAlternativo });
      return json({ ...resultado, modelo: resultado.eventos.at(-1)?.modelo ?? provedorAlternativo?.modelo ?? MODELO_AGENTE,
        provedor: resultado.provedorResposta ?? entrada.provedor,
        esforco: provedorAlternativo?.formato === 'openai' ? 'none' : null, memoria_versao: VERSAO_MEMORIA_HUMANA });
    } catch {
      return json({ error: 'falha na simulação de followup; nenhuma ação comercial foi executada' }, 502);
    }
  }

  // Todo estado é local à chamada: NÃO usar atualizarLead/ratchet de banco neste harness.
  const estado = { nome: entrada.nome_lead, formacao: entrada.formacao_academica };
  const fichaSim: FichaSimulada | null = entrada.ficha ? {
    jornada: {},
    cadastro: String(entrada.mocks?.cadastro ?? entrada.formacao_academica ?? '').trim() || null,
    inicioRodada: new Date().toISOString(),
  } : null;
  const aulaPiloto = Boolean(fichaSim && entrada.persona === 'aula' && provedorAlternativo?.nome === 'openai');
  const aberturaControlada = provedorAlternativo?.nome === 'openai';
  let aberturaPendente = aberturaControlada && Boolean(entrada.troca_de_numero);
  const blocoDaFicha = () => {
    if (!fichaSim) return undefined;
    const entradaFicha = { cadastro: fichaSim.cadastro, jornada: fichaSim.jornada, inicioRodada: fichaSim.inicioRodada };
    return montarBlocoFicha(entradaFicha, avaliarFicha(entradaFicha));
  };
  let agenteAtual: AgenteRouter = entrada.agente_atual ?? 'agente_validacao';
  const routers: Record<string, unknown>[] = [];
  let reprovadoPorPrazo = false;
  const cacheTools = new Map<string, any[]>();
  const toolsDe = async (agente: string) => {
    // provedor openai ⇒ lê lista_tools_openai (a mesma tabela que a produção usará)
    if (!cacheTools.has(agente)) cacheTools.set(agente, await carregarTools(supabase, agente, provedorAlternativo));
    return cacheTools.get(agente)!;
  };

  try {
    const resultado = await executarSimulacao(entrada, {
      prepararRodada: async (messages, turno) => {
        // Cada fala do lead equivale a uma invocação de produção. Só as voltas de
        // ferramentas desse turno compartilham memória, inclusive a correção do canal.
        if (provedorAlternativo?.formato === 'openai' && provedorAlternativo.raciocinio === true) {
          provedorAlternativo = { ...provedorAlternativo, memoriaRaciocinio: new Map() };
        }
        // 16/09/2026: 'aula' abre com o prompt próprio e fecha com o qualificador (igual à
        // campanha direta); o router é consultado como na validação.
        let agente = entrada.persona === 'campanha_direta' ? 'agente_campanha_direta'
          : entrada.persona === 'aula' ? 'agente_aula'
          : entrada.persona === 'qualificador' ? 'agente_qualificador' : 'agente_validacao';
        // TROCA DE NÚMERO (14/09/2026): mesma nota e mesma exceção do ratchet da produção
        // (crm-agente-sdr/index.ts), só na 1ª rodada — depois o João já falou por este número.
        const troca = turno === 1 ? entrada.troca_de_numero : null;
        // Ficha: novo turno = nova rodada (o bloqueio do turno anterior passa a contar como
        // "já perguntou"); o pedido de cronograma do lead fica anotado antes de o modelo falar.
        if (fichaSim) {
          // +5 ms: a marca da pergunta do turno anterior nasce no MESMO milissegundo em que este
          // turno começa (não há espera entre eles no harness) e deixaria de contar como "anterior".
          fichaSim.inicioRodada = new Date(Date.now() + 5).toISOString();
          const ultima = messages[messages.length - 1];
          const textoLead = typeof ultima?.content === 'string' ? ultima.content : '';
          const pedido = detectarPedidoDeCronograma([{ tipo: entrada.mocks?.botao_cronograma === true && turno === 1 ? 'button' : 'text', mensagem: textoLead }]);
          if (pedido) {
            fichaSim.jornada = { ...fichaSim.jornada, cronograma: { ...(fichaSim.jornada.cronograma ?? {}), pedido_em: new Date().toISOString(), pedido_por: pedido } };
          }
          // As perguntas feitas são marcadas DEPOIS da fala do João (deps.aoResponder), como na produção.
        }
        const notaTroca = troca ? notaTrocaDeNumero(
          { ...sinalInerte('conta-atual-simulada', 1, 'trocou'), trocou: true, contaAnterior: 'conta-anterior-simulada',
            gapMin: troca.gap_min ?? 90,
            templateAtual: troca.template ? { nome: null, conteudo: troca.template, em: new Date().toISOString() } : null },
          { atual: troca.conta_atual ? { id: 'conta-atual-simulada', persona: 'qualificador', nome: troca.conta_atual, numero_display: null } : null,
            anterior: troca.conta_anterior ? { id: 'conta-anterior-simulada', persona: 'qualificador', nome: troca.conta_anterior, numero_display: null } : null },
          { agendado: troca.agendado, aberturaControlada },
        ) : null;
        const ratchetIgnorado = Boolean(notaTroca) && !troca?.agendado;
        if (entrada.usar_router) {
          const anterior = agenteAtual;
          const campanha = entrada.persona === 'campanha_direta';
          // Espelha a promoção da campanha: sem nome+formação, permanece na coleta.
          const consultar = !campanha || (anterior !== 'agente_qualificador' && Boolean(estado.nome.trim() && estado.formacao.trim()));
          let decidiu = anterior;
          let fallback = false;
          let usoRouter: Record<string, number> = {};
          let modeloRouter = MODELO_AGENTE;
          if (consultar) {
            try {
              decidiu = await chamarRouter(limparParaRouter(comNotaParaRouter(messages, notaTroca)), (resposta) => {
                usoRouter = extrairUso(resposta.usage);
                modeloRouter = resposta.model ?? MODELO_AGENTE;
              }, provedorAlternativo);
            } catch {
              fallback = true;
            }
          }
          agenteAtual = anterior === 'agente_qualificador' && !ratchetIgnorado ? anterior : decidiu;
          agente = campanha && agenteAtual === 'agente_validacao' ? 'agente_campanha_direta'
            : entrada.persona === 'aula' && agenteAtual === 'agente_validacao' ? 'agente_aula' : agenteAtual;
          routers.push({ turno, anterior, decidiu, efetivo: agenteAtual, consultado: consultar, fallback,
            ...(notaTroca ? { troca_numero: true, ratchet_ignorado: ratchetIgnorado } : {}),
            ...(consultar ? { modelo: modeloRouter, usage: usoRouter } : {}) });
        }
        const promptBase = agente === 'agente_campanha_direta' ? AGENTE_CAMPANHA_DIRETA
          : agente === 'agente_aula' ? AGENTE_AULA
          : agente === 'agente_qualificador' ? AGENTE_QUALIFICADOR : AGENTE_VALIDACAO;
        // Persona aula: as vars da aula (quando ocorre, link, pós vinculada) vêm do objeto
        // `aula` da entrada; o curso do lead é a pós vinculada, vazia quando a aula não tem pós.
        const varsAula = entrada.aula ? montarVarsAula(entrada.aula) : {};
        const vars = {
          ...varsAula,
          nome: extrairPrimeiroNome(estado.nome),
          curso_interesse_original: entrada.aula ? (varsAula.curso_interesse_original ?? '') : entrada.curso,
          pergunta_formacao: montarPerguntaFormacao(encontrarFormacao(estado.formacao)),
        };
        let promptAgente = renderPrompt(promptBase, vars);
        // Mesma escolha da produção (index.ts → comBlocoDaEscola): quem já está na Escola
        // recebe o aviso, não o convite. Sem isto o caso Leandro (2026-09-11) não é testável.
        if (entrada.esta_na_escola) promptAgente = comBlocoDaEscola(promptAgente, true);
        else if (!entrada.sem_presente_escola) promptAgente = comPresenteEscola(promptAgente);
        if (entrada.prompt_extra) promptAgente += `\n\n${entrada.prompt_extra}`;
        // agente_aula ainda não tem linha própria em lista_tools_claude: usa as tools da
        // validação (que já incluem atualizar_dados_lead), como o PRD prevê.
        const agenteTools = entrada.agente_override || (agente === 'agente_aula' ? 'agente_validacao' : agente);
        let tools = await toolsDe(agenteTools);
        if (entrada.usar_router && !entrada.agente_override && entrada.persona === 'campanha_direta' && agente === 'agente_qualificador') {
          const extras = (await toolsDe('agente_campanha_direta')).filter((t) => t?.name === 'atualizar_dados_lead');
          tools = [...tools, ...extras];
        }
        // Canário: gancho do primeiro lote + CONVITE DE AGENDA, como em crm-agente-sdr/index.ts.
        const promptFinal = fichaSim && !aulaPiloto ? comGanchoDoLote(promptAgente, { nome: vars.nome, curso: vars.curso_interesse_original }).prompt : promptAgente;
        const contextoBase = comNotaNoContexto(montarContextoTemporal() + notaDoNome(vars.nome) + notaDoCurso(vars.curso_interesse_original)
          + (provedorAlternativo?.nome === 'openai' ? contextoEspecialidadeCannabis(vars.curso_interesse_original) : '')
          + (aberturaControlada ? '\n\n' + NOTA_ABERTURA_CONTROLADA : ''), notaTroca);
        const contextoFinal = aulaPiloto ? contextoBase + contextoAulaPiloto(entrada.aula)
          : fichaSim ? `${contextoBase}\n\n${blocoConviteAgenda()}` : contextoBase;
        return { agente: agenteTools, promptAgente: promptFinal, contextoTemporal: contextoFinal, tools, comFicha: Boolean(fichaSim),
          ...(aulaPiloto ? { instrucaoFicha: INSTRUCAO_AULA_PILOTO } : {}) };
      },
      chamarPrincipal: (opts: Parameters<typeof chamarAgentePrincipal>[0]) => chamarAgentePrincipal({ ...opts, provedor: provedorAlternativo }),
      humanizar: humanizarTexto,
      prepararFala: texto => {
        if (!aberturaPendente) return texto;
        aberturaPendente = false;
        return comAberturaNumero(texto, 0);
      },
      // Mesma composição da produção: ficha + perguntas já feitas, derivadas do histórico da volta.
      fichaDaVolta: (messages) => {
        // Espelho da produção (index.ts): declaração explícita de conclusão no histórico vale como coleta.
        if (fichaSim && !fichaSim.jornada.coleta?.graduacao_concluida && declaracaoDeConclusao(falasDoLead(messages))) {
          fichaSim.jornada = aplicarDeclaracaoNaJornada(fichaSim.jornada);
        }
        const base = blocoDaFicha();
        return base
          ? [base, blocoPerguntasRecentes(messages), alertaFatoSemFonte(falasDoLead(messages).at(-1))].filter(Boolean).join('\n\n')
          : undefined;
      },
      aoResponder: (texto) => {
        if (!fichaSim) return;
        const entradaFicha = { cadastro: fichaSim.cadastro, jornada: fichaSim.jornada, inicioRodada: fichaSim.inicioRodada };
        const marcas = perguntasFeitas(entradaFicha, avaliarFicha(entradaFicha), texto);
        if (marcas.length) fichaSim.jornada = aplicarPerguntasNaJornada(fichaSim.jornada, marcas);
      },
      mockTool: async (nome, input) => {
        const dados = input as Record<string, unknown>;
        // Espelho do executor real: reprovado por PRAZO não entra em "próxima turma".
        if (nome === 'temporizador_proxima_turma' && reprovadoPorPrazo) {
          const { id: _id, ...recusa } = bloqueioProximaTurmaDeEstudante('');
          return JSON.stringify(recusa);
        }
        const resposta = await mockTool(nome, dados, entrada.mocks, fichaSim);
        if (nome === 'verificar_compatibilidade_curso') reprovadoPorPrazo = resposta.startsWith('REPROVADO_PRAZO') || resposta.includes('"output":"REPROVADO_PRAZO"');
        if (nome === 'atualizar_dados_lead') {
          if (typeof dados?.nome === 'string') estado.nome = dados.nome;
          if (typeof dados?.formacao === 'string') estado.formacao = dados.formacao;
        }
        return resposta;
      },
    });
    return json({
      ...resultado, modelo: resultado.chamadas.at(-1)?.modelo ?? (provedorAlternativo?.formato === 'openai' ? provedorAlternativo.modelo : MODELO_AGENTE), provedor: entrada.provedor, esforco: provedorAlternativo?.formato === 'openai' ? provedorAlternativo.esforco : null,
      raciocinio_encadeado: provedorAlternativo?.formato === 'openai' && provedorAlternativo.raciocinio === true,
      usar_router: entrada.usar_router, routers, memoria_versao: VERSAO_MEMORIA_HUMANA,
      ...(fichaSim ? { ficha: { cadastro: fichaSim.cadastro, jornada: fichaSim.jornada } } : {}),
    });
  } catch (e) {
    // Não devolver body cru de falha da API nem histórico/credenciais em logs.
    const diagnostico = diagnosticoDoProvedor(e);
    return json({ error: 'falha na simulação; nenhuma ação comercial foi executada', ...(diagnostico ? { diagnostico_provedor: diagnostico } : {}) }, 502);
  }
});
