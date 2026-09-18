// ── Ficha do atendimento (19/09/2026) — memória DETERMINÍSTICA do que já se sabe do lead ──
//
// Por que existe: o João decidia "o que falta perguntar" lendo o histórico, e errava dos
// dois lados — mandava o cronograma sem saber a graduação (regra do usuário, 18/09/2026)
// ou repetia pergunta já respondida. Aqui o CÓDIGO junta o cadastro do formulário (CRM),
// o que o lead já disse na conversa (tool atualizar_dados_lead), o que já foi pedido e
// enviado e as objeções já tratadas, calcula o que FALTA e escreve um bloco curto no fim
// da última mensagem — fora do prefixo de cache (o mesmo lugar do relógio), relido a cada
// volta. A trava do envia_informacoes lê a mesma avaliação: sem o dado, o cronograma não sai.
//
// Escopo (canário): só o lead atendido pela Luna (`crm_agente_sdr_config.luna_telefones`)
// recebe a ficha, a instrução e a trava. A produção no Claude não muda.
//
// Dados medidos em 18/09/2026 (formulário da LP, 14 dias): cadastro vago ("Sou formado em
// outra área", "Não possuo formação", vazio, "Não informado") ≈ 49%; profissão nomeada
// (Médico Veterinário, Zootecnista, Engenheiro de Alimentos…) ≈ 38%; estudante ≈ 13%.
// E 75% dos leads do SDR com formação vazia TÊM a resposta do formulário no CRM — por isso a
// ficha lê `leads.profissao` direto, não a cópia do agente.
import { encontrarFormacao, FORMACOES_OFICIAIS } from './contexto.ts';
import { jidsDoTelefone } from './historico.ts';
import { phoneVariants } from '../crm-whatsapp-send/telefoneConversa.ts';

export type GrupoCadastro = 'vago' | 'profissao' | 'estudante' | 'desconhecido';
export type ColetaJornada = {
  graduacao?: string;
  graduacao_concluida?: 'sim' | 'cursando' | 'nao';
  tempo_formacao?: string;
  area_atuacao?: string;
  atua_na_area?: 'sim' | 'nao';
  atualizado_em?: string;
};
export type Jornada = {
  cronograma?: {
    pedido_em?: string;
    pedido_por?: 'botao' | 'texto';
    enviado_em?: string;
    /** Quantas vezes o envio foi recusado por falta de dado. */
    bloqueios?: number;
    bloqueado_em?: string;
    /** A rodada em que a ficha mostrou FALTA COLETAR com pedido pendente: a pergunta foi feita ali. */
    coleta_perguntada_em?: string;
  };
  /** tipo_objecao → quantas vezes a base foi consultada. */
  objecoes?: Record<string, number>;
  coleta?: ColetaJornada;
};
export type EntradaFicha = {
  /** Resposta do formulário da LP (`leads.profissao`); fallback: `formacao_academica` do agente. */
  cadastro: string | null;
  jornada: Jornada;
  agendado?: boolean;
  elegibilidade?: { decisao: string; motivo?: string | null } | null;
  /** Início desta rodada (ISO). Bloqueio ANTERIOR a ele = "já perguntou e o lead insistiu". */
  inicioRodada?: string | null;
};
export type AvaliacaoFicha = {
  grupo: GrupoCadastro;
  profissao: string | null;
  faltaParaCronograma: string[];
  semGraduacao: boolean;
  jaPerguntou: boolean;
  liberaCronograma: boolean;
  proximoPasso: string;
};

const VAGAS = new Set(['Outra área', 'Sem formação superior']);
const RE_ESTUDANTE = /faculdade|per[ií]odo|semestre|cursando|estudante|gradua(?:ndo|nda)/i;

/** Em que grupo o cadastro do formulário coloca o lead. Decide QUAL pergunta vem antes do cronograma. */
export function grupoDoCadastro(cadastro: string | null | undefined): { grupo: GrupoCadastro; profissao: string | null } {
  const bruto = String(cadastro ?? '').trim();
  if (!bruto || /^n[ãa]o informad[oa]$/i.test(bruto)) return { grupo: 'desconhecido', profissao: null };
  if (RE_ESTUDANTE.test(bruto)) return { grupo: 'estudante', profissao: null };
  const oficial = encontrarFormacao(bruto);
  if (oficial === 'Estudante') return { grupo: 'estudante', profissao: null };
  if (VAGAS.has(oficial)) return { grupo: 'vago', profissao: null };
  if (FORMACOES_OFICIAIS.includes(oficial)) return { grupo: 'profissao', profissao: oficial };
  return { grupo: 'desconhecido', profissao: null };
}

