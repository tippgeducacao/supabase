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

/** 0 = domingo, 6 = sábado, pelo calendário de Ampére (o dia local, nunca o de UTC). */
export function diaDaSemanaEmSP(d: Date): number {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d); // YYYY-MM-DD
  const [y, m, dd] = p.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}

/**
 * O horário de atendimento como ele vem de `onb_agente_config` (linha única, editável sem
 * deploy). Nada aqui é a regra: a regra mora no banco, e estes campos são só o que a edge leu.
 */
export type HorarioDaSemana = {
  inicio?: string | null;
  fim?: string | null;
  /** `horario_fim_sabado`: sábado fecha mais cedo. */
  fimSabado?: string | null;
  /** `atende_domingo`: domingo só existe com isto ligado. */
  atendeDomingo?: boolean | null;
};

/**
 * A reserva de quando a leitura da config falha, e NÃO a regra: com a config em pé, quem manda
 * é ela. Mesmo assim a reserva não é "sempre aberto", é o horário que o Rafael pediu.
 */
export const HORARIO_RESERVA: Required<HorarioDaSemana> = {
  inicio: '08:00', fim: '21:00', fimSabado: '12:00', atendeDomingo: false,
};

/**
 * A janela de atendimento DESTE dia da semana, em minutos desde a meia-noite, ou null quando o
 * dia é fechado. Decisão do Rafael (revisão de 12/09/2026): "segunda até sábado de meio dia".
 * Segunda a sexta das 8h às 21h; sábado das 8h ao meio-dia; domingo fechado.
 */
export function janelaDoDia(dia: number, c: HorarioDaSemana = {}): { inicio: number; fim: number } | null {
  const inicio = paraMinutos(c.inicio) ?? paraMinutos(HORARIO_RESERVA.inicio)!;
  const fim = paraMinutos(c.fim) ?? paraMinutos(HORARIO_RESERVA.fim)!;
  if (dia === 0) return c.atendeDomingo === true ? { inicio, fim } : null;
  if (dia === 6) return { inicio, fim: paraMinutos(c.fimSabado) ?? paraMinutos(HORARIO_RESERVA.fimSabado)! };
  return { inicio, fim };
}

/**
 * Se o assistente atende neste instante. O início conta como dentro e o fim como fora: 08:00
 * responde, 21:00 já fica para a manhã seguinte; sábado 12:00 já é segunda de manhã.
 *
 * Fora do horário ele NÃO enfileira a resposta para as 8h: uma resposta que espera 11 horas
 * na fila sairia por cima de um atendente que respondeu às 7h50, e a fila não confere isso.
 * Quem retoma é o tick da manhã, que refaz o turno do zero com o estado real da conversa, e
 * que também respeita o dia da semana: o que chega sábado à tarde é respondido segunda.
 */
export function dentroDoHorario(d: Date, c: HorarioDaSemana = {}): boolean {
  const janela = janelaDoDia(diaDaSemanaEmSP(d), c);
  if (!janela) return false;
  const agora = minutosDoDiaEmSP(d);
  // Janela que vira a meia-noite (ex.: 22:00 até 06:00) também funciona, por segurança.
  return janela.inicio <= janela.fim
    ? agora >= janela.inicio && agora < janela.fim
    : agora >= janela.inicio || agora < janela.fim;
}

