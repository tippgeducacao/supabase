// 23/09/2026 — direção de Gustavo: conversar sobre a pessoa, seus projetos e ganhos.
// Temas do catálogo ativo, da grade pedagógica e de src/data/spin; perguntas são possibilidades, nunca
// diagnóstico do lead, promessa de renda, grade curricular ou autorização profissional.
// Uma pergunta por curso só volta depois de reset explícito da jornada do teste.
export type EixoCarreira = 'objetivo' | 'futuro' | 'valorizacao' | 'ganhos' | 'mercado';
export type PerfilCarreira = {
  id: string;
  nomes: string[];
  area: string;
  perguntas: [string, string, string];
  ganhos?: string;
  mercado?: string;
};
export type PerguntaCarreira = { id: string; eixo: EixoCarreira; exemplo: string };
export type RegistroPerguntaCarreira = { escopo: string; pergunta_id: string; enviado_em: string };

export const PERFIS_CARREIRA: PerfilCarreira[] = [
  { id: 'bovinos_3em1', nomes: ['reproducao nutricao e gestao de bovinos 3em1', 'reproducao nutricao e gestao de bovinos'], area: 'reprodução, nutrição e gestão de bovinos', perguntas: [
    'entre reprodução, nutrição e gestão de bovinos, em qual área você gostaria de construir sua carreira?',
    'daqui a algum tempo, você se imagina mais atendendo fazendas como consultor ou fazendo parte da equipe de uma propriedade?',
    'pensando no trabalho com bovinos, que mudança faria você sentir que seu conhecimento está sendo mais valorizado?',
  ] },
  { id: 'bovinos_nutricao', nomes: ['nutricao e gestao de bovinos'], area: 'nutrição e gestão de bovinos', perguntas: [
    'com nutrição de bovinos, você quer desenvolver um trabalho próprio de consultoria ou crescer dentro de uma empresa?',
    'como você imagina sua rotina profissional se passar a acompanhar a nutrição das fazendas de forma mais próxima?',
    'na consultoria nutricional, o que teria mais valor pra você: ampliar os atendimentos ou ser mais reconhecido pelo trabalho?',
  ] },
  { id: 'cannabis', nomes: ['cannabis medicinal veterinaria', 'cannabis medicinal na medicina veterinaria'], area: 'cannabis medicinal veterinária', perguntas: [
    'o que você gostaria de aprofundar sobre prescrição de cannabis para a sua atuação na clínica?',
    'o que ter mais segurança para avaliar a prescrição de cannabis mudaria nos seus atendimentos?',
    'como você gostaria que esse conhecimento sobre cannabis fosse reconhecido pelos tutores na sua clínica?',
  ],
    ganhos: 'pensando no acompanhamento dos pacientes com cannabis, que diferença você gostaria que esse trabalho fizesse na sua carreira?',
    mercado: 'os tutores que você atende já procuram orientação sobre o uso de cannabis para os animais?',
  },
  { id: 'clinica_bovinos', nomes: ['clinica medica e cirurgica de bovinos'], area: 'clínica e cirurgia de bovinos', perguntas: [
    'na clínica de bovinos, qual tipo de atendimento você gostaria de fazer com mais segurança?',
    'olhando pra frente, como você imagina seu trabalho com clínica e cirurgia nas fazendas?',
    'no atendimento de bovinos, o que você gostaria que os produtores reconhecessem mais no seu trabalho?',
  ] },
  { id: 'bea_companhia', nomes: ['comportamento e bem estar de animais de companhia e silvestres'], area: 'comportamento de animais de companhia e silvestres', perguntas: [
    'qual parte do trabalho com comportamento animal mais combina com a carreira que você quer construir?',
    'você se imagina com atendimentos voltados ao comportamento ou integrando isso à sua rotina clínica?',
    'o que faria você sentir que seu trabalho com comportamento animal está sendo mais valorizado?',
  ] },
  { id: 'bea_producao', nomes: ['comportamento e bem estar de animais de producao'], area: 'bem-estar de animais de produção', perguntas: [
    'dentro do bem-estar animal, você quer estar mais perto do manejo nas propriedades ou de projetos de avaliação?',
    'como você gostaria de participar das decisões sobre bem-estar nas equipes com que vier a trabalhar?',
    'que tipo de responsabilidade em bem-estar animal você gostaria de assumir pra crescer profissionalmente?',
  ] },
  { id: 'fitoterapia', nomes: ['fitoterapia veterinaria com enfase em plantas medicinais'], area: 'fitoterapia veterinária', perguntas: [
    'o que você gostaria de desenvolver na sua atuação estudando fitoterapia veterinária?',
    'como você imagina integrar o estudo das plantas medicinais à carreira que quer construir?',
    'pensando no atendimento veterinário, qual mudança faria você sentir que seu trabalho está sendo mais reconhecido?',
  ] },
  { id: 'avicultura_gestao', nomes: ['gestao e producao avicola'], area: 'gestão e produção avícola', perguntas: [
    'na avicultura, seu objetivo é aprofundar a atuação técnica ou caminhar pra gestão de equipes?',
    'qual responsabilidade você gostaria de assumir no futuro dentro da produção avícola?',
    'que mudança na sua atuação na avicultura representaria crescimento profissional pra você?',
  ] },
  { id: 'suinos', nomes: ['producao de suinos'], area: 'produção de suínos', perguntas: [
    'na produção de suínos, qual etapa você gostaria de ter como foco da sua carreira?',
    'como você se imagina trabalhando na suinocultura daqui a alguns anos?',
    'qual próximo passo na suinocultura faria seu trabalho ser mais valorizado, na sua visão?',
  ] },
  { id: 'alimentos', nomes: ['qualidade e seguranca de alimentos de origem animal'], area: 'qualidade e segurança de alimentos de origem animal', perguntas: [
    'você se vê mais na rotina da indústria, na inspeção ou em consultoria de qualidade de alimentos?',
    'qual papel você gostaria de assumir no futuro na área de segurança dos alimentos?',
    'que tipo de reconhecimento você busca ao construir uma carreira em qualidade de alimentos?',
  ] },
  { id: 'sanidade_avicola', nomes: ['sanidade avicola'], area: 'sanidade avícola', perguntas: [
    'o que você gostaria de desenvolver na sua atuação com sanidade avícola?',
    'no futuro, você se imagina mais no acompanhamento de campo ou coordenando programas de sanidade?',
    'que responsabilidade na saúde dos plantéis você gostaria de assumir como próximo passo na carreira?',
  ] },
  { id: 'saude_unica', nomes: ['saude unica e zoonoses'], area: 'saúde única e zoonoses', perguntas: [
    'na saúde única, você se interessa mais pela vigilância, pelos projetos de prevenção ou pela pesquisa?',
    'em que tipo de projeto de prevenção de zoonoses você gostaria de estar trabalhando no futuro?',
    'o que representaria uma evolução importante pra você trabalhando com saúde única?',
  ] },
  { id: 'credito_rural', nomes: ['credito rural cooperativismo e vendas'], area: 'crédito rural, cooperativismo e vendas', perguntas: [
    'no crédito rural, você quer crescer mais no relacionamento com o produtor ou na estruturação de propostas?',
    'como você imagina seu papel no atendimento aos produtores daqui a alguns anos?',
    'no trabalho com crédito rural, que mudança nos seus resultados você gostaria que fosse mais reconhecida?',
  ] },
  { id: 'leite', nomes: ['gestao da pecuaria leitera', 'gestao da pecuaria leiteira'], area: 'gestão da pecuária leiteira', perguntas: [
    'na pecuária leiteira, seu projeto é gerir uma propriedade ou prestar consultoria pra várias fazendas?',
    'como você gostaria que fosse sua rotina tomando decisões no negócio do leite?',
    'que tipo de reconhecimento você busca ao assumir mais responsabilidade na gestão leiteira?',
  ] },
  { id: 'cooperativas_credito', nomes: ['gestao de cooperativas de credito'], area: 'gestão de cooperativas de crédito', perguntas: [
    'qual próximo passo você quer dar na sua carreira dentro do cooperativismo de crédito?',
    'como você se imagina participando das decisões de uma cooperativa no futuro?',
    'o que você gostaria que mudasse na valorização do seu trabalho dentro da cooperativa?',
  ] },
  { id: 'pessoas_rural', nomes: ['gestao de pessoas e extensao rural'], area: 'gestão de pessoas e extensão rural', perguntas: [
    'você quer desenvolver mais a liderança de equipes rurais ou a conexão do trabalho técnico com os produtores?',
    'que tipo de líder você gostaria de se tornar no trabalho com equipes do campo?',
    'que avanço na sua carreira com pessoas e extensão rural teria mais significado pra você?',
  ] },
  { id: 'rh_cooperativas', nomes: ['gestao de pessoas e rh em cooperativas de credito'], area: 'gestão de pessoas em cooperativas de crédito', perguntas: [
    'em gestão de pessoas na cooperativa, qual responsabilidade você gostaria de assumir?',
    'como você imagina sua participação nas decisões de pessoas e cultura no futuro?',
    'o que faria você sentir que seu trabalho com as equipes da cooperativa está sendo mais valorizado?',
  ] },
  { id: 'lideranca_ia', nomes: ['lideranca e inteligencia artificial no agronegocio'], area: 'liderança e inteligência artificial no agronegócio', perguntas: [
    'em que parte do seu trabalho no agro você gostaria de unir liderança e inteligência artificial?',
    'que tipo de projeto com tecnologia você gostaria de liderar no agronegócio?',
    'como você gostaria que sua contribuição com tecnologia e liderança fosse reconhecida na carreira?',
  ] },
  { id: 'postura', nomes: ['postura comercial'], area: 'avicultura de postura', perguntas: [
    'na produção de ovos, você quer aprofundar o trabalho técnico ou seguir pra gestão da operação?',
    'qual papel você gostaria de assumir no futuro dentro de uma operação de postura comercial?',
    'que mudança na sua atuação na produção de ovos representaria valorização profissional pra você?',
  ] },
];

