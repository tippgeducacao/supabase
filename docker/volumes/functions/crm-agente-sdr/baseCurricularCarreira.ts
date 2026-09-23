// 23/09/2026: leitura de ped_pos_graduacoes + ped_curso_aulas_blueprint.
// Recorte revisado da grade cadastrada, não promessa de resultado nem oferta de uma turma.
// Só o recorte da pós escolhida entra no contexto; sem consulta extra/LLM por follow-up.
// Referência e limitações: docs/analises/2026-09-23-base-curricular-followup.md.
export type BaseCurricularCarreira = {
  curso_id: string;
  grade_id: string;
  grade_nome: string;
  conferido_em: string;
  temas: string[];
};

export const BASES_CURRICULARES_CARREIRA: Record<string, BaseCurricularCarreira> = {
  "credito_rural": {
    "curso_id": "227d8c6a-148d-4ba3-99d3-0d30ad938ee3",
    "grade_id": "b6c48316-f8dc-41e9-8053-9f094990eef9",
    "grade_nome": "Crédito Rural, Cooperativismo e Vendas",
    "conferido_em": "2026-09-23",
    "temas": [
      "ANÁLISE E CONCESSÃO DE CRÉDITO RURAL",
      "GESTÃO DE RISCOS E COMPLIANCE",
      "VENDAS E RELACIONAMENTO COM O COOPERADO"
    ]
  },
  "leite": {
    "curso_id": "e575e65e-37f0-434a-b663-ad7c05d1be03",
    "grade_id": "4ba40fd2-6232-4c21-bfb5-f8762e4fec8b",
    "grade_nome": "Gestão na Pecuária Leiteira",
    "conferido_em": "2026-09-23",
    "temas": [
      "GESTÃO TÉCNICA E PRODUTIVA DA FAZENDA LEITEIRA",
      "INDICADORES E PLANEJAMENTO - PECUÁRIA LEITEIRA",
      "GESTÃO FINANCEIRA E ESTRATÉGICA"
    ]
  },
  "cooperativas_credito": {
    "curso_id": "8bbe57e5-7073-4dd8-a0f8-f7cba9bd5393",
    "grade_id": "94d671d8-fa47-443a-9824-dd282716db45",
    "grade_nome": "Gestão de Cooperativas de Crédito",
    "conferido_em": "2026-09-23",
    "temas": [
      "GESTÃO E GOVERNANÇA COOPERATIVA",
      "GESTÃO DE RISCOS E COMPLIANCE",
      "VENDAS E RELACIONAMENTO COM O COOPERADO"
    ]
  },
  "pessoas_rural": {
    "curso_id": "ea551859-893f-4751-835f-4dfea42b9f8f",
    "grade_id": "2ec92564-2036-476a-8319-a7bc3f0aaad0",
    "grade_nome": "Gestão de Pessoas e Extensão Rural na Agroindústria",
    "conferido_em": "2026-09-23",
    "temas": [
      "EXTENSÃO RURAL E ANDRAGOGIA APLICADA",
      "COMUNICAÇÃO, FEEDBACK E GESTÃO DE CONFLITOS",
      "SUCESSÃO FAMILIAR NA GESTÃO RURAL"
    ]
  },
  "postura": {
    "curso_id": "ebe24d54-52b0-4fce-a30b-128dc820b676",
    "grade_id": "52be94df-06d7-4271-b6a7-d842f22eb2ed",
    "grade_nome": "MBA em Postura Comercial",
    "conferido_em": "2026-09-23",
    "temas": [
      "GESTÃO ZOOTÉCNICA E MANEJO DE POEDEIRAS",
      "NUTRIÇÃO DE POEDEIRAS",
      "QUALIDADE DE OVOS E SEGURANÇA DE ALIMENTOS"
    ]
  },
  "cannabis": {
    "curso_id": "5aedb8e2-2869-468d-a3fe-7732616c9380",
    "grade_id": "65a84565-5390-4f4a-a5ee-cf1e78dbdd03",
    "grade_nome": "Cannabis Medicinal na Medicina Veterinária",
    "conferido_em": "2026-09-23",
    "temas": [
      "Prescrição Veterinária, Titulação e Acompanhamento Clínico",
      "Aplicações Clínicas em Pequenos Animais II (Neurologia, Dor e Comportamento)",
      "Toxicologia – Aspectos Toxicológicos e de Segurança"
    ]
  },
  "clinica_bovinos": {
    "curso_id": "482013e3-7634-4b7d-8e5e-73416548ca5c",
    "grade_id": "4efc1a36-78d6-4626-ad87-e0c742abb631",
    "grade_nome": "Clínica Médica e Cirúrgica de Bovinos 2027",
    "conferido_em": "2026-09-23",
    "temas": [
      "ANATOMIA APLICADA, FARMACOLOGIA E DIAGNÓSTICO À CAMPO",
      "TÉCNICAS CIRÚRGICAS DOS DIFERENTES SISTEMAS DE BOVINOS",
      "MEDICINA DE PRODUÇÃO E VETERINÁRIA PREVENTIVA"
    ]
  },
  "bea_companhia": {
    "curso_id": "bcc716b5-6e56-49ba-bbcd-16d3bb5ae3e0",
    "grade_id": "29603a96-dccd-48c0-9b01-ab88f11d0a99",
    "grade_nome": "Comportamento e Bem-Estar de Animais de Companhia e Silvestres 2027",
    "conferido_em": "2026-09-23",
    "temas": [
      "AVALIAÇÃO COMPORTAMENTAL, COGNIÇÃO, DOR E ESTADOS EMOCIONAIS",
      "CLÍNICA COMPORTAMENTAL E ETOLOGIA APLICADA A CÃES",
      "CLÍNICA COMPORTAMENTAL E ETOLOGIA APLICADA A GATOS - MANEJO CAT FRIENDLY"
    ]
  },
  "bea_producao": {
    "curso_id": "4278c3b1-b8c6-4f63-8e95-94b00f2fb02d",
    "grade_id": "b01aaad4-18ab-4c5d-af1d-e284f32c12da",
    "grade_nome": "Comportamento e Bem-Estar de Animais de Produção 2027",
    "conferido_em": "2026-09-23",
    "temas": [
      "COMPORTAMENTO E BEM-ESTAR ANIMAL POR ESPÉCIE",
      "LEGISLAÇÃO APLICADA AO BEM-ESTAR EM SISTEMAS DE PRODUÇÃO ANIMAL",
      "TÓPICOS APLICADOS DE BEM-ESTAR E COMPORTAMENTO ANIMAL EM BOVINOS"
    ]
  },
  "fitoterapia": {
    "curso_id": "1f4a4297-b805-4c50-97a5-cf67905da29e",
    "grade_id": "fbf01603-c94f-4797-9d3e-45e9090774de",
    "grade_nome": "Fitoterapia Veterinária com Ênfase em Plantas Medicinais",
    "conferido_em": "2026-09-23",
    "temas": [
      "Prescrição Fitoterápica",
      "Fitoterapia Clínica Veterinária por Sistemas",
      "Toxicologia – Aspectos Toxicológicos e de Segurança"
    ]
  },
  "avicultura_gestao": {
    "curso_id": "0b99aad4-8322-4c88-bd64-e249820bbe2d",
    "grade_id": "4a2fdc3a-ca1e-452a-acf6-1ac0e6991be3",
    "grade_nome": "Gestão e Produção Avícola",
    "conferido_em": "2026-09-23",
    "temas": [
      "GESTÃO NA AVICULTURA",
      "MANEJO E AMBIÊNCIA",
      "INCUBATÓRIO"
    ]
  },
  "bovinos_nutricao": {
    "curso_id": "1ab710b6-aa2b-4cad-811a-2fba794fe7f8",
    "grade_id": "052ff647-1bab-4f46-884d-4ee479e807b8",
    "grade_nome": "Nutrição e Gestão de Bovinos",
    "conferido_em": "2026-09-23",
    "temas": [
      "FORMULAÇÃO E MANEJO NUTRICIONAL",
      "FORMULANDO DIETAS DE VACAS DE LEITE PARTE I",
      "GESTÃO ESTRATÉGICA DE FAZENDAS"
    ]
  },
  "suinos": {
    "curso_id": "91474e03-2ef0-4ada-8b2f-2a279c445a38",
    "grade_id": "f2dbe176-4284-4d17-a67c-8c6ecd129b1f",
    "grade_nome": "Produção de Suínos",
    "conferido_em": "2026-09-23",
    "temas": [
      "NUTRIÇÃO DE SUÍNOS",
      "REPRODUÇÃO DE SUÍNOS",
      "ANATOMIA DOS SUÍNOS E INDICADORES ZOOTÉCNICOS NA SUINOCULTURA"
    ]
  },
  "alimentos": {
    "curso_id": "09f26b62-0dd9-4234-a09d-0bb9da20f21a",
    "grade_id": "31e8514a-1577-4ef1-a324-e733e5307103",
    "grade_nome": "Qualidade e Segurança de Alimentos de Origem Animal",
    "conferido_em": "2026-09-23",
    "temas": [
      "ANÁLISE DE PERIGOS E PONTOS CRÍTICOS DE CONTROLE",
      "PROGRAMAS DE AUTOCONTROLE",
      "LEGISLAÇÃO SANITÁRIA E RESPONSABILIDADE TÉCNICA"
    ]
  },
  "bovinos_3em1": {
    "curso_id": "d391cef0-f4d6-4b1d-a32d-2238427fbe9c",
    "grade_id": "d07bfd25-9bd1-4b05-b099-fae468bfd226",
    "grade_nome": "Reprodução, Nutrição e Gestão de Bovinos",
    "conferido_em": "2026-09-23",
    "temas": [
      "FORMULAÇÃO E MANEJO NUTRICIONAL",
      "PRODUÇÃO E TRANSFERÊNCIA DE EMBRIÃO",
      "GESTÃO ESTRATÉGICA DE FAZENDAS"
    ]
  },
  "sanidade_avicola": {
    "curso_id": "3dfea82f-d1e1-4c6a-bcbb-5ed39d9042e8",
    "grade_id": "f0929989-bfb2-47f4-9624-c0471de4ef3e",
    "grade_nome": "Sanidade Avícola",
    "conferido_em": "2026-09-23",
    "temas": [
      "CONDUTAS DIAGNÓSTICAS DAS DOENÇAS DAS AVES",
      "DOENÇAS VIRAIS E BACTERIANAS DAS AVES",
      "SANIDADE AVÍCOLA"
    ]
  },
  "saude_unica": {
    "curso_id": "686a0105-5ce2-4811-98dc-cb50dd172f03",
    "grade_id": "5f95aed7-9033-4284-811e-ed76fe8f70a7",
    "grade_nome": "Saúde Única e Zoonoses",
    "conferido_em": "2026-09-23",
    "temas": [
      "EPIDEMIOLOGIA",
      "VIGILÂNCIA E CONTROLE DE ZOONOSES",
      "COMUNICAÇÃO EM SAÚDE"
    ]
  }
};

