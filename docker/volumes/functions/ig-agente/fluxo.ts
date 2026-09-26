// O ROTEIRO do direct do Instagram — caminho feliz do DIRETOR COMERCIAL (25/09/2026),
// "bem mais direto" que a 1ª versão do Gustavo (24/09, oferta da Escola na abertura):
//
//   ManyChat (novo seguidor): "Oii, tudo bem?" — só puxa conversa
//   1. boas_vindas             a pessoa responde           → pergunta a formação
//   2. pergunta_formacao       formado                     → pergunta se quer o portfólio
//                              estudante                   → pergunta QUANDO se forma
//                              nem formado nem estudante   → link da Escola (fim, sem CRM)
//   2b. pergunta_data_formacao mês e ano                   → pergunta se quer o portfólio
//   3. pergunta_interesse      quer                        → pede o WhatsApp ("o PDF não vai pelo insta")
//                              não quer                    → despedida (fim)
//   4. pergunta_whatsapp       número válido               → CRM 1.5 INSTAGRAM + RECIBO no
//                                                            WhatsApp; o PDF vai quando a pessoa
//                                                            responde lá (fim) — _shared/igWhatsapp.ts
//   fins: escola_enviada | whatsapp_enviado | encerrada
//
// A data de formação (aprovada pelo Gustavo em 25/09) decide a etapa do CRM: Formados |
// Na graduação (forma até o limite da régua do João, hoje 31/01/2027) | Forma depois de
// jan/2027. Quem LÊ a data é o código do João (elegibilidadeFormatura.ts), não o modelo.
//
// A IA (classificador.ts) só ENTENDE a resposta da pessoa. As frases são fixas e moram
// AQUI: o texto é do comercial, não do modelo — o contrário do João do WhatsApp.
// Módulo puro (sem banco, sem rede): cada passagem tem teste em fluxo.test.ts.
import { avaliarConclusao, limiteFormatura } from "../crm-agente-sdr/elegibilidadeFormatura.ts";
import { IG_WA_NUMERO_EXIBIDO } from "../_shared/igWhatsapp.ts";

export const LINK_ESCOLA = "https://escoladeespecializacao.ppgvet.com.br";
/** A IA do direct se apresenta com este nome (decisão do Gustavo, 25/09/2026). */
export const NOME_AGENTE = "Flávia";

export type EtapaFluxo =
  | "boas_vindas"
  | "pergunta_formacao"
  | "pergunta_curso"
  | "pergunta_data_formacao"
  | "pergunta_interesse"
  | "pergunta_whatsapp"
  | "escola_enviada"
  | "whatsapp_enviado"
  | "encerrada";
export type Situacao = "formado" | "estudante" | "nenhum" | "nao_informou";
export type Intencao = "aceita" | "recusa" | "pergunta" | "outro";

/** O que o classificador entendeu das mensagens novas da pessoa. */
export type Classificacao = {
  intencao: Intencao;
  situacao: Situacao;
  area: string | null;
  telefone: string | null;
  /**
   * Mês/ano de formação que o MODELO entendeu ("07/2027"). Só é usado quando o texto da
   * pessoa, lido pelo código, não fecha uma data — a regra é a do João (avaliarConclusao).
   */
  conclusao: string | null;
  /** Resposta curta, escrita pelo modelo, SÓ quando a pessoa fez uma pergunta. */
  resposta_pergunta: string | null;
};

export type ContextoFluxo = {
  /** Nome do perfil do Instagram (ig_perfis.nome), cru. */
  nomePerfil: string | null;
  /** Texto das mensagens novas da pessoa, juntas — é dele que sai o telefone e a data. */
  textoNovo: string;
  /** Quantas vezes a IA já repetiu a pergunta DESTA etapa. */
  tentativas: number;
  /** Relógio (a régua da data depende de hoje). */
  agora?: Date;
  /** O que o roteiro já guardou em rodadas anteriores (ig_conversa_ia). */
  situacaoSalva?: string | null;
  areaSalva?: string | null;
  dataSalva?: string | null;
};

export type Passo = {
  mensagens: string[];
  proximaEtapa: EtapaFluxo;
  tentativas: number;
  situacao?: "formado" | "estudante";
  area?: string | null;
  /** Data prevista de formação, AAAA-MM-DD (último dia do mês citado). */
  dataFormacao?: string;
  /** Canônico: 55 + DDD + número. */
  telefone?: string;
  /** Capturou o WhatsApp: criar a oportunidade e mandar o recibo (o PDF vai na resposta). */
  enviarWhatsapp?: boolean;
};

