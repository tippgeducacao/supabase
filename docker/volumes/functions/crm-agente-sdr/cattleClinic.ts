// Fonte: Gustavo, caso Luis Henrique, checkout e print fornecidos em 09/11/2026.
// Exceção de produto explícita: não estende a elegibilidade às pós de bovinos.
export const CATTLE_CLINIC = {
  nome: 'Curso em Clínica Médica de Bovinos — Cattle Clinic',
  tipo: 'curso_livre',
  exige_graduacao: false,
  produtor: 'PRODUTIVA ASSESSORIA VETERINARIA LTDA',
  checkout: 'https://pay.hotmart.com/Y86165228M?off=hdxozr65&bid=1772038959898',
  preco_referencia: { a_vista: 1397, parcelas: 12, valor_parcela: 144.48, confirmado_em: '2026-11-09' },
} as const;

export function mencionaCattleClinic(texto: unknown): boolean {
  if (typeof texto !== 'string') return false;
  return /\bcattle[\s_-]*clinic\b/i.test(texto) || /https:\/\/pay\.hotmart\.com\/Y86165228M(?:[?#\s]|$)/i.test(texto);
}

export const INSTRUCAO_CATTLE_CLINIC = `[PRODUTO CONFIRMADO — CATTLE CLINIC]
O Curso em Clínica Médica de Bovinos — Cattle Clinic é um curso livre, NÃO uma pós-graduação. Qualquer pessoa pode se inscrever, inclusive sem formação superior. Não exigir graduação, conclusão ou compatibilidade de pós para informar preço, fornecer o link ou se inscrever nesse curso. Não desqualificar nem pausar o atendimento por falta de graduação quando o interesse é esse curso.
O checkout legítimo informado pela gestão é ${CATTLE_CLINIC.checkout}, do produtor ${CATTLE_CLINIC.produtor}. Não dizer que esse link não é nosso ou que não trabalhamos com Hotmart. Essa confirmação vale para esse produto/link; não valida outros links apenas por estarem na Hotmart.
Preço de referência confirmado em 09/11/2026: R$ 1.397,00 à vista ou 12 parcelas de R$ 144,48. Não dizer sem juros: a soma parcelada difere do preço à vista. O print indica tempo limitado; condições vigentes devem ser conferidas no checkout, sem inventar prazo, desconto ou atualização de preço.
Não confundir com a pós em Clínica Médica e Cirúrgica de Bovinos. Se o lead disser apenas clínica de bovinos e houver dúvida, pergunte se quer o curso Cattle Clinic ou a pós. A ausência no catálogo de pós NÃO significa que o Cattle Clinic não é oferecido. Não invente carga horária, certificado, conteúdo ou agenda. Matrícula no curso não autoriza exercício profissional regulamentado. Responda à pergunta do lead sobre o curso; não imponha reunião de pós como requisito de compra.
Se já negamos esse checkout, corrija a informação de forma breve e reconheça o equívoco. Esta regra específica prevalece sobre orientações genéricas de qualificação de pós, somente para Cattle Clinic.`;

export function consultarCattleClinic(alvo: unknown) {
  return mencionaCattleClinic(alvo) ? {
    status: 'curso_livre_confirmado', curso: CATTLE_CLINIC,
    instrucao: INSTRUCAO_CATTLE_CLINIC,
  } : null;
}
