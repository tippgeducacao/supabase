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
  BOTAO_FECHA_O_PASSO,
  canonDdd8,
  DIA_DO_BOTAO,
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
/** Quantas vezes a oferta espera a conversa respirar antes de sair de qualquer jeito. */
const MAX_ADIAMENTOS_DA_OFERTA = 3;

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

// ── Integração acelerada ─────────────────────────────────────────────────────
// O aluno engajado não precisa esperar 15 dias. Se ele está conversando, o assistente oferece o
// próximo passo. Duas ferramentas, e a ordem entre elas é a regra de negócio inteira:
//   1. ele FECHA um passo  → marcar_passo_concluido agenda uma oferta para daqui a 10 minutos
//   2. ele diz SIM         → entregar_proximo_passo devolve o roteiro, e só DEPOIS de a mensagem
//                            sair é que o passo é marcado e o aluno é movido.
// Oferta nunca move ninguém. Quem não responde fica onde está e recebe o template no dia normal.

const TOOL_FECHOU = {
  name: 'marcar_passo_concluido',
  description:
    'Use quando ele DEIXAR CLARO que terminou o que a mensagem de hoje pedia: disse que assistiu ' +
    'ao vídeo, que conseguiu entrar, que achou o material, que salvou o número. Não use com um ' +
    '"ok" solto nem com "vou ver depois": isso não é terminar, é acusar recebimento. ' +
    'Não responde nada ao aluno; só marca que daqui a pouco cabe oferecer o próximo passo.',
  input_schema: {
    type: 'object',
    properties: {
      como_ele_disse: {
        type: 'string',
        description: 'O trecho, nas palavras dele, que mostra que terminou. Máx. 200 caracteres.',
      },
    },
    required: ['como_ele_disse'],
    additionalProperties: false,
  },
} as const;

