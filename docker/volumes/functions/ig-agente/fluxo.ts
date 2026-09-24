// O ROTEIRO do direct do Instagram — fluxo desenhado pelo Gustavo em 24/09/2026.
//
//   ManyChat (novo seguidor): oferta da Escola gratuita → "Quer receber o acesso?"
//   1. boas_vindas        a pessoa responde           → a IA pergunta a formação
//   2. pergunta_formacao  formado ou estudante         → pede o WhatsApp
//                         nem formado nem estudante    → link da Escola (fim, sem CRM)
//   3. pergunta_whatsapp  número válido                → CRM 1.5 INSTAGRAM + template com
//                                                        o portfólio no WhatsApp (fim)
//   fins: escola_enviada | whatsapp_enviado | encerrada
//
// A IA (classificador.ts) só ENTENDE a resposta da pessoa. As frases são fixas e moram
// AQUI: o texto é do comercial, não do modelo — o contrário do João do WhatsApp.
// Módulo puro (sem banco, sem rede): cada passagem tem teste em fluxo.test.ts.

export const LINK_ESCOLA = "https://escoladeespecializacao.ppgvet.com.br";

export type EtapaFluxo =
  | "boas_vindas"
  | "pergunta_formacao"
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
  /** Resposta curta, escrita pelo modelo, SÓ quando a pessoa fez uma pergunta. */
  resposta_pergunta: string | null;
};

export type ContextoFluxo = {
  /** Nome do perfil do Instagram (ig_perfis.nome), cru. */
  nomePerfil: string | null;
  /** Texto das mensagens novas da pessoa, juntas — é dele que sai o telefone. */
  textoNovo: string;
  /** Quantas vezes a IA já repetiu a pergunta DESTA etapa. */
  tentativas: number;
};

export type Passo = {
  mensagens: string[];
  proximaEtapa: EtapaFluxo;
  tentativas: number;
  situacao?: "formado" | "estudante";
  area?: string | null;
  /** Canônico: 55 + DDD + número. */
  telefone?: string;
  /** Capturou o WhatsApp: criar a oportunidade e mandar o template do portfólio. */
  enviarWhatsapp?: boolean;
};

export const ETAPAS_FINAIS: ReadonlySet<EtapaFluxo> = new Set(["escola_enviada", "whatsapp_enviado", "encerrada"]);

// ── As frases (do comercial) ───────────────────────────────────────────────────
export const TEXTOS = {
  perguntaFormacaoAceite: (nome: string | null) =>
    `Te envio sim! Só me confirma${nome ? `, ${nome}` : ""}: você já se formou e tá trabalhando, ou ainda tá na graduação?`,
  perguntaFormacao: (nome: string | null) =>
    `Oi${nome ? `, ${nome}` : ""}! Me conta rapidinho: você já se formou e tá trabalhando, ou ainda tá na graduação?`,
  reperguntarFormacao:
    "Só pra eu te mandar o material certo: você já tem graduação completa ou ainda tá cursando?",
  pedirWhatsapp:
    "Perfeito! Me passa seu WhatsApp com DDD? Te mando por lá o link e o nosso portfólio em PDF, pra você olhar com calma.",
  telefoneInvalido: "Acho que faltou algum número 🤔 Me manda seu WhatsApp com DDD?",
  relembrarWhatsapp: "É só me mandar seu WhatsApp com DDD que eu te envio o link e o portfólio por lá 😉",
  confirmacaoWhatsapp:
    'Prontinho! Te mandei lá no WhatsApp 😉 É só tocar em "Receber acesso" que o link chega na hora.',
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

// ── As passagens ─────────────────────────────────────────────────────────────
function comResposta(c: Classificacao, depois: string[]): string[] {
  const resposta = c.intencao === "pergunta" ? String(c.resposta_pergunta ?? "").trim() : "";
  return resposta ? [resposta, ...depois] : depois;
}

function pedirOuCapturarWhatsapp(
  c: Classificacao,
  ctx: ContextoFluxo,
  situacao: "formado" | "estudante",
): Passo {
  const telefone = extrairTelefoneBR(ctx.textoNovo) ?? extrairTelefoneBR(c.telefone);
  // Já mandou o número junto ("sou vet, meu zap é 46 9…"): não pergunta de novo.
  if (telefone) {
    return {
      mensagens: [TEXTOS.confirmacaoWhatsapp],
      proximaEtapa: "whatsapp_enviado",
      tentativas: 0,
      situacao,
      area: c.area,
      telefone,
      enviarWhatsapp: true,
    };
  }
  return {
    mensagens: comResposta(c, [TEXTOS.pedirWhatsapp]),
    proximaEtapa: "pergunta_whatsapp",
    tentativas: 0,
    situacao,
    area: c.area,
  };
}

export function decidirPasso(etapa: EtapaFluxo, c: Classificacao, ctx: ContextoFluxo): Passo {
  const nome = primeiroNomeConfiavel(ctx.nomePerfil);

  // Fim de roteiro: só responde pergunta; conversa fiada não reabre o fluxo.
  if (ETAPAS_FINAIS.has(etapa)) {
    return { mensagens: comResposta(c, []), proximaEtapa: etapa, tentativas: ctx.tentativas };
  }

  if (etapa === "pergunta_whatsapp") {
    const telefone = extrairTelefoneBR(ctx.textoNovo) ?? extrairTelefoneBR(c.telefone);
    if (telefone) {
      return {
        mensagens: [TEXTOS.confirmacaoWhatsapp],
        proximaEtapa: "whatsapp_enviado",
        tentativas: 0,
        telefone,
        enviarWhatsapp: true,
      };
    }
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

  // boas_vindas e pergunta_formacao: a pessoa pode já ter dito a situação.
  if (c.situacao === "formado" || c.situacao === "estudante") return pedirOuCapturarWhatsapp(c, ctx, c.situacao);
  if (c.situacao === "nenhum") {
    return { mensagens: [TEXTOS.escola], proximaEtapa: "escola_enviada", tentativas: 0 };
  }
  if (c.intencao === "recusa") {
    return { mensagens: [TEXTOS.recusa], proximaEtapa: "encerrada", tentativas: 0 };
  }

  if (etapa === "boas_vindas") {
    const pergunta = c.intencao === "aceita" ? TEXTOS.perguntaFormacaoAceite(nome) : TEXTOS.perguntaFormacao(nome);
    return { mensagens: comResposta(c, [pergunta]), proximaEtapa: "pergunta_formacao", tentativas: 0 };
  }

  // pergunta_formacao sem resposta clara: repergunta UMA vez; na segunda, manda a Escola
  // (é o que não custa nada errar: ninguém vai para o CRM sem saber a formação).
  if (ctx.tentativas < 1 || c.intencao === "pergunta") {
    return {
      mensagens: comResposta(c, [TEXTOS.reperguntarFormacao]),
      proximaEtapa: "pergunta_formacao",
      tentativas: ctx.tentativas + 1,
    };
  }
  return { mensagens: [TEXTOS.escola], proximaEtapa: "escola_enviada", tentativas: 0 };
}