const texto = (v: unknown) => String(v ?? '').trim();

export function avaliarFicha(e: EntradaFicha): AvaliacaoFicha {
  const { grupo, profissao } = grupoDoCadastro(e.cadastro);
  const c = e.jornada.coleta ?? {};
  const semGraduacao = c.graduacao_concluida === 'nao';
  const falta: string[] = [];
  if (!semGraduacao) {
    if (grupo === 'vago' || grupo === 'desconhecido') {
      if (!texto(c.graduacao)) falta.push('qual é a graduação dele');
      if (!texto(c.area_atuacao) && c.atua_na_area !== 'sim') falta.push('em que área ele atua hoje');
    } else if (grupo === 'profissao') {
      const formado = c.graduacao_concluida === 'sim' || /formad/i.test(texto(c.tempo_formacao));
      if (!formado && c.atua_na_area !== 'sim') falta.push(`se ele já é formado em ${profissao} (graduação concluída)`);
    } else if (grupo === 'estudante') {
      if (!texto(c.tempo_formacao) && c.graduacao_concluida !== 'sim') falta.push('quando ele conclui a graduação (mês e ano)');
    }
  }
  const cr = e.jornada.cronograma ?? {};
  // "Pergunta uma vez" (decisão do usuário): conta como perguntado tanto a recusa da tool numa
  // rodada anterior quanto a rodada anterior em que a ficha já mostrou FALTA COLETAR com o
  // pedido pendente (o modelo pergunta sem chamar a tool — caso vago-insiste do harness).
  const anterior = (iso?: string) => !!iso && (!e.inicioRodada || iso < e.inicioRodada);
  const jaPerguntou = ((cr.bloqueios ?? 0) > 0 && anterior(cr.bloqueado_em)) || anterior(cr.coleta_perguntada_em);
  const liberaCronograma = !semGraduacao && (falta.length === 0 || jaPerguntou);
  const proximoPasso = semGraduacao
    ? 'Não envie o cronograma: ele disse que não tem graduação. Siga o encerramento previsto para esse caso.'
    : falta.length === 0
      ? 'Nada falta: se ele pedir o cronograma, chame envia_informacoes.'
      : jaPerguntou
        ? 'Você já perguntou uma vez. Se ele pedir o cronograma de novo sem responder, chame envia_informacoes assim mesmo e siga; '
          + 'se ele responder, registre com atualizar_dados_lead antes de enviar.'
        : `Antes de enviar o cronograma, diga "claro, te envio aqui" e pergunte, numa frase só: ${falta.join(' e ')}. `
          + 'Só depois da resposta chame envia_informacoes.';
  return { grupo, profissao, faltaParaCronograma: falta, semGraduacao, jaPerguntou, liberaCronograma, proximoPasso };
}

const NOME_GRUPO: Record<GrupoCadastro, string> = {
  vago: 'formação vaga', profissao: 'profissão nomeada', estudante: 'estudante', desconhecido: 'sem cadastro',
};

function horaBr(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return ` (${p(br.getUTCDate())}/${p(br.getUTCMonth() + 1)} ${p(br.getUTCHours())}:${p(br.getUTCMinutes())})`;
}

