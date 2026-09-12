// crm-agente-aluno: o assistente pedagógico do Suporte ao Aluno (linha 3250).
//
// Recebe o relay do crm-whatsapp-webhook quando a conta que recebeu a mensagem tem
// `agente_ia_persona = 'aluno'` e `agente_ia_ativo = true`, e conversa com o aluno que está
// na integração dos 15 dias (funil ONBORDING / Experiência do Aluno). Não move card, não
// dispara régua: quem faz isso são as automações do funil. Este aqui só conversa, registra o
// que o aluno respondeu (grupo da turma, preferência de ligação, e desde 11/09 a meta pessoal
// com a pós e como conheceu a gente) e passa para a equipe o que não é com ele.
//
// INDEPENDENTE DE PROPÓSITO (decisão do Rafael): não importa uma linha de `crm-agente-sdr`
// (o João) nem de `crm-agente-rh`. Prompt, telemetria, trava e tabelas são só dele. O que é
// igual ao RH foi copiado, não compartilhado: mexer num agente nunca muda o que o outro diz.
//
// A 3250 é a linha que o time de suporte JÁ atende. Por isso os gates são estreitos, e cada
// um que falha deixa rastro em `onb_agente_eventos`:
//   1. NÚMERO   a conta de `onb_agente_conta()` e a persona 'aluno' no payload.
//   2. ORIGEM   a mensagem existe no banco, inbound, desta conta (o endpoint é público).
//   3. ALUNO    card próprio OU posição no funil da integração, achado pelo telefone canônico.
//   4. ETAPA    só etapa com papel em `onb_etapas_papel` (as D+). Saídas do funil são humano.
//   5. TESTE    enquanto `onb_agente_config.teste_telefones` tiver número, só eles; lista vazia
//               só vale com `liberado_para_todos` (nasce false: produção é UPDATE explícito).
//   6. HORÁRIO  segunda a sexta das 8h às 21h, sábado até meio-dia e domingo fechado, em
//               Ampére e pela config. Fora disso, o tick da manhã retoma no próximo dia aberto.
//   7. JANELA   só respondendo a quem escreveu nas últimas 24h. Nunca inicia conversa. A
//               retomada da manhã que chega tarde demais (fim de semana) vira passagem, não
//               silêncio: fora das 24h a Meta recusa texto livre, e quem responde é a equipe.
//   8. HUMANO   se a última mensagem nossa foi de uma pessoa, ele cala.
//   9. PASSAGEM se já passou a conversa para a equipe e ninguém respondeu ainda, ele cala.
//
// ÁUDIO (12/09/2026): o assistente responde o que foi FALADO. Quem transcreve é a fila
// `onb_agente_audio_fila`, enchida pela trigger do banco quando chega áudio de entrada nesta
// linha e drenada pela `crm-transcrever-audio` (a mesma do botão do SAC e da memória do João).
// O turno espera o texto por até 20 s depois das portas acima, e só então monta o histórico.
// Sem transcrição no prazo, nada muda em relação a antes: uma frase gentil e a passagem com o
// assunto `audio`.
//
// NENHUMA ferramenta nem consulta daqui enxerga financeiro (o teste agenteAlunoSemFinanceiro
// confere). Isso sozinho NÃO basta: a 3250 é a linha em que a EQUIPE responde o financeiro, e o
// histórico que o modelo lê teria o valor, o vencimento, o link do boleto e até a senha
// provisória que uma pessoa mandou. Por isso o que foi escrito por gente chega ao modelo só
// como o aviso de que um atendente respondeu, sem o texto (ver ESCRITA_POR_PESSOA). O prompt
// cuida do tom; a ausência na ferramenta E no histórico cuida da segurança.
//
// Responde 200 na hora e processa em background: o relay do webhook desiste em 10 s.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';
import { PROMPT_ALUNO } from './prompt.ts';
import {
  ASSUNTOS_TRANSFERENCIA,
  assuntoValido,
  canonDdd8,
  CATEGORIAS_COMO_CONHECEU,
  CATEGORIAS_META_PESSOAL,
  type ContextoAluno,
  dentroDoHorario,
  descreverParaModelo,
  digitos,
  esperaSorteada,
  interpretarBotao,
  limparResposta,
  linhaDaAula,
  mesmoTelefone,
  montarContexto,
  parametrosDoPerfil,
  perfilDoContexto,
  type PerguntaDoPerfil,
  PERGUNTAS_DO_PERFIL,
  sanearParaModelo,
  temPalavraProibida,
  ultimos8,
  vetoDaPerguntaDoPerfil,
} from './regras.ts';

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Mesma ordem do RH: a chave própria, depois a do João, e a do container por último, que já
// deu 401 (29/08). Vazia ou recusada, vale a de `ai_api_keys`, que troca sem deploy.
let ANTHROPIC_KEY = Deno.env.get('AGENTE_ALUNO_ANTHROPIC_KEY')
  ?? Deno.env.get('AGENTE_SDR_ANTHROPIC_KEY')
  ?? Deno.env.get('ANTHROPIC_API_KEY')
  ?? '';
// O modelo de verdade vem de `onb_agente_config.modelo`: o Dokploy reverte env, e modelo
// aposentado dá 404 sem retry (foi o que emudeceu o João em 15/06). Isto é só a reserva.
// ⚠️ Sonnet 5 recusa temperature e budget_tokens com 400: nada de sampling aqui.
const MODELO_RESERVA = Deno.env.get('AGENTE_ALUNO_MODEL') ?? 'claude-sonnet-5';

const PERSONA = 'aluno';
/** Assinatura das respostas na fila. É por ela que uma resposta nova substitui a pendente. */
const AUTOR = 'Assistente pedagógico';
const BUFFER_MS = 6000;          // quem manda 3 balões seguidos recebe UMA resposta
const LOCK_TTL_SEGUNDOS = 90;
/**
 * Quanto o turno espera a transcrição do áudio que ACABOU de chegar. A fila
 * (`onb_agente_audio_fila`) é acordada pela própria trigger do banco assim que a mensagem é
 * gravada, então na prática o texto chega em poucos segundos; o teto existe porque o aluno
 * está do outro lado esperando resposta, e um provedor lento não pode virar silêncio. Sem
 * transcrição no prazo, vale o caminho de sempre: uma frase e a passagem para a equipe.
 */
const ESPERA_TRANSCRICAO_MS = 20_000;
const PASSO_TRANSCRICAO_MS = 2_000;
const JANELA_HORAS = 24;
const MAX_HISTORICO = 40;
const MAX_RODADAS = 4;
/** Quanto tempo a marca `manha:disparada` do tick vale como autorização da retomada. */
const MANHA_VALIDADE_MIN = 30;
/**
 * O que o modelo lê no lugar de uma mensagem que uma PESSOA da equipe mandou nesta linha. O
 * texto dela fica fora: é por ali que sai o que o assistente não pode repetir nem mandar para
 * a API (dinheiro, senha provisória, a situação do aluno na plataforma).
 */
const ESCRITA_POR_PESSOA = '(aqui um atendente da equipe respondeu ao aluno)';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Qual número é o do aluno ─────────────────────────────────────────────────
//
// Sai SÓ do banco (`onb_agente_conta()`: a conta ativa com persona 'aluno' e a IA ligada; com
// a IA desligada ela devolve nulo e a edge fica tão muda quanto o webhook). Sem UUID de
// reserva de propósito: o RH já ficou ouvindo uma conta desativada porque o UUID estava
// escrito no código. Aqui, se a RPC falhar, o assistente fica calado, que é reversível; falar
// pelo número errado não é.
let contaCache: { id: string | null; em: number } = { id: null, em: 0 };
async function contaDoAluno(): Promise<string | null> {
  if (contaCache.em && Date.now() - contaCache.em < 60_000) return contaCache.id;
  const { data, error } = await supabase.rpc('onb_agente_conta');
  if (error) {
    console.log('[crm-agente-aluno] onb_agente_conta falhou, fica em silêncio:', error.message);
    return null; // erro não vai para o cache: a próxima mensagem tenta de novo
  }
  contaCache = { id: data ? String(data) : null, em: Date.now() };
  return contaCache.id;
}

type Config = {
  modelo: string | null;
  horario_inicio: string | null;
  horario_fim: string | null;
  horario_fim_sabado: string | null;
  atende_domingo: boolean | null;
  teste_telefones: string[] | null;
  liberado_para_todos: boolean | null;
  tcc_site_url: string | null;
  mentoria_tcc_quando: string | null;
  mentoria_tcc_url: string | null;
  /** Se as colunas do horário da semana existem no banco (a 20260912120000 foi aplicada). */
  temHorarioDaSemana: boolean;
};

const COLUNAS_CONFIG =
  'modelo, horario_inicio, horario_fim, teste_telefones, liberado_para_todos, tcc_site_url, mentoria_tcc_quando, mentoria_tcc_url';
