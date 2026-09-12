// Réguas PURAS do disparador da integração do aluno (onb-regua-dispatch).
//
// Aqui mora só o que decide "manda ou não manda" sem tocar em rede nem em banco, porque essa
// é a decisão que não pode errar: do outro lado tem aluno real recebendo mensagem no WhatsApp
// do Suporte. O index.ts faz entrada e saída e obedece ao que estas funções responderem.
//
// O QUE NÃO ESTÁ AQUI, E POR QUÊ: a janela de horário, a escolha do modelo pelo TCC, a
// resolução das variáveis, a trava de 24 h da Meta e o intervalo de nova tentativa são do
// `onb_regua_candidatos` (migration 20260912150000_onb_regua.sql). Repetir aquela régua em
// TypeScript criaria duas verdades que um dia divergem. O que sobrou para a edge é o que o
// banco não alcança: a listagem de modelos aprovados na Meta, o PDF do cronograma do D+1, o
// envio, e a conferência de novo do que já foi conferido lá (rede de segurança barata).

import {
  canonicalBrClassificacao,
  classificaTelefone,
  digitosParaEnvio,
  digitsTelefone,
} from '../_shared/telefone.ts';

/** Conta de WhatsApp do Suporte ao Aluno, "Grupo PPG Educação (3250)". Só serve de rede: a
 * conta de verdade vem em `onb_regua_config.wa_account_id`, porque trocar de número é UPDATE. */
export const CONTA_SUPORTE_3250 = 'b5987306-4f73-46fb-b90a-054ad800c9ab';

/** Idioma dos modelos int_aluno_* na Meta. */
export const IDIOMA_TEMPLATE = 'pt_BR';

export type Modo = 'simulacao' | 'teste' | 'producao';

/** Do mais tímido para o mais perigoso. Serve para o corpo do POST poder DESCER, nunca subir. */
const RANK: Record<Modo, number> = { simulacao: 0, teste: 1, producao: 2 };

export function modoValido(v: unknown): v is Modo {
  return v === 'simulacao' || v === 'teste' || v === 'producao';
}

/**
 * Modo que vale nesta rodada.
 *
 * O corpo do POST pode pedir um modo, mas só para RECUAR: com a config em 'teste', pedir
 * 'producao' pelo corpo mandaria mensagem para aluno real a partir de um curl, sem ninguém ter
 * virado a chave no banco.
 *
 * E recuar pelo corpo é ENSAIO: não grava nem move nada. O 'simulado' que fica gravado ocupa a
 * unique de onb_regua_envios e faz o passo contar como cumprido; se uma simulação rodada à mão
 * por cima de uma régua em produção gravasse, ela apagaria de vez o envio de verdade daqueles
 * alunos, e ainda os moveria de etapa. Simulação que ESCREVE é só a que está na config.
 */
export function modoEfetivo(
  doConfig: unknown,
  pedido: unknown,
): { modo: Modo; pedido: Modo | null; rebaixado: boolean; ensaio: boolean } {
  const base: Modo = modoValido(doConfig) ? doConfig : 'teste';
  if (!modoValido(pedido)) return { modo: base, pedido: null, rebaixado: false, ensaio: false };
  const desceu = RANK[pedido] < RANK[base];
  return {
    modo: desceu ? pedido : base,
    pedido,
    rebaixado: RANK[pedido] > RANK[base],
    ensaio: desceu,
  };
}

/**
 * Telefone para o log do console (que vai parar no Dokploy, onde mais gente enxerga).
 * Mantém DDI + DDD e os 2 últimos dígitos: dá para reconhecer o número de teste do Rafael sem
 * publicar o celular de aluno nenhum.
 */
export function mascararTelefone(raw: string | null | undefined): string {
  const d = digitsTelefone(raw);
  if (!d) return '(sem telefone)';
  if (d.length <= 6) return `${d.slice(0, 2)}${'*'.repeat(Math.max(0, d.length - 2))}`;
  return `${d.slice(0, 4)}${'*'.repeat(d.length - 6)}${d.slice(-2)}`;
}