/** O bloco que o modelo lê. Sem instrução aqui: as regras ficam em INSTRUCAO_FICHA (cacheada). */
export function montarBlocoFicha(e: EntradaFicha, a: AvaliacaoFicha): string {
  const c = e.jornada.coleta ?? {};
  const ou = (v: unknown) => texto(v) || '—';
  const cr = e.jornada.cronograma ?? {};
  const cronograma = cr.enviado_em
    ? `enviado${horaBr(cr.enviado_em)}`
    : cr.pedido_em
      ? `pedido ${cr.pedido_por === 'botao' ? 'pelo botão do template' : 'em texto'}${horaBr(cr.pedido_em)} · ainda não enviado`
        + (a.jaPerguntou ? ' · coleta já perguntada uma vez' : '')
      : 'não pedido';
  const objecoes = Object.entries(e.jornada.objecoes ?? {})
    .map(([tipo, n]) => `${tipo.replace(/^objecao_|^pergunta_/, '')} ${n}x`).join(', ') || 'nenhuma';
  const eleg = e.elegibilidade?.decisao ? `${e.elegibilidade.decisao}${e.elegibilidade.motivo ? ` (${texto(e.elegibilidade.motivo).slice(0, 80)})` : ''}` : 'não avaliada';
  return '[FICHA DO ATENDIMENTO — estado que o sistema já sabe; não é fala do lead, não é assunto de conversa e nunca deve ser citada]\n'
    + `Cadastro do formulário: ${e.cadastro ? JSON.stringify(e.cadastro) : 'vazio'} → grupo: ${NOME_GRUPO[a.grupo]}\n`
    + `Dito na conversa: graduação ${ou(c.graduacao)} · concluiu ${ou(c.graduacao_concluida)}${texto(c.tempo_formacao) ? ` (${texto(c.tempo_formacao)})` : ''}`
    + ` · área de atuação ${ou(c.area_atuacao)} · atua na área da pós ${ou(c.atua_na_area)}\n`
    + `Cronograma: ${cronograma}\n`
    + `Objeções já tratadas: ${objecoes}\n`
    + `Elegibilidade: ${eleg} · Reunião: ${e.agendado ? 'marcada' : 'não marcada'}\n`
    + `FALTA COLETAR antes de enviar o cronograma: ${a.faltaParaCronograma.length ? a.faltaParaCronograma.join(' e ') : 'nada'}\n`
    + `PRÓXIMO PASSO: ${a.proximoPasso}`;
}

// Bloco estático do system (cacheado, compartilhado entre os leads do canário). Derivado do
// fluxo aprovado em 18/09/2026 (docs/Agente SDR — Mapa de execução.md, "Ficha do atendimento").
export const INSTRUCAO_FICHA = `## FICHA DO ATENDIMENTO (estado do sistema)
No fim da última mensagem existe o bloco [FICHA DO ATENDIMENTO]. Ele é a memória determinística desta conversa: o que o cadastro do formulário diz, o que o lead já informou, o que já foi pedido e enviado, as objeções já tratadas e o que FALTA COLETAR. Confie nele acima da sua leitura do histórico. Nunca cite a ficha e nunca diga que registrou ou salvou dados.

### Pedido de cronograma (clique em "Receber Cronograma" ou pedido em texto)
- Se a ficha traz FALTA COLETAR: responda "claro, te envio aqui" e faça, numa frase só, a pergunta do PRÓXIMO PASSO. Não chame envia_informacoes nesta resposta. Isso NÃO é puxar assunto de formação por conta própria: é a condição para entregar o material que ele pediu.
- Quando ele responder, registre com atualizar_dados_lead (graduação, se concluiu, área de atuação, se atua na área da pós), rode verificar_compatibilidade_curso e, aprovado, chame envia_informacoes.
- Se ele não responder à pergunta e insistir no cronograma, chame envia_informacoes de novo: o sistema decide se libera.
- Lead que não tem graduação nenhuma: não envie o cronograma; siga o encerramento previsto para esse caso.
- Sem pedido de material, a ficha não muda a conversa: não puxe formação por conta própria.

### Falta de tempo junto com pedido de material
"tô sem tempo, manda por aqui" traz duas objeções. Trate PRIMEIRO a falta de tempo: consulta_objecoes com tipo_objecao="objecao_tempo", e ofereça o encaixe. Só ofereça material pelo WhatsApp se ele insistir depois disso (aí sim objecao_canal).

### Gatilho de ação
Toda mensagem sua termina com UMA pergunta que leva o lead para a conversa com o monitor (encaixe, período do dia, confirmação). Exceções: (a) você acabou de solicitar um material: pergunte só se apareceu e abriu, e faça o convite quando ele confirmar; (b) você está fazendo a pergunta de coleta da ficha; (c) despedida depois de reunião confirmada, opt-out, pausa ou reprovação. Fora dessas, nunca termine só informando nem com "disponha", "qualquer dúvida me chama" ou "fico à disposição".`;

// Quebra de TEMPO do canário: substitui a referência revisada de tools.ts para quem tem a
// ficha. Respeita os limites que o próprio retorno da tool impõe (sem "resolve horas", sem
// carga horária, sem "10 minutinhos é um bom sinal") e fecha com o gatilho de ação.
export const INSTRUCAO_TEMPO_FICHA = 'Reconheça a rotina corrida sem minimizar e sem julgar dedicação. A conversa com o monitor é rápida, '
  + 'cerca de 10 minutos (não diga 15 ou 20), e você encaixa no período que for melhor para ele, dentro dos horários de '
  + 'atendimento. Não diga que a reunião resolve horas de conversa, não invente carga horária da pós e NÃO ofereça '
  + 'cronograma ou material pelo WhatsApp nesta resposta: material só se ele insistir depois desta quebra. Termine '
  + 'perguntando qual período fica mais tranquilo para ele. Se ele realmente não puder nos próximos dias, combine um '
  + 'retorno no prazo que ele escolher.';