export const ETAPAS_FINAIS: ReadonlySet<EtapaFluxo> = new Set(["escola_enviada", "whatsapp_enviado", "encerrada"]);

// ── As frases (do diretor comercial, 25/09/2026) ────────────────────────────────
export const TEXTOS = {
  // 1º balão da IA na conversa: "tava muito seco, falta uma saudação" (25/09/2026). Serve
  // para "tudo sim" e para "tudo bem?" devolvido.
  apresentacao: `Tudo ótimo por aqui! 😊 Sou a ${NOME_AGENTE}, da PPGVET.`,
  perguntaFormacao: (nome: string | null) =>
    nome
      ? `${nome}, você já se formou e tá trabalhando, ou ainda tá na graduação?`
      : "Você já se formou e tá trabalhando, ou ainda tá na graduação?",
  reperguntarFormacao:
    "Só pra eu te mandar o material certo: você já tem graduação completa ou ainda tá cursando?",
  // 2ª resposta ainda sem a formação (área de atuação de novo, "produtor rural"…): antes
  // ia direto para a Escola e o lead saía do roteiro. Frase do Gustavo (26/09/2026).
  confirmarSemGraduacao: (nome: string | null) =>
    nome
      ? `Você não possui graduação? Não consegui entender, ${nome} 😅`
      : "Você não possui graduação? Não consegui entender 😅",
  // "A IA está assumindo qualquer coisa na graduação, tinha que perguntar qual é"
  // (Gustavo, 25/09/2026): sem o curso dito, a IA pergunta antes de seguir.
  perguntaCursoFormado: "Show! E qual é a sua formação?",
  perguntaCursoEstudante: "Legal! E qual curso você faz?",
  reperguntarCurso: "Me conta qual é o curso da sua graduação? Por exemplo: medicina veterinária, zootecnia, agronomia…",
  perguntaDataFormacao: "E você se forma quando? Me fala o mês e o ano 😊",
  reperguntarDataFormacao: "Só pra eu anotar certinho: em que mês e ano você se forma?",
  perguntaInteresse:
    "Você tem interesse em conhecer as nossas pós-graduações? Te encaminho o nosso portfólio pra você olhar com calma?",
  pedirWhatsapp:
    "Não consigo encaminhar o PDF pelo Insta. Me passa seu WhatsApp com DDD que te mando por lá?",
  telefoneInvalido: "Acho que faltou algum número 🤔 Me manda seu WhatsApp com DDD?",
  relembrarWhatsapp: "É só me mandar seu WhatsApp com DDD que eu te envio o portfólio por lá 😉",
  // 25/09/2026 (aprovada pelo Gustavo): o que sai no WhatsApp é o RECIBO, não o PDF — o
  // PDF vai quando a pessoa responde lá (ver _shared/igWhatsapp.ts). Esta frase é que
  // explica isso; sem ela o recibo sozinho não diz nada do portfólio.
  confirmacaoWhatsapp:
    `Prontinho! Acabei de te mandar uma mensagem no WhatsApp, do número ${IG_WA_NUMERO_EXIBIDO}. Manda um Oi por lá pra confirmar que é você que eu já te encaminho o portfólio 😉`,
  // O recibo NÃO saiu (número sem WhatsApp, Meta recusou): a etapa volta para o pedido do
  // número, para a pessoa conferir. Nunca dizer "te mandei" sem ter mandado.
  whatsappNaoFoi: "Hmm, não consegui te chamar nesse número 🤔 Confere se é o seu WhatsApp com DDD e me manda de novo?",
  escola:
    `Te mando sim! 😉 Aqui está o acesso à nossa Escola de Especialização gratuita, com mais de 10 cursos, além de artigos, e-books e podcasts: ${LINK_ESCOLA}`,
  recusa: "Tranquilo! Se mudar de ideia, é só me chamar por aqui 😉",
  // ⚠️ PROVISÓRIA: o que fazer com quem não passa o número ficou para depois (24/09).
  recusaWhatsapp: "Sem problema! Se preferir, é só me mandar o número aqui quando quiser 😉",
} as const;

// ── Nome ─────────────────────────────────────────────────────────────────────
// O nome do perfil do Instagram nem sempre é nome de gente: medido em 24/09, ~15% dos
// perfis que falaram com a gente eram marca, casal ou tudo em maiúsculas ("JS MIMOS",
// "JHORRAN BARBER'S SHOP"). Só chama pelo nome quando a 1ª palavra parece nome próprio.
const PALAVRA_DE_MARCA = /(cl[ií]nica|vet|pet|agro|hospital|fazenda|consult|oficial|store|shop|loja|ltda|haras|grupo|centro|studio|est[uú]dio|zoo)/i;

