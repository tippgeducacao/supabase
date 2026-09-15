// crm-agente-sdr/trocaDeNumero.ts — o lead escreveu por OUTRO número da PPGVET.
//
// Por que existe (14/09/2026): a memória do João (cliente_ppg_mensagens_sdr) é UMA por
// telefone, compartilhada por todos os nossos números — e um template que sai por qualquer
// número entra nela como fala do próprio João, sem marca nenhuma. Quando o lead conversava
// com o número A (até escolher um horário) e responde a um template do número B, o modelo
// vê uma conversa contínua e cobra, em B, um horário que ninguém combinou ali: "ficou
// faltando você me confirmar o horário". Medido em 14/09/2026: 31% dos balões enviados
// logo após uma troca de número falavam de horário/confirmar/agendar.
//
// O que este módulo faz, SEM mexer em prompt nem em tools:
//   1. detecta a troca de forma DETERMINÍSTICA, pelas últimas linhas de crm_whatsapp_messages
//      do telefone (cada mensagem do CRM sabe por qual conta saiu/entrou): a última FALA
//      (inbound, ou saída que não é template) aconteceu em outra conta e é mais recente que
//      qualquer fala nesta;
//   2. monta uma NOTA INTERNA — texto dinâmico gerado aqui, nunca gravado no histórico — que
//      vai ao router (fundida ao turno do lead) e ao modelo principal (dentro do bloco de
//      contexto temporal, fora do prefixo cacheado);
//   3. devolve o sinal para o index.ts ignorar o ratchet do agente_atual SÓ nesta rodada.
//      Reunião confirmada (lead.agendado) mantém o ratchet: é fato, não pendência.
//
// Modo em crm_agente_sdr_config.troca_numero_modo — off (nada) · sombra (só telemetria) ·
// ativo (nota + ratchet). Trocar de modo é UPDATE no banco, sem deploy.
// Molde: continuidadeWebchat.ts (fronteira de canal) + evidenciaFormacao.ts (função pura).

// deno-lint-ignore-file no-explicit-any
import type { Msg } from './historico.ts';
import { type DadosConta, mapaDeContas, phoneVariants } from './conta.ts';

export type ModoTrocaNumero = 'off' | 'sombra' | 'ativo';

/** Linha de crm_whatsapp_messages, só as colunas que a detecção lê. */
export type LinhaMensagemCrm = {
  wa_account_id: string | null;
  direcao: string | null;
  tipo?: string | null;
  template_name?: string | null;
  conteudo?: string | null;
  created_at: string;
  wa_message_id?: string | null;
  status_entrega?: string | null;
};

export type MotivoTroca =
  | 'desligado'
  | 'sem_conta'
  | 'sem_historico_crm'
  | 'sem_conversa_em_outro_numero'
  | 'conversa_continua_aqui'
  | 'trocou'
  | 'erro_consulta';

export type SinalTrocaDeNumero = {
  trocou: boolean;
  motivo: MotivoTroca;
  contaAtual: string | null;
  contaAnterior: string | null;
  /** ISO da última fala no número anterior. */
  ultimaFalaAnteriorEm: string | null;
  /** ISO da última fala (não-template) neste número, se houver. */
  ultimaFalaAquiEm: string | null;
  /** Minutos desde a última fala no número anterior. */
  gapMin: number | null;
  /** Último template que saiu por ESTE número depois da última fala aqui — o que o lead está respondendo. */
  templateAtual: { nome: string | null; conteudo: string | null; em: string } | null;
  /** Contas distintas no lote drenado (>1 = o lead escreveu em dois números no mesmo debounce). */
  contasNoLote: number;
};

/** Últimas linhas do CRM que a detecção precisa — cobre dias de conversa e a cadência inteira. */
export const LIMITE_LINHAS_CRM = 40;
// Números que têm agente próprio: conversa lá não é conversa do João.
const PERSONAS_DE_OUTRO_AGENTE = new Set(['aluno', 'rh']);
export const PREFIXO_NOTA_INTERNA = '[NOTA INTERNA — não repita ao lead]';