// ── Detecção do pedido de cronograma no lote de entrada ──────────────────────
// Clique em botão de template chega com `tipo: 'button'` e o texto do botão ("Receber
// Cronograma", 936 cliques em 30 dias) depois da citação embutida pelo webhook.
const RE_CITACAO = /^\[Em resposta à mensagem: [\s\S]*?\]\s*/;
export function detectarPedidoDeCronograma(itens: ReadonlyArray<{ tipo?: unknown; mensagem?: unknown; conteudo?: unknown }>): 'botao' | 'texto' | null {
  let porTexto: 'texto' | null = null;
  for (const item of itens) {
    const t = texto(item?.mensagem ?? item?.conteudo).replace(RE_CITACAO, '').trim();
    if (!/cronograma/i.test(t)) continue;
    if (item?.tipo === 'button') return 'botao';
    if (t.length <= 120) porTexto = 'texto';
  }
  return porTexto;
}

// ── Mutações puras da jornada (usadas pelo executor real e pelo mock do simulador) ──
const FIXO = (v: unknown, aceitos: string[]) => (aceitos.includes(texto(v).toLowerCase()) ? texto(v).toLowerCase() : undefined);

export function aplicarColetaNaJornada(j: Jornada, input: Record<string, unknown>, agora = new Date()): Jornada {
  const coleta: ColetaJornada = { ...(j.coleta ?? {}) };
  if (texto(input.formacao)) coleta.graduacao = texto(input.formacao);
  if (texto(input.tempo_formacao)) coleta.tempo_formacao = texto(input.tempo_formacao);
  if (texto(input.area_atuacao)) coleta.area_atuacao = texto(input.area_atuacao);
  const atua = FIXO(input.atua_na_area, ['sim', 'nao']);
  if (atua) coleta.atua_na_area = atua as 'sim' | 'nao';
  const concluida = FIXO(input.graduacao_concluida, ['sim', 'cursando', 'nao']);
  if (concluida) coleta.graduacao_concluida = concluida as 'sim' | 'cursando' | 'nao';
  coleta.atualizado_em = agora.toISOString();
  return { ...j, coleta };
}

export function contarObjecaoNaJornada(j: Jornada, tipo: string): Jornada {
  const t = texto(tipo);
  if (!t) return j;
  return { ...j, objecoes: { ...(j.objecoes ?? {}), [t]: ((j.objecoes ?? {})[t] ?? 0) + 1 } };
}

/** Há pedido de cronograma pendente e a ficha vai mostrar FALTA COLETAR: o modelo pergunta nesta rodada. */
export function deveMarcarPergunta(e: EntradaFicha, a: AvaliacaoFicha): boolean {
  const cr = e.jornada.cronograma ?? {};
  const pendente = Boolean(cr.pedido_em) && (!cr.enviado_em || String(cr.pedido_em) > String(cr.enviado_em));
  return pendente && a.faltaParaCronograma.length > 0 && !a.jaPerguntou && !a.semGraduacao;
}

export function registrarPerguntaNaJornada(j: Jornada, agora = new Date()): Jornada {
  return { ...j, cronograma: { ...(j.cronograma ?? {}), coleta_perguntada_em: agora.toISOString() } };
}

export function registrarBloqueioNaJornada(j: Jornada, agora = new Date()): Jornada {
  return { ...j, cronograma: { ...(j.cronograma ?? {}), bloqueios: ((j.cronograma ?? {}).bloqueios ?? 0) + 1, bloqueado_em: agora.toISOString() } };
}

export function registrarEnvioNaJornada(j: Jornada, agora = new Date()): Jornada {
  return { ...j, cronograma: { ...(j.cronograma ?? {}), enviado_em: agora.toISOString() } };
}