/** O horário da semana (20260912120000): sábado até meio-dia e o liga/desliga do domingo. */
const COLUNAS_SEMANA = 'horario_fim_sabado, atende_domingo';

/** Configuração editável sem deploy. Sem ela o assistente não fala (fail-closed). */
async function lerConfig(): Promise<Config | null> {
  const { data, error } = await supabase
    .from('onb_agente_config')
    .select(`${COLUNAS_CONFIG}, ${COLUNAS_SEMANA}`)
    .eq('id', true)
    .maybeSingle();
  if (!error && data) return { ...(data as Record<string, unknown>), temHorarioDaSemana: true } as Config;
  // A edge sobe sozinha no push e a migration é aplicada à mão: enquanto as colunas do horário
  // da semana não existirem, o PostgREST recusa o SELECT inteiro e o assistente ficaria mudo
  // com todo mundo. Então a leitura antiga vale, e a marca diz que o banco ainda é o de antes.
  const { data: semSemana, error: erroVelho } = await supabase
    .from('onb_agente_config')
    .select(COLUNAS_CONFIG)
    .eq('id', true)
    .maybeSingle();
  if (erroVelho || !semSemana) return null;
  console.log('[crm-agente-aluno] onb_agente_config sem o horário da semana, usando a janela única:', error?.message ?? '');
  return {
    ...(semSemana as Record<string, unknown>),
    horario_fim_sabado: null, atende_domingo: null, temHorarioDaSemana: false,
  } as Config;
}

/**
 * O horário de atendimento do jeito que as réguas leem.
 *
 * ⚠️ Sem as colunas da 20260912120000 no banco, vale a JANELA ÚNICA de antes, todo dia, e não a
 * reserva de sábado/domingo. O par disto é o `onb_agente_manha_tick`: enquanto a migration não
 * for aplicada, o tick vivo é o da 20260911233400, que olha só as últimas 12 horas e não conhece
 * dia da semana. Se a edge adiasse sábado à tarde e domingo com o tick velho no ar, a mensagem
 * seria adiada para uma retomada que nunca chega (segunda de manhã está a 41 h) e o aluno ficaria
 * sem resposta nenhuma. A ausência das colunas é o sinal de que o tick também é o antigo.
 */
const horarioDaConfig = (c: Config) => (c.temHorarioDaSemana
  ? { inicio: c.horario_inicio, fim: c.horario_fim, fimSabado: c.horario_fim_sabado, atendeDomingo: c.atende_domingo }
  : { inicio: c.horario_inicio, fim: c.horario_fim, fimSabado: c.horario_fim, atendeDomingo: true });

async function chaveDoBanco(): Promise<string> {
  const { data } = await supabase
    .from('ai_api_keys').select('api_key')
    .eq('provider', 'anthropic').eq('is_active', true)
    .limit(1).maybeSingle();
  return (data?.api_key ?? '').trim();
}

async function evento(tipo: string, dados: Record<string, unknown> = {}) {
  try {
    await supabase.from('onb_agente_eventos').insert({
      telefone: (dados.telefone as string) ?? null,
      lead_id: (dados.lead_id as string) ?? null,
      oportunidade_id: (dados.oportunidade_id as string) ?? null,
      tipo,
      detalhe: dados,
    });
  } catch (e) {
    console.error('[crm-agente-aluno] telemetria falhou:', e instanceof Error ? e.message : String(e));
  }
}

// ── Anthropic com retry (cópia do RH, não import) ────────────────────────────
async function chamarClaude(body: Record<string, unknown>): Promise<any> {
  let ultimo = '';
  let tentouBanco = false;
  for (let i = 1; i <= 4; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return await res.json();
    ultimo = `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`;
    if (res.status === 401 && !tentouBanco) {
      tentouBanco = true;
      const doBanco = await chaveDoBanco();
      if (doBanco && doBanco !== ANTHROPIC_KEY) { ANTHROPIC_KEY = doBanco; continue; }
    }
    // 4xx que não é 429 não melhora repetindo (modelo aposentado é 404 e cai aqui).
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    if (i < 4) await dormir(2500);
  }
  throw new Error(`Anthropic: ${ultimo}`);
}

// ── Ferramentas ──────────────────────────────────────────────────────────────
//
// Lista CONSTANTE, na mesma ordem sempre: a lista de ferramentas é o começo do prefixo que o
// cache do prompt reaproveita, e uma lista que muda por etapa é cache perdido em todo turno.
// Nenhuma é financeira, e o teste agenteAlunoSemFinanceiro trava a lista.