/**
 * Mesma pessoa? Compara pelo canônico de 13 dígitos (55 + DDD + 9 + 8), então o número da lista
 * de teste casa esteja ele escrito com +55, com ou sem o nono dígito, com traço ou não. É a
 * mesma ideia do fn_canon_ddd8 que o onb_regua_candidatos usa do lado do banco.
 */
export function mesmoTelefone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalBrClassificacao(String(a ?? ''));
  const cb = canonicalBrClassificacao(String(b ?? ''));
  return ca.length > 2 && ca === cb;
}

/** O número está na lista de quem pode receber no modo teste? Lista vazia = ninguém. */
export function estaNaListaDeTeste(
  telefone: string | null | undefined,
  lista: readonly (string | null)[] | null | undefined,
): boolean {
  if (!Array.isArray(lista) || lista.length === 0) return false;
  return lista.some((t) => mesmoTelefone(telefone, t));
}

/**
 * Valor de variável pronto para a Meta: sem quebra de linha e sem espaço repetido.
 * A Meta recusa o disparo inteiro quando um parâmetro tem \n (incidente do convite ao
 * professor), e nome de curso copiado de planilha vem com quebra mais vezes do que parece.
 */
export function limparValorDeVariavel(valor: string): string {
  return String(valor ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export type ResultadoValores =
  | { ok: true; valores: string[] }
  | { ok: false; faltando: string };

/**
 * Os valores das {{n}} que o banco já resolveu, conferidos de novo.
 *
 * O onb_regua_candidatos não deixa passar valor vazio, mas "Olá, !" é o tipo de erro que o
 * aluno vê e ninguém desfaz: a conferência aqui custa nada e vale pelas duas.
 */
export function valoresParaEnvio(
  valores: readonly (string | null)[] | null | undefined,
  variaveis: readonly (string | null)[] | null | undefined,
): ResultadoValores {
  const nomes = Array.isArray(variaveis) ? variaveis : [];
  const brutos = Array.isArray(valores) ? valores : [];
  if (brutos.length !== nomes.length) {
    return { ok: false, faltando: `esperava ${nomes.length} valor(es), veio ${brutos.length}` };
  }
  const limpos: string[] = [];
  for (let i = 0; i < brutos.length; i++) {
    const valor = limparValorDeVariavel(String(brutos[i] ?? ''));
    if (!valor) return { ok: false, faltando: String(nomes[i] ?? `{{${i + 1}}}`) };
    limpos.push(valor);
  }
  return { ok: true, valores: limpos };
}

/** Componente de corpo do template no formato da Meta. Passo sem variável vai sem componente. */
export function componentsDoCorpo(valores: readonly string[]): Record<string, unknown>[] {
  if (!valores.length) return [];
  return [{ type: 'body', parameters: valores.map((text) => ({ type: 'text', text })) }];
}

/** 'documento' | 'video' | 'imagem' do passo vira o formato que a Meta entende. */
export function formatoDoCabecalho(cabecalho: unknown): 'DOCUMENT' | 'VIDEO' | 'IMAGE' | null {
  const c = String(cabecalho ?? '').trim().toLowerCase();
  if (c === 'documento') return 'DOCUMENT';
  if (c === 'video') return 'VIDEO';
  if (c === 'imagem') return 'IMAGE';
  return null;
}

/** Cabeçalho 'documento' é o do D+1: o PDF do cronograma, gerado na hora para cada aluno. */
export function precisaDoCronograma(cand: { cabecalho?: unknown }): boolean {
  return formatoDoCabecalho(cand?.cabecalho) === 'DOCUMENT';
}

export const MOTIVO = {
  ja_enviado: 'ja_enviado',
  fora_do_teste: 'fora_do_teste',
  sem_telefone: 'sem_telefone',
  sem_modelo: 'sem_modelo',
  modelo_nao_aprovado: 'modelo_nao_aprovado',
  sem_midia: 'sem_midia',
  sem_variavel: 'sem_variavel',
  sem_cronograma: 'sem_cronograma',
  sem_turma: 'sem_turma',
  /**
   * A Meta recusou por ritmo de mensagem para aquela pessoa (131049/131050). NÃO existe mais
   * trava de "1 template por número a cada 24 h" na crm-whatsapp-send: ela foi removida a pedido
   * do diretor. Quem ainda espaça template no caminho da régua é o onb_regua_candidatos, e só
   * enquanto a janela de bypass de crm_pipeline_settings estiver fechada.
   */
  frequencia_meta: 'frequencia_meta',
} as const;

export type Motivo = (typeof MOTIVO)[keyof typeof MOTIVO];

/**
 * Uma linha de `onb_regua_candidatos(p_limite)`. Os campos seguem os nomes das colunas da RPC
 * (migration 20260912150000_onb_regua.sql) e são opcionais de propósito: coluna ausente não
 * pode derrubar o disparador, só deixa de barrar por aquele motivo.
 */
export type Candidato = {
  oportunidade_id: string;
  /** 'card' (card próprio no funil) ou 'posicao' (espelho do card fixo ALUNOS). */
  via?: string | null;
  lead_id?: string | null;
  /** Primeiro nome, já tratado pelo banco. */
  nome?: string | null;
  nome_completo?: string | null;
  telefone?: string | null;
  wa_account_id?: string | null;
  etapa_id: string;
  etapa_nome?: string | null;
  ordem?: number | null;
  /** O D+N do passo, como rótulo. */
  dia?: number | null;
  /** 'enviar' (o passo tem modelo e está na hora) ou 'mover' (só andar de etapa). */
  acao?: string | null;
  /** Preenchido só quando acao = 'mover': por que ele anda sem receber nada. */
  motivo?: string | null;
  /**
   * O que o BANCO já viu faltando para este envio: 'sem_variavel', 'sem_turma', 'sem_cronograma'
   * ou 'sem_midia'. Não nulo = não mande, registre 'pulado' com este motivo. A linha vem assim de
   * propósito (contrato do onb_regua_candidatos): é ela que faz o aluno travado aparecer no log,
   * em vez de sumir da fila sem explicação.
   */
  alerta?: string | null;
  /** Modelo JÁ escolhido pelo banco (o D+13 pelo TCC do curso). */
  template_nome?: string | null;
  cabecalho?: string | null;
  midia_url?: string | null;
  midia_nome?: string | null;
  /** Nomes das variáveis, na ordem das {{n}}. */
  variaveis?: string[] | null;
  /** Valores já resolvidos pelo banco, na mesma ordem. */
  valores?: string[] | null;
  turma_id?: string | null;
  turma_nome?: string | null;
  grupo_whatsapp_url?: string | null;
  curso?: string | null;
  marca?: string | null;
  tcc?: string | null;
  aulas_futuras?: number | null;
  proxima_etapa_id?: string | null;
  interagiu?: boolean | null;
  entrou_na_etapa_em?: string | null;
  modo?: string | null;
};

export type ContextoTravas = {
  modo: Modo;
  telefonesTeste: readonly (string | null)[] | null | undefined;
  /** Nomes aprovados na Meta para a conta. `null` = não deu para consultar nesta rodada. */
  aprovados: ReadonlySet<string> | null;
  telefoneEnvio: string | null;
  /** Já existe linha enviada/simulada deste passo para este aluno. */
  jaEnviado: boolean;
};

/**
 * A primeira trava que barra o passo, na ordem do desenho.
 *
 * Quase tudo aqui o `onb_regua_candidatos` já barrou em SQL. A repetição é deliberada: este é
 * o último ponto antes de a mensagem sair, e é o único que sobrevive a alguém chamar a edge à
 * mão. A exceção é `modelo_nao_aprovado`, que só existe aqui: a aprovação mora na Meta, e o
 * banco não a enxerga.
 *
 * A conferência do cronograma do D+1 NÃO está aqui porque é chamada de rede (gera o PDF): ela
 * roda depois, no index.ts, para não gerar PDF de quem já está barrado por outro motivo.
 */
export function primeiraTrava(
  cand: Candidato,
  ctx: ContextoTravas,
): { motivo: Motivo; detalhe?: string } | null {
  // Rede de segurança antes de tudo: a unique de onb_regua_envios existe, mas conferir aqui
  // evita queimar template e, principalmente, evita o aluno receber o mesmo passo duas vezes.
  if (ctx.jaEnviado) return { motivo: MOTIVO.ja_enviado };

  // No modo teste, quem não está na lista nem chega a ser processado.
  if (ctx.modo === 'teste' && !estaNaListaDeTeste(cand.telefone, ctx.telefonesTeste)) {
    return { motivo: MOTIVO.fora_do_teste };
  }

  if (!ctx.telefoneEnvio || !cand.telefone) return { motivo: MOTIVO.sem_telefone };
  if (classificaTelefone(cand.telefone) === 'impossivel') {
    return { motivo: MOTIVO.sem_telefone, detalhe: 'numero_impossivel' };
  }

  const template = String(cand.template_nome ?? '').trim();
  if (!template) return { motivo: MOTIVO.sem_modelo };
  // `aprovados` nulo = a Meta não respondeu a listagem nesta rodada. Aí a régua segue: quem
  // recusa modelo não aprovado é a própria Meta, e o erro dela vira 'erro' sem estrago.
  if (ctx.aprovados && !ctx.aprovados.has(template)) {
    return { motivo: MOTIVO.modelo_nao_aprovado };
  }

  // Cabeçalho de vídeo/imagem sem arquivo: a Meta recusa o disparo inteiro (132012). O
  // 'documento' é o D+1 e não usa midia_url: o PDF nasce na hora.
  const formato = formatoDoCabecalho(cand.cabecalho);
  if (formato && formato !== 'DOCUMENT' && !String(cand.midia_url ?? '').trim()) {
    return { motivo: MOTIVO.sem_midia };
  }

  const vals = valoresParaEnvio(cand.valores, cand.variaveis);
  if (!vals.ok) return { motivo: MOTIVO.sem_variavel, detalhe: vals.faltando };

  // O que o banco já viu faltando e mandou junto na linha. Vem por último porque os motivos que
  // esta função calcula sozinha são mais específicos (dizem QUAL variável, por exemplo); o que
  // sobra aqui é o que só o banco enxerga, como 'sem_turma' e 'sem_cronograma' (e este último
  // evita a ida até o generate-cronograma-aluno-pdf para descobrir o que já se sabe).
  const alerta = String(cand.alerta ?? '').trim();
  if (alerta) return { motivo: alerta as Motivo };

  return null;
}

/**
 * A Meta recusou por ritmo/frequência para aquela pessoa? Isso é passo ADIADO ('pulado'), não
 * passo com erro: o número está certo, o modelo está aprovado, e a próxima tentativa sai depois
 * de retentar_apos_horas. 131049 e 131050 são os códigos de pacing por usuário.
 */
export function ehFrequenciaDaMeta(erro: unknown): boolean {
  return /\b(131049|131050)\b/.test(String(erro ?? ''));
}

/** Comparação em tempo constante: a chave de serviço não pode vazar pelo tempo de resposta. */
export function iguaisTempoConstante(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Teto de candidatos por rodada. Sem valor no corpo, quem manda é o lote_max da config (null). */
export const LOTE_MAXIMO = 200;

export function limiteDaRodada(bruto: unknown): number | null {
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), LOTE_MAXIMO);
}

/** Dígitos que vão para a Meta (mantém DDI estrangeiro, acrescenta 55 ao formato nacional). */
export function telefoneDeEnvio(raw: string | null | undefined): string | null {
  return digitosParaEnvio(raw);
}