/** tool_result da recusa: mesmo contrato de bloqueio das outras guardas (status 'bloqueado' ⇒ não concluiu). */
export function bloqueioCronograma(id: string, a: AvaliacaoFicha) {
  return {
    id,
    status: 'bloqueado',
    output: a.semGraduacao ? 'SEM_GRADUACAO' : 'PRECISA_COLETAR',
    cronograma_enviado: false,
    falta: a.faltaParaCronograma,
    resultado: a.semGraduacao
      ? 'RECUSADO: o lead informou que não tem graduação, e a pós exige graduação concluída. O cronograma não foi enviado.'
      : `RECUSADO: o cronograma NÃO foi enviado porque ainda falta coletar: ${a.faltaParaCronograma.join(' e ')}.`,
    instrucao: a.semGraduacao
      ? 'Não diga que enviou. Siga o encerramento previsto para quem não tem graduação.'
      : 'Não diga que enviou. Responda "claro, te envio aqui" e faça, numa frase só, a pergunta do que falta. '
        + 'Quando ele responder, registre com atualizar_dados_lead e chame envia_informacoes de novo.',
  };
}

// ── Leitura e escrita no banco ───────────────────────────────────────────────
type Banco = { from: (tabela: string) => any };
export type ContextoFicha = { telefone: string; leadId?: string | null; ficha?: { inicioRodada: string } | null };
export type FichaCarregada = { texto: string; avaliacao: AvaliacaoFicha; entrada: EntradaFicha };

async function cadastroDoCrm(supabase: Banco, ctx: ContextoFicha): Promise<string | null> {
  try {
    if (ctx.leadId) {
      const { data } = await supabase.from('leads').select('profissao').eq('id', ctx.leadId).maybeSingle();
      if (texto(data?.profissao)) return texto(data.profissao);
    }
    const variantes = phoneVariants(ctx.telefone);
    if (!variantes.length) return null;
    const { data } = await supabase.from('leads').select('profissao, created_at')
      .in('whatsapp', variantes).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return texto(data?.profissao) || null;
  } catch {
    return null;
  }
}

/** null = ficha indisponível nesta volta (falha de leitura). A rodada segue sem ela. */
export async function carregarFicha(supabase: Banco, ctx: ContextoFicha): Promise<FichaCarregada | null> {
  try {
    const { data: lead, error } = await supabase.from('cliente_ppg_leads_sdr')
      .select('id, jornada, formacao_academica, agendado')
      .in('remotejid', jidsDoTelefone(ctx.telefone))
      .order('id', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    const jornada: Jornada = lead?.jornada && typeof lead.jornada === 'object' && !Array.isArray(lead.jornada) ? lead.jornada : {};
    const cadastro = (await cadastroDoCrm(supabase, ctx)) ?? (texto(lead?.formacao_academica) || null);
    let elegibilidade: EntradaFicha['elegibilidade'] = null;
    try {
      const { data: e } = await supabase.from('crm_agente_elegibilidade').select('decisao, motivo, atualizada_em')
        .in('telefone_canonico', phoneVariants(ctx.telefone)).order('atualizada_em', { ascending: false }).limit(1).maybeSingle();
      if (e?.decisao) elegibilidade = { decisao: String(e.decisao), motivo: e.motivo ?? null };
    } catch { /* elegibilidade é informativa na ficha; a trava dela vive no confirmar_agendamento */ }
    const entrada: EntradaFicha = { cadastro, jornada, agendado: lead?.agendado === true, elegibilidade, inicioRodada: ctx.ficha?.inicioRodada ?? null };
    const avaliacao = avaliarFicha(entrada);
    return { texto: montarBlocoFicha(entrada, avaliacao), avaliacao, entrada };
  } catch (e) {
    console.error('[crm-agente-sdr] ficha do atendimento indisponível:', (e as Error)?.message ?? e);
    return null;
  }
}

/** Lê, muta e grava a jornada do lead do agente. Uma rodada por lead (lock) ⇒ sem corrida. */
export async function registrarNaJornada(supabase: Banco, telefone: string, mutar: (j: Jornada) => Jornada): Promise<Jornada | null> {
  const { data: lead, error } = await supabase.from('cliente_ppg_leads_sdr')
    .select('id, jornada')
    .in('remotejid', jidsDoTelefone(telefone))
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!lead?.id) return null;
  const atual: Jornada = lead.jornada && typeof lead.jornada === 'object' && !Array.isArray(lead.jornada) ? lead.jornada : {};
  const nova = mutar(atual);
  const { error: erroUpdate } = await supabase.from('cliente_ppg_leads_sdr').update({ jornada: nova }).eq('id', lead.id);
  if (erroUpdate) throw new Error(erroUpdate.message);
  return nova;
}