/** Minutos desde a meia-noite do jeito que se fala: 480 vira "8h", 510 vira "8h30". */
function horaFalada(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

const faixaFalada = (j: { inicio: number; fim: number }): string =>
  `das ${horaFalada(j.inicio)} ${j.fim === 12 * 60 ? 'ao meio-dia' : `às ${horaFalada(j.fim)}`}`;

/**
 * O horário de atendimento em uma frase, montado da MESMA config que decide se ele responde
 * agora. O prompt não crava hora nenhuma de propósito: mudar o expediente é um UPDATE na linha
 * de `onb_agente_config` (a migration do horário da semana diz isso), e o aluno tem de ouvir o
 * horário que está valendo, não o que estava escrito no dia do deploy.
 */
export function frasePeriodoDeAtendimento(c: HorarioDaSemana = {}): string {
  // 3 é uma quarta-feira: qualquer dia de segunda a sexta serve, todos têm a mesma janela.
  const semana = janelaDoDia(3, c)!;
  const sabado = janelaDoDia(6, c);
  const domingo = janelaDoDia(0, c);
  const partes = [`segunda a sexta ${faixaFalada(semana)}`];
  partes.push(sabado ? `sábado ${faixaFalada(sabado)}` : 'sábado não tem atendimento');
  partes.push(domingo ? `domingo ${faixaFalada(domingo)}` : 'domingo não tem atendimento');
  return partes.join(', ');
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
 * Responder em três segundos é a assinatura de um robô. Na revisão de 12/09/2026 o Rafael
 * pediu explicitamente a janela: "envie uma resposta dentro de uma janela de 2 a 4 minutos
 * depois de receber a dúvida", e nada de digitar logo depois de o aluno responder.
 *
 * ⚠️ O sorteio NÃO é o tempo que o aluno espera: a resposta vai para `crm_mensagens_agendadas` e
 * quem entrega é o cron `crm-mensagens-agendadas-dispatch`, que varre de minuto em minuto. O
 * tempo real é o sorteio MAIS até 60 s de varredura, então o teto do sorteio é 180 s (3 min), e
 * não 240: com 240 o pior caso vira 5 minutos, fora da janela que ele pediu. Mudar este número
 * sem descontar a varredura é o mesmo erro de novo.
 */
export const ESPERA_MIN_S = 120;
export const ESPERA_MAX_S = 180;
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
 *
 * ÁUDIO, desde 12/09/2026: o sistema transcreve. Quem transcreve é a fila
 * `onb_agente_audio_fila` (a mesma `crm-transcrever-audio` do botão do SAC e da memória do
 * João, Whisper com Gemini de reserva), e o texto pronto chega aqui pela `metadata` da
 * mensagem. Com transcrição, o modelo recebe o que ele FALOU e responde o conteúdo; sem ela,
 * continua valendo o caminho antigo, que é avisar numa frase e passar para a equipe.
 *
 * ⚠️ O `case 'audio'` e a seção QUANDO ELE MANDA ÁUDIO do `prompt.ts` são UM PAR: o system diz o
 * que ele pode fazer com áudio e isto aqui é o que ele recebe de verdade na conversa. Mudar um
 * sem o outro põe o modelo entre duas instruções opostas (foi o que aconteceu enquanto a
 * transcrição não existia), e o teste do vocabulário confere as duas pontas.
 */
export function descreverParaModelo(tipo: unknown, conteudo: unknown, transcricao?: unknown): string {
  const c = String(conteudo ?? '');
  const falado = String(transcricao ?? '').trim();
  switch (String(tipo ?? '')) {
    case 'audio':
      // A moldura diz de quem é a fala: o áudio é conteúdo do aluno, nunca instrução para o
      // modelo. O que veio do provedor ainda passa por `sanearParaModelo` no index.ts.
      if (falado) {
        const moldura = `(ele mandou um áudio, e esta é a transcrição do que ele falou) ${falado}`;
        // Sem o marcador (mensagem gravada por outro caminho), a moldura é a mensagem inteira:
        // perder a transcrição por causa do formato do marcador seria o pior dos dois mundos.
        return c.includes('[áudio]') ? c.replace('[áudio]', moldura) : moldura;
      }
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
  // O perfil do aluno (20260911235100). Só o que ele JÁ respondeu e quantas vezes foi
  // perguntado, nunca o texto da resposta nem o sexo: o sexo sai do primeiro nome, no banco,
  // para a aba da equipe, e o assistente não pergunta, não registra e não lê.
  meta_pessoal_respondida?: boolean | null;
  meta_pessoal_perguntas?: number | null;
  meta_pessoal_perguntada_em?: string | null;
  como_conheceu_respondido?: boolean | null;
  como_conheceu_perguntas?: number | null;
  como_conheceu_perguntada_em?: string | null;
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

// ── O perfil do aluno: a meta dele com a pós e como ele conheceu a gente ────
//
// Pedido do Rafael (11/09/2026): na integração, guardar para um dashboard futuro a meta
// pessoal do aluno com a pós e como ele conheceu a casa. Quem pergunta é o assistente, na
// conversa, e o que ele responde vai para `onb_integracao_estado` pela
// `onb_agente_registrar_perfil`.
//
// As listas são FECHADAS e iguais aos CHECKs das colunas (o teste agenteAlunoSemFinanceiro
// confere as duas pontas): categoria fora delas é recusada aqui, antes do banco, e o modelo é
// avisado para corrigir. Mudar aqui exige mudar lá.

export const CATEGORIAS_META_PESSOAL = [
  'crescer_na_carreira',
  'aumentar_renda',
  'empreender',
  'mudar_de_area',
  'especializacao_tecnica',
  'docencia_pesquisa',
  'concurso',
  'realizacao_pessoal',
  'outro',
] as const;
export const CATEGORIAS_COMO_CONHECEU = [
  'redes_sociais',
  'indicacao',
  'google_site',
  'curso_evento_ppg',
  'youtube',
  'outro',
] as const;
export const PERGUNTAS_DO_PERFIL = ['meta_pessoal', 'como_conheceu'] as const;
export type PerguntaDoPerfil = typeof PERGUNTAS_DO_PERFIL[number];
/** Cada pergunta vai no máximo duas vezes em toda a integração, em dias diferentes (Rafael). */
export const MAX_PERGUNTAS_DO_PERFIL = 2;

/** O que vai para `onb_agente_registrar_perfil`. Sem sexo, e não há como pôr: a lista é esta. */
export type ParametrosDoPerfil = {
  p_oportunidade_id: string;
  p_meta_pessoal: string | null;
  p_meta_categoria: string | null;
  p_como_conheceu: string | null;
  p_como_detalhe: string | null;
  p_perguntou: PerguntaDoPerfil | null;
};

export type LeituraDoPerfil =
  | { ok: true; params: ParametrosDoPerfil }
  | { ok: false; motivo: string; paraOModelo: string };

/** As palavras dele numa linha só, sem sobra nas pontas, com teto. Vazio vira null. */
function palavrasDele(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || null;
}

/** Item de lista fechada: ausente é null; fora da lista é `false` (recusa, nunca "outro"). */
function itemDaLista<T extends string>(v: unknown, lista: readonly T[]): T | null | false {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  const s = String(v).trim();
  return (lista as readonly string[]).includes(s) ? s as T : false;
}

/**
 * O texto está mesmo nas palavras do aluno? Compara normalizado (sem acento, minúsculo,
 * pontuação virando espaço) com tudo o que ELE escreveu nesta conversa, lido neste turno.
 *
 * Sem isto, nada impede o modelo de resumir, corrigir ou completar a fala dele antes de gravar,
 * e o que vai para o dashboard deixa de ser a resposta do aluno para virar a versão do modelo.
 * As mensagens entram juntas de propósito: quem responde em três balões continua sendo ele.
 */
export function nasPalavrasDoAluno(texto: unknown, falasDoAluno: readonly string[]): boolean {
  const alvo = normalizarTitulo(texto);
  if (!alvo) return false;
  return normalizarTitulo(falasDoAluno.join(' ')).includes(alvo);
}

/**
 * Lê a entrada de `registrar_perfil_do_aluno` e monta os parâmetros da RPC, ou diz ao modelo o
 * que corrigir. Categoria fora da lista é RECUSADA, e não trocada por "outro": "outro" é a
 * resposta vaga do aluno, e uma categoria inventada pelo modelo não é isso. Sem a oportunidade
 * não há o que gravar, e a RPC nem é chamada.
 *
 * `falasDoAluno` são as mensagens dele que este turno leu: todo texto livre gravado (a meta e o
 * detalhe do como conheceu) precisa aparecer ali, senão é recusado. E resposta e pergunta nunca
 * vêm na mesma chamada: misturadas, uma recusa do que ele disse levava junto a marca da
 * pergunta (ou o contrário), e as duas coisas seguem réguas diferentes.
 *
 * Só os cinco campos da ferramenta passam. Qualquer outro (sexo, idade) é ignorado aqui mesmo,
 * se o modelo inventar de mandar.
 */
export function parametrosDoPerfil(
  oportunidadeId: unknown, input: unknown, falasDoAluno: readonly string[],
): LeituraDoPerfil {
  const op = typeof oportunidadeId === 'string' ? oportunidadeId.trim() : '';
  if (!op) {
    return {
      ok: false, motivo: 'sem_oportunidade',
      paraOModelo: 'Não deu para registrar agora. Continue a conversa normalmente, sem comentar isso com ele.',
    };
  }
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const meta = palavrasDele(i.meta_pessoal, 500);
  const metaCat = itemDaLista(i.meta_pessoal_categoria, CATEGORIAS_META_PESSOAL);
  const como = itemDaLista(i.como_conheceu, CATEGORIAS_COMO_CONHECEU);
  const detalhe = palavrasDele(i.como_conheceu_detalhe, 300);
  const perguntou = itemDaLista(i.acabei_de_perguntar, PERGUNTAS_DO_PERFIL);

  const recusa = (motivo: string, paraOModelo: string): LeituraDoPerfil => ({ ok: false, motivo, paraOModelo });
  if (metaCat === false) {
    return recusa('meta_categoria_fora_da_lista',
      `meta_pessoal_categoria tem de ser uma destas: ${CATEGORIAS_META_PESSOAL.join(', ')}. ` +
      'Chame de novo com a que mais se aproxima do que ele disse; na dúvida, outro.');
  }
  if (como === false) {
    return recusa('como_conheceu_fora_da_lista',
      `como_conheceu tem de ser uma destas: ${CATEGORIAS_COMO_CONHECEU.join(', ')}. ` +
      'Chame de novo com a que mais se aproxima do que ele disse; na dúvida, outro.');
  }
  if (perguntou === false) {
    return recusa('pergunta_fora_da_lista',
      `acabei_de_perguntar tem de ser uma destas: ${PERGUNTAS_DO_PERFIL.join(', ')}.`);
  }
  if (perguntou && (meta || metaCat || como || detalhe)) {
    return recusa('pergunta_com_resposta',
      'Numa chamada só vai ou a resposta dele, ou acabei_de_perguntar, nunca as duas coisas. ' +
      'Chame primeiro com o que ele respondeu; se depois disso você fizer uma pergunta do perfil, ' +
      'chame de novo só com acabei_de_perguntar.');
  }
  if (meta && !nasPalavrasDoAluno(meta, falasDoAluno)) {
    return recusa('meta_nao_e_do_aluno',
      'meta_pessoal tem de ser o que ELE escreveu, copiado da mensagem dele, sem resumir e sem ' +
      'reescrever. Chame de novo com as palavras dele, ou não registre nada agora.');
  }
  if (detalhe && !nasPalavrasDoAluno(detalhe, falasDoAluno)) {
    return recusa('detalhe_nao_e_do_aluno',
      'como_conheceu_detalhe tem de ser o que ELE escreveu, copiado da mensagem dele. Chame de ' +
      'novo com as palavras dele, ou registre só a categoria.');
  }
  if (meta && !metaCat) {
    return recusa('meta_sem_categoria',
      'Faltou meta_pessoal_categoria: chame de novo com as palavras dele e a categoria que mais se aproxima; na dúvida, outro.');
  }
  if (metaCat && !meta) {
    return recusa('categoria_sem_meta',
      'Faltou meta_pessoal, com as palavras dele. Registre só o que ele disse, nunca o que você acha.');
  }
  if (detalhe && !como) {
    return recusa('detalhe_sem_categoria',
      'Faltou como_conheceu: chame de novo com a categoria que mais se aproxima do que ele disse; na dúvida, outro.');
  }
  if (!meta && !como && !perguntou) {
    return recusa('vazio',
      'Nada para registrar. Use acabei_de_perguntar logo depois de fazer a pergunta, ou as palavras dele e a categoria quando ele responder.');
  }
  return {
    ok: true,
    params: {
      p_oportunidade_id: op,
      p_meta_pessoal: meta,
      p_meta_categoria: metaCat || null,
      p_como_conheceu: como || null,
      p_como_detalhe: como ? detalhe : null,
      p_perguntou: perguntou || null,
    },
  };
}

/** O perfil do jeito que o assistente usa: respondido ou não, quantas vezes e quando perguntou. */
export type PerfilDoAluno = {
  metaRespondida: boolean;
  metaPerguntas: number;
  metaPerguntadaEm: string | null;
  comoRespondido: boolean;
  comoPerguntas: number;
  comoPerguntadaEm: string | null;
};

/**
 * O perfil que veio no contexto, ou null quando o banco ainda não sabe dele: a edge sobe sozinha
 * no push, e a migration é aplicada à mão, então por um tempo a `onb_agente_contexto` pode vir
 * sem esses campos. Sem eles ninguém sabe quantas vezes já perguntou, e o assistente não
 * pergunta (fica mudo nesse ponto, que é reversível; perguntar todo dia não é).
 *
 * Campo presente e nulo (aluno sem linha em `onb_integracao_estado` ainda) é zero, não ausência.
 */
export function perfilDoContexto(c: ContextoAluno): PerfilDoAluno | null {
  if (
    c.meta_pessoal_respondida === undefined && c.meta_pessoal_perguntas === undefined &&
    c.como_conheceu_respondido === undefined && c.como_conheceu_perguntas === undefined
  ) return null;
  const vezes = (v: unknown) => {
    const n = Math.floor(Number(v ?? 0));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    metaRespondida: c.meta_pessoal_respondida === true,
    metaPerguntas: vezes(c.meta_pessoal_perguntas),
    metaPerguntadaEm: c.meta_pessoal_perguntada_em ?? null,
    comoRespondido: c.como_conheceu_respondido === true,
    comoPerguntas: vezes(c.como_conheceu_perguntas),
    comoPerguntadaEm: c.como_conheceu_perguntada_em ?? null,
  };
}

export type PerguntasDeHoje = {
  liberadas: PerguntaDoPerfil[];
  /** Por que nenhuma está liberada: indisponivel, ja_perguntou_hoje ou nada_mais. */
  motivo: 'liberada' | 'indisponivel' | 'ja_perguntou_hoje' | 'nada_mais';
};

/**
 * Quais perguntas do perfil podem ir HOJE, pela régua do Rafael: uma por dia no máximo (nunca
 * as duas no mesmo dia), cada uma no máximo duas vezes em toda a integração, e a meta primeiro
 * (como conheceu só depois de a meta ter sido perguntada ou respondida). O que ele já respondeu
 * não é perguntado de novo. O dia é o de Ampére.
 *
 * O prompt diz a mesma coisa, e isto não é redundância: o contexto conta ao modelo o que pode
 * ir hoje, e a ferramenta recusa marcar o que não podia (instrução no prompt não segura sempre).
 */
export function perguntasDoPerfilDeHoje(p: PerfilDoAluno | null, agora: Date): PerguntasDeHoje {
  if (!p) return { liberadas: [], motivo: 'indisponivel' };
  const hoje = (iso: string | null) => {
    const d = diasDesde(iso, agora);
    return d !== null && d <= 0;
  };
  if (hoje(p.metaPerguntadaEm) || hoje(p.comoPerguntadaEm)) return { liberadas: [], motivo: 'ja_perguntou_hoje' };
  const liberadas: PerguntaDoPerfil[] = [];
  if (!p.metaRespondida && p.metaPerguntas < MAX_PERGUNTAS_DO_PERFIL) liberadas.push('meta_pessoal');
  if (!p.comoRespondido && p.comoPerguntas < MAX_PERGUNTAS_DO_PERFIL && (p.metaRespondida || p.metaPerguntas > 0)) {
    liberadas.push('como_conheceu');
  }
  return liberadas.length ? { liberadas, motivo: 'liberada' } : { liberadas: [], motivo: 'nada_mais' };
}

const NOME_DA_PERGUNTA: Record<PerguntaDoPerfil, string> = {
  meta_pessoal: 'a meta pessoal dele com a pós',
  como_conheceu: 'como ele conheceu a gente',
};

/**
 * Se a pergunta que o modelo diz ter acabado de fazer podia ir agora. Devolve null quando pode,
 * ou o que dizer ao modelo quando não pode (e aí ela não é marcada: ele tira a pergunta da
 * mensagem, porque o texto que veio junto com a ferramenta ainda não foi enviado).
 */
export function vetoDaPerguntaDoPerfil(
  qual: PerguntaDoPerfil,
  o: { perfil: PerfilDoAluno | null; agora: Date; outraMarcadaNesteTurno: boolean; passouParaEquipe: boolean },
): string | null {
  const tire = 'Tire essa pergunta da mensagem e escreva a sua resposta sem ela.';
  if (o.passouParaEquipe) {
    return `Não faça essa pergunta agora: neste turno a conversa foi passada para a equipe. ${tire}`;
  }
  if (o.outraMarcadaNesteTurno) {
    return `Nunca as duas perguntas do perfil juntas, e a outra já foi feita. ${tire}`;
  }
  const hoje = perguntasDoPerfilDeHoje(o.perfil, o.agora);
  if (hoje.liberadas.includes(qual)) return null;
  if (hoje.motivo === 'indisponivel') return `O perfil do aluno não está disponível agora. ${tire}`;
  if (hoje.motivo === 'ja_perguntou_hoje') return `Hoje você já fez uma pergunta do perfil. ${tire}`;
  if (hoje.liberadas.length) {
    return `Hoje a pergunta do perfil que pode ir é ${NOME_DA_PERGUNTA[hoje.liberadas[0]]}, e não essa. ${tire}`;
  }
  return `Essa pergunta não vai mais: ele já respondeu, ou ela já foi feita duas vezes. ${tire}`;
}

/** "perguntada 2 vezes, a última em 10/09/2026", ou "nunca perguntada". Contagem, sem casas. */
function vezesPerguntada(vezes: number, em: string | null, feminino: boolean): string {
  const nunca = feminino ? 'nunca perguntada' : 'nunca perguntado';
  if (vezes <= 0) return nunca;
  const dia = diaBrDoInstante(em);
  return `${feminino ? 'perguntada' : 'perguntado'} ${vezes} ${vezes === 1 ? 'vez' : 'vezes'}${dia ? `, a última em ${dia}` : ''}`;
}

/**
 * A linha do perfil no contexto: o que ele já respondeu, quantas vezes cada pergunta foi feita,
 * quando foi a última (dia de Ampére), e qual pode ir hoje. Nunca a resposta dele, e nunca sexo.
 */
export function linhaDoPerfil(c: ContextoAluno, agora: Date): string {
  const p = perfilDoContexto(c);
  if (!p) {
    return '- Perfil do aluno: não disponível agora. Não pergunte a meta dele nem como ele conheceu a gente.';
  }
  const meta = `meta pessoal com a pós ${p.metaRespondida ? 'já respondida' : 'ainda não respondida'}, ` +
    vezesPerguntada(p.metaPerguntas, p.metaPerguntadaEm, true);
  const como = `como ele conheceu a gente ${p.comoRespondido ? 'já respondido' : 'ainda não respondido'}, ` +
    vezesPerguntada(p.comoPerguntas, p.comoPerguntadaEm, false);
  const hoje = perguntasDoPerfilDeHoje(p, agora);
  const quando = hoje.liberadas.length === 2
    ? `Hoje, se a conversa estiver tranquila, você pode perguntar ${NOME_DA_PERGUNTA.meta_pessoal} ou ${NOME_DA_PERGUNTA.como_conheceu}, uma das duas só.`
    : hoje.liberadas.length === 1
      ? `Hoje, se a conversa estiver tranquila, você pode perguntar ${NOME_DA_PERGUNTA[hoje.liberadas[0]]}.`
      : hoje.motivo === 'ja_perguntou_hoje'
        ? 'Hoje você já fez uma pergunta do perfil: não pergunte de novo.'
        : 'Não pergunte mais nada do perfil: o que faltava já foi respondido ou já foi perguntado duas vezes.';
  return `- Perfil do aluno: ${meta}; ${como}. ${quando}`;
}

export type OpcoesContexto = {
  agora: Date;
  ehManha: boolean;
  totalEmIntegracao: number;
  /** O expediente que está valendo agora (`onb_agente_config`), para o prompt não cravar hora. */
  horario?: HorarioDaSemana;
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
  // O horário vem daqui, e não do prompt: quem muda o expediente muda a config, sem deploy, e
  // o aluno não pode continuar ouvindo o horário antigo.
  linhas.push(`- Horário de atendimento daqui, o que está valendo: ${frasePeriodoDeAtendimento(o.horario)}. ` +
    'Esse é o único horário que você diz a ele.');

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

  // Por último de propósito: não é dado do curso, é o que ele pode perguntar nesta conversa.
  linhas.push(linhaDoPerfil(c, o.agora));

  let texto = `CONTEXTO DESTE ALUNO (não repita de volta para ele; use para conversar):\n${linhas.join('\n')}`;
  if (o.ehManha) {
    // Sem a hora cravada: a abertura sai de `horario_inicio`, que muda por UPDATE na config.
    texto += '\n\nESTA RESPOSTA SAI NA ABERTURA DO ATENDIMENTO: ele escreveu fora do horário. Responda ao que ele ' +
      'mandou, retomando o assunto, sem se desculpar pelo horário e sem explicar expediente.';
  }
  if (o.instrucaoAgora) texto += `\n\nAGORA: ${o.instrucaoAgora}`;
  return texto;
}