export function sinalInerte(contaAtual: string | null, contasNoLote: number, motivo: MotivoTroca): SinalTrocaDeNumero {
  return {
    trocou: false, motivo, contaAtual, contaAnterior: null,
    ultimaFalaAnteriorEm: null, ultimaFalaAquiEm: null, gapMin: null, templateAtual: null, contasNoLote,
  };
}

const quando = (l: LinhaMensagemCrm): number => {
  const t = Date.parse(String(l.created_at ?? ''));
  return Number.isFinite(t) ? t : 0;
};
const falhou = (l: LinhaMensagemCrm): boolean => l.direcao === 'outbound' && l.status_entrega === 'failed';
// FALA = alguém realmente conversou: o lead escreveu, ou saiu texto/áudio/documento (IA ou
// humano). Template automático NÃO é fala — é a cadência tocando, ninguém respondeu ainda.
const ehFala = (l: LinhaMensagemCrm): boolean =>
  l.direcao === 'inbound' || (l.direcao === 'outbound' && l.tipo !== 'template' && !falhou(l));
const ehTemplateEnviado = (l: LinhaMensagemCrm): boolean =>
  l.direcao === 'outbound' && l.tipo === 'template' && !falhou(l);

/**
 * Regra pura. `linhas` = crm_whatsapp_messages do telefone, qualquer ordem (é reordenado por
 * created_at desc). `idsDoLote` = wa_message_id das mensagens que ESTÃO sendo respondidas nesta
 * rodada — elas já estão gravadas no CRM na conta atual e não podem contar como "conversa aqui".
 */
export function detectarTrocaDeNumero(
  linhas: readonly LinhaMensagemCrm[],
  contaAtual: string | null | undefined,
  opts: { idsDoLote?: Iterable<string | null | undefined>; personas?: Map<string, string | null>; contasNoLote?: number; agora?: number } = {},
): SinalTrocaDeNumero {
  const contasNoLote = opts.contasNoLote ?? 1;
  const atual = contaAtual ? String(contaAtual) : null;
  if (!atual) return sinalInerte(null, contasNoLote, 'sem_conta');
  const ignorar = new Set([...(opts.idsDoLote ?? [])].filter(Boolean).map(String));
  const personas = opts.personas ?? new Map<string, string | null>();
  const validas = (linhas ?? [])
    .filter((l) => l && l.wa_account_id)
    .filter((l) => !(l.wa_message_id && ignorar.has(String(l.wa_message_id))))
    .filter((l) => !PERSONAS_DE_OUTRO_AGENTE.has(personas.get(String(l.wa_account_id)) ?? ''))
    .sort((a, b) => quando(b) - quando(a));
  if (!validas.length) return sinalInerte(atual, contasNoLote, 'sem_historico_crm');

  const falaAqui = validas.find((l) => String(l.wa_account_id) === atual && ehFala(l)) ?? null;
  const falaOutra = validas.find((l) => String(l.wa_account_id) !== atual && ehFala(l)) ?? null;
  const base = {
    contaAtual: atual,
    ultimaFalaAquiEm: falaAqui ? String(falaAqui.created_at) : null,
    contasNoLote,
  };
  if (!falaOutra) {
    return { ...sinalInerte(atual, contasNoLote, 'sem_conversa_em_outro_numero'), ...base };
  }
  if (falaAqui && quando(falaAqui) >= quando(falaOutra)) {
    return {
      ...sinalInerte(atual, contasNoLote, 'conversa_continua_aqui'), ...base,
      contaAnterior: String(falaOutra.wa_account_id), ultimaFalaAnteriorEm: String(falaOutra.created_at),
    };
  }
  // Trocou: a conversa mais recente vive em outra conta. O template deste número que saiu
  // DEPOIS da última fala aqui é o que o lead tem na tela — provavelmente respondeu a ele.
  const desde = falaAqui ? quando(falaAqui) : -Infinity;
  const template = validas.find((l) => String(l.wa_account_id) === atual && ehTemplateEnviado(l) && quando(l) > desde) ?? null;
  const agora = opts.agora ?? Date.now();
  return {
    trocou: true,
    motivo: 'trocou',
    ...base,
    contaAnterior: String(falaOutra.wa_account_id),
    ultimaFalaAnteriorEm: String(falaOutra.created_at),
    gapMin: Math.max(0, Math.round((agora - quando(falaOutra)) / 60_000)),
    templateAtual: template
      ? { nome: template.template_name ?? null, conteudo: template.conteudo ?? null, em: String(template.created_at) }
      : null,
  };
}

