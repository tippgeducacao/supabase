// Leitura do lead pelo Jev para a FICHA DO ATENDIMENTO (nó 4b) — 29/09/2026, só no canário.
//
// A ficha é o estado que a Luna recebe a cada rodada. O que o LEAD disse chegava lá por palavras-
// chave ("me formei", "sou formada"; título sozinho não entrava) ou quando a própria Luna lembrava
// de chamar atualizar_dados_lead. No duelo de 25/09 foi o que sobrou de erro: "2027.2" junto de
// outro assunto passava em branco; "sou dentista" era convidado antes da checagem; quem já tinha
// dito a formação ouvia a pergunta de novo.
//
// Aqui o Jev lê as mensagens novas (com a conversa recente) e responde perguntas FECHADAS. Quem
// decide o que fazer com cada resposta é `efeitosDaLeitura`, em código:
//  · só SOMA ao que já existe — nunca apaga o que a palavra-chave ou a Luna registraram;
//  · só preenche campo VAZIO da ficha, e só com certeza ≥ limiar;
//  · "não tem graduação" nunca é gravado: vira aviso para a Luna confirmar (corta o cronograma e
//    leva ao encerramento — o erro é caro);
//  · a DATA de conclusão não é lida pelo Jev (erra datas): ele só avisa que o lead a informou.
// Modos em crm_agente_sdr_config.ficha_jev_modo: off | sombra (só registra) | ativo.
import { FORMACOES_OFICIAIS } from './contexto.ts';
import type { ColetaJornada, Jornada } from './fichaAtendimento.ts';
import type { Msg } from './historico.ts';
import { chamarJev, conversaParaJev, corpoJev, escolhaDoJev, mascarar, PRAZO_JEV_MS, type RespostaJev, simDoJev, type TurnoJev } from './jev.ts';

export type ModoLeituraJev = 'off' | 'sombra' | 'ativo';
export interface ConfigLeituraJev { modo: Exclude<ModoLeituraJev, 'off'>; limiar: number }
export const LIMIAR_LEITURA_PADRAO = 0.9;
export const JANELA_LEITURA = 8;

// Opção do Jev → nome oficial da formação (contexto.ts). "Estudante", "Outra área" e "Sem formação
// superior" não são graduação: ficam de fora de propósito.
const GRADUACAO_OFICIAL: Record<string, string> = {
  medicina_veterinaria: 'Medicina Veterinária',
  agronomia: 'Agronomia',
  zootecnia: 'Zootecnia',
  biologia: 'Biologia',
  engenharia_de_alimentos: 'Engenharia de Alimentos',
  engenharia_de_producao: 'Engenharia de Produção',
  administracao: 'Administração',
  direito: 'Direito',
};