const TOOL_QUIETO = {
  name: 'nao_responder',
  description:
    'Use quando a mensagem não pede nada: agradecimento, "ok", "beleza", "vou ver", confirmação ' +
    'do que você acabou de dizer, emoji ou figurinha. Chamar isto encerra o turno sem enviar ' +
    'mensagem nenhuma. Não use para fugir de pergunta que você não sabe responder: nesse caso o ' +
    'certo é passar_para_atendente.',
  input_schema: {
    type: 'object',
    properties: {
      motivo: { type: 'string', description: 'Em poucas palavras, por que não respondeu. Fica no registro, não vai para o aluno.' },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

const TOOL_PASSAR = {
  name: 'passar_para_atendente',
  description:
    'Use sempre que a conversa precisar de uma pessoa da equipe: dinheiro em qualquer forma, ' +
    'inclusive condição de pagamento; cancelar, trancar, desistir ou trocar de curso; outro ' +
    'curso nosso, inclusive quando ele quiser comprar; prazo; declaração ou documento oficial; ' +
    'crítica, sugestão, feedback ou reclamação; contestação de regra nossa ou bate-boca sobre a ' +
    'vida acadêmica dele; algo que depende da situação dele na plataforma; documento que ele ' +
    'mandou por aqui; ligação ou videochamada; TCC com pendência; turma que você não sabe; grupo ' +
    'da turma sem link; pedido para falar com uma pessoa ou com o pedagógico; quem não quer mais ' +
    'receber mensagens; áudio que chegou sem transcrição; e qualquer coisa que você não saiba. ' +
    'Chamar isto registra a passagem e deixa a conversa marcada para a equipe, que responde neste ' +
    'mesmo número. Depois, escreva no máximo uma frase curta dizendo que vai confirmar e já ' +
    'retorna, sem falar em encaminhar para setor nenhum (só crítica, sugestão e feedback são ditos ' +
    'de outro jeito: que você vai levar aquilo para a coordenação avaliar).',
  input_schema: {
    type: 'object',
    properties: {
      assunto: {
        type: 'string',
        enum: [...ASSUNTOS_TRANSFERENCIA],
        description: 'O assunto que mais se aproxima. Na dúvida, outro.',
      },
      motivo: {
        type: 'string',
        description: 'O que ele pediu, com as palavras dele, em uma ou duas frases. Fica registrado junto da passagem.',
      },
    },
    required: ['assunto', 'motivo'],
    additionalProperties: false,
  },
} as const;

const TOOL_AULAS = {
  name: 'consultar_proximas_aulas',
  description:
    'Use quando ele perguntar das próximas aulas da turma dele: quando é a próxima, o que tem ' +
    'nesta semana, que horas começa, qual o tema. Devolve data, horário e tema já do jeito de ' +
    'dizer. Peça 1 quando ele quer só a próxima, e no máximo 5. Responda só com o que voltou ' +
    'daqui: nunca invente aula, data, tema nem professor.',
  input_schema: {
    type: 'object',
    properties: {
      quantidade: { type: 'integer', minimum: 1, maximum: 5, description: 'Quantas aulas trazer, de 1 a 5.' },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

const TOOL_GRUPO = {
  name: 'registrar_grupo_da_turma',
  description:
    'Use quando ele disser, por escrito, se já está ou não no grupo de WhatsApp da turma. ' +
    'Grava a resposta e diz o que fazer em seguida: mandar o link do grupo, ou passar para um ' +
    'atendente quando não temos o link da turma dele.',
  input_schema: {
    type: 'object',
    properties: {
      esta_no_grupo: { type: 'boolean', description: 'true se ele disse que já está no grupo; false se disse que não está.' },
    },
    required: ['esta_no_grupo'],
    additionalProperties: false,
  },
} as const;

const TOOL_LIGACAO = {
  name: 'registrar_preferencia_ligacao',
  description:
    'Use SÓ quando ele estiver respondendo por escrito ao pedido de ligação da integração (a ' +
    'mensagem do quinto dia, com os botões "Começo da manhã" e "Fim da tarde") e disser o que ' +
    'prefere. Você não marca dia nem hora: só registra a preferência, e a equipe combina com ele. ' +
    'Chamar isto já registra a passagem para a equipe. Fora desse convite, quem pede ligação ou ' +
    'videochamada vai por passar_para_atendente com o assunto ligacao, sem você perguntar nada.',
  input_schema: {
    type: 'object',
    properties: {
      periodo: { type: 'string', enum: ['comeco_da_manha', 'fim_da_tarde', 'outro'], description: 'O período que ele prefere.' },
      canal: { type: 'string', enum: ['ligacao', 'videochamada', 'tanto_faz', 'nao_disse'], description: 'Voz ou vídeo.' },
      como_ele_disse: { type: 'string', description: 'A preferência com as palavras dele, inclusive horário exato se ele deu.' },
    },
    required: ['periodo', 'canal', 'como_ele_disse'],
    additionalProperties: false,
  },
} as const;

const TOOL_TCC = {
  name: 'consultar_tcc',
  description:
    'Use quando ele já enviou o TCC e quer saber em que etapa o trabalho está. Devolve só a ' +
    'etapa, com o nome que você pode dizer a ele, ou avisa que é caso de passar para um ' +
    'atendente. Nunca traz prazo, e você nunca fala em prazo.',
  input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
} as const;

// O perfil do aluno (pedido do Rafael, 11/09): a meta dele com a pós e como ele conheceu a
// gente, para um dashboard futuro. Sem campo de sexo de propósito: o sexo sai do primeiro nome,
// no banco, e o assistente nunca pergunta nem registra. As listas são as dos CHECKs da tabela.
const TOOL_PERFIL = {
  name: 'registrar_perfil_do_aluno',
  description:
    'Use logo depois de perguntar a meta pessoal dele com a pós ou como ele conheceu a gente, com ' +
    'acabei_de_perguntar, para ficar marcado. E use quando ele responder: as palavras dele, ' +
    'copiadas da mensagem dele, e a categoria que mais se aproxima (resposta vaga vai do jeito ' +
    'que veio, com a categoria outro). Numa chamada vai uma coisa só: ou a resposta dele, ou ' +
    'acabei_de_perguntar; se ele respondeu e você perguntou a outra na mesma mensagem, chame ' +
    'duas vezes. Registre só o que ele disse, nunca o que você acha, e sem resumir nem corrigir ' +
    'as palavras dele. Não registra mais nada da vida dele.',
  input_schema: {
    type: 'object',
    properties: {
      meta_pessoal: {
        type: 'string',
        description: 'A meta dele com a pós, com as palavras dele, copiadas da mensagem dele (sem resumir ' +
          'e sem corrigir). Vai sempre junto com meta_pessoal_categoria.',
      },
      meta_pessoal_categoria: {
        type: 'string',
        enum: [...CATEGORIAS_META_PESSOAL],
        description: 'A categoria que mais se aproxima da meta que ele disse. Na dúvida, outro.',
      },
      como_conheceu: {
        type: 'string',
        enum: [...CATEGORIAS_COMO_CONHECEU],
        description: 'Como ele conheceu a gente: a categoria que mais se aproxima do que ele disse. Na dúvida, outro.',
      },
      como_conheceu_detalhe: {
        type: 'string',
        description: 'O detalhe que ele deu, com as palavras dele, copiadas da mensagem dele: quem indicou, ' +
          'qual rede, qual curso ou evento. Só junto com como_conheceu.',
      },
      acabei_de_perguntar: {
        type: 'string',
        enum: [...PERGUNTAS_DO_PERFIL],
        description: 'Qual das duas perguntas você acabou de fazer.',
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

const FERRAMENTAS = [TOOL_QUIETO, TOOL_PASSAR, TOOL_AULAS, TOOL_GRUPO, TOOL_LIGACAO, TOOL_TCC, TOOL_PERFIL];

// ── Envio pela fila ──────────────────────────────────────────────────────────

/**
 * A resposta é ENFILEIRADA em `crm_mensagens_agendadas`, não enviada na hora (mesmo desenho
 * do RH): dormir dentro da função perderia a resposta se o worker fosse reciclado, e na fila
 * ela é uma linha que o `crm-agendadas-dispatch` entrega mesmo assim.
 *
 * `criado_por` fica NULO de propósito: é ele que faria o `crm-whatsapp-send` carimbar a
 * mensagem como `origem = 'humano'`, e aí a porta do humano calaria o próprio assistente.
 *
 * ⚠️ A fila tem um trigger BEFORE INSERT (`crm_fila_bloqueia_disparo`) que troca na hora
 * 'agendado' por 'cancelado' quando o telefone está arquivado, em não perturbe ou com
 * temporizador, e ninguém confere isso depois. A 20260911233500 tira a resposta do assistente
 * desses três (é resposta a quem acabou de escrever, não disparo de motor); qualquer outro
 * bloqueio segue valendo. Por isso a linha volta com o status: cancelada na entrada vira
 * `bloqueio`, e quem chama registra o evento certo em vez de 'respondido'.
 *
 * Devolve também o id da linha nova e o das pendentes que esta resposta cancelou: é por eles
 * que a pergunta do perfil só conta depois de a mensagem existir de verdade na fila, e que a
 * pergunta de uma mensagem cancelada deixa de contar (ver `marcarPerguntaFeita`).
 */
async function enviar(
  conta: string, telefone: string, texto: string, leadId: string | null, opId: string,
): Promise<{ espera: number; bloqueio: string | null; filaId: string | null; canceladas: string[] }> {
  const espera = esperaSorteada();
  const quando = new Date(Date.now() + espera * 1000).toISOString();

  // Se o aluno escreveu de novo antes da resposta sair, esta aqui já considerou tudo: a
  // pendente é substituída, para ele não receber duas respostas parecidas em seguida.
  const { data: canceladas } = await supabase.from('crm_mensagens_agendadas')
    .update({ status: 'cancelado', erro_detalhe: 'Substituída por uma resposta mais nova do assistente pedagógico.' })
    .eq('oportunidade_id', opId)
    .eq('criado_por_nome', AUTOR)
    .eq('status', 'agendado')
    .select('id');

  const { data: linha, error } = await supabase.from('crm_mensagens_agendadas').insert({
    criado_por_nome: AUTOR,
    wa_account_id: conta,
    wa_conexao_id: null,
    lead_id: leadId,
    oportunidade_id: opId,
    telefone,
    tipo_mensagem: 'texto',
    conteudo: texto,
    enviar_em: quando,
    status: 'agendado',
  }).select('id, status, erro_detalhe').maybeSingle();
  if (error) throw new Error(`fila crm_mensagens_agendadas: ${error.message}`);
  const bloqueio = linha?.status === 'cancelado'
    ? String(linha.erro_detalhe ?? '').trim() || 'cancelada pela fila na entrada'
    : null;
  return {
    espera,
    bloqueio,
    filaId: linha?.id ? String(linha.id) : null,
    canceladas: ((canceladas ?? []) as { id?: unknown }[]).map((l) => String(l?.id ?? '')).filter(Boolean),
  };
}

// ── O aluno ──────────────────────────────────────────────────────────────────

type Aluno = {
  oportunidade_id: string;
  via: 'card' | 'posicao';
  lead_id: string | null;
  lead_nome: string | null;
  etapa_id: string | null;
  etapa_nome: string | null;
  papel: string | null;
  entrou_na_etapa_em: string | null;
  total_em_integracao: number | null;
};

/** Abre a passagem para a equipe e devolve o id. Uma por ASSUNTO em cada turno (ver `passar`). */
async function abrirTransferencia(
  aluno: Aluno, telefone: string, conta: string, assunto: string, motivo: string | null, msgId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('onb_agente_registrar_transferencia', {
    p_oportunidade_id: aluno.oportunidade_id,
    p_telefone: telefone,
    p_wa_account_id: conta,
    p_assunto: assunto,
    p_motivo: motivo,
    p_inbound_wa_message_id: msgId,
  });
  await evento(`transferido:${assunto}`, {
    telefone, lead_id: aluno.lead_id, oportunidade_id: aluno.oportunidade_id, motivo, erro: error?.message ?? null,
  });
  return data ? String(data) : null;
}

/**
 * A pergunta do perfil só CONTA depois de a resposta existir na fila. Antes ela era gravada no
 * meio do turno, e a mensagem com a pergunta sai de 2 a 4 minutos depois: turno que terminava em
 * silêncio, em resposta vazia ou com a fila bloqueando a linha contava uma pergunta que o aluno
 * nunca leu, e queimava uma das duas que ele tem em toda a integração.
 *
 * O evento guarda o id da linha da fila e o carimbo que havia ANTES: é por ele que a marca é
 * desfeita se essa mensagem for cancelada por uma resposta mais nova (ver o desfazer abaixo).
 */
async function marcarPerguntaFeita(
  aluno: Aluno, pergunta: PerguntaDoPerfil, antes: string | null, filaId: string | null,
  rastro: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await supabase.rpc('onb_agente_registrar_perfil', {
    p_oportunidade_id: aluno.oportunidade_id,
    p_meta_pessoal: null, p_meta_categoria: null, p_como_conheceu: null, p_como_detalhe: null,
    p_perguntou: pergunta,
  });
  const estado = (data && typeof data === 'object' ? data : null) as Record<string, unknown> | null;
  const coluna = pergunta === 'meta_pessoal' ? 'meta_pessoal_perguntada_em' : 'como_conheceu_perguntada_em';
  const marcadaEm = estado?.[coluna] ? String(estado[coluna]) : null;
  await evento('perfil:pergunta_marcada', {
    ...rastro,
    pergunta,
    fila_id: filaId,
    marcada_em: marcadaEm,
    antes,
    // A mensagem com a pergunta já está na fila: não dá para voltar atrás, e a conta das duas
    // vezes vai ficar curta. Fica o rastro em vez de um silêncio.
    erro: error?.message ?? (estado ? null : 'a RPC não devolveu o estado (oportunidade não encontrada)'),
  });
}

/**
 * A resposta que levava a pergunta foi cancelada antes de sair (o aluno escreveu de novo e esta
 * resposta substituiu a pendente): a pergunta não foi feita, então ela não pode continuar
 * contada. Desfaz pelo carimbo exato que a marca gravou, e por isso repetir é inofensivo: se
 * outra marca veio depois, o carimbo já é outro e a RPC não mexe em nada.
 */
async function desfazerPerguntasCanceladas(
  aluno: Aluno, canceladas: string[], rastro: Record<string, unknown>,
): Promise<void> {
  if (!canceladas.length) return;
  const { data: marcas, error: erroLeitura } = await supabase
    .from('onb_agente_eventos')
    .select('detalhe')
    .eq('tipo', 'perfil:pergunta_marcada')
    .eq('oportunidade_id', aluno.oportunidade_id)
    .in('detalhe->>fila_id', canceladas)
    .limit(10);
  // Sem esta leitura não há o que desfazer, e o desfazer é a metade invisível da conta: a
  // pergunta continuaria contada para sempre, o aluno perderia uma das duas que tem na
  // integração inteira e nada explicaria por quê. Não dá para repetir (a resposta já foi
  // cancelada), mas o rastro deixa alguém enxergar que a conta ficou alta.
  if (erroLeitura) {
    await evento('perfil:desfazer_falhou', { ...rastro, fila_ids: canceladas, erro: erroLeitura.message });
    return;
  }
  for (const m of (marcas ?? []) as { detalhe?: Record<string, unknown> | null }[]) {
    const d = m?.detalhe ?? {};
    const pergunta = String(d.pergunta ?? '');
    const marcadaEm = d.marcada_em ? String(d.marcada_em) : '';
    if (!(PERGUNTAS_DO_PERFIL as readonly string[]).includes(pergunta) || !marcadaEm) continue;
    const { data: desfeita, error } = await supabase.rpc('onb_agente_desmarcar_pergunta', {
      p_oportunidade_id: aluno.oportunidade_id,
      p_pergunta: pergunta,
      p_marcada_em: marcadaEm,
      p_anterior: d.antes ? String(d.antes) : null,
    });
    await evento('perfil:pergunta_desfeita', {
      ...rastro, pergunta, fila_id: d.fila_id ?? null, desfeita: desfeita === true, erro: error?.message ?? null,
    });
  }
}

/**
 * A retomada das 8h vem do banco (`onb_agente_manha_tick`), e o endpoint é público. Não dá
 * para autenticar por Bearer: o service_role que o banco conhece não é o da edge. A prova é
 * a marca que o próprio tick grava antes de chamar, com o mesmo id, que ninguém de fora
 * consegue escrever (a tabela de eventos não aceita insert de usuário).
 */
async function manhaAutentica(id: string, telefone: string): Promise<boolean> {
  if (!id.startsWith('manha-') || !telefone) return false;
  const desde = new Date(Date.now() - MANHA_VALIDADE_MIN * 60_000).toISOString();
  const { data } = await supabase
    .from('onb_agente_eventos')
    .select('telefone')
    .eq('tipo', 'manha:disparada')
    .eq('detalhe->>id', id)
    .gte('criada_em', desde)
    .limit(1)
    .maybeSingle();
  return !!data && mesmoTelefone(data.telefone, telefone);
}

/** O que a fila de transcrição gravou nesta mensagem. Vazio enquanto não terminou. */
const transcricaoDe = (metadata: any): string => String(metadata?.audio_transcricao ?? '').trim();

/**
 * Espera a transcrição do áudio que acabou de chegar, igual ao que o João faz com o áudio do
 * vendedor: quem transcreve é a fila do banco, e o turno segura o passo em vez de responder
 * "não consigo ouvir" a um áudio que estaria pronto três segundos depois.
 *
 * Renova a trava a cada volta: sem isso, uma espera de 20 s comeria um quinto dos 90 s da
 * trava justamente no turno mais longo, e o próximo balão do aluno entraria por cima.
 * Devolve '' quando o prazo acaba, e aí o turno segue pelo caminho antigo.
 */
async function esperarTranscricao(msgId: string, chave: string): Promise<string> {
  const limite = Date.now() + ESPERA_TRANSCRICAO_MS;
  while (true) {
    const { data } = await supabase
      .from('crm_whatsapp_messages')
      .select('metadata')
      .eq('wa_message_id', msgId)
      .eq('direcao', 'inbound')
      .limit(1)
      .maybeSingle();
    const texto = transcricaoDe(data?.metadata);
    if (texto) return texto;
    if (Date.now() >= limite) return '';
    await supabase.rpc('onb_agente_lock_renovar', { p_telefone: chave, p_ttl_segundos: LOCK_TTL_SEGUNDOS });
    await dormir(PASSO_TRANSCRICAO_MS);
  }
}

async function processar(payload: any, conta: string, profundidade = 0): Promise<void> {
  const msgId = String(payload?.id ?? '').trim();
  if (!msgId) return;
  const ehManha = payload?.motivo === 'manha';

  // ── ORIGEM: o que o payload diz só vale se o banco confirmar ──────────────
  // O endpoint é público (VERIFY_JWT desligado no self-hosted) e o UUID da conta está no
  // front. Então o telefone, o tipo, o texto e o botão saem da linha gravada pelo webhook,
  // e não do corpo do POST.
  let telefone = '';
  let tipo = 'text';
  let conteudo = '';
  let botaoBruto: unknown = null;
  let chegouEm = new Date();
  if (ehManha) {
    telefone = digitos(payload?.telefone);
    if (!(await manhaAutentica(msgId, telefone))) {
      console.log('[crm-agente-aluno] retomada das 8h sem marca do tick, ignorada:', msgId);
      return;
    }
  } else {
    const { data: origem } = await supabase
      .from('crm_whatsapp_messages')
      .select('telefone, tipo, conteudo, metadata, created_at')
      .eq('wa_message_id', msgId)
      .eq('direcao', 'inbound')
      .eq('wa_account_id', conta)
      .limit(1)
      .maybeSingle();
    if (!origem) {
      console.log('[crm-agente-aluno] mensagem que o banco não conhece nesta conta, ignorada:', msgId);
      return;
    }
    telefone = digitos(origem.telefone);
    tipo = String(origem.tipo ?? 'text');
    conteudo = String(origem.conteudo ?? '');
    botaoBruto = origem.metadata?.interactive_reply ?? null;
    chegouEm = new Date(origem.created_at);
  }
  const chave = canonDdd8(telefone) ?? ultimos8(telefone);
  if (!chave) return;

  // Idempotência antes de qualquer coisa cara.
  const { error: errDup } = await supabase
    .from('onb_agente_processadas').insert({ wa_message_id: msgId, telefone });
  if (errDup) { await evento('pulado:duplicada', { telefone, msgId }); return; }

  await evento('recebido', { telefone, msgId, tipo, conteudo: conteudo.slice(0, 200), motivo: ehManha ? 'manha' : null });

  // Reação e figurinha não pedem resposta, e o modelo não precisa ser acordado para isso.
  // (Para a régua elas contam como interação: quem mede é a automação, não este agente.)
  if (tipo === 'reaction' || tipo === 'sticker') { await evento('pulado:reacao', { telefone, msgId, tipo }); return; }

  const { data: pegou } = await supabase.rpc('onb_agente_lock_claim', {
    p_telefone: chave, p_ttl_segundos: LOCK_TTL_SEGUNDOS,
  });
  if (!pegou) {
    // ⚠️ A marca de processada foi gravada ANTES de saber se o lock estava livre. Sem
    // desfazê-la, a mensagem fica como feita e ninguém volta para buscá-la (foi assim que o
    // agente de RH perguntou a cidade de novo em 31/08). Devolvida, o turno em andamento a
    // pega na retomada lá embaixo.
    await supabase.from('onb_agente_processadas').delete().eq('wa_message_id', msgId);
    await evento('pulado:lock', { telefone, msgId });
    return;
  }

  // Até onde este turno LEU a conversa: é isso que decide o que "chegou no meio".
  let conversaLidaAte = new Date().toISOString();
  let rastro: Record<string, unknown> = { telefone, msgId };

  try {
    if (!ehManha) await dormir(BUFFER_MS);

    // ── ALUNO: card próprio OU posição no funil da integração ─────────────────
    // A busca mora no banco, pelo telefone canônico (DDD + 8), porque o funil está marcado
    // como espelho e o Rafael ainda decide se aluno entra como card próprio ou como posição
    // do card fixo. A função acha dos dois jeitos; aqui não importa qual.
    const { data: achado, error: errAchado } = await supabase
      .rpc('onb_agente_aluno_por_telefone', { p_telefone: telefone });
    if (errAchado) throw new Error(`onb_agente_aluno_por_telefone: ${errAchado.message}`);
    const aluno = (Array.isArray(achado) ? achado[0] : achado) as Aluno | null;
    if (!aluno?.oportunidade_id) { await evento('pulado:sem_card', rastro); return; }
    rastro = {
      telefone, msgId, lead_id: aluno.lead_id, oportunidade_id: aluno.oportunidade_id,
      via: aluno.via, etapa: aluno.etapa_nome,
    };

    // ── ETAPA: papel do banco, nunca o nome ───────────────────────────────────
    // Renomear uma etapa no kanban não pode ligar nem desligar o agente. Etapa sem papel é
    // etapa onde ele não fala: recuperação, indicação, sem resposta, integrado e cancelado
    // são conversas de gente.
    if (aluno.papel !== 'conversa') { await evento('pulado:etapa', rastro); return; }

    const cfg = await lerConfig();
    if (!cfg) { await evento('pulado:sem_config', rastro); return; }

    // ── TESTE: allowlist fail-closed, e produção só por decisão explícita ─────
    // Lista com número: só esses. Lista VAZIA não é produção por omissão: só vale com
    // `liberado_para_todos`, que nasce false. Sem isso, ligar a IA do número na tela antes de
    // preencher a lista soltava o assistente (prompt ainda sem revisão) em todos os alunos.
    const lista = (cfg.teste_telefones ?? []).filter((t) => String(t ?? '').trim());
    if (lista.length) {
      if (!lista.some((t) => mesmoTelefone(t, telefone))) {
        await evento('pulado:fora_da_allowlist', rastro);
        return;
      }
    } else if (cfg.liberado_para_todos !== true) {
      await evento('pulado:nao_liberado', rastro);
      return;
    }

    // Passagens deste turno, UMA POR ASSUNTO: a do botão (grupo sem link, ligação) não pode
    // engolir a que o modelo abre depois. "E parem de me mandar mensagem" depois do "Não estou"
    // tem de virar a sua própria linha, e é ela que grava a régua pausada.
    let transferenciaDesteTurno: string | null = null;
    const assuntosDesteTurno = new Set<string>();
    const passar = async (assunto: string, motivo: string | null) => {
      if (assuntosDesteTurno.has(assunto)) return;
      assuntosDesteTurno.add(assunto);
      const id = await abrirTransferencia(aluno, telefone, conta, assunto, motivo, msgId);
      transferenciaDesteTurno ??= id;
    };

    // ── Botões da régua: gravados antes do horário, para valer mesmo de madrugada ──
    // Só o REGISTRO vem antes. A passagem do botão de ligação abre lá embaixo, depois das
    // portas: aberta aqui, o toque das 22h virava passagem aberta, e a retomada das 8h calava
    // diante dela sem nunca perguntar se ele prefere ligação ou vídeo.
    let linkQueTemQueIr: string | null = null;
    let instrucaoAgora: string | null = null;
    const botao = ehManha ? null : interpretarBotao(botaoBruto);
    if (botao?.tipo === 'grupo') {
      const { error } = await supabase.rpc('onb_agente_registrar_grupo', {
        p_oportunidade_id: aluno.oportunidade_id, p_no_grupo: botao.estaNoGrupo,
      });
      await evento('grupo:registrado', { ...rastro, no_grupo: botao.estaNoGrupo, pelo: 'botao', erro: error?.message ?? null });
    } else if (botao?.tipo === 'ligacao') {
      const { error } = await supabase.rpc('onb_agente_registrar_ligacao', {
        p_oportunidade_id: aluno.oportunidade_id, p_periodo: botao.periodo, p_canal: null,
        p_obs: 'escolheu pelo botão do pedido de ligação',
      });
      await evento('ligacao:registrada', { ...rastro, periodo: botao.periodo, pelo: 'botao', erro: error?.message ?? null });
    }

    // ── HORÁRIO: pela hora e pelo DIA em que a mensagem CHEGOU ────────────────
    // Fora do horário não se chama o modelo nem se enfileira nada para as 8h: o tick da manhã
    // refaz o turno do zero, e se um atendente já tiver respondido, a porta do humano cala.
    // Segunda a sexta das 8h às 21h, sábado até meio-dia e domingo fechado (tudo da config):
    // o que chega sábado à tarde ou no domingo é respondido na segunda de manhã.
    if (!ehManha && !dentroDoHorario(chegouEm, horarioDaConfig(cfg))) {
      await evento('adiado:fora_do_horario', rastro);
      return;
    }

    // ── ÁUDIO: o que ele falou, em texto ──────────────────────────────────────
    // A trigger do banco enfileira o áudio de entrada desta linha assim que o webhook grava a
    // mensagem, e acorda a `crm-transcrever-audio` na hora. Aqui o turno só espera o texto
    // aparecer na `metadata`, e espera DEPOIS das portas: nada de segurar o turno por um
    // áudio de quem não é aluno da integração, ou de quem escreveu fora do horário.
    let transcricaoAgora = '';
    if (!ehManha && tipo === 'audio') {
      transcricaoAgora = await esperarTranscricao(msgId, chave);
      await evento(transcricaoAgora ? 'audio:transcrito' : 'audio:sem_transcricao',
        { ...rastro, caracteres: transcricaoAgora.length });
    }

    // ── Histórico da conversa NESTA linha, com ESTA pessoa ────────────────────
    // O `ilike` pelos últimos 8 dígitos acha a linha com e sem o 9 e com e sem o 55; o
    // refiltro pelo canon (DDD + 8) tira o número igual de outro DDD. A 3250 fala com o
    // Brasil inteiro, e contexto de outra pessoa é o pior erro possível aqui.
    const { data: msgs } = await supabase
      .from('crm_whatsapp_messages')
      .select('direcao, tipo, conteudo, created_at, telefone, status_entrega, metadata')
      .eq('wa_account_id', conta)
      .ilike('telefone', `%${ultimos8(telefone)}`)
      .order('created_at', { ascending: false })
      .limit(120);
    const daPessoa = (msgs ?? []).filter((m: any) => mesmoTelefone(m.telefone, telefone));
    const ultimaLida = daPessoa.reduce(
      (max: string, m: any) => (m.created_at && m.created_at > max ? m.created_at : max), '',
    );
    if (ultimaLida) conversaLidaAte = ultimaLida;

    // O botão que ainda está sem resposta nossa: o desta mensagem ou, na retomada (8h, ou a
    // mensagem que chegou no meio), o mais recente depois da nossa última fala. Sem isto, o
    // "Não estou" tocado às 23h, ou seguido de um "pode mandar?", perdia a garantia do link.
    const iSaida = daPessoa.findIndex((m: any) => m.direcao === 'outbound');
    const semResposta = iSaida === -1 ? daPessoa : daPessoa.slice(0, iSaida);
    const botaoPendente = botao ?? semResposta
      .map((m: any) => (m.direcao === 'inbound' ? interpretarBotao(m.metadata?.interactive_reply) : null))
      .find((b: ReturnType<typeof interpretarBotao>) => b !== null) ?? null;

    const conversa = daPessoa
      .filter((m: any) => String(m.conteudo ?? '').trim() && !(m.direcao === 'outbound' && m.status_entrega === 'failed'))
      .reverse()
      .slice(-MAX_HISTORICO);

    // O que ELE escreveu nesta conversa: é contra isto que a ferramenta do perfil confere se a
    // meta e o detalhe são mesmo as palavras dele, e não a versão do modelo.
    //
    // Vai nas DUAS formas, a crua e a saneada, porque o modelo não lê a crua: `sanearParaModelo`
    // troca "5 a 10" por "5 a 10" e o travessão por vírgula antes de o texto chegar nele. Só com a
    // crua, o aluno que escreve "sair de 5 a 10 mil" tem a meta recusada por não ser dele, e ele
    // copiou certinho o que leu.
    const falasDoAluno: string[] = [];
    const guardarFala = (cru: string) => {
      if (!cru.trim()) return;
      falasDoAluno.push(cru);
      const saneada = sanearParaModelo(cru);
      if (saneada !== cru) falasDoAluno.push(saneada);
    };
    for (const m of conversa) {
      if (m.direcao !== 'inbound') continue;
      guardarFala(String(m.conteudo ?? ''));
      // O que ele falou num áudio é fala dele igual. Sem isto, a meta pessoal dita por voz
      // seria recusada pela própria trava que existe para não deixar o modelo inventar: o
      // texto cru daquela mensagem é "[áudio]".
      guardarFala(transcricaoDe(m.metadata));
    }
    guardarFala(conteudo);
    guardarFala(transcricaoAgora);

    // ── JANELA ────────────────────────────────────────────────────────────────
    const ultimoInbound = daPessoa.find((m: any) => m.direcao === 'inbound');
    const idadeH = ultimoInbound
      ? (Date.now() - new Date(ultimoInbound.created_at).getTime()) / 3_600_000
      : Infinity;
    if (idadeH > JANELA_HORAS) {
      // ⚠️ A retomada da manhã chega DEPOIS das 24 h quando ele escreve no fim de semana: o que
      // chegou sábado às 13h só é retomado segunda às 8h, 43 h depois (é por isso que a busca do
      // tick vai a 48 h). Responder ali é impossível, a Meta recusa texto livre fora da janela de
      // 24 h do último inbound. E sair calado seria pior do que antes desta régua: o tick já
      // gravou `manha:disparada`, então nenhuma rodada seguinte volta a buscar essa pessoa, e a
      // mensagem dela morreria sem ninguém saber. Então a conversa vai para a equipe, que
      // responde por modelo. Sem incomodar quem já está com ela: pessoa conduzindo a linha ou
      // passagem ainda aberta dispensam a nova.
      let paraAEquipe = false;
      if (ehManha) {
        const humanoNaLinha = daPessoa.find((m: any) => m.direcao === 'outbound')?.metadata?.origem === 'humano';
        const { data: jaAberta } = await supabase
          .from('onb_agente_transferencias')
          .select('id')
          .eq('oportunidade_id', aluno.oportunidade_id)
          .is('resolvida_em', null)
          .limit(1)
          .maybeSingle();
        paraAEquipe = !humanoNaLinha && !jaAberta?.id;
        if (paraAEquipe) {
          await passar('outro', 'ele escreveu fora do horário de atendimento e a janela de 24 horas do WhatsApp ' +
            'fechou antes da retomada: o assistente não pode mais responder, quem responde é a equipe');
        }
      }
      await evento('pulado:janela', { ...rastro, idadeH, manha: ehManha, passou_para_equipe: paraAEquipe });
      return;
    }

    // ── Porta do humano: uma PESSOA está conduzindo esta conversa ─────────────
    // Se a última mensagem nossa nesta linha foi escrita por gente, ele não fala. A régua é
    // o estado, não um tempo: volta sozinho quando sai algo nosso que não é humano (a
    // automação da próxima etapa). Assim o suporte assume sem desligar nada.
    const { data: saidas } = await supabase
      .from('crm_whatsapp_messages')
      .select('metadata, created_at, telefone')
      .eq('wa_account_id', conta)
      .eq('direcao', 'outbound')
      .ilike('telefone', `%${ultimos8(telefone)}`)
      .order('created_at', { ascending: false })
      .limit(5);
    const ultimaSaida = (saidas ?? []).find((m: any) => mesmoTelefone(m.telefone, telefone));
    if (ultimaSaida?.metadata?.origem === 'humano') {
      await evento('pulado:humano_no_comando', { ...rastro, quem: ultimaSaida.metadata?.enviado_por_nome ?? null });
      return;
    }

    // ── Contexto do aluno (lista fechada de campos, nada financeiro) ──────────
    const { data: ctxBruto, error: errCtx } = await supabase.rpc('onb_agente_contexto', {
      p_oportunidade_id: aluno.oportunidade_id, p_telefone: telefone,
    });
    if (errCtx || !ctxBruto) throw new Error(`onb_agente_contexto: ${errCtx?.message ?? 'vazio'}`);
    const ctx = ctxBruto as ContextoAluno;

    // ── Passagem aberta: a equipe já foi chamada e ainda não respondeu ────────
    // Sem isto, o "e aí?" do aluno reabriria a conversa por cima da pessoa que vai responder.
    // Nenhuma passagem deste turno existe ainda neste ponto: as dos botões abrem logo abaixo.
    const aberta = ctx.transferencia_aberta;
    if (aberta?.id) {
      await evento('pulado:transferencia_aberta', { ...rastro, assunto: aberta.assunto ?? null });
      return;
    }

    // O que o botão pede, dito ao modelo com o link já na mão. Botão antigo que o estado já
    // desmentiu (alguém da equipe corrigiu o "está no grupo" depois) não vale mais.
    const botaoDaVez = botaoPendente?.tipo === 'grupo' && ctx.no_grupo !== null && ctx.no_grupo !== undefined &&
        ctx.no_grupo !== botaoPendente.estaNoGrupo
      ? null
      : botaoPendente;
    if (botaoDaVez?.tipo === 'grupo' && botaoDaVez.estaNoGrupo) {
      instrucaoAgora = 'Ele tocou no botão dizendo que JÁ ESTÁ no grupo da turma, e isso já ficou ' +
        'registrado. Se a mensagem não pede mais nada, não precisa responder (use nao_responder); ' +
        'se responder, uma frase curta.';
    } else if (botaoDaVez?.tipo === 'grupo' && ctx.grupo_url) {
      linkQueTemQueIr = ctx.grupo_url;
      instrucaoAgora = 'Ele tocou no botão dizendo que NÃO está no grupo da turma, e isso já ficou ' +
        `registrado. Mande o link do grupo da turma dele, copiado igual: ${ctx.grupo_url}. ` +
        'Sem rodeio e sem pedir mais nada.';
    } else if (botaoDaVez?.tipo === 'grupo') {
      await passar('grupo_sem_link', 'disse pelo botão que não está no grupo, e a turma não tem link cadastrado');
      instrucaoAgora = 'Ele tocou no botão dizendo que NÃO está no grupo da turma, e nós não temos o ' +
        'link da turma dele. A equipe já foi avisada. Diga numa frase que vai providenciar o acesso ' +
        'e já retorna. Não mande link nenhum.';
    } else if (botaoDaVez?.tipo === 'ligacao') {
      // Vale o botão desta mensagem e, na retomada das 8h, o que ele tocou de madrugada.
      const periodo = botaoDaVez.periodo === 'comeco_da_manha' ? 'começo da manhã' : 'fim da tarde';
      await passar('ligacao', `escolheu ${periodo} pelo botão`);
      instrucaoAgora = `Ele escolheu pelo botão do pedido de ligação: ${periodo}. Já ficou registrado e ` +
        'a equipe vai combinar com ele. Pergunte só se ele prefere ligação ou videochamada, numa ' +
        'frase, sem marcar dia nem hora.';
    }

    // Um relógio só para o turno: o que o contexto diz que pode ser perguntado hoje e o que a
    // ferramenta aceita marcar têm de concordar, inclusive perto da meia-noite.
    const agora = new Date();
    const perfil = perfilDoContexto(ctx);
    /** A pergunta que o modelo fez neste turno e que só será contada se a resposta for enviada. */
    let perguntaPendente: PerguntaDoPerfil | null = null;

    const contexto = montarContexto(ctx, {
      agora,
      ehManha,
      totalEmIntegracao: Number(aluno.total_em_integracao ?? 1),
      // O mesmo horário que decidiu se ele responde agora: o prompt não crava hora nenhuma.
      horario: horarioDaConfig(cfg),
      tccSiteUrl: cfg.tcc_site_url,
      mentoriaQuando: cfg.mentoria_tcc_quando,
      mentoriaUrl: cfg.mentoria_tcc_url,
      instrucaoAgora,
    });

    const messages: any[] = conversa
      .map((m: any) => ({
        role: m.direcao === 'inbound' ? 'user' : 'assistant',
        // O que uma PESSOA da equipe escreveu não entra, só o aviso de que ela respondeu (ver
        // ESCRITA_POR_PESSOA). O resto passa pelo saneamento: ele copia o estilo do que lê.
        content: m.direcao === 'outbound' && m.metadata?.origem === 'humano'
          ? ESCRITA_POR_PESSOA
          : sanearParaModelo(m.direcao === 'inbound'
              // A transcrição vem da mesma linha da mensagem: áudio antigo já transcrito pela
              // fila entra no histórico como o que ele falou, e não como marcador.
              ? descreverParaModelo(m.tipo, m.conteudo, transcricaoDe(m.metadata))
              : m.conteudo)
            .slice(0, 4000).trim(),
      }))
      // ⚠️ Bloco vazio derruba a chamada inteira com HTTP 400.
      .filter((m: any) => m.content.length > 0);

    // A conversa do aluno quase sempre COMEÇA com mensagem nossa (a régua), e a API exige
    // que a primeira seja do usuário. Tirar as nossas faria o modelo perder justamente a
    // mensagem a que o aluno está respondendo; então entra uma abertura neutra.
    if (messages.length && messages[0].role !== 'user') {
      messages.unshift({ role: 'user', content: '(a conversa começou com mensagens nossas, da integração, e segue abaixo)' });
    }
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      messages.push({
        role: 'user',
        content: ehManha
          ? '(sem mensagem nova: é a retomada das 8h do que ele escreveu fora do horário)'
          : sanearParaModelo(descreverParaModelo(tipo, conteudo, transcricaoAgora)).slice(0, 4000).trim() ||
            '(ele mandou algo sem texto)',
      });
    }

    // ── Claude ───────────────────────────────────────────────────────────────
    // System em DOIS blocos: o prompt fixo com cache, e o contexto (que tem o relógio) fora
    // dele. No RH os dois vão juntos e o cache nunca acerta, porque a hora muda o prefixo.
    const modelo = (cfg.modelo ?? '').trim() || MODELO_RESERVA;
    let resposta = '';
    let textoAntesDaFerramenta = '';
    let rodada = 0;
    let usouFerramentas: string[] = [];
    const historico: any[] = [...messages];

    while (rodada < MAX_RODADAS) {
      rodada++;
      const r = await chamarClaude({
        model: modelo,
        max_tokens: 1024,
        thinking: { type: 'disabled' },
        system: [
          { type: 'text', text: PROMPT_ALUNO, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: contexto },
        ],
        messages: historico,
        tools: FERRAMENTAS,
      });

      const blocos = r?.content ?? [];
      const texto = blocos.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      const usos = blocos.filter((b: any) => b.type === 'tool_use');

      if (!usos.length) { resposta = texto || textoAntesDaFerramenta; break; }

      // ⚠️ SÓ os blocos de ferramenta entram no histórico, nunca o texto que veio junto: esse
      // texto ainda não foi enviado, e deixá-lo aqui faz o modelo achar que já falou (lição do
      // RH, 30/08). Ele fica guardado como rede, logo abaixo.
      historico.push({ role: 'assistant', content: usos });
      const results: any[] = [];
      for (const u of usos) {
        usouFerramentas = [...usouFerramentas, String(u.name)];

        if (u.name === 'nao_responder') {
          // Botão "Não estou" com link na mão: o link TEM que ir, silêncio aqui é aluno fora
          // do grupo e sem a aula ao vivo.
          if (linkQueTemQueIr) {
            results.push({
              type: 'tool_result', tool_use_id: u.id,
              content: `Não dá para ficar quieto agora: mande o link do grupo da turma dele, copiado igual: ${linkQueTemQueIr}`,
            });
            continue;
          }
          const motivo = String(u.input?.motivo ?? '').trim().slice(0, 300) || null;
          await evento('silencio', { ...rastro, motivo });
          return;
        }

        if (u.name === 'passar_para_atendente') {
          const assunto = assuntoValido(u.input?.assunto);
          const motivo = String(u.input?.motivo ?? '').trim().slice(0, 500) || null;
          await passar(assunto, motivo);
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            // ⚠️ Sem promessa de que as mensagens param: `regua_pausada_em` fica gravado, mas
            // nenhuma automação da régua lê essa coluna ainda (ver a migration das tabelas).
            content: assunto === 'nao_quer_mensagens'
              ? 'Registrado para a equipe. Responda numa frase que entendeu e que vai ajustar isso, sem prometer que nenhuma mensagem vai chegar, sem insistir e sem perguntar nada.'
              : 'Registrado: a equipe responde neste mesmo número. Agora escreva UMA frase curta dizendo que vai confirmar isso certinho e já retorna, e pare. Não fale em encaminhar, setor ou chamado.',
          });
          continue;
        }

        if (u.name === 'consultar_proximas_aulas') {
          const qtd = Math.min(Math.max(Number(u.input?.quantidade ?? 1) || 1, 1), 5);
          if (!ctx.turma_id || ctx.turma_ambigua) {
            results.push({
              type: 'tool_result', tool_use_id: u.id,
              content: 'Não sei a turma dele, então não há aula para mostrar. Não chute: use passar_para_atendente com o assunto turma_desconhecida.',
            });
            continue;
          }
          const { data: aulas, error } = await supabase.rpc('onb_agente_proximas_aulas', {
            p_turma_id: ctx.turma_id, p_qtd: qtd,
          });
          await evento('consulta:aulas', { ...rastro, qtd, achou: (aulas ?? []).length, erro: error?.message ?? null });
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            content: error
              ? 'A consulta falhou agora. Não invente: diga que vai confirmar e use passar_para_atendente com o assunto outro.'
              : (aulas ?? []).length
                ? (aulas as any[]).map((a) => linhaDaAula(a)).join('\n')
                : 'Não há aula futura cadastrada para a turma dele. Não invente data: use passar_para_atendente com o assunto outro.',
          });
          continue;
        }

        if (u.name === 'registrar_grupo_da_turma') {
          const esta = u.input?.esta_no_grupo === true;
          const { error } = await supabase.rpc('onb_agente_registrar_grupo', {
            p_oportunidade_id: aluno.oportunidade_id, p_no_grupo: esta,
          });
          await evento('grupo:registrado', { ...rastro, no_grupo: esta, pelo: 'texto', erro: error?.message ?? null });
          if (!esta && ctx.grupo_url) linkQueTemQueIr = ctx.grupo_url;
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            content: esta
              ? 'Registrado.'
              : ctx.grupo_url
                ? `Registrado. Mande o link do grupo da turma dele, copiado igual: ${ctx.grupo_url}`
                : 'Registrado, mas não temos o link do grupo da turma dele. Use passar_para_atendente com o assunto grupo_sem_link, e nunca mande link de outra turma.',
          });
          continue;
        }

        if (u.name === 'registrar_preferencia_ligacao') {
          const periodo = ['comeco_da_manha', 'fim_da_tarde', 'outro'].includes(u.input?.periodo) ? u.input.periodo : 'outro';
          const canal = ['ligacao', 'videochamada', 'tanto_faz', 'nao_disse'].includes(u.input?.canal) ? u.input.canal : 'nao_disse';
          const obs = String(u.input?.como_ele_disse ?? '').trim().slice(0, 500) || null;
          const { error } = await supabase.rpc('onb_agente_registrar_ligacao', {
            p_oportunidade_id: aluno.oportunidade_id, p_periodo: periodo, p_canal: canal, p_obs: obs,
          });
          await evento('ligacao:registrada', { ...rastro, periodo, canal, pelo: 'texto', erro: error?.message ?? null });
          await passar('ligacao', obs);
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            // Nada de "já deixei combinado": não há nada combinado ainda, e prometer combinado é
            // a promessa que o Rafael mandou tirar na revisão de 12/09.
            content: 'Registrado, e a equipe já foi avisada. Diga numa frase que alguém da equipe vai falar com ele para combinar, sem prometer dia nem hora.',
          });
          continue;
        }

        if (u.name === 'consultar_tcc') {
          const { data: tcc, error } = await supabase.rpc('onb_agente_tcc_status', {
            p_telefone: telefone, p_lead_id: aluno.lead_id,
          });
          const linha = Array.isArray(tcc) ? tcc[0] : tcc;
          await evento('consulta:tcc', {
            ...rastro, encontrados: linha?.encontrados ?? null, transferir: linha?.transferir ?? null, erro: error?.message ?? null,
          });
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            // `transferir` ANTES de `encontrados`: com o de-para indisponível a RPC devolve
            // encontrados NULO e transferir true, e "não achei TCC" para quem já mandou assusta.
            content: error || !linha
              ? 'A consulta falhou agora. Não diga etapa nenhuma: use passar_para_atendente com o assunto tcc.'
              : linha.transferir
                ? 'Este caso precisa de uma pessoa da equipe. Não diga a etapa: use passar_para_atendente com o assunto tcc.'
                : Number(linha.encontrados ?? 0) === 0
                  ? 'Não achei TCC enviado no nome dele. Se ele diz que já enviou, use passar_para_atendente com o assunto tcc. Se ainda não enviou, oriente pelo site do TCC, se o curso tiver TCC.'
                  : `Etapa do trabalho dele: ${sanearParaModelo(linha.rotulo)}. Diga só isso, com essas palavras, sem prazo nenhum.`,
          });
          continue;
        }

        if (u.name === 'registrar_perfil_do_aluno') {
          // Só os campos da ferramenta passam, categoria fora da lista volta para o modelo
          // corrigir (a RPC a trocaria por "outro" calada, e "outro" é a resposta vaga DELE, não
          // um engano do modelo que some no dashboard) e texto que não está nas palavras do
          // aluno é recusado, assim como resposta e pergunta na mesma chamada.
          const lido = parametrosDoPerfil(aluno.oportunidade_id, u.input, falasDoAluno);
          if (!lido.ok) {
            await evento('perfil:recusado', { ...rastro, motivo: lido.motivo });
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: lido.paraOModelo });
            continue;
          }
          const params = { ...lido.params };

          // Ou este uso é a pergunta que ele acabou de fazer, ou é o que o aluno respondeu:
          // nunca os dois (a régua recusa), e cada um segue um caminho.
          if (params.p_perguntou) {
            if (params.p_perguntou === perguntaPendente) {
              results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Já está anotado.' });
              continue;
            }
            // A pergunta só vale se podia ir agora (uma por dia, nunca as duas, no máximo duas
            // vezes, a meta primeiro, nada com passagem aberta neste turno). Vetada, ele tira a
            // pergunta da mensagem: o texto que veio junto com a ferramenta ainda não saiu.
            const veto = vetoDaPerguntaDoPerfil(params.p_perguntou, {
              perfil,
              agora,
              outraMarcadaNesteTurno: perguntaPendente !== null,
              passouParaEquipe: assuntosDesteTurno.size > 0,
            });
            if (veto) {
              await evento('perfil:recusado', { ...rastro, motivo: 'pergunta_vetada', pergunta: params.p_perguntou });
              results.push({ type: 'tool_result', tool_use_id: u.id, content: veto });
              continue;
            }
            // ⚠️ Nada é gravado aqui: a mensagem com a pergunta só entra na fila no fim do turno
            // e sai de 2 a 4 minutos depois. Quem conta é `marcarPerguntaFeita`, depois do envio.
            perguntaPendente = params.p_perguntou;
            results.push({
              type: 'tool_result', tool_use_id: u.id,
              content: 'Anotado. Agora escreva a sua mensagem para ele com essa pergunta, uma vez só, e sem a outra.',
            });
            continue;
          }

          // O que ELE respondeu vai para o banco na hora: isso não depende de nenhuma mensagem
          // nossa sair. Oportunidade que o banco não acha volta NULO, sem erro: também é falha.
          const { data: gravado, error } = await supabase.rpc('onb_agente_registrar_perfil', params);
          const falha = error?.message ?? (gravado ? null : 'a RPC não devolveu o estado (oportunidade não encontrada)');
          await evento('perfil:registrado', {
            ...rastro,
            meta_categoria: params.p_meta_categoria,
            como_conheceu: params.p_como_conheceu,
            erro: falha,
          });
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            content: falha
              ? 'Não deu para registrar agora. Continue a conversa normalmente, sem comentar isso com ele.'
              : params.p_meta_pessoal
                ? 'Registrado. Se for comentar a meta dele, uma frase, com naturalidade, sem elogio exagerado e sem prometer resultado.'
                : 'Registrado.',
          });
          continue;
        }

        // Ferramenta que não existe nesta lista: o modelo inventou. Não executa nada.
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Ferramenta desconhecida.' });
      }
      historico.push({ role: 'user', content: results });
      // Rede: se a rodada final não escrever nada, vale o que ele escreveu antes da ferramenta.
      if (texto && !textoAntesDaFerramenta) textoAntesDaFerramenta = texto;
    }

    // Rodadas esgotadas só com ferramenta: vale o que ele escreveu antes delas.
    if (!resposta) resposta = textoAntesDaFerramenta;
    resposta = sanearParaModelo(limparResposta(resposta)).trim();
    if (linkQueTemQueIr && resposta && !resposta.includes(linkQueTemQueIr)) {
      // O modelo prometeu o link e esqueceu de colar: o link é o que resolve, então vai junto.
      resposta = `${resposta}\n${linkQueTemQueIr}`;
    }
    if (!resposta) {
      await evento(transferenciaDesteTurno ? 'transferido_sem_aviso' : 'erro', {
        ...rastro, motivo: 'resposta vazia', ferramentas: usouFerramentas,
      });
      return;
    }
    if (temPalavraProibida(resposta)) {
      // Não reescreve por conta própria (poderia ser a outra coleção, a assinada): deixa rastro
      // para o Rafael ver e ajustar o prompt.
      await evento('alerta:vocabulario', { ...rastro, trecho: resposta.slice(0, 300) });
    }

    const envio = await enviar(conta, telefone, resposta, aluno.lead_id, aluno.oportunidade_id);
    // DESFAZER antes de MARCAR, sempre: as duas mexem no mesmo carimbo, e na ordem trocada a
    // pergunta da resposta cancelada ficaria contada para sempre (o desfazer não a acharia).
    await desfazerPerguntasCanceladas(aluno, envio.canceladas, rastro);
    if (envio.bloqueio) {
      // A fila cancelou na entrada: o aluno não vai receber nada, e 'respondido' seria mentira.
      // A pergunta deste turno também não conta: ninguém vai ler.
      await evento('erro:fila_bloqueou', {
        ...rastro, bloqueio: envio.bloqueio, ferramentas: usouFerramentas, manha: ehManha,
        pergunta_nao_marcada: perguntaPendente,
      });
      return;
    }
    if (perguntaPendente) {
      const antes = perguntaPendente === 'meta_pessoal'
        ? perfil?.metaPerguntadaEm ?? null
        : perfil?.comoPerguntadaEm ?? null;
      await marcarPerguntaFeita(aluno, perguntaPendente, antes, envio.filaId, rastro);
    }
    await evento('respondido', {
      ...rastro, rodadas: rodada, tamanho: resposta.length, ferramentas: usouFerramentas,
      espera_s: envio.espera, manha: ehManha,
    });
  } catch (e) {
    await evento('erro', { ...rastro, motivo: e instanceof Error ? e.message : String(e) });
    console.error('[crm-agente-aluno]', e);
  } finally {
    await supabase.rpc('onb_agente_lock_liberar', { p_telefone: chave });
    // Em TODO desfecho do turno, e não só quando ele respondeu: o `return` do silêncio, da
    // resposta vazia ou de uma porta também passa por aqui. A mensagem que bateu no lock
    // devolveu a marca e depende disto; sem isto, o "obrigado!" seguido de "e quando é a
    // próxima aula?" terminava em silêncio e a pergunta ficava sem ninguém.
    try {
      await retomarOQueChegouNoMeio(conta, telefone, conversaLidaAte, profundidade);
    } catch (e) {
      console.error('[crm-agente-aluno] retomada do que chegou no meio falhou:', e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * O aluno escreveu enquanto o turno pensava? Roda com o lock já solto e busca o que chegou
 * depois do que o turno leu. Duas rodadas extras bastam: o próprio webhook traz a próxima.
 */
async function retomarOQueChegouNoMeio(
  conta: string, telefone: string, lidaAte: string, profundidade: number,
): Promise<void> {
  if (profundidade >= 2) return;

  const { data: novas } = await supabase
    .from('crm_whatsapp_messages')
    .select('wa_message_id, telefone, created_at')
    .eq('wa_account_id', conta)
    .eq('direcao', 'inbound')
    .ilike('telefone', `%${ultimos8(telefone)}`)
    .gt('created_at', lidaAte)
    .order('created_at', { ascending: true })
    .limit(10);

  const candidatas = (novas ?? []).filter(
    (m: any) => m.wa_message_id && mesmoTelefone(m.telefone, telefone),
  );
  if (!candidatas.length) return;

  // Só reprocessa o que NÃO está marcado como feito, olhando TODAS as que chegaram: figurinha
  // e reação gravam a marca e saem antes do lock, e parar na primeira marcada perdia a
  // pergunta que veio logo depois dela.
  const { data: feitas } = await supabase
    .from('onb_agente_processadas')
    .select('wa_message_id')
    .in('wa_message_id', candidatas.map((m: any) => String(m.wa_message_id)));
  const jaFeitas = new Set((feitas ?? []).map((f: any) => String(f.wa_message_id)));
  const pendente = candidatas.find((m: any) => !jaFeitas.has(String(m.wa_message_id)));
  if (!pendente) return;

  await evento('retomando:chegou_no_meio', { telefone, msgId: pendente.wa_message_id });
  await processar(
    { wa_account_id: conta, agente_ia_persona: PERSONA, direcao: 'inbound', from_me: false, id: pendente.wa_message_id },
    conta,
    profundidade + 1,
  );
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return json({ erro: 'use POST' }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch { return json({ erro: 'json inválido' }, 400); }

  // NÚMERO: a conta do banco E a persona do payload. As duas, porque o webhook só manda a
  // persona 'aluno' quando lê isso da própria conta, e a conta sozinha está no front.
  const conta = await contaDoAluno();
  if (!conta || payload?.wa_account_id !== conta || payload?.agente_ia_persona !== PERSONA) {
    return json({ ok: true, pulado: 'numero' });
  }
  if (payload?.direcao !== 'inbound' || payload?.from_me === true) return json({ ok: true, pulado: 'nao_inbound' });
  if (!ANTHROPIC_KEY) ANTHROPIC_KEY = await chaveDoBanco();
  if (!ANTHROPIC_KEY) { await evento('erro', { motivo: 'sem chave da Anthropic' }); return json({ ok: true, pulado: 'sem_chave' }); }

  const tarefa = processar(payload, conta);
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(tarefa);
  else await tarefa;
  return json({ ok: true });
});