// ── Nota interna (texto dinâmico, NÃO é o prompt; nunca persistida) ──────────

function humanizarGap(min: number | null): string {
  if (min == null) return 'antes';
  if (min < 2) return 'há poucos minutos';
  if (min < 60) return `há ${min} minutos`;
  const horas = Math.round(min / 60);
  if (horas < 48) return `há ${horas} hora${horas === 1 ? '' : 's'}`;
  const dias = Math.round(horas / 24);
  return `há ${dias} dia${dias === 1 ? '' : 's'}`;
}

function finalDoNumero(numero: string | null | undefined): string | null {
  const d = String(numero ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

/** «Nome» (final 1234) — ou null quando a conta é desconhecida (a frase muda de forma). */
function descreverConta(dados: DadosConta | null | undefined): string | null {
  const nome = String(dados?.nome ?? '').trim();
  const fim = finalDoNumero(dados?.numero_display);
  if (nome && fim) return `«${nome}» (final ${fim})`;
  if (nome) return `«${nome}»`;
  if (fim) return `(final ${fim})`;
  return null;
}

function resumirTemplate(conteudo: string | null | undefined, max = 220): string | null {
  const t = String(conteudo ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Postura TRANSPARENTE (decisão do usuário, 14/09/2026): o João reconhece em uma frase que já
 * houve contato por outro número, sem detalhar horários nem o outro atendimento (pode ter sido
 * com vendedor humano). Horário proposto no outro número não é pendência aqui; reunião
 * confirmada continua valendo; fatos do lead (nome/curso/formação/materiais) continuam valendo.
 * Prefixo obrigatório: se o modelo ecoar a nota, RE_META (saida.ts) descarta o balão.
 */
export function notaTrocaDeNumero(
  sinal: SinalTrocaDeNumero,
  contas: { atual?: DadosConta | null; anterior?: DadosConta | null },
  lead: { agendado?: boolean | null },
): string {
  const atual = descreverConta(contas.atual);
  const anterior = descreverConta(contas.anterior);
  const porEsteNumero = atual ? `pelo número ${atual}` : 'por este número';
  const porOutroNumero = anterior ? `por OUTRO número da PPGVET, ${anterior},` : 'por OUTRO número da PPGVET,';
  const corpoTemplate = resumirTemplate(sinal.templateAtual?.conteudo);
  const origem = sinal.templateAtual
    ? `A última coisa que saiu por ESTE número foi um template automático da empresa${corpoTemplate ? ` — "${corpoTemplate}"` : ''}; o lead está respondendo a ele.`
    : 'Nenhuma mensagem sua havia saído por este número: o lead escreveu aqui por conta própria.';
  const reuniao = lead.agendado === true
    ? 'Existe uma reunião CONFIRMADA no sistema para este lead: ela continua valendo em qualquer número. Não remarque nem ofereça horários novos sem ele pedir.'
    : 'Não há reunião confirmada no sistema para este lead.';
  return [
    `${PREFIXO_NOTA_INTERNA} TROCA DE NÚMERO. Esta mensagem chegou ${porEsteNumero}, e é por ele que você responde agora. `
      + `A conversa anterior com esta pessoa aconteceu ${porOutroNumero} ${humanizarGap(sinal.gapMin)}. ${origem}`,
    'Como agir nesta resposta:',
    '- Diga, em UMA frase curta e natural, que a PPGVET já tinha conversado com ele por outro número (ex.: "vi aqui que a gente já tinha se falado por outro número da PPG"). Não cite horários, nome de atendente nem detalhes daquele atendimento — ele pode ter sido com um vendedor humano.',
    '- Horários propostos ou discutidos no outro número que NÃO viraram reunião confirmada NÃO estão pendentes aqui: não peça confirmação, não diga "ficou faltando", "aquele horário" nem "como combinamos". Se fizer sentido avançar para a reunião, recomece pela consulta de disponibilidade ou espere o lead trazer o assunto.',
    `- ${reuniao}`,
    '- Nome, curso de interesse, formação e materiais já enviados continuam valendo: não se reapresente nem pergunte de novo o que ele já respondeu.',
    '- Responda ao que ele trouxe agora (o template respondido ou a pergunta dele), no tom de quem retoma um contato — não de quem cobra uma pendência.',
  ].join('\n');
}

/**
 * Router: a nota entra como turno `user` logo depois do último turno `assistant`, ou seja,
 * imediatamente antes das falas do lote — limparParaRouter funde com a fala do lead.
 * Não muta o array recebido e nunca passa por gravarMensagem.
 */
export function comNotaParaRouter(historico: readonly Msg[], nota: string | null | undefined): Msg[] {
  if (!nota) return [...historico];
  let idx = -1;
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i]?.role === 'assistant') { idx = i; break; }
  }
  const saida = [...historico];
  saida.splice(idx + 1, 0, { role: 'user', content: nota });
  return saida;
}

/** Modelo principal: a nota vai no bloco de contexto temporal (relido a cada volta, fora do cache). */
export function comNotaNoContexto(contexto: string, nota: string | null | undefined): string {
  return nota ? `${contexto}\n\n${nota}` : contexto;
}

// ── Leituras no banco (fail-open: qualquer falha = comportamento antigo) ─────

export async function carregarModoTrocaNumero(supabase: any): Promise<ModoTrocaNumero> {
  try {
    const { data, error } = await supabase
      .from('crm_agente_sdr_config')
      .select('troca_numero_modo')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const v = data?.troca_numero_modo;
    return v === 'ativo' || v === 'sombra' ? v : 'off';
  } catch (e) {
    console.error(`[crm-agente-sdr][troca-numero] modo indisponível, assumindo off: ${(e as Error)?.message ?? e}`);
    return 'off';
  }
}

export async function carregarSinalTrocaDeNumero(
  supabase: any,
  args: { telefone: string; contaAtual: string | null | undefined; itens: readonly any[]; contasNoLote: number },
): Promise<SinalTrocaDeNumero> {
  const contaAtual = args.contaAtual ? String(args.contaAtual) : null;
  if (!contaAtual) return sinalInerte(null, args.contasNoLote, 'sem_conta');
  try {
    const variants = phoneVariants(args.telefone);
    if (!variants.length) return sinalInerte(contaAtual, args.contasNoLote, 'sem_historico_crm');
    const { data, error } = await supabase
      .from('crm_whatsapp_messages')
      .select('wa_account_id, direcao, tipo, template_name, conteudo, created_at, wa_message_id, status_entrega')
      .in('telefone', variants)
      .not('wa_account_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(LIMITE_LINHAS_CRM);
    if (error) throw new Error(error.message);
    const contas = await mapaDeContas(supabase);
    const personas = new Map<string, string | null>([...contas].map(([id, c]) => [id, c.persona]));
    return detectarTrocaDeNumero((data ?? []) as LinhaMensagemCrm[], contaAtual, {
      idsDoLote: args.itens.map((i: any) => i?.msg_id ?? null),
      personas,
      contasNoLote: args.contasNoLote,
    });
  } catch (e) {
    console.error(`[crm-agente-sdr][troca-numero] consulta falhou (fail-open): ${(e as Error)?.message ?? e}`);
    return sinalInerte(contaAtual, args.contasNoLote, 'erro_consulta');
  }
}

/** Resumo do sinal para a telemetria (sem o corpo inteiro do template). */
export function resumoDoSinal(sinal: SinalTrocaDeNumero): Record<string, unknown> {
  return {
    trocou: sinal.trocou,
    motivo: sinal.motivo,
    conta_atual: sinal.contaAtual,
    conta_anterior: sinal.contaAnterior,
    ultima_fala_anterior_em: sinal.ultimaFalaAnteriorEm,
    ultima_fala_aqui_em: sinal.ultimaFalaAquiEm,
    gap_min: sinal.gapMin,
    template_na_troca: sinal.templateAtual?.nome ?? null,
    template_em: sinal.templateAtual?.em ?? null,
    contas_no_lote: sinal.contasNoLote,
  };
}
