// Réguas PURAS do assistente pedagógico: relógio, telefone, botões e o saneamento do que o
// modelo lê. Sem nenhum import de URL de propósito, para o vitest conseguir rodar este
// arquivo direto (o index.ts importa o supabase-js do esm.sh e só roda no Deno).
//
// Nada daqui é copiado de `crm-agente-sdr` nem de `crm-agente-rh` por import: a decisão do
// Rafael é que este agente seja independente, então o que é igual foi duplicado, não
// compartilhado. Mexer no João ou no RH nunca pode mudar o que o aluno lê.

const FUSO = 'America/Sao_Paulo';

// ── Relógio ────────────────────────────────────────────────────────────────

/** Minutos desde a meia-noite, no fuso de Ampére. `h23` evita o "24:05" de alguns ICU. */
export function minutosDoDiaEmSP(d: Date): number {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const h = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

/** "08:00" ou "08:00:00" (o `time` do Postgres chega assim) viram minutos; lixo vira null. */
export function paraMinutos(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * O assistente atende das 8h às 21h, horário de Ampére (decisão do Rafael). O início conta
 * como dentro e o fim como fora: 08:00 responde, 21:00 já fica para a manhã seguinte.
 *
 * Fora do horário ele NÃO enfileira a resposta para as 8h: uma resposta que espera 11 horas
 * na fila sairia por cima de um atendente que respondeu às 7h50, e a fila não confere isso.
 * Quem retoma é o tick das 8h, que refaz o turno do zero com o estado real da conversa.
 */
export function dentroDoHorario(d: Date, inicio = '08:00', fim = '21:00'): boolean {
  const ini = paraMinutos(inicio) ?? 8 * 60;
  const fi = paraMinutos(fim) ?? 21 * 60;
  const agora = minutosDoDiaEmSP(d);
  // Janela que vira a meia-noite (ex.: 22:00 até 06:00) também funciona, por segurança.
  return ini <= fi ? agora >= ini && agora < fi : agora >= ini || agora < fi;
}

/** Que dia é hoje, por extenso e com a hora, no fuso de Ampére. O modelo não tem relógio. */
export function agoraPorExtenso(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO,
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d);
}

/** Dias inteiros entre uma data e agora, contados no calendário de Ampére. Contagem, não medida. */
export function diasDesde(iso: string | null | undefined, agora: Date = new Date()): number | null {
  if (!iso) return null;
  const antes = new Date(iso);
  if (Number.isNaN(antes.getTime())) return null;
  const dia = (d: Date) => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d); // YYYY-MM-DD
    const [y, m, dd] = p.split('-').map(Number);
    return Date.UTC(y, m - 1, dd);
  };
  return Math.round((dia(agora) - dia(antes)) / 86_400_000);
}

// ── Espera antes de responder ──────────────────────────────────────────────

/**
 * Mesmo ritmo do agente de RH (decisão do Rafael, 10/09): responder em três segundos é a
 * assinatura de um robô. De 120 a 165 s, e a fila varre de minuto em minuto, então o tempo
 * real na conversa fica entre 2 e perto de 4 minutos.
 */
export const ESPERA_MIN_S = 120;
export const ESPERA_MAX_S = 165;
export function esperaSorteada(sorteio: () => number = Math.random): number {
  const r = Math.min(Math.max(sorteio(), 0), 0.999999);
  return ESPERA_MIN_S + Math.floor(r * (ESPERA_MAX_S - ESPERA_MIN_S + 1));
}

// ── Telefone ───────────────────────────────────────────────────────────────

/** Só os dígitos. */
export const digitos = (t: string | null | undefined) => String(t ?? '').replace(/\D/g, '');

/**
 * DDD + últimos 8 dígitos, a mesma régua do `fn_canon_ddd8` do banco: imune ao 9º dígito, ao
 * DDI e à formatação, e (ao contrário dos "últimos 8") distingue DDD. Com 110 mil leads, dois
 * números iguais nos últimos 8 dígitos em DDDs diferentes não é teoria.
 *
 * Aqui serve para a trava e para refiltrar o histórico. Quem ACHA o aluno é o banco
 * (`onb_agente_aluno_por_telefone`), com o `fn_canon_ddd8` de verdade.
 */