// Régua da autodeclaração (fatosLead.ts, INSTRUCAO_TITULOS_PROFISSIONAIS) e da conclusão explícita
// (instrucaoElegibilidade.ts, fichaAtendimento.ts). O Jev é LITERAL: cada regra precisa estar escrita
// (28/09, Instagram: "nunca deduza pela profissão" fez ele ignorar "sou vet").
export const PERGUNTAS_LEITURA = {
  conclusao: {
    type: 'choice',
    instructions: {
      pergunta: 'Pelo que o LEAD disse sobre ELE MESMO na conversa (principalmente nas mensagens novas), qual é a situação da graduação dele?',
      regras: [
        "concluiu: declarou que concluiu ('me formei', 'já concluí', 'sou formado', 'sou formada', 'sim' respondendo se já se formou); OU disse que tem ou fez pós-graduação, especialização, residência, mestrado ou doutorado; OU se apresentou como médico veterinário, médica veterinária, veterinário, veterinária, vet, zootecnista, chefe ou subchefe de veterinária.",
        "Outros títulos sozinhos (agrônomo, nutricionista, biólogo, advogado, dentista) não provam conclusão: nao_disse, a menos que ele também diga que se formou.",
        "cursando: disse que ainda está na graduação (período, semestre, 'faço', 'curso', 'me formo em…', 'ainda não me formei').",
        'nao_tem_graduacao: disse que não tem nem faz faculdade (só ensino médio, só curso técnico, parou ou trancou e não cursa mais).',
        "Auxiliar, técnico, cargo, área de trabalho, nome do curso sozinho, intenção ('quero me formar') e fala sobre outra pessoa não são conclusão.",
        'Na dúvida, nao_disse.',
      ],
    },
    criteria: {
      concluiu: 'Graduação concluída, pelas regras acima.',
      cursando: 'Ainda cursa a graduação.',
      nao_tem_graduacao: 'Não tem nem cursa graduação.',
      nao_disse: 'Não dá para saber pelo que ele disse.',
    },
  },
  graduacao: {
    type: 'choice',
    instructions: {
      pergunta: 'Qual é o curso de graduação DO LEAD (o que ele concluiu ou faz)?',
      regras: [
        "O título conta como o curso: 'sou vet', 'veterinária', 'médico veterinário', 'chefe/subchefe de veterinária' = medicina_veterinaria; 'zootecnista' = zootecnia; 'agrônomo', 'engenheiro agrônomo' = agronomia; 'biólogo' = biologia; 'advogado' = direito.",
        "Cargo ou área de trabalho não é curso: 'trabalho com gado', 'auxiliar veterinário', 'gerente de fazenda', 'atuo em clínica' = nao_disse.",
        'Curso de outra pessoa não conta. Curso que ele só pretende fazer não conta.',
      ],
    },
    criteria: {
      ...Object.fromEntries(Object.entries(GRADUACAO_OFICIAL).map(([k, v]) => [k, v])),
      outra_graduacao: 'Uma graduação que não está nesta lista (ex.: odontologia, farmácia, enfermagem).',
      nao_disse: 'Ele não disse o curso.',
    },
  },
  informou_data: {
    type: 'noul',
    instructions: "Nas mensagens NOVAS, o lead disse QUANDO conclui ou concluiu a graduação (mês, ano, '2027.2', 'fim do ano', 'ano que vem', 'em dezembro', 'esse semestre')? A posição no curso ('tô no 5º semestre', '7º período') não diz quando ele conclui: não conta.",
  },
  pediu_material: {
    type: 'noul',
    // Mesma exceção de detectarPedidoDeCronograma (mapa, nó 4b): "tô sem tempo, manda por aqui" trata o
    // TEMPO primeiro; contando como pedido, a ficha mostrava FALTA COLETAR e a Luna pulava a quebra.
    instructions: "Nas mensagens NOVAS, o lead pediu para receber o cronograma, o material, o PDF ou as informações da pós por escrito (ex.: 'manda as informações por aqui', 'quero o cronograma')? Se na MESMA mensagem ele diz que está sem tempo, ocupado ou na correria ('tô sem tempo, manda por aqui'), NÃO conta: aí o assunto é a falta de tempo.",
  },
  dois_assuntos: {
    type: 'noul',
    instructions: 'As mensagens NOVAS do lead tratam de dois ou mais assuntos diferentes que pedem resposta (ex.: informa quando se forma E relata um problema de acesso)?',
  },
  dor_financeira: {
    type: 'noul',
    instructions: "Nas mensagens NOVAS, o lead disse que está com dificuldade de dinheiro para pagar (sem dinheiro, desempregado, fora do orçamento, 'não cabe no bolso', 'caro demais pra mim', 'parcela pesada')? Só perguntar o preço ou o parcelamento não é dificuldade.",
  },
} as const;

/** O que o Jev leu. Vai para a telemetria (leitura_jev); nunca carrega texto da conversa. */
export interface LeituraLead {
  conclusao: { valor: string; confianca: number } | null;
  graduacao: { valor: string; confianca: number } | null;
  informou_data: number | null;
  pediu_material: number | null;
  dois_assuntos: number | null;
  dor_financeira: number | null;
  modelo: string | null;
  tokens_entrada: number | null;
  ms: number;
  erro?: string;
}