export function primeiroNomeConfiavel(nome: string | null | undefined): string | null {
  const primeiro = String(nome ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][a-záàâãéêíóôõúç]{2,14}$/.test(primeiro)) return null;
  if (PALAVRA_DE_MARCA.test(primeiro)) return null;
  return primeiro;
}

// ── Telefone ─────────────────────────────────────────────────────────────────
/**
 * Acha um WhatsApp brasileiro no texto: DDD (dois dígitos, sem zero) + 8 ou 9 dígitos,
 * com ou sem 55 na frente. Devolve canônico (55…) ou null. Quem decide é o código, não
 * o modelo — o classificador só ajuda quando o número vem escrito de um jeito estranho.
 */
export function extrairTelefoneBR(texto: string | null | undefined): string | null {
  const candidatos = String(texto ?? "").match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
  for (const c of candidatos) {
    let n = c.replace(/\D/g, "");
    if (n.length >= 12 && n.startsWith("55")) n = n.slice(2);
    if (!/^[1-9][1-9]/.test(n)) continue;
    if (n.length === 11 && n[2] === "9") return `55${n}`;
    if (n.length === 10) return `55${n}`;
  }
  return null;
}

/** Tem cara de número (muitos dígitos) mas não é um WhatsApp válido. */
function pareceNumeroInvalido(texto: string): boolean {
  return (texto.replace(/\D/g, "").length >= 6) && !extrairTelefoneBR(texto);
}

// ── Data de formação ───────────────────────────────────────────────────────────
/**
 * Lê a data prevista de formação com a régua do João: mês e ano → último dia do mês;
 * "tô no 7º período" (posição no curso) e "ano que vem" NÃO viram data. O que o modelo
 * entendeu (`c.conclusao`) só entra se o texto não fechar. Devolve AAAA-MM-DD ou null.
 */
export function lerDataFormacao(c: Classificacao, ctx: ContextoFluxo): string | null {
  const r = avaliarConclusao(ctx.textoNovo, c.conclusao, ctx.agora ?? new Date());
  return r.leitura.tipo === "data" ? r.leitura.data.toISOString().slice(0, 10) : null;
}

/** Última etapa semestral criada no funil; depois dela, "Forma depois de 2031/06". */
export const ULTIMO_SEMESTRE_CRM = "2031/06";

/**
 * Semestre de formatura no formato das etapas do CRM (pedido do Gustavo, 25/09/2026):
 * fevereiro a julho → "AAAA/06"; agosto a dezembro → "(AAAA+1)/01"; janeiro → "AAAA/01"
 * (a colação do 2º semestre cai em janeiro).
 */
export function semestreDeFormatura(dataFormacao: string): string {
  const [ano, mes] = dataFormacao.split("-").map(Number);
  if (mes === 1) return `${ano}/01`;
  if (mes <= 7) return `${ano}/06`;
  return `${ano + 1}/01`;
}

/**
 * Etapa do funil 1.5 INSTAGRAM:
 *   formado → "Formados";
 *   estudante que se forma até o limite da régua do João (hoje 31/01/2027) → "Na graduação"
 *   (pode ir para reunião) — e também o estudante SEM data: o João re-confere o prazo;
 *   depois do limite → "Forma em AAAA/06" | "Forma em AAAA/01", até 2031/06;
 *   mais tarde que isso → "Forma depois de 2031/06".
 */
export function etapaCrmInstagram(
  situacao: string | null | undefined,
  dataFormacao: string | null | undefined,
  agora: Date = new Date(),
): string {
  if (situacao !== "estudante") return "Formados";
  if (!dataFormacao) return "Na graduação";
  const fim = new Date(`${dataFormacao}T23:59:59Z`);
  if (fim <= limiteFormatura(agora)) return "Na graduação";
  const semestre = semestreDeFormatura(dataFormacao);
  return semestre > ULTIMO_SEMESTRE_CRM ? `Forma depois de ${ULTIMO_SEMESTRE_CRM}` : `Forma em ${semestre}`;
}

// ── As passagens ─────────────────────────────────────────────────────────────
function comResposta(c: Classificacao, depois: string[]): string[] {
  const resposta = c.intencao === "pergunta" ? String(c.resposta_pergunta ?? "").trim() : "";
  return resposta ? [resposta, ...depois] : depois;
}