export function canonDdd8(t: string | null | undefined): string | null {
  let d = digitos(t).replace(/^0+/, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99 || ddd % 10 === 0) return null;
  return d.slice(0, 2) + d.slice(-8);
}

/** Últimos 8 dígitos: só para o `ilike` do histórico, que depois é refiltrado pelo canon. */
export const ultimos8 = (t: string | null | undefined) => digitos(t).slice(-8);

// ── Botões da régua ────────────────────────────────────────────────────────

export type RespostaDeBotao =
  | { tipo: 'grupo'; estaNoGrupo: boolean }
  | { tipo: 'ligacao'; periodo: 'comeco_da_manha' | 'fim_da_tarde' };

/**
 * Payload fixo que os modelos da régua devem levar nos botões (decisão pendente do Rafael).
 * Enquanto não levam, a Meta devolve o próprio TEXTO do botão como payload, e é por isso que
 * o título normalizado é a reserva logo abaixo.
 */
const POR_PAYLOAD: Record<string, RespostaDeBotao> = {
  ONB_GRUPO_SIM: { tipo: 'grupo', estaNoGrupo: true },
  ONB_GRUPO_NAO: { tipo: 'grupo', estaNoGrupo: false },
  ONB_LIGAR_MANHA: { tipo: 'ligacao', periodo: 'comeco_da_manha' },
  ONB_LIGAR_TARDE: { tipo: 'ligacao', periodo: 'fim_da_tarde' },
};

/** Os títulos dos botões do D+1/D+2 (grupo) e do D+5 (ligação), normalizados. */
const POR_TITULO: Record<string, RespostaDeBotao> = {
  'sim estou': { tipo: 'grupo', estaNoGrupo: true },
  'nao estou': { tipo: 'grupo', estaNoGrupo: false },
  'comeco da manha': { tipo: 'ligacao', periodo: 'comeco_da_manha' },
  'fim da tarde': { tipo: 'ligacao', periodo: 'fim_da_tarde' },
};

