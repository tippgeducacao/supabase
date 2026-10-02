// Descrições enxutas das ferramentas da IA de aula no n8n v9 (02/10/2026).
// A régua: prompt = o fluxo; descrição = o que a ferramenta faz e quando chamar; código = a trava.
// Fonte: revisão das 11 ferramentas (C:\tmp\framework-sdr\revisao-ferramentas-aula.md). Só a rota
// `tools` do v9 (rotasV9.ts) aplica isto, e só para agente_aula: a produção (tools-luna.ts e
// canalResposta.ts) não muda. Troca SÓ textos: nome, tipo, enum, required e campos ficam intactos.
import { SINAIS_DO_PERFIL } from './carreiraPos.ts';

export type DescricaoAulaV9 = { description: string; campos?: Record<string, string> };

export const DESCRICOES_AULA_V9: Record<string, DescricaoAulaV9> = {
  consulta_disponibilidade: {
    description: [
      'Horários livres (30 min) da conversa individual com o monitor sobre a pós. Não trata da aula: horário, presença ou "confirmo" da aula não são aceite desta conversa.',
      'Quando chamar: o lead aceitou a conversa ou propôs dia e hora para ela.',
      'Retorno: só os horários listados existem. O nome do monitor é interno. Fora dos horários de atendimento do contexto temporal (domingo, sábado à tarde, madrugada) não há horário: consulte o próximo período válido e apresente como alternativa.',
      'Consultar não reserva: a reunião só existe depois que o agendamento é criado.',
    ].join('\n'),
    campos: {
      data_desejada: 'YYYY-MM-DD, pela tabela de dias do contexto temporal; hoje ou até 2 dias à frente.',
      curso_escolhido: 'Nome da pós. Na aula, é a pós da aula, não o curso do cadastro, salvo se o lead escolheu outra.',
      periodo_desejado: 'manhã (até 12h), tarde (12h às 19h), noite (após 19h) ou qualquer (sem preferência).',
      horario_inicio_desejado: 'Opcional. HH:mm da hora que o lead propôs; prevalece sobre o período. Se ela voltar no retorno, está livre.',
    },
  },
  consulta_objecoes: {
    description: [
      'Busca na base comercial o argumento para uma objeção do lead e os fatos sobre a PPG (sede, número de alunos, reconhecimento: esses só vêm daqui).',
      'Não é para preço, conteúdo ou duração (envia_informacoes) nem para existência ou modalidade de pós (consulta_pos_disponiveis).',
      'Retorno: resposta_objecao é a referência escrita pelo comercial, não texto para copiar; pode trazer mais de um fato, use só o que responde ao que ele disse. CONFIANCA_BAIXA ou INDISPONIVEL = não há argumento confirmado.',
    ].join('\n'),
    campos: {
      tipo_objecao: 'Filtra a busca: rótulo errado traz resposta de outro assunto. objecao_tempo = sem tempo pra cursar; objecao_canal = prefere mensagem a reunião; pergunta_preco = pergunta o valor; objecao_financeira = diz que não consegue pagar ("não tenho condições", "tô desempregado"); objecao_adiamento = vou pensar; objecao_desconfianca = golpe, nunca ouvi falar; objecao_duvida = vale a pena?; pergunta_condicao = desconto, bolsa; objecao_terceiro = ver com esposa ou sócio; pergunta_modalidade = online ou presencial (com curso_consulta); pergunta_instituicao = quem é a PPG, sede, reconhecimento.',
      mensagem_lead: 'A fala do lead, exata e completa, com negações. É o texto da busca.',
      curso_consulta: 'Pós da dúvida de modalidade. Não muda o interesse.',
    },
  },
  envia_informacoes: {
    description: [
      'Envia material da pós ao WhatsApp do lead ou devolve o preço.',
      'Retorno: valor = preço integral, sem a condição (essa é com o monitor); informe só o que voltou. PRECISA_COLETAR = nada enviado: falta o dado indicado em falta. SEM_GRADUACAO = não enviado. Solicitação aceita não é entrega, e entrega não é leitura.',
      'Reenvie só se ele pedir de novo ou disser que não recebeu ou não abre.',
    ].join('\n'),
    campos: {
      conteudo: 'cronograma = PDF (grade, conteúdo, datas, duração); valor = preço integral; cronograma_e_valor = os dois; portfolio = PDF com todas as pós e MBAs, só em aula sem pós vinculada.',
      curso_escolhido: 'Nome da pós (na aula, a da aula, salvo escolha de outra). Com portfolio, "portfolio".',
    },
  },
  temporizador_proxima_turma: {
    description: [
      'Agenda o recontato para a data da próxima turma da pós, tira o lead de todos os disparos até lá e pausa a IA.',
      'Quando chamar: o lead aceitou ser chamado quando abrir a próxima turma. Estudante que ainda cursa não entra aqui: o caminho dele é agendar_retorno tipo formatura.',
    ].join('\n'),
    campos: {
      curso: 'Pós da conversa (na aula, a da aula). Vazio usa o curso do cadastro, que pode ser outro.',
      motivo: 'O pedido do lead em poucas palavras (ex.: "pediu pra ser chamado na próxima turma").',
    },
  },
  consulta_pos_disponiveis: {
    description: [
      'Catálogo de pós ativas e modalidade de cada uma. Sem parâmetros, lista tudo. A pós da aula já está no catálogo.',
      'Use para pós que o lead citou e ainda não foi validada, se temos uma pós, ou qual é online ou semipresencial.',
      'Retorno: só curso_confirmado ou interesse_atualizado confirmam a pós. Nome parecido não é a mesma pós (pequenos animais não é bovinos). Não encontrada = não temos. erro_atualizar_interesse = troca não registrada.',
    ].join('\n'),
    campos: {
      trocar_para: 'Pós que o lead escolheu explicitamente. Registra como novo interesse.',
      curso_consulta: 'Nome dito pelo lead, só para conferir existência ou modalidade, sem mudar o interesse.',
    },
  },
  pausa_ia: {
    description: [
      'Para a IA neste lead. Dizer ao lead que alguém vai assumir não pausa nada: só esta chamada pausa.',
      'Tipo pausa quando: pediu uma pessoa ou ligação; já é aluno da PPG; pagou a matrícula; pediu cancelar ou remarcar reunião; já teve reunião desta pós; formação incompatível sem alternativa.',
      'Retorno bloqueado (SEM_EVIDENCIA_SEM_GRADUACAO) = nada feito: o histórico não tem a declaração dele de não ter graduação.',
    ].join('\n'),
    campos: {
      tipo: 'pausa = alguém do time assume; o lead continua recebendo disparos. nao_perturbe = opt-out: arquiva, resolve as conversas e tira de todos os disparos, campanhas e follow-ups. sem_graduacao = mesmo efeito, para quem declarou não ter graduação nem estar cursando (quem ainda cursa não é sem_graduacao).',
      motivo: 'O motivo em poucas palavras, pelo que o lead disse (ex.: "Lead pediu atendimento humano").',
    },
  },
  atualizar_dados_lead: {
    description: [
      'Registra o que o lead disse sobre nome, graduação e atuação. Chame quando ele disser; não puxe assunto para preencher. Silencioso: o lead não vê. Dado não dito fica vazio.',
      'A conclusão e a atuação registradas aqui liberam o envio do cronograma e a verificação de compatibilidade.',
    ].join('\n'),
    campos: {
      nome: 'Como ele informou, sem saudação.',
      formacao: 'Nome do curso de graduação (ex.: Medicina Veterinária). "Formado" ou "estudante" não é curso.',
      qual_pos: 'Pós que ele já tem, se disse.',
      possui_pos: 'Se já tem pós-graduação, quando ele disser.',
      area_atuacao: 'Onde atua hoje, nas palavras dele (ex.: "plantão em clínica", "não trabalha na área").',
      atua_na_area: 'sim = atua na área da pós; nao = não atua ou atua em outra.',
      tempo_formacao: 'Conclusão da graduação nas palavras dele (ex.: "formado há 2 anos", "cursando, conclui em 12/2026").',
      graduacao_concluida: 'sim = formado; cursando = ainda na faculdade (mande tempo_formacao); nao = declarou não ter graduação nem cursar.',
    },
  },
  verificar_compatibilidade_curso: {
    description: [
      'Verifica se a graduação do lead permite cursar a pós e registra a decisão. Sem APROVADO para esta pós, o agendamento é recusado.',
      'Quando chamar: com o nome da graduação e a conclusão já ditos pelo lead e registrados em atualizar_dados_lead; de novo se a pós mudar. É interna: o resultado não se comenta com o lead.',
      'Retorno: APROVADO = pode seguir para a conversa com o monitor desta pós. pode_cursar=false com curso_alternativo = há outra pós que ele pode fazer. pode_cursar=false sem alternativa = incompatível. REPROVADO_PRAZO = ainda cursa e conclui depois da data-limite: sem reunião agora, o caminho é agendar_retorno tipo formatura. PRECISA_DATA_CONCLUSAO = falta o mês e o ano da conclusão. CONFIRMAR_CONCLUSAO = falta ele confirmar que concluiu: registre graduacao_concluida e verifique de novo. FALHA_TECNICA = não avaliou; não é aprovação.',
    ].join('\n'),
    campos: {
      area_trabalho: 'Opcional. Atuação já informada.',
      curso_interesse: 'Pós a verificar: na aula, a pós da aula (não o curso do cadastro); a alternativa só depois que ele aceitar.',
      formacao_academica: 'Nome do curso de graduação (ex.: Medicina Veterinária, Zootecnia). "Estudante", "formado" ou "cursando" não servem.',
      conclusao_graduacao: 'Quem ainda cursa: MM/AAAA, só se ele disse ano ou prazo ("2027.1", "faltam 6 meses"). Semestre ou período não é data.',
      contexto_qualificacao: 'normal = graduação concluída, dita por ele ou pelo título dele ("sou veterinária", zootecnista); nome do curso ou trabalho na área sozinhos não confirmam. estudante_apto / estudante_fora_do_prazo = ainda cursa e conclui até / depois da DATA-LIMITE do contexto temporal (o sistema relê a bruta e decide). correcao_sem_formacao = cadastro marcado Sem Formação e ele disse que é formado, com o curso.',
      objetivos_profissionais: 'Opcional. Objetivo de carreira que ele disse.',
      conclusao_graduacao_bruta: 'Obrigatório para quem ainda cursa: a resposta dele sobre quando conclui, literal. O sistema decide o prazo por ela.',
    },
  },
  agendar_retorno: {
    description: [
      'Agenda um recontato futuro e tira o lead dos disparos até a data. Não pausa a IA e não cria reunião.',
      'analise: o lead pediu tempo para ler ou pensar e disse quando pode ser chamado (até 7 dias).',
      'formatura: estudante com REPROVADO_PRAZO em verificar_compatibilidade_curso; use o que ele já disse sobre a conclusão.',
      'Retorno: vale a data devolvida (o sistema limita a 7 dias ou 12 meses). "Não consegui agendar" = nada agendado.',
    ].join('\n'),
    campos: {
      dias: 'Só em analise: em quantos dias ele pediu (1 a 7; amanhã = 1, semana que vem = 7).',
      tipo: 'analise = pediu tempo (dias); formatura = ainda cursa e conclui depois da data-limite (meses).',
      meses: 'Só em formatura: meses até a conclusão, pelo contexto temporal (12/2028 visto de 10/2026 = 26). O sistema limita a 12.',
      motivo: 'O que o lead disse, curto (ex.: "conclui a graduação em 2028").',
    },
  },
  busca_carreira: {
    description: 'Devolve, para a pós da aula e o perfil do lead, a pergunta de dor, a ponte do convite e as objeções desse perfil.',
    campos: {
      perfil: 'O perfil que combina com o que ele disse. Quem já faz o que a pós ensina é ja_atua_no_tema, mesmo tendo clínica ou emprego. '
        + Object.entries(SINAIS_DO_PERFIL).map(([p, sinal]) => `${p}: ${sinal}`).join('; ') + '.',
    },
  },
  responder_ao_cliente: {
    description: 'A única forma de falar com o lead: só o que vai em mensagem chega a ele. Mensagem vazia = silêncio.',
    campos: {
      mensagem: 'A fala ao lead, sem análise interna; ou "" para não responder.',
    },
  },
};

/** Cópias das ferramentas com as descrições da aula v9. Muda só `description` (da ferramenta e dos
 *  campos que já existem); ferramenta fora da lista e campo sem texto novo passam como estão. */
export function comDescricoesDaAulaV9(tools: any[]): any[] {
  return tools.map((original) => {
    const tool = structuredClone(original);
    const novo = DESCRICOES_AULA_V9[tool?.name];
    if (!novo) return tool;
    tool.description = novo.description;
    const props = tool.input_schema?.properties;
    if (props && novo.campos) {
      for (const [campo, texto] of Object.entries(novo.campos)) {
        if (props[campo] && typeof props[campo] === 'object') props[campo].description = texto;
      }
    }
    return tool;
  });
}
