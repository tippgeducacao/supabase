// FICHA DA PÓS — o que o João precisa saber de UMA pós para criar conexão com o lead antes de
// propor a reunião (pedido do TI em 17/09/2026: "quero criar conexão com o lead de aula e
// escola para aí levar para o agendamento"; "quando a pessoa falar a área de atuação, retornar
// uma resposta melhor, específica para aquela área").
//
// Fonte: o banco SPIN escrito pelo comercial/marketing em src/data/spin/spin<Pós>.ts (público,
// tom, dores e perguntas por contexto). A ficha é um DESTILADO desse banco, não conteúdo novo:
// nada aqui pode prometer o que o banco não promete. Pós sem ficha = conexão genérica (o
// prompt funciona igual, só menos específico). Próximo passo natural: mover para tabela e,
// quando passar de uma página por pós, para busca vetorial.

export type FichaPos = {
  /** Como casar com cursos.nome (normalizado, sem acento, minúsculo). */
  chaves: string[];
  texto: string;
};

const FICHAS: FichaPos[] = [
  {
    chaves: ['cannabis medicinal veterinaria', 'cannabis medicinal', 'cannabis'],
    texto: [
      'PÚBLICO PRINCIPAL: médico veterinário de clínica de pequenos animais, muitas vezes recém-formado, em rotina de plantões, que quer agregar valor ao atendimento, sair dos plantões e cobrar como especialista.',
      'TOM OBRIGATÓRIO: cannabis é TERAPIA ADJUVANTE. Nunca prometa cura nem resultado clínico. A prescrição veterinária foi regulamentada pela RDC 936, de outubro de 2024: pode citar como respaldo, sem dar parecer jurídico.',
      'O QUE A PÓS ENTREGA (só isto; não invente módulo): base de fisiologia e farmacologia do sistema endocanabinoide (receptores CB1 e CB2, vias de administração); como prescrever e titular a dose ("start low, go slow"), toxicologia (o cão é mais sensível ao THC que o humano) e interações em paciente polimedicado; aplicações em neurologia e comportamento, dor crônica e osteoartrite, oncologia (cuidados paliativos) e dermatologia; regulamentação e respaldo jurídico (tem advogada no curso); registro e acompanhamento de casos; professora que é prescritora e traz os casos que conduziu.',
      'GANCHOS DE CONEXÃO PELA ÁREA QUE O LEAD DISSER (use UM, o que casar com a fala dele):',
      '- Clínica de pequenos, ainda não prescreve: os tutores já perguntam sobre cannabis; hoje ele responde com segurança ou acaba encaminhando pra outro profissional?',
      '- Atende dor crônica ou osteoartrite, paciente idoso: caso que não melhora só com anti-inflamatório, e o uso crônico preocupa pelo risco renal ou intestinal.',
      '- Neurologia: epilepsia que segue com crises mesmo com fenobarbital na dose máxima.',
      '- Comportamento: ansiedade de separação ou comportamento destrutivo em que o tutor já cogita abandonar o animal.',
      '- Dermatologia: dermatopatia crônica que sempre volta.',
      '- Oncologia: sensação de faltar "uma carta a mais" pra oferecer à família.',
      '- Plantonista ou contratado: rotina de plantão que pesa, teto da clínica de pequenos, consulta que não vale o que deveria sem uma especialidade que diferencie.',
      '- Já prescreve ou já estudou: o que mais trava hoje, a dose, a forma de prescrever ou a parte jurídica?',
      '- Outras espécies (equinos, exóticos, produção): a pós parte de pequenos animais; aplicar em outras espécies é tema de interesse, sem prometer protocolo pronto.',
      '- Não é veterinário: o tema interessa como conhecimento, mas a elegibilidade para a pós é decidida pela ferramenta, nunca por você.',
      'DORES MAIS COMUNS: insegurança para prescrever, receio do conselho e do jurídico, perder autoridade ao encaminhar o tutor, casos que travam no convencional, ficar para trás num tema novo e em alta.',
    ].join('\n'),
  },
];

const normalizar = (s: string) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/^(pos|mba|curso)\s*\|\s*/, '').replace(/\s+/g, ' ').trim();

/** Ficha da pós pelo nome do curso (cursos.nome). Texto vazio quando não há ficha. */
export function fichaDaPos(cursoNome: string | null | undefined): string {
  const alvo = normalizar(cursoNome ?? '');
  if (!alvo) return '';
  const ficha = FICHAS.find((f) => f.chaves.some((c) => alvo === c || alvo.includes(c)));
  return ficha ? ficha.texto : '';
}