function capturou(telefone: string): Passo {
  return {
    mensagens: [TEXTOS.confirmacaoWhatsapp],
    proximaEtapa: "whatsapp_enviado",
    tentativas: 0,
    telefone,
    enviarWhatsapp: true,
  };
}

function telefoneDe(c: Classificacao, ctx: ContextoFluxo): string | null {
  return extrairTelefoneBR(ctx.textoNovo) ?? extrairTelefoneBR(c.telefone);
}

function irParaInteresse(c: Classificacao, extra: Partial<Passo> = {}): Passo {
  return { mensagens: comResposta(c, [TEXTOS.perguntaInteresse]), proximaEtapa: "pergunta_interesse", tentativas: 0, ...extra };
}

/** Curso resolvido (ou desistido): formado vai ao portfólio; estudante ainda precisa da data. */
function depoisDoCurso(
  c: Classificacao,
  situacao: "formado" | "estudante",
  area: string | null,
  data: string | null,
): Passo {
  const base = { situacao, ...(area ? { area } : {}) };
  if (situacao === "formado" || data) return irParaInteresse(c, { ...base, ...(data ? { dataFormacao: data } : {}) });
  return {
    mensagens: comResposta(c, [TEXTOS.perguntaDataFormacao]),
    proximaEtapa: "pergunta_data_formacao",
    tentativas: 0,
    ...base,
  };
}

export function decidirPasso(etapa: EtapaFluxo, c: Classificacao, ctx: ContextoFluxo): Passo {
  const passo = decidirPassoSemApresentacao(etapa, c, ctx);
  // Primeira resposta da IA (respondendo o "Oii, tudo bem?" do ManyChat): a Flávia se
  // apresenta antes de qualquer coisa — menos na despedida de quem não quer papo.
  if (etapa === "boas_vindas" && passo.proximaEtapa !== "encerrada" && passo.mensagens.length) {
    return { ...passo, mensagens: [TEXTOS.apresentacao, ...passo.mensagens] };
  }
  return passo;
}