/**
 * Estado: a conversa recente (sem as falas novas) + as mensagens novas do lote, separadas —
 * as perguntas são sobre as NOVAS, com a conversa para o contexto ("sim" depois de "já se formou?").
 */
export function estadoDaLeitura(historicoLimpo: readonly Msg[], novas: readonly string[]) {
  const conversa: TurnoJev[] = conversaParaJev(historicoLimpo, { janela: JANELA_LEITURA + 1 });
  while (conversa.length && conversa[conversa.length - 1].de === 'lead') conversa.pop();
  return {
    conversa_anterior: conversa.slice(-JANELA_LEITURA),
    mensagens_novas_do_lead: novas.map((m) => mascarar(String(m ?? '')).trim().slice(0, 1500)).filter(Boolean),
  };
}

/** O pedido da leitura ao Jev (o agente no n8n faz a chamada com este corpo). */
export function pedidoJevLeitura(historicoLimpo: readonly Msg[], novas: readonly string[]) {
  return corpoJev(estadoDaLeitura(historicoLimpo, novas), PERGUNTAS_LEITURA);
}

/** Resposta do Jev (ou a falha dela) → LeituraLead. */
export function leituraDasRespostas(r: RespostaJev | null, ms: number, erro?: string): LeituraLead {
  if (!r) {
    return {
      conclusao: null, graduacao: null, informou_data: null, pediu_material: null, dois_assuntos: null, dor_financeira: null,
      modelo: null, tokens_entrada: null, ms, erro: String(erro ?? 'Jev: sem resposta').slice(0, 200),
    };
  }
  const a = r.answers;
  return {
    conclusao: escolhaDoJev(a.conclusao),
    graduacao: escolhaDoJev(a.graduacao),
    informou_data: simDoJev(a.informou_data),
    pediu_material: simDoJev(a.pediu_material),
    dois_assuntos: simDoJev(a.dois_assuntos),
    dor_financeira: simDoJev(a.dor_financeira),
    modelo: r.modelo, tokens_entrada: r.tokens_entrada, ms,
  };
}

export async function lerLeadComJev(
  historicoLimpo: readonly Msg[],
  novas: readonly string[],
  opts: { chave?: string; fetchFn?: typeof fetch; prazoMs?: number } = {},
): Promise<LeituraLead | null> {
  const chave = opts.chave ?? Deno.env.get('TYPESAFE_API_KEY') ?? '';
  if (!chave) return null;
  const inicio = Date.now();
  try {
    const r = await chamarJev(estadoDaLeitura(historicoLimpo, novas), PERGUNTAS_LEITURA, chave, opts.fetchFn, opts.prazoMs ?? PRAZO_JEV_MS);
    return leituraDasRespostas(r, Date.now() - inicio);
  } catch (e) {
    return leituraDasRespostas(null, Date.now() - inicio, String((e as Error)?.message ?? e));
  }
}

export const CABECALHO_LEITURA = '[LEITURA DAS MENSAGENS NOVAS — sistema; não é fala do lead nem texto para ele]';
export const AVISO_DATA_INFORMADA = 'O lead informou nestas mensagens quando conclui a graduação. Registre com atualizar_dados_lead (tempo_formacao) e siga para a checagem, mesmo que ele tenha falado de outro assunto junto.';
export const AVISO_DOIS_ASSUNTOS = 'As mensagens novas trazem mais de um assunto: responda a cada um, sem deixar nenhum para trás.';
export const AVISO_SEM_GRADUACAO = 'Ele pode ter dito que não tem graduação. Confirme isso diretamente antes de encerrar ou de recusar o cronograma.';