const TOOL_ENTREGAR = {
  name: 'entregar_proximo_passo',
  description:
    'Use SÓ quando você tiver oferecido o próximo passo e ele tiver ACEITADO ("sim", "pode ' +
    'mandar", "quero"). Nunca use por conta própria, sem ele ter dito que sim. ' +
    'Devolve os PONTOS que a sua mensagem precisa cobrir. Escreva com as suas palavras, ' +
    'continuando a conversa de onde parou: nada de "oi, tudo bem" nem de "hoje vamos falar de".',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

const FERRAMENTAS = [
  TOOL_QUIETO, TOOL_PASSAR, TOOL_AULAS, TOOL_GRUPO, TOOL_LIGACAO, TOOL_TCC, TOOL_PERFIL,
  TOOL_FECHOU, TOOL_ENTREGAR,
];

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
/**
 * A mídia da integração acelerada. A fila e o `crm-agendadas-dispatch` já sabem entregar
 * `tipo_mensagem = 'midia'` lendo anexo_url/filename/mime_type; o que não existia era o
 * assistente preencher esses campos. Sem isto ele entregaria o passo da plataforma falando de um
 * vídeo que nunca chega.
 */
type Midia = { url: string; nome: string | null; mime: string };

function mimeDaMidia(url: string, cabecalho: string | null): string {
  const ext = (url.split('?')[0].split('.').pop() ?? '').toLowerCase();
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  // Sem extensão reconhecida, o cabeçalho cadastrado no passo decide.
  const c = String(cabecalho ?? '').toLowerCase();
  if (c === 'video') return 'video/mp4';
  if (c === 'documento') return 'application/pdf';
  return 'image/jpeg';
}

async function enviar(
  conta: string, telefone: string, texto: string, leadId: string | null, opId: string,
  midia: Midia | null = null,
  ehEntregaDePasso = false,
): Promise<{ espera: number; bloqueio: string | null; filaId: string | null; canceladas: string[] }> {
  const espera = esperaSorteada();
  const quando = new Date(Date.now() + espera * 1000).toISOString();

  // Se o aluno escreveu de novo antes da resposta sair, esta aqui já considerou tudo: a
  // pendente é substituída, para ele não receber duas respostas parecidas em seguida.
  //
  // ⚠️ MENOS A ENTREGA DE UM PASSO. Matheus, 17/09/2026: ele disse "Sim" às 10:56:32, o vídeo da
  // Adriane entrou na fila às 10:56:45 e foi CANCELADO às 10:56:56, porque ele digitou mais duas
  // mensagens ("Por mensagem ou video", "??") e o turno seguinte substituiu a pendente. Ele
  // perguntou "por mensagem ou vídeo?" JUSTAMENTE porque o vídeo tinha sumido.
  //
  // Conversa e entrega são coisas diferentes: uma é papo, a outra é o conteúdo que ele pediu.
  // Duas respostas parecidas em seguida é chato; perder o vídeo que ele pediu é falha.
  const { data: canceladas } = await supabase.from('crm_mensagens_agendadas')
    .update({ status: 'cancelado', erro_detalhe: 'Substituída por uma resposta mais nova do assistente pedagógico.' })
    .eq('oportunidade_id', opId)
    .eq('criado_por_nome', AUTOR)
    .eq('status', 'agendado')
    .eq('entrega_de_passo', false)
    .select('id');

  const { data: linha, error } = await supabase.from('crm_mensagens_agendadas').insert({
    criado_por_nome: AUTOR,
    wa_account_id: conta,
    wa_conexao_id: null,
    lead_id: leadId,
    oportunidade_id: opId,
    telefone,
    tipo_mensagem: midia ? 'midia' : 'texto',
    conteudo: texto,
    ...(midia
      ? { anexo_url: midia.url, filename: midia.nome ?? undefined, mime_type: midia.mime }
      : {}),
    enviar_em: quando,
    status: 'agendado',
    entrega_de_passo: ehEntregaDePasso,
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
/**
 * O endpoint é público (VERIFY_JWT desligado no self-hosted), então quem diz "sou o tick" tem de
 * provar: o tick grava a marca ANTES do POST, e aqui a gente confere que ela existe, é recente e
 * é do mesmo telefone. Vale para a retomada das 8h e para a oferta da integração acelerada.
 */
async function tickAutentico(
  id: string, telefone: string, prefixo: string, tipoEvento: string,
): Promise<boolean> {
  if (!id.startsWith(prefixo) || !telefone) return false;
  const desde = new Date(Date.now() - MANHA_VALIDADE_MIN * 60_000).toISOString();
  const { data } = await supabase
    .from('onb_agente_eventos')
    .select('telefone')
    .eq('tipo', tipoEvento)
    .eq('detalhe->>id', id)
    .gte('criada_em', desde)
    .limit(1)
    .maybeSingle();
  return !!data && mesmoTelefone(data.telefone, telefone);
}

const manhaAutentica = (id: string, telefone: string) =>
  tickAutentico(id, telefone, 'manha-', 'manha:disparada');
const ofertaAutentica = (id: string, telefone: string) =>
  tickAutentico(id, telefone, 'oferta-', 'acelerada:oferta_disparada');

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
  // A transcrição ficou pronta depois de o turno anterior desistir da espera: o gatilho do banco
  // (`onb_agente_audio_acorda`) devolve o turno pela mesma porta dos outros ticks. Aqui HÁ
  // mensagem de entrada; o que muda é que o id do POST é sintético e o áudio de verdade está
  // no `msgId` que a marca carrega.
  const ehAudioPronto = payload?.motivo === 'audio';
  // A oferta da integração acelerada entra pela mesma porta da retomada das 8h: o tick faz o
  // POST, e aqui não há mensagem nova do aluno para ler.
  const ehOferta = payload?.motivo === 'oferta';
  const semInbound = ehManha || ehOferta;

  // ── ORIGEM: o que o payload diz só vale se o banco confirmar ──────────────
  // O endpoint é público (VERIFY_JWT desligado no self-hosted) e o UUID da conta está no
  // front. Então o telefone, o tipo, o texto e o botão saem da linha gravada pelo webhook,
  // e não do corpo do POST.
  let telefone = '';
  let tipo = 'text';
  let conteudo = '';
  let botaoBruto: unknown = null;
  let chegouEm = new Date();
  /** No despertar do áudio, o wa_message_id REAL da mensagem (o do POST é sintético). */
  let wamidDoAudio: string | null = null;
  if (semInbound) {
    telefone = digitos(payload?.telefone);
    const ok = ehManha
      ? await manhaAutentica(msgId, telefone)
      : await ofertaAutentica(msgId, telefone);
    if (!ok) {
      console.log('[crm-agente-aluno] tick sem marca, ignorado:', msgId);
      return;
    }
  } else {
    // No despertar do áudio o `msgId` é sintético (`audio-<wamid>-<epoch>`): a mensagem de
    // verdade vem da marca que o gatilho gravou ANTES do POST, e é ela que autoriza o turno.
    if (ehAudioPronto) {
      const tel = digitos(payload?.telefone);
      const { data: marca } = await supabase
        .from('onb_agente_eventos')
        .select('telefone, detalhe')
        .eq('tipo', 'audio:transcricao_chegou')
        .eq('detalhe->>id', msgId)
        .gte('criada_em', new Date(Date.now() - MANHA_VALIDADE_MIN * 60_000).toISOString())
        .limit(1)
        .maybeSingle();
      const wamid = String((marca?.detalhe as any)?.msgId ?? '').trim();
      if (!wamid || !mesmoTelefone(marca?.telefone ?? '', tel)) {
        console.log('[crm-agente-aluno] despertar de áudio sem marca, ignorado:', msgId);
        return;
      }
      wamidDoAudio = wamid;
    }
    const { data: origem } = await supabase
      .from('crm_whatsapp_messages')
      .select('telefone, tipo, conteudo, metadata, created_at')
      .eq('wa_message_id', wamidDoAudio ?? msgId)
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

  await evento('recebido', { telefone, msgId, tipo, conteudo: conteudo.slice(0, 200), motivo: ehManha ? 'manha' : (ehOferta ? 'oferta' : null) });

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
  // Do turno da oferta, para o `finally` soltar a vaga se nada chegou a sair. Ficam FORA do
  // `try` porque é de lá que o `finally` os lê, e todo `return` de porta passa por ele.
  let ofertaVirouMensagem = false;
  let ofertaOportunidadeId: string | null = null;

  try {
    if (!semInbound) await dormir(BUFFER_MS);

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
    ofertaOportunidadeId = aluno.oportunidade_id;

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
    // Integração acelerada: o passo só é marcado DEPOIS de a mensagem sair. Se ela falhar, nada
    // foi gravado e nada foi movido, e a régua manda o template deste passo no dia normal.
    let entregaPendente = false;
    let entregaMidia: Midia | null = null;
    // ⚠️ A ETAPA QUE O ROTEIRO DEVOLVEU, guardada aqui até a confirmação. Perguntar de novo depois
    // do envio era carimbar um passo que ninguém entregou: entre o roteiro e a confirmação cabe o
    // tick da régua (de 5 em 5 min, e o dispatch ENVIA antes de registrar) e cabe uma pessoa
    // arrastando o card no kanban.
    let entregaEtapaId: string | null = null;
    let instrucaoAgora: string | null = null;
    const botao = semInbound ? null : interpretarBotao(botaoBruto);
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
      transcricaoAgora = await esperarTranscricao(wamidDoAudio ?? msgId, chave);
      if (transcricaoAgora) {
        await evento('audio:transcrito', { ...rastro, caracteres: transcricaoAgora.length });
      } else {
        // ⚠️ DESISTIR DA ESPERA NÃO É DESISTIR DO ALUNO. Cristiane, 18/09: o áudio dela levou
        // 38,2 s e a espera é de 20: o turno transferia para a equipe e respondia "não consegui
        // escutar" a um áudio que o próprio sistema transcreveu doze segundos depois.
        //
        // Aqui o turno sai calado e deixa a marca: quando a transcrição chega, o gatilho
        // `onb_agente_audio_acorda` devolve o turno pela porta dos ticks, com o texto na mão.
        // Se ela NUNCA chegar, `onb_agente_audio_desistir()` deixa rastro em 10 min para a equipe.
        await evento('audio:aguardando_transcricao', {
          ...rastro, msgId: wamidDoAudio ?? msgId, esperou_ms: ESPERA_TRANSCRICAO_MS,
        });
        return;
      }
    }

    // ── Histórico da conversa NESTA linha, com ESTA pessoa ────────────────────
    // O `ilike` pelos últimos 8 dígitos acha a linha com e sem o 9 e com e sem o 55; o
    // refiltro pelo canon (DDD + 8) tira o número igual de outro DDD. A 3250 fala com o
    // Brasil inteiro, e contexto de outra pessoa é o pior erro possível aqui.
    const { data: msgs } = await supabase
      .from('crm_whatsapp_messages')
      // `wa_message_id` entra por causa do botão: é ele que marca o toque como já contado.
      .select('direcao, tipo, conteudo, created_at, telefone, status_entrega, metadata, wa_message_id')
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
    // A mensagem de onde o botão veio, e não só o botão: é o `wa_message_id` dela que impede o
    // mesmo toque de fechar o passo duas vezes (ele fica "sem resposta" enquanto o assistente não
    // falar nada, e `nao_responder` não grava saída nenhuma).
    const linhaDoBotaoPendente = botao
      ? null
      : semResposta.find((m: any) => m.direcao === 'inbound' && interpretarBotao(m.metadata?.interactive_reply)) ?? null;
    const botaoPendente = botao ??
      (linhaDoBotaoPendente ? interpretarBotao(linhaDoBotaoPendente.metadata?.interactive_reply) : null);
    const botaoPendenteMsgId = botao
      ? msgId
      : (linhaDoBotaoPendente?.wa_message_id ? String(linhaDoBotaoPendente.wa_message_id) : null);

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

    // ── A OFERTA PRECISA SABER O QUE ESTÁ OFERECENDO ─────────────────────────
    // ⚠️ 15/09: o primeiro teste em produção entregou "Que bom, Rafael! Fico feliz que os primeiros
    // dias tenham sido bons pra você": gentileza, não oferta. O convite de cada passo estava
    // escrito no banco desde 14/09 e nunca chegava aqui: pedir "ofereça o próximo passo" sem dizer
    // QUAL faz o modelo puxar conversa e encerrar, que é o único movimento possível sem objeto.
    let conviteDaOferta = '';
    if (ehOferta) {
      const { data: rotBruto, error: errRot } = await supabase.rpc('onb_acelerada_roteiro', {
        p_oportunidade_id: aluno.oportunidade_id,
      });
      const rot = (rotBruto ?? {}) as Record<string, unknown>;
      // ⚠️ FALHA DE INFRAESTRUTURA NÃO É RESPOSTA DO NEGÓCIO. Sem esta separação, um timeout da
      // RPC fechava a oferta como 'recusada' e o aluno só ganharia outra ao fechar mais um passo.
      // Agora a oferta fica de pé (ela expira sozinha em 20 h) e o turno sai calado.
      if (errRot) {
        await evento('acelerada:oferta_falhou', { ...rastro, erro: errRot.message });
        return;
      }
      conviteDaOferta = rot.ok === true ? String(rot.convite ?? '').trim() : '';
      if (!conviteDaOferta) {
        // Aqui o banco RESPONDEU que não há o que oferecer: passo de resgate, passo que só sai por
        // template, aluno que pediu para parar, etapa fora da régua, ou o D+1 (a porta de entrada
        // não se oferece). Falar sem ter o que oferecer é pior do que ficar quieto, e a oferta
        // morre AQUI em vez de segurar a vaga única por 20 h; assim o aluno volta a poder receber
        // uma assim que fechar o próximo passo.
        const agoraIso = new Date().toISOString();
        await supabase.from('onb_acelerada_ofertas')
          .update({
            status: 'recusada',
            motivo: `sem convite: ${rot.motivo ?? 'passo sem oferta_convite'}`,
            respondida_em: agoraIso,
            atualizada_em: agoraIso,
          })
          .eq('oportunidade_id', aluno.oportunidade_id)
          // Só fecha a oferta que ESTÁ SENDO OFERECIDA agora. Um turno atrasado não pode derrubar
          // a oferta nova que o aluno ganhou enquanto isso.
          .eq('status', 'oferecida');
        await evento('acelerada:sem_convite', { ...rastro, motivo: rot.motivo ?? null });
        return;
      }

      // ── A OFERTA NÃO ATROPELA UMA RESPOSTA QUE JÁ ESTÁ NA FILA ─────────────
      // rayanne, 16/09: ela escreveu quatro mensagens às 09:46-09:47, a resposta a elas foi
      // redigida às 09:47:54 e estava NA FILA (com o atraso humano) quando a oferta disparou às
      // 09:49. O turno da oferta respondeu a ela, e a substituição trocou a resposta pendente
      // pela dele. A oferta foi gasta sem nunca ter sido feita, e travou a vaga por 20 h.
      //
      // ⚠️ O SINAL É A FILA, NÃO "INBOUND SEM RESPOSTA". A primeira versão deste gate olhava
      // `semResposta.some(inbound)` e a revisão adversarial mostrou que aquilo mataria a acelerada
      // inteira: o gatilho da oferta é o TOQUE NO BOTÃO, e o assistente fica calado diante dele de
      // propósito (ver o comentário do `botaoDaVez`, logo abaixo). Toda oferta nasceria adiada,
      // para sempre. Reação e figurinha (`pulado:reacao`) têm o mesmo efeito: a rayanne, que
      // motivou o conserto, teria travado por causa de um ❤️.
      //
      // Resposta ENFILEIRADA é o estado exato da colisão: existe fala dela que o assistente já
      // redigiu e que ainda não saiu. Aí sim a oferta espera a conversa respirar.
      const { data: pendentes } = await supabase
        .from('crm_mensagens_agendadas')
        .select('id')
        .eq('oportunidade_id', aluno.oportunidade_id)
        .eq('criado_por_nome', AUTOR)
        .eq('status', 'agendado')
        .limit(1);
      if (pendentes?.length) {
        // Teto de adiamentos: sem ele, quem conversa muito nunca receberia a oferta e ela ficaria
        // empurrando o próprio prazo de morte junto (o `expira_em` é preservado de propósito).
        const { data: of } = await supabase
          .from('onb_acelerada_ofertas')
          .select('adiamentos')
          .eq('oportunidade_id', aluno.oportunidade_id)
          .maybeSingle();
        const jaAdiada = Number(of?.adiamentos ?? 0);
        if (jaAdiada < MAX_ADIAMENTOS_DA_OFERTA) {
          await supabase.from('onb_acelerada_ofertas')
            .update({
              status: 'agendada',
              oferecer_em: new Date(Date.now() + 10 * 60_000).toISOString(),
              oferecida_em: null,
              adiamentos: jaAdiada + 1,
              motivo: 'adiada: havia resposta dele na fila',
              atualizada_em: new Date().toISOString(),
            })
            .eq('oportunidade_id', aluno.oportunidade_id)
            .eq('status', 'oferecida');
          await evento('acelerada:oferta_adiada', { ...rastro, adiamentos: jaAdiada + 1 });
          return;
        }
        // Estourou o teto: melhor oferecer agora do que nunca. A substituição pode comer a
        // resposta pendente, mas o aluno recebe o convite, e isso fica no log.
        await evento('acelerada:oferta_forcada', { ...rastro, adiamentos: jaAdiada });
      }
    }

    // O que o botão pede, dito ao modelo com o link já na mão. Botão antigo que o estado já
    // desmentiu (alguém da equipe corrigiu o "está no grupo" depois) não vale mais.
    //
    // ⚠️⚠️ NO TURNO DA OFERTA O BOTÃO NÃO VALE MAIS. Ele já foi tratado no turno em que chegou;
    // o que trouxe a gente aqui foi o tick, dez minutos depois. Sem esta linha, o botão continua
    // "pendente" (o assistente ficou calado, então não há saída nossa depois dele) e a instrução
    // dele, "não precisa responder (use nao_responder)", entra como ÚLTIMA linha do contexto,
    // brigando com o pedido de oferta que está na última mensagem do usuário. O modelo obedece à
    // negativa e cala: o passo fecharia e a oferta continuaria não saindo, que é exatamente o
    // problema que este conserto existe para resolver. Achado na revisão adversarial, 15/09/2026.
    const botaoDaVez = ehOferta
      ? null
      : botaoPendente?.tipo === 'grupo' && ctx.no_grupo !== null && ctx.no_grupo !== undefined &&
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
    } else if (botaoDaVez?.tipo === 'entendido') {
      instrucaoAgora = 'Ele tocou em "Ok, entendido" na mensagem sobre as aulas ao vivo. Já está ' +
        'anotado. Não precisa responder (use nao_responder); se responder, uma frase curta.';
    } else if (botaoDaVez?.tipo === 'duvida') {
      // Quem ficou com dúvida NÃO concluiu nada: aqui o assistente tem de abrir a boca.
      instrucaoAgora = 'Ele tocou em "Fiquei com dúvida" na mensagem sobre as aulas ao vivo. ' +
        'Pergunte, em UMA frase, qual é a dúvida dele. Não explique nada antes de saber o que ele ' +
        'não entendeu.';
    } else if (botaoDaVez?.tipo === 'combinado') {
      instrucaoAgora = 'Ele tocou no botão da mensagem sobre quem cuida do suporte dele. Já está ' +
        'anotado. Não precisa responder (use nao_responder); se responder, uma frase curta.';
    } else if (botaoDaVez?.tipo === 'ligacao') {
      // Vale o botão desta mensagem e, na retomada das 8h, o que ele tocou de madrugada.
      const periodo = botaoDaVez.periodo === 'comeco_da_manha' ? 'começo da manhã' : 'fim da tarde';
      await passar('ligacao', `escolheu ${periodo} pelo botão`);
      instrucaoAgora = `Ele escolheu pelo botão do pedido de ligação: ${periodo}. Já ficou registrado e ` +
        'a equipe vai combinar com ele. Pergunte só se ele prefere ligação ou videochamada, numa ' +
        'frase, sem marcar dia nem hora.';
    }

    // ── O BOTÃO FECHA O PASSO, sem passar pelo modelo ────────────────────────
    // ⚠️ 15/09/2026, pergunta do Rafael na primeira noite no ar: oito alunos tocaram "Sim, estou"
    // e a integração acelerada não soube de NENHUM. `marcar_passo_concluido` foi chamada zero vez
    // no dia. A causa é estrutural, não do modelo: o botão é registrado por código e a instrução
    // que ele recebe diz "isso já ficou registrado, não precisa responder"; então ele cala, e a
    // ferramenta que dispara a acelerada é uma decisão DELE que nunca acontece.
    //
    // Botão é sinal BINÁRIO. "Ele responder se está ou não no grupo da turma" é, literalmente, o
    // critério de conclusão do D+1 escrito no banco; os oito fizeram exatamente isso.
    //
    // DEPOIS da cadeia de instruções de propósito: é lá que o "Não estou" sem link da turma abre
    // passagem para a equipe, e passo que acabou de virar assunto de gente não vira oferta.
    if (botaoDaVez && BOTAO_FECHA_O_PASSO.has(botaoDaVez.tipo)) {
      // O botão é de OUTRO passo? Quick-reply de mensagem antiga continua clicável no WhatsApp:
      // o aluno rola a conversa, toca no "Ok, entendido" do D+3 estando no D+9, e sem esta trava
      // isso fecharia o D+9 e ofereceria o D+11: dois passos adiantados por um toque no lugar
      // errado. `passo_dia` é o passo em que o card está, que é a mensagem que ele acabou de
      // receber. (Achado na revisão adversarial: os tipos novos não tinham a conferência de
      // coerência que o `grupo` já tinha contra `ctx.no_grupo`.)
      const diaDoBotao = DIA_DO_BOTAO[botaoDaVez.tipo];
      // O mesmo toque não pode contar duas vezes: enquanto o assistente não responde nada, o
      // botão continua "sem resposta" para sempre, e a oferta seguinte (depois de a primeira
      // expirar) nasceria de um toque de ontem.
      const jaContado = botaoPendenteMsgId
        ? !!(await supabase
          .from('onb_agente_eventos')
          .select('id')
          .eq('tipo', 'acelerada:fechou')
          .eq('detalhe->>botao_msg_id', botaoPendenteMsgId)
          .limit(1)
          .maybeSingle()).data
        : false;

      const recusa = assuntosDesteTurno.size
        ? 'passagem_aberta_neste_turno'
        : jaContado
        ? 'botao_ja_contado'
        : diaDoBotao !== undefined && ctx.passo_dia != null && ctx.passo_dia !== diaDoBotao
        ? `botao_de_outro_passo(D+${diaDoBotao} tocado no D+${ctx.passo_dia})`
        : null;

      if (recusa) {
        await evento('acelerada:botao_nao_fecha', {
          ...rastro, motivo: recusa, botao: botaoDaVez.tipo, botao_msg_id: botaoPendenteMsgId,
        });
      } else {
        const { data: r, error } = await supabase.rpc('onb_acelerada_agendar', {
          // ⚠️ `p_etapa_id` é IGNORADO pela função: quem decide o passo é
          // `onb_acelerada_passo_pendente`, a partir do estado do card. Vai só por compatibilidade
          // de assinatura: não confie nele para fixar passo nenhum.
          p_oportunidade_id: aluno.oportunidade_id, p_etapa_id: aluno.etapa_id,
        });
        await evento('acelerada:fechou', {
          ...rastro, resultado: String(r ?? (error ? 'erro' : '?')), pelo: 'botao',
          botao: botaoDaVez.tipo, botao_msg_id: botaoPendenteMsgId, erro: error?.message ?? null,
        });
      }
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
          : ehOferta
          // O convite vem do passo em que ele está AGORA (onb_regua_passos.oferta_convite), não de
          // uma frase pronta: o modelo adapta às palavras da conversa. Sem ele o turno nem chega
          // aqui: ver a porta do convite, lá em cima.
          ? `(sem mensagem nova: ele terminou o passo de hoje há pouco e a conversa continua aberta. `
            + `Faça o convite, ${conviteDaOferta}, em UMA frase, continuando de onde a conversa parou, `
            + `e espere. Não entregue nada agora, não explique o que vem, não abra com saudação e não `
            + `encerre a conversa. Se ele disser que sim, aí sim use entregar_proximo_passo.)`
          : sanearParaModelo(descreverParaModelo(tipo, conteudo, transcricaoAgora)).slice(0, 4000).trim() ||
            '(ele mandou algo sem texto)',
      });
    }

    // ── Claude ───────────────────────────────────────────────────────────────
    // System em DOIS blocos: o prompt fixo com cache, e o contexto (que tem o relógio) fora
    // dele. No RH os dois vão juntos e o cache nunca acerta, porque a hora muda o prefixo.
    const modelo = (cfg.modelo ?? '').trim() || MODELO_RESERVA;
    let resposta = '';
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

      if (!usos.length) { resposta = texto; break; }

      // ⚠️ SÓ os blocos de ferramenta entram no histórico, nunca o texto que veio junto: esse
      // texto ainda não foi enviado, e deixá-lo aqui faz o modelo achar que já falou (lição do
      // RH, 30/08). Também não serve como resposta reserva: pode ser análise interna.
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

        if (u.name === 'marcar_passo_concluido') {
          const como = String(u.input?.como_ele_disse ?? '').trim().slice(0, 200) || null;
          const { data, error } = await supabase.rpc('onb_acelerada_agendar', {
            p_oportunidade_id: aluno.oportunidade_id, p_etapa_id: aluno.etapa_id,
          });
          const r = String(data ?? (error ? 'erro' : '?'));
          await evento('acelerada:fechou', { ...rastro, resultado: r, como, erro: error?.message ?? null });
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            // O aluno NÃO pode saber que existe uma fila esperando: a oferta chega daqui a pouco
            // como se fosse ideia do assistente, no meio da conversa.
            content: r === 'agendada'
              ? 'Anotado. Não fale nada sobre isso, siga a conversa normalmente.'
              : 'Anotado, mas não cabe oferecer o próximo passo agora. Siga a conversa normalmente.',
          });
          continue;
        }

        if (u.name === 'entregar_proximo_passo') {
          const { data, error } = await supabase.rpc('onb_acelerada_roteiro', {
            p_oportunidade_id: aluno.oportunidade_id,
          });
          const rot = (data ?? {}) as Record<string, unknown>;
          if (error || rot.ok !== true) {
            await evento('acelerada:sem_roteiro', { ...rastro, motivo: rot.motivo ?? error?.message ?? null });
            results.push({
              type: 'tool_result', tool_use_id: u.id,
              content: 'Agora não dá para adiantar nada. Responda a ele sem prometer próximo passo.',
            });
            continue;
          }
          const url = String(rot.midia_url ?? '').trim();
          if (url) {
            entregaMidia = {
              url,
              nome: String(rot.midia_nome ?? '').trim() || null,
              mime: mimeDaMidia(url, String(rot.cabecalho ?? '') || null),
            };
          }
          entregaPendente = true;
          // É ESTA etapa que vai ser carimbada lá embaixo, e não a que o banco disser depois.
          entregaEtapaId = String(rot.etapa_id ?? '').trim() || null;
          const pontos = Array.isArray(rot.pontos) ? (rot.pontos as string[]) : [];
          results.push({
            type: 'tool_result', tool_use_id: u.id,
            content: [
              `Assunto: ${rot.assunto ?? ''}`,
              'Cubra estes pontos, com as SUAS palavras:',
              ...pontos.map((p) => `· ${p}`),
              entregaMidia ? 'O vídeo vai junto com a sua mensagem: fale dele como quem está mandando agora.' : '',
              'Continue a conversa de onde parou. NÃO comece com saudação, não diga "hoje vamos falar de",',
              'não numere etapa nem dia. Ele acabou de dizer que sim: escreva como quem já estava falando com ele.',
            ].filter(Boolean).join('\n'),
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
    }

    // 14/09/2026: resposta vazia ou limite de tools não autoriza enviar o texto
    // intermediário. O fluxo abaixo registra silêncio/transferência sem aviso.
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

    const envio = await enviar(
      conta, telefone, resposta, aluno.lead_id, aluno.oportunidade_id, entregaMidia,
      // Entrega de passo é intocável pela substituição: ver o comentário em `enviar`.
      entregaPendente,
    );
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
    // A oferta virou mensagem de verdade: a partir daqui ela SEGURA a vaga com razão, esperando
    // o sim do aluno (e expira sozinha em 20 h se ele não responder).
    ofertaVirouMensagem = true;
    if (perguntaPendente) {
      const antes = perguntaPendente === 'meta_pessoal'
        ? perfil?.metaPerguntadaEm ?? null
        : perfil?.comoPerguntadaEm ?? null;
      await marcarPerguntaFeita(aluno, perguntaPendente, antes, envio.filaId, rastro);
    }
    // ⚠️ A ORDEM AQUI É A REGRA DE NEGÓCIO. Só marca o passo e move o aluno DEPOIS de a mensagem
    // ter entrado na fila sem bloqueio. Se o envio falhar, o `return` acima já saiu e nada disto
    // rodou: o aluno continua na mesma etapa e a régua manda o template dele no dia normal.
    //
    // ⚠️⚠️ MAS "NA FILA" NÃO É "ENTREGUE". O `enviar()` enfileira; quem manda é o
    // `crm-agendadas-dispatch`, depois. Se ele falhar (mídia fora do ar, recusa da Meta) ou se uma
    // resposta mais nova cancelar a linha, o aluno não recebe nada e o carimbo daqui seria mentira
    // permanente: a régua nunca mais mandaria aquele passo. Por isso o `fila_id` vai junto: o
    // `onb_acelerada_tick` confere a fila de minuto em minuto e DESFAZ o carimbo do que morreu
    // (`onb_acelerada_desfazer_entregas_mortas`), e aí o passo volta a sair por template.
    if (entregaPendente) {
      const { data: r, error: errEntrega } = await supabase.rpc('onb_acelerada_confirmar_entrega', {
        p_oportunidade_id: aluno.oportunidade_id,
        // A etapa é a que o ROTEIRO devolveu, não a que o banco calcularia agora.
        p_etapa_id: entregaEtapaId,
        p_wa_message_id: null,
        p_fila_id: envio.filaId,
      });
      await evento('acelerada:entregue', {
        ...rastro, resultado: r ?? null, etapa_entregue: entregaEtapaId, fila_id: envio.filaId,
        com_midia: !!entregaMidia, erro: errEntrega?.message ?? null,
      });
    }
    await evento('respondido', {
      ...rastro, rodadas: rodada, tamanho: resposta.length, ferramentas: usouFerramentas,
      espera_s: envio.espera, manha: ehManha,
    });
  } catch (e) {
    await evento('erro', { ...rastro, motivo: e instanceof Error ? e.message : String(e) });
    console.error('[crm-agente-aluno]', e);
  } finally {
    // ── OFERTA QUE NÃO VIROU MENSAGEM NÃO PODE SEGURAR A VAGA ────────────────
    // ⚠️ Só existe UMA oferta viva por aluno, e `onb_acelerada_agendar` só reabre quando a
    // anterior está num estado final. O tick marca 'oferecida' ANTES do POST, então toda oferta
    // que morre depois disso (passagem aberta, humano no comando, janela de 24 h fechada, erro
    // de RPC, ou o próprio modelo decidindo calar) travava a acelerada do aluno por 20 horas.
    // Aconteceu de verdade em 15/09 (`pulado:transferencia_aberta` seis segundos depois do tick).
    //
    // Mora no `finally` de propósito: os `return` de porta estão espalhados pelo turno inteiro e
    // qualquer um deles chega aqui. Se a mensagem SAIU, a oferta continua de pé esperando o sim.
    if (ehOferta && !ofertaVirouMensagem) {
      try {
        const agoraIso = new Date().toISOString();
        await supabase.from('onb_acelerada_ofertas')
          .update({
            status: 'expirada', motivo: 'a oferta não chegou a virar mensagem',
            respondida_em: agoraIso, atualizada_em: agoraIso,
          })
          .eq('oportunidade_id', ofertaOportunidadeId ?? '00000000-0000-0000-0000-000000000000')
          .eq('status', 'oferecida');
      } catch (e) {
        console.error('[crm-agente-aluno] não consegui soltar a oferta:', e instanceof Error ? e.message : String(e));
      }
    }
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
