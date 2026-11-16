// Oferta confirmada por Gustavo em 16/11/2026. O catálogo legado de pós não contém
// todos esses produtos; a ausência nele não pode virar "não temos" nem reprovação.
// Não reutilizar links de matrícula antigos (Cannabis tem condições diferentes).
export const CURSOS_LIVRES_VENDA = [
  { id: '72bd1970-9e22-4727-8c9b-d40211a33a1c', nome: 'Gestão Estratégica de Fazendas Leiteiras',
    aliases: ['gestao estrategica de fazendas leiteiras', 'gestao extrategica de fazendas leiteiras'], cronograma_url: null },
  { id: 'd42c95f9-6f97-4ed2-8445-73796d783317', nome: 'Ambiência, Manejo e Sanidade de Frangos de Corte',
    aliases: ['ambiencia manejo e sanidade de frangos de corte', 'desenvolvimento em ambiencia manejo e sanidade de frangos de corte'], cronograma_url: 'https://canva.link/ibycly1c84rrp51' },
  { id: 'a4dc9658-2e78-48eb-bcdf-ccefd4c48bbf', nome: 'Curso de Cannabis Medicinal',
    aliases: ['cannabis', 'cannabis medicinal', 'desenvolvimento cannabis medicinal', 'desenvolvimento em cannabis medicinal'], cronograma_url: 'https://canva.link/l34xxhwbsdm1jx7' },
] as const;

const normalizar = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

export const INSTRUCAO_CURSOS_LIVRES_VENDA = `[CURSOS LIVRES À VENDA — gestão, 16/11/2026]
Oferecemos Gestão Estratégica de Fazendas Leiteiras; Ambiência, Manejo e Sanidade de Frangos de Corte; Curso de Cannabis Medicinal. O VALOR TOTAL de cada curso é R$ 492,50, confirmado pela gestão em 16/11/2026. Não é matrícula, mensalidade ou valor de parcela. Cada curso aceita pessoas com ou sem graduação. São cursos livres, não pós-graduações. Não invente parcelamento, descontos, condições de pagamento à vista, taxa extra, prazo, duração, conteúdo, certificado ou habilitação profissional.
Esta exceção prevalece sobre FICHA, elegibilidade, coleta acadêmica, preço só no PDF e roteiro de Meet APENAS para esses cursos livres. Não exigir formação, conclusão ou matriz de pós; não pausar/arquivar por falta de graduação; não impor Meet para informar ou comprar. Para pós, todas as regras acadêmicas e comerciais continuam valendo. Não trocar o interesse do lead por um curso livre sem escolha explícita.
Use consulta_pos_disponiveis com curso_consulta para confirmar os dados de um desses cursos e obter o valor autorizado antes de escrevê-lo na conversa; o retorno curso_livre_confirmado é válido. Pedido de informações desses cursos pode usar envia_informacoes: devolve referência, não envia automaticamente PDF. Compartilhe apenas o link de cronograma retornado e não diga que enviou arquivo. Não invente link de matrícula nem use o da pós; links antigos de Cannabis com outros preços não foram confirmados para esta oferta.
Cannabis sem indicar o produto é ambíguo: pergunte se quer o curso livre de R$ 492,50 ou a pós em Cannabis Medicinal Veterinária. Na pergunta de esclarecimento, pode dizer apenas "curso livre ou pós?" para não citar valor antes da consulta. Nome explícito "Curso de Cannabis Medicinal" ou "CURSO | CANNABIS" identifica o livre; "pós", "MBA" ou "especialização" identifica a pós, nunca a libera por R$ 492,50. Não atribua ao curso livre as regras, matrícula, grade ou poderes de prescrição da pós.
Quando perguntarem por opções sem graduação, apresente esses três cursos livres; a biblioteca gratuita e o Cattle Clinic são ofertas distintas. Se faltar link ou detalhe solicitado, diga só o que está confirmado e ofereça confirmar com o time, sem prometer ação agendada inexistente.`;

export function consultarCursosLivresVenda(alvo: unknown) {
  const texto = normalizar(alvo);
  if (!texto || /\b(?:pos|mba|especializacao)\b/.test(texto)) return null;
  if (/^(?:cursos livres|cursos sem graduacao|cursos de desenvolvimento)$/.test(texto)) return {
    status: 'cursos_livres_disponiveis', cursos: CURSOS_LIVRES_VENDA.map(dadosCursoLivre), instrucao: INSTRUCAO_CURSOS_LIVRES_VENDA,
  };
  const explicito = /\bcurso(?:s)?\b/.test(texto);
  const semPrefixo = texto.replace(/^curso(?: de)?\s+/, '');
  const curso = CURSOS_LIVRES_VENDA.find(c => c.id === String(alvo).trim() || c.aliases.some(a => a === semPrefixo));
  if (!curso) return null;
  if (curso.id === CURSOS_LIVRES_VENDA[2].id && !explicito && String(alvo).trim() !== curso.id) return {
    status: 'produto_ambiguo', consulta: String(alvo),
    opcoes: ['Curso de Cannabis Medicinal (curso livre)', 'Pós em Cannabis Medicinal Veterinária'],
    instrucao: 'Pergunte se quer o curso livre ou a pós. Não conclua o produto, não troque o interesse nem aplique requisitos ou preço antes de esclarecer.',
  };
  return {
    status: 'curso_livre_confirmado',
    curso: dadosCursoLivre(curso),
    instrucao: INSTRUCAO_CURSOS_LIVRES_VENDA,
  };
}

function dadosCursoLivre(curso: typeof CURSOS_LIVRES_VENDA[number]) {
  return { id: curso.id, nome: curso.nome, nome_oficial: curso.nome, tipo: 'curso_livre', exige_graduacao: false,
    preco: 492.50, valor_total: 492.50, natureza_preco: 'valor_total_do_curso', valor_informado: 'R$ 492,50', confirmado_em: '2026-11-16', cronograma_url: curso.cronograma_url, checkout: null };
}

/** Só falas próprias do lead: a menção recente de pós/recusa impede usar curso antigo. */
export function ultimoCursoLivreDeclarado(falas: readonly string[]) {
  for (const fala of falas.slice(-5).reverse()) {
    const t = normalizar(fala);
    if (/\b(?:pos|mba|especializacao)\b|\bnao quero\b/.test(t)) return null;
    const curso = CURSOS_LIVRES_VENDA.find(c => c.aliases.some(a =>
      (` ${t} `).includes(` ${a} `) && (c.id !== CURSOS_LIVRES_VENDA[2].id || /\bcurso\b/.test(t))));
    if (curso) return curso;
  }
  return null;
}