/** Sem acento, minúsculo, pontuação vira espaço: "Não estou!" e "nao  estou" são o mesmo botão. */
export function normalizarTitulo(t: unknown): string {
  return String(t ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * O clique num botão da régua, lido de `metadata.interactive_reply` da mensagem gravada pelo
 * webhook. Só clique de verdade conta: texto livre "sim, estou" passa pelo modelo, que decide
 * com o contexto da conversa (a pergunta pode ter sido outra).
 */
export function interpretarBotao(ir: unknown): RespostaDeBotao | null {
  if (!ir || typeof ir !== 'object') return null;
  const r = ir as { tipo?: unknown; id?: unknown; title?: unknown };
  if (r.tipo !== 'template_button' && r.tipo !== 'button_reply') return null;
  const payload = String(r.id ?? '').trim().toUpperCase();
  if (POR_PAYLOAD[payload]) return POR_PAYLOAD[payload];
  for (const candidato of [r.title, r.id]) {
    const achado = POR_TITULO[normalizarTitulo(candidato)];
    if (achado) return achado;
  }
  return null;
}

// ── O que o modelo lê ──────────────────────────────────────────────────────

/**
 * O modelo copia o estilo do que LÊ. Proibir travessão no prompt não basta se o título da
 * aula que a consulta devolve tem um (todos os de pré-abertura e de prático têm, medido em
 * 11/09/2026), ou se o histórico traz negrito de Markdown, que no WhatsApp vira asterisco
 * duplo. Tudo que vem do banco para o modelo passa por aqui.
 *
 * Os traços estão escritos por código Unicode para este arquivo não ter nenhum.
 */
export function sanearParaModelo(txt: unknown): string {
  let t = String(txt ?? '');
  // Intervalo de horário e de número vira "às"/"a", e não vírgula: "19:00, 22:00" confunde.
  t = t.replace(/(\d{1,2}:\d{2})\s*[\u2013\u2014]\s*(\d{1,2}:\d{2})/g, '$1 às $2');
  t = t.replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1 a $2');
  t = t.replace(/\s*[\u2013\u2014]+\s*/g, ', ');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  // Traço no começo ou no fim da linha virou uma vírgula solta.
  t = t.split('\n').map((l) => l.replace(/^\s*,\s*/, '').replace(/,\s*$/, '')).join('\n');
  t = t.replace(/,\s*,/g, ',');
  return t;
}

/** Se a resposta chamou o material de biblioteca. Não reescreve: registra para o Rafael ver. */
export const PALAVRA_PROIBIDA = /bibliotec/i;
export const temPalavraProibida = (t: string) => PALAVRA_PROIBIDA.test(t);

// Lição do agente do João: às vezes o modelo SIMULA o raciocínio dentro do texto, embrulhado
// em <thinking>. Instrução no prompt não resolve sempre; esta régua determinística resolve.
const TAGS = '(?:antml:)?(?:thinking|thought|thoughts|scratchpad|reasoning|reflection)';
export function limparResposta(texto: string): string {
  let t = texto ?? '';
  t = t.replace(new RegExp(`<${TAGS}[^>]*>[\\s\\S]*?</${TAGS}>`, 'gi'), '');
  t = t.replace(new RegExp(`</?${TAGS}[^>]*>`, 'gi'), '');
  return t.trim();
}

// ── Aulas e turma, do jeito que o aluno lê ─────────────────────────────────

const DIA_CURTO = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIA_LONGO = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** "a", "a e b", "a, b e c". */
function juntar(itens: string[]): string {
  if (itens.length <= 1) return itens[0] ?? '';
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

/**
 * `ped_turmas.dia_semana_aulas` (0 = domingo, como o `DIA_LABEL` do BlocoTurmas) por extenso,
 * começando na segunda. Vazio devolve string vazia, e quem chama diz que não sabe.
 */
export function rotuloDiasSemana(dias: unknown): string {
  if (!Array.isArray(dias)) return '';
  const validos = [...new Set(dias.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
  validos.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return juntar(validos.map((n) => DIA_CURTO[n]));
}

/** "19:00 - 22:00" (o texto de `ped_aulas.horario`) vira "das 19:00 às 22:00". */
export function horarioLegivel(h: unknown): string {
  const s = String(h ?? '').trim();
  const m = /^(\d{1,2}:\d{2})(?::\d{2})?\s*(?:-|\u2013|\u2014|às|as|a)\s*(\d{1,2}:\d{2})(?::\d{2})?$/i.exec(s);
  if (m) return `das ${m[1]} às ${m[2]}`;
  return sanearParaModelo(s);
}

/** "19:00:00" (o `time` do Postgres) vira "19:00". */
export const horaCurta = (t: unknown) => (/^(\d{1,2}:\d{2})/.exec(String(t ?? ''))?.[1] ?? '');

/** "2026-09-15" vira "15/09/2026", sem passar por fuso (é data, não instante). */
export function dataBr(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Dia da semana de uma data "YYYY-MM-DD", sem passar por fuso. */
export function diaDaSemanaLongo(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return '';
  return DIA_LONGO[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
}

/**
 * Uma aula da consulta, numa linha: "terça-feira, 15/09/2026, das 19:00 às 22:00: Título".
 * O título é saneado aqui, e não confiado ao banco.
 */
export function linhaDaAula(a: { data?: unknown; horario?: unknown; titulo?: unknown }): string {
  const partes = [diaDaSemanaLongo(a.data), dataBr(a.data)].filter(Boolean);
  const hora = String(a.horario ?? '').trim() ? horarioLegivel(a.horario) : 'horário ainda não informado';
  const titulo = sanearParaModelo(a.titulo).trim() || 'tema ainda não informado';
  return `${partes.join(', ')}, ${hora}: ${titulo}`;
}

/** Primeiro nome, com a caixa arrumada: "MARIA DA SILVA" vira "Maria". */
export function primeiroNome(nome: unknown): string {
  const p = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  if (!p) return '';
  return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR');
}

/**
 * O que chega sem texto (áudio, imagem, figurinha) vira uma descrição honesta para o modelo.
 * O webhook grava marcadores como "[áudio]"; deixá-los crus faz o modelo responder ao
 * marcador, e "não consigo ouvir" seria ele anunciando sozinho que é sistema.
 */
export function descreverParaModelo(tipo: unknown, conteudo: unknown): string {
  const c = String(conteudo ?? '');
  switch (String(tipo ?? '')) {
    case 'audio':
      return c.replace('[áudio]', '(ele mandou um áudio, que você não consegue ouvir)');
    case 'image':
      return c.includes('[imagem]') ? c.replace('[imagem]', '(ele mandou uma imagem, que você não consegue ver)')
        : `(ele mandou uma imagem, que você não consegue ver, com a legenda) ${c}`;
    case 'video':
      return c.includes('[vídeo]') ? c.replace('[vídeo]', '(ele mandou um vídeo, que você não consegue ver)')
        : `(ele mandou um vídeo, que você não consegue ver, com a legenda) ${c}`;
    case 'document':
      return `(ele mandou um arquivo, que você não consegue abrir) ${c}`;
    case 'sticker':
      return c.replace('[sticker]', '(ele mandou uma figurinha)');
    case 'reaction':
      return `(ele reagiu com ${c.replace('[reacao]', '').trim() || 'um emoji'})`;
    case 'location':
      return '(ele mandou uma localização)';
    default:
      return c;
  }
}

/** Mesma pessoa? Pelo canon (DDD + 8) quando os dois têm; senão, pelos últimos 8 dígitos. */
export function mesmoTelefone(a: unknown, b: unknown): boolean {
  const ca = canonDdd8(String(a ?? ''));
  const cb = canonDdd8(String(b ?? ''));
  if (ca && cb) return ca === cb;
  const ua = ultimos8(String(a ?? ''));
  return ua.length === 8 && ua === ultimos8(String(b ?? ''));
}

// ── Passagem para um atendente ─────────────────────────────────────────────

/**
 * Por que o assistente passou a conversa. Lista FECHADA, igual ao CHECK de
 * `onb_agente_transferencias.assunto`: o motivo livre vai em `motivo`, e o assunto é o que a
 * equipe filtra. Mudar aqui exige mudar lá (o teste confere as duas pontas).
 */
export const ASSUNTOS_TRANSFERENCIA = [
  'financeiro',
  'cancelamento_troca',
  'prazo',
  'documento_oficial',
  'reclamacao',
  'situacao_na_plataforma',
  'documento_recebido',
  'ligacao',
  'tcc',
  'turma_desconhecida',
  'grupo_sem_link',
  'falar_com_pessoa',
  'nao_quer_mensagens',
  'audio',
  'outro',
] as const;
export type AssuntoTransferencia = typeof ASSUNTOS_TRANSFERENCIA[number];
export const assuntoValido = (a: unknown): AssuntoTransferencia =>
  (ASSUNTOS_TRANSFERENCIA as readonly string[]).includes(String(a)) ? a as AssuntoTransferencia : 'outro';

// ── Contexto do aluno, em texto ────────────────────────────────────────────

/** O que `onb_agente_contexto` devolve. Lista fechada: nada de financeiro entra aqui. */
export type ContextoAluno = {
  lead_nome?: string | null;
  marca?: string | null;
  pos_nome?: string | null;
  pos_formato?: string | null;
  pos_tcc?: string | null;
  turma_id?: string | null;
  turma_nome?: string | null;
  turma_inicio?: string | null;
  turma_fim?: string | null;
  turma_ambigua?: boolean | null;
  dias_semana?: number[] | null;
  horario_inicio?: string | null;
  horario_fim?: string | null;
  grupo_url?: string | null;
  no_grupo?: boolean | null;
  matricula_em?: string | null;
  etapa_nome?: string | null;
  etapa_entrou_em?: string | null;
  ultima_regua?: { template_name?: string | null; enviado_em?: string | null } | null;
  transferencia_aberta?: { id?: string | null; assunto?: string | null; criada_em?: string | null } | null;
};

/**
 * O DIA de um instante do banco, no calendário de Ampére: "10/09/2026". Não é o `dataBr` do
 * começo da string: o timestamptz chega em UTC, e a venda aprovada às 22h de Ampére já é o dia
 * seguinte lá (o contexto dizia que ele se matriculou no dia 11 quando foi no dia 10).
 */
export function diaBrDoInstante(iso: unknown): string {
  const d = new Date(String(iso ?? ''));
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('day')}/${v('month')}/${v('year')}`;
}

/** Um instante do banco, do jeito que se fala: "11/09 às 14:05", no fuso de Ampére. */
export function momentoBr(iso: unknown): string {
  const d = new Date(String(iso ?? ''));
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('day')}/${v('month')} às ${v('hour')}:${v('minute')}`;
}

/** Qual mensagem da régua é, pelo nome do modelo na Meta (`int_aluno_NN_...`). */
const REGUA: Record<string, string> = {
  '01': 'D+1, as boas-vindas com o cronograma em PDF e a pergunta do grupo da turma',
  '02': 'D+2, o vídeo da plataforma e a pergunta do grupo da turma',
  '03': 'D+3, o vídeo do acesso às aulas ao vivo e do material de cada aula',
  '04': 'D+4, o material didático do curso',
  '05': 'D+5, o pedido de ligação',
  '07': 'D+7, a apresentação da equipe de suporte',
  '09': 'D+9, os documentos da matrícula',
  '11': 'D+11, onde ver o financeiro na plataforma',
  '13': 'D+13, a reta final da integração',
  '15': 'D+15, o pedido de avaliação de 1 a 5',
};
export function descreverModeloDaRegua(nome: unknown): string {
  const m = /^int_aluno_(\d{2})/.exec(String(nome ?? ''));
  return (m && REGUA[m[1]]) || sanearParaModelo(nome);
}

export type OpcoesContexto = {
  agora: Date;
  ehManha: boolean;
  totalEmIntegracao: number;
  tccSiteUrl?: string | null;
  mentoriaQuando?: string | null;
  mentoriaUrl?: string | null;
  /** O que acabou de acontecer neste turno e pede uma resposta específica (botão, por exemplo). */
  instrucaoAgora?: string | null;
};

/**
 * O bloco de contexto que vai DEPOIS do prompt fixo, fora do cache (tem o relógio). Toda
 * string do banco passa pelo saneamento; links não, porque um link alterado não abre.
 */
export function montarContexto(c: ContextoAluno, o: OpcoesContexto): string {
  const s = (v: unknown) => sanearParaModelo(v).trim();
  const linhas: string[] = [];
  linhas.push(`- HOJE é ${agoraPorExtenso(o.agora)}.`);

  const nome = primeiroNome(c.lead_nome);
  linhas.push(`- Primeiro nome do aluno: ${nome || 'não informado'}.`);

  linhas.push(c.marca
    ? `- Nome da casa para esse aluno: ${s(c.marca)}. É assim que você fala da gente com ele.`
    : '- Nome da casa para esse aluno: não definido. Fale só "aqui da PPG".');

  linhas.push(c.pos_nome ? `- Pós que ele contratou: ${s(c.pos_nome)}.` : '- Pós que ele contratou: não sei.');

  if (c.turma_nome && !c.turma_ambigua) {
    const periodo = [
      c.turma_inicio ? `começa em ${dataBr(c.turma_inicio)}` : '',
      c.turma_fim ? `termina em ${dataBr(c.turma_fim)}` : '',
    ].filter(Boolean).join(' e ');
    linhas.push(`- Turma: ${s(c.turma_nome)}${periodo ? `, que ${periodo}` : ''}.`);
    const dias = rotuloDiasSemana(c.dias_semana);
    const ini = horaCurta(c.horario_inicio);
    const fim = horaCurta(c.horario_fim);
    linhas.push(dias || ini
      ? `- Aulas ao vivo da turma: ${[dias, ini && fim ? `das ${ini} às ${fim}` : ini ? `a partir das ${ini}` : ''].filter(Boolean).join(', ')}.`
      : '- Dias e horário das aulas: não cadastrados. Não afirme; para datas, use consultar_proximas_aulas.');
  } else {
    linhas.push('- Turma: NÃO SEI A TURMA DELE. Não chute e não deduza pela data. Se a resposta depender ' +
      'da turma, use passar_para_atendente com o assunto turma_desconhecida.');
  }
  if (c.turma_ambigua || o.totalEmIntegracao > 1) {
    linhas.push('- ATENÇÃO: ele tem mais de uma matrícula em integração. Não chute de qual curso ou turma ' +
      'ele está falando; se não ficar claro pela conversa, passe para um atendente.');
  }

  if (c.pos_formato === 'hibrido') {
    linhas.push('- Formato: a pós tem módulos gravados, liberados ao longo do curso. Nunca prometa data de liberação.');
  } else if (c.pos_formato === 'ao_vivo') {
    linhas.push('- Formato: aulas ao vivo, com a gravação na plataforma depois.');
  }

  const links = [
    o.tccSiteUrl ? `Site do TCC: ${o.tccSiteUrl}` : '',
    o.mentoriaUrl ? `Mentoria de TCC ao vivo${o.mentoriaQuando ? `, ${s(o.mentoriaQuando)}` : ''}, no Google Meet: ${o.mentoriaUrl}` : '',
  ].filter(Boolean).join('. ');
  if (c.pos_tcc === 'obrigatorio') {
    linhas.push(`- TCC: o curso tem TCC obrigatório. ${links}.`);
  } else if (c.pos_tcc === 'opcional') {
    linhas.push(`- TCC: o curso tem TCC, e ele é opcional. ${links}.`);
  } else if (c.pos_tcc === 'nao_tem') {
    linhas.push('- TCC: o curso NÃO tem TCC. Não mande o site do TCC e não convide para a mentoria.');
  } else {
    linhas.push('- TCC: não está definido se o curso tem TCC. Não afirme que tem nem que não tem; ' +
      'se ele perguntar, use passar_para_atendente com o assunto tcc.');
  }

  linhas.push(c.grupo_url
    ? `- Link do grupo de WhatsApp da turma dele: ${c.grupo_url}`
    : '- Link do grupo de WhatsApp da turma dele: não temos. Nunca mande o de outra turma.');
  linhas.push(`- Grupo da turma: ${c.no_grupo === true ? 'ele disse que já está no grupo'
    : c.no_grupo === false ? 'ele disse que NÃO está no grupo' : 'ainda não sabemos se ele está no grupo'}.`);

  const dias = diasDesde(c.matricula_em, o.agora);
  linhas.push(dias === null
    ? '- Matrícula: data não encontrada.'
    : `- Matrícula: há ${dias} ${dias === 1 ? 'dia' : 'dias'} (${diaBrDoInstante(c.matricula_em)}).`);

  if (c.etapa_nome) {
    const desde = momentoBr(c.etapa_entrou_em);
    linhas.push(`- Etapa da integração: ${s(c.etapa_nome)}${desde ? `, desde ${desde}` : ''}.`);
  }
  linhas.push(c.ultima_regua?.template_name
    ? `- Última mensagem da régua que ele recebeu: ${descreverModeloDaRegua(c.ultima_regua.template_name)}` +
      `${c.ultima_regua.enviado_em ? `, em ${momentoBr(c.ultima_regua.enviado_em)}` : ''}.`
    : '- Última mensagem da régua que ele recebeu: nenhuma ainda.');

  let texto = `CONTEXTO DESTE ALUNO (não repita de volta para ele; use para conversar):\n${linhas.join('\n')}`;
  if (o.ehManha) {
    texto += '\n\nESTA RESPOSTA SAI ÀS 8H: ele escreveu fora do horário de atendimento. Responda ao que ele ' +
      'mandou, retomando o assunto, sem se desculpar pelo horário e sem explicar expediente.';
  }
  if (o.instrucaoAgora) texto += `\n\nAGORA: ${o.instrucaoAgora}`;
  return texto;
}