function decidirPassoSemApresentacao(etapa: EtapaFluxo, c: Classificacao, ctx: ContextoFluxo): Passo {
  const nome = primeiroNomeConfiavel(ctx.nomePerfil);

  // Fim de roteiro: só responde pergunta; conversa fiada não reabre o fluxo.
  if (ETAPAS_FINAIS.has(etapa)) {
    return { mensagens: comResposta(c, []), proximaEtapa: etapa, tentativas: ctx.tentativas };
  }

  if (etapa === "pergunta_whatsapp") {
    const telefone = telefoneDe(c, ctx);
    if (telefone) return capturou(telefone);
    if (pareceNumeroInvalido(ctx.textoNovo)) {
      return { mensagens: [TEXTOS.telefoneInvalido], proximaEtapa: "pergunta_whatsapp", tentativas: ctx.tentativas + 1 };
    }
    if (c.intencao === "recusa") {
      return { mensagens: [TEXTOS.recusaWhatsapp], proximaEtapa: "encerrada", tentativas: 0 };
    }
    // Pergunta: responde e relembra. Outra coisa: relembra UMA vez, depois espera calado.
    if (c.intencao === "pergunta" || ctx.tentativas < 1) {
      return {
        mensagens: comResposta(c, [TEXTOS.relembrarWhatsapp]),
        proximaEtapa: "pergunta_whatsapp",
        tentativas: ctx.tentativas + 1,
      };
    }
    return { mensagens: [], proximaEtapa: "pergunta_whatsapp", tentativas: ctx.tentativas };
  }

  if (etapa === "pergunta_interesse") {
    // Já mandou o número junto do "quero": captura na hora.
    const telefone = telefoneDe(c, ctx);
    if (telefone && c.intencao !== "recusa") return capturou(telefone);
    if (c.intencao === "aceita") {
      return { mensagens: [TEXTOS.pedirWhatsapp], proximaEtapa: "pergunta_whatsapp", tentativas: 0 };
    }
    if (c.intencao === "recusa") {
      return { mensagens: [TEXTOS.recusa], proximaEtapa: "encerrada", tentativas: 0 };
    }
    if (c.intencao === "pergunta" || ctx.tentativas < 1) {
      return {
        mensagens: comResposta(c, [TEXTOS.perguntaInteresse]),
        proximaEtapa: "pergunta_interesse",
        tentativas: ctx.tentativas + 1,
      };
    }
    return { mensagens: [], proximaEtapa: "pergunta_interesse", tentativas: ctx.tentativas };
  }

  if (etapa === "pergunta_curso") {
    const situacao = c.situacao === "formado" || c.situacao === "estudante"
      ? c.situacao
      : (ctx.situacaoSalva === "formado" ? "formado" : "estudante");
    const data = situacao === "estudante" ? (lerDataFormacao(c, ctx) ?? ctx.dataSalva ?? null) : null;
    if (c.area) return depoisDoCurso(c, situacao, c.area, data);
    // Sem curso claro: pergunta de novo UMA vez; depois segue sem ele (não trava).
    if (c.intencao === "pergunta" || (ctx.tentativas < 1 && c.intencao !== "recusa")) {
      return {
        mensagens: comResposta(c, [TEXTOS.reperguntarCurso]),
        proximaEtapa: "pergunta_curso",
        tentativas: ctx.tentativas + 1,
      };
    }
    return depoisDoCurso(c, situacao, null, data);
  }

  if (etapa === "pergunta_data_formacao") {
    const data = lerDataFormacao(c, ctx);
    if (data) return irParaInteresse(c, { dataFormacao: data });
    // Pergunta ou resposta que não fecha data ("tô no 7º período", "ano que vem"):
    // repergunta UMA vez. Depois segue sem a data — não trava a conversa por isso.
    if (c.intencao === "pergunta" || (ctx.tentativas < 1 && c.intencao !== "recusa")) {
      return {
        mensagens: comResposta(c, [ctx.tentativas < 1 ? TEXTOS.reperguntarDataFormacao : TEXTOS.perguntaDataFormacao]),
        proximaEtapa: "pergunta_data_formacao",
        tentativas: ctx.tentativas + 1,
      };
    }
    return irParaInteresse(c);
  }

  // boas_vindas e pergunta_formacao: a pessoa pode já ter dito a situação (e o curso).
  if (c.situacao === "formado" || c.situacao === "estudante") {
    const situacao = c.situacao;
    const data = situacao === "estudante" ? lerDataFormacao(c, ctx) : null;
    if (!c.area) {
      // "Tô na graduação" / "sou formado" sem dizer o quê: pergunta o curso. Uma data dita
      // junto ("me formo em julho de 2027") já fica guardada.
      return {
        mensagens: comResposta(c, [situacao === "formado" ? TEXTOS.perguntaCursoFormado : TEXTOS.perguntaCursoEstudante]),
        proximaEtapa: "pergunta_curso",
        tentativas: 0,
        situacao,
        ...(data ? { dataFormacao: data } : {}),
      };
    }
    return depoisDoCurso(c, situacao, c.area, data);
  }
  if (c.situacao === "nenhum") {
    return { mensagens: [TEXTOS.escola], proximaEtapa: "escola_enviada", tentativas: 0 };
  }
  if (c.intencao === "recusa") {
    return { mensagens: [TEXTOS.recusa], proximaEtapa: "encerrada", tentativas: 0 };
  }

  if (etapa === "boas_vindas") {
    return { mensagens: comResposta(c, [TEXTOS.perguntaFormacao(nome)]), proximaEtapa: "pergunta_formacao", tentativas: 0 };
  }

  // pergunta_formacao sem resposta clara (cargo e área de trabalho não contam — 26/09):
  // 1ª vez repergunta; 2ª confirma se é sem graduação ("você não possui graduação? não
  // consegui entender {nome}", Gustavo 26/09); só na 3ª manda a Escola — o que não custa
  // nada errar: ninguém vai para o CRM sem saber a formação. Pergunta da pessoa não gasta
  // a Escola: responde e repergunta.
  if (ctx.tentativas < 1) {
    return { mensagens: comResposta(c, [TEXTOS.reperguntarFormacao]), proximaEtapa: "pergunta_formacao", tentativas: 1 };
  }
  if (ctx.tentativas < 2) {
    return { mensagens: comResposta(c, [TEXTOS.confirmarSemGraduacao(nome)]), proximaEtapa: "pergunta_formacao", tentativas: 2 };
  }
  if (c.intencao === "pergunta") {
    return { mensagens: comResposta(c, [TEXTOS.reperguntarFormacao]), proximaEtapa: "pergunta_formacao", tentativas: ctx.tentativas + 1 };
  }
  return { mensagens: [TEXTOS.escola], proximaEtapa: "escola_enviada", tentativas: 0 };
}