export const FONTE_QUALIFICACAO = {
  nome: 'Catho', pesquisa: '2019', publicado_em: '2022-07-04',
  url: 'https://paraempresas.catho.com.br/5-cursos-de-pos-graduacao-para-quem-estudou-gestao-de-rh/',
  recorte: 'profissionais em cargos de coordenação; comparação por qualificação',
  limite: 'Não é média de toda a população, previsão individual, dado específico de veterinária/agro nem prova de que esta pós causa aumento de renda.',
};

export function normalizarCursoCarreira(nome: string): string {
  return nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/^(?:pos(?:[- ]graduacao)?|mba)(?:\s*\|\s*|\s+)/, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function perfilCarreira(nome: string): PerfilCarreira | null {
  const alvo = normalizarCursoCarreira(nome);
  return PERFIS_CARREIRA.find(p => p.nomes.includes(alvo)) ?? null;
}

export function catalogoPerguntasCarreira(nome: string): { escopo: string; area: string | null; perguntas: PerguntaCarreira[] } {
  const perfil = perfilCarreira(nome);
  const escopo = perfil?.id ?? `generico:${normalizarCursoCarreira(nome) || 'sem-curso'}`;
  const exemplos = perfil?.perguntas ?? [
    'qual é o próximo passo que você gostaria de dar na sua carreira?',
    'que tipo de trabalho você gostaria de estar fazendo daqui a alguns anos?',
    'o que faria você sentir que seu trabalho está sendo mais valorizado?',
  ];
  const eixos: EixoCarreira[] = ['objetivo', 'futuro', 'valorizacao'];
  const perguntas = exemplos.map((exemplo, i) => ({ id: `${escopo}:${eixos[i]}`, eixo: eixos[i], exemplo }));
  // Renda é aspiração, não exploração de aperto financeiro. Só usar se fizer sentido
  // na conversa; a pesquisa não obriga o lead a falar de salário nem autoriza números.
  perguntas.push({ id: `${escopo}:ganhos`, eixo: 'ganhos', exemplo: perfil?.ganhos ?? 'pensando no caminho profissional que você quer seguir, o que gostaria de mudar nos seus ganhos?' });
  if (perfil) perguntas.push({ id: `${escopo}:mercado`, eixo: 'mercado', exemplo: perfil.mercado ?? 'você já chegou a pesquisar como a qualificação é valorizada nos cargos que gostaria de ocupar?' });
  return { escopo, area: perfil?.area ?? null, perguntas };
}