export interface EfeitosLeitura {
  /** Campos da coleta a preencher (só os que estavam vazios). */
  coleta: Partial<ColetaJornada>;
  /** Registrar pedido de cronograma que a palavra-chave não pegou. */
  pedidoMaterial: boolean;
  /** Tratar a objeção como dificuldade financeira (soma à palavra-chave, nunca a desliga). */
  dorFinanceira: boolean;
  /** Linhas para o bloco da ficha (orientação para a Luna). */
  avisos: string[];
  /** Rótulos do que foi (ou seria, na sombra) aplicado: telemetria. */
  aplicado: string[];
}

/** Regra em código: o que fazer com cada resposta. Pura — a mesma leitura sempre dá o mesmo efeito. */
export function efeitosDaLeitura(
  l: LeituraLead,
  limiar: number,
  jornada: Jornada,
  jaDetectado: { pedidoMaterial: boolean } = { pedidoMaterial: false },
): EfeitosLeitura {
  const c = jornada.coleta ?? {};
  const seguro = (p: number | null | undefined) => typeof p === 'number' && p >= limiar;
  const coleta: Partial<ColetaJornada> = {};
  const avisos: string[] = [];
  const aplicado: string[] = [];

  if (l.conclusao && l.conclusao.confianca >= limiar) {
    if (l.conclusao.valor === 'concluiu' && !c.graduacao_concluida) {
      coleta.graduacao_concluida = 'sim';
      aplicado.push('conclusao:sim');
    } else if (l.conclusao.valor === 'cursando' && !c.graduacao_concluida) {
      coleta.graduacao_concluida = 'cursando';
      aplicado.push('conclusao:cursando');
    } else if (l.conclusao.valor === 'nao_tem_graduacao' && c.graduacao_concluida !== 'nao') {
      avisos.push(AVISO_SEM_GRADUACAO);
      aplicado.push('aviso:sem_graduacao');
    }
  }
  const oficial = l.graduacao && l.graduacao.confianca >= limiar ? GRADUACAO_OFICIAL[l.graduacao.valor] : undefined;
  if (oficial && FORMACOES_OFICIAIS.includes(oficial) && !String(c.graduacao ?? '').trim()) {
    coleta.graduacao = oficial;
    aplicado.push(`graduacao:${l.graduacao!.valor}`);
  }
  if (seguro(l.informou_data)) {
    avisos.push(AVISO_DATA_INFORMADA);
    aplicado.push('aviso:data_informada');
  }
  if (seguro(l.dois_assuntos)) {
    avisos.push(AVISO_DOIS_ASSUNTOS);
    aplicado.push('aviso:dois_assuntos');
  }
  const pedidoMaterial = seguro(l.pediu_material) && !jaDetectado.pedidoMaterial;
  if (pedidoMaterial) aplicado.push('pedido_material');
  const dorFinanceira = seguro(l.dor_financeira);
  if (dorFinanceira) aplicado.push('dor_financeira');
  return { coleta, pedidoMaterial, dorFinanceira, avisos, aplicado };
}

export function blocoDaLeitura(avisos: readonly string[]): string | null {
  return avisos.length ? [CABECALHO_LEITURA, ...avisos.map((a) => `- ${a}`)].join('\n') : null;
}

/** Config do banco. Qualquer falha = off (a ficha de sempre), nunca uma rodada parada. */
export async function carregarConfigLeituraJev(supabase: any): Promise<ConfigLeituraJev | null> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('ficha_jev_modo, ficha_jev_limiar').eq('id', 1).maybeSingle();
    if (error || !data) return null;
    const modo = data.ficha_jev_modo;
    if (modo !== 'sombra' && modo !== 'ativo') return null;
    const limiar = Number(data.ficha_jev_limiar);
    return { modo, limiar: Number.isFinite(limiar) && limiar >= 0.5 && limiar < 1 ? limiar : LIMIAR_LEITURA_PADRAO };
  } catch {
    return null;
  }
}
