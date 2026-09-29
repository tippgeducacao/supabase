// FERRAMENTAS DA LUNA (canário) — o `tools` que a Luna recebe em cada chamada, por persona.
//
// 29/09/2026: saiu da tabela lista_tools_openai (que a Luna deixou de ler) para o código, para ter
// histórico no git, teste antes de valer e edição pelo Markdown, como o prompts-luna.ts. Nasceu
// idêntico às 48 linhas da tabela (conferido persona a persona). O Claude NÃO lê isto (usa
// lista_tools_claude + descricoesTools.ts).
//
// 29/09/2026: cada persona tem a SUA cópia de cada ferramenta (apelido `<nome>__<persona>`): quando
// chamar cada uma muda de agente para agente, e editar a da aula não pode mexer na da abertura.
//
// ⚠️ ARQUIVO GERADO: editar pelo Markdown —
//   npx vite-node scripts/sdr/montar-prompt-md.ts   → docs/prompts-montados/luna-3-ferramentas-<persona>.md
//   npx vite-node scripts/sdr/aplicar-prompt-md.ts  → grava aqui (só textos de descrição)
// Nome, tipo, valores permitidos e obrigatórios dos parâmetros são o contrato com o código
// (tools.ts): mudam só com mudança de código junto, e tools-luna.test.ts trava a forma.

/** Uma ferramenta no formato nativo da Responses API. */
export type ToolLuna = {
  type: 'function'; name: string; description: string;
  parameters: { type: string; properties?: Record<string, Record<string, unknown>>; required?: string[]; [k: string]: unknown };
  strict?: boolean;
  [k: string]: unknown;
};

/** Uma versão por persona. A chave é só um apelido (`<nome>__<persona>`); o nome que a IA vê é `name`. */
export const FERRAMENTAS: Record<string, ToolLuna> = {
  "envia_informacoes__abertura": {
    "name": "envia_informacoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "conteudo"
      ],
      "properties": {
        "conteudo": {
          "enum": [
            "cronograma",
            "valor",
            "cronograma_e_valor"
          ],
          "type": "string",
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' (valor integral retornado pra você informar na conversa), 'cronograma_e_valor' (ambos)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia informações da pós de interesse ao lead. Três modos: 'cronograma' solicita o envio do PDF do cronograma detalhado no WhatsApp do lead; 'valor' retorna o valor integral (sem desconto) para VOCÊ informar com suas palavras; 'cronograma_e_valor' faz os dois. Use 'cronograma' quando o lead pedir cronograma, grade, conteúdo programático, ementa, datas das aulas ou 'me manda mais informações'. Use 'valor' sempre que o lead perguntar preço, valor ou investimento. Use 'cronograma_e_valor' quando o lead pedir explicitamente as duas coisas. Quando o lead INSISTIR que só pode resolver pelo WhatsApp (segunda objeção de canal), chame esta função com 'cronograma' E a consulta_objecoes NA MESMA resposta: o cronograma atende o pedido dele e a quebra de objeção reforça que a condição do primeiro lote promocional é apresentada na reunião com o monitor. Se a pendência for recebimento ou acesso ao material, resolva essa dificuldade antes de retomar a objeção ou o agendamento.\n\nConfira o curso e o histórico antes de enviar. Não repita o mesmo material sem novo pedido ou falha. Se o lead pedir novamente, disser que não recebeu, não encontrou ou não consegue abrir, faça uma nova tentativa com 'cronograma', mesmo que exista um tool_result antigo ou registro de envio humano. O relato do lead permite o reenvio; nunca insista que ele recebeu, que o sistema confirma a entrega ou que basta procurar acima na conversa. Depois da tentativa, aguarde a confirmação de acesso antes de perguntar sobre leitura, opinião ou agendamento. Se ela falhar ou o arquivo estiver indisponível, explique a dificuldade e encaminhe para ajuda humana pela ferramenta apropriada, sem repetir envios em loop.\n\nResponda conforme o status atual retornado pela função. Solicitação aceita não comprova entrega; entrega registrada não comprova que o lead abriu o arquivo. Se o retorno indicar falha, reconheça que o material não foi enviado e não prometa envio posterior sem providenciar uma ação efetiva. Só confirme entrega quando houver confirmação de entrega; nunca transforme um registro antigo de envio em prova contra o relato do lead. NUNCA invente valor, parcela ou desconto que não esteja no retorno; a condição especial em cima do valor integral é apresentada apenas no Meet.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome.\nFICHA DO ATENDIMENTO: antes de chamar para cronograma, leia o bloco [FICHA DO ATENDIMENTO] no fim da última mensagem. Se houver FALTA COLETAR, faça a pergunta indicada e só chame depois da resposta (ou se ele insistir sem responder). O sistema recusa o envio enquanto faltar dado e devolve PRECISA_COLETAR com o que perguntar."
  },
  "temporizador_proxima_turma__abertura": {
    "name": "temporizador_proxima_turma",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo"
      ],
      "properties": {
        "curso": {
          "type": "string",
          "description": "Curso de interesse do lead, se você souber. Vazio = usa o curso já conhecido da conversa."
        },
        "motivo": {
          "type": "string",
          "description": "Frase curta com o que o lead pediu. Ex.: 'Lead pediu pra ser chamado quando abrir a próxima turma'."
        }
      }
    },
    "description": "Agendar o recontato do lead para a PRÓXIMA TURMA do curso dele. Use SEMPRE que o lead disser que prefere ser chamado quando abrir a próxima turma, \"me chama mais pra frente\", \"agora não posso, me procura depois\" — em vez de pausa_ia. A função busca a data real da próxima turma no sistema, agenda o temporizador de recontato (o lead fica FORA de todos os disparos em massa até lá) e a IA é pausada em seguida. Chame UMA vez só, na mesma resposta da sua mensagem de despedida. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "consulta_pos_disponiveis__abertura": {
    "name": "consulta_pos_disponiveis",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "trocar_para": {
          "type": "string",
          "description": "Pós explicitamente escolhida pelo lead. Valida e registra; não use só porque ele perguntou se existe ou como funciona."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome exato dito pelo lead para verificar existência/modalidade. Somente consulta, sem mudar o interesse."
        }
      },
      "additionalProperties": false
    },
    "description": "Fonte obrigatória do catálogo de pós ATIVAS e modalidades por curso. Chame quando o lead mencionar uma pós ainda não validada, inclusive na PRIMEIRA escolha de interesse, ou perguntar se temos uma pós, quais existem, qual é online ou semipresencial. Antes de confirmar que oferecemos, falar em matrícula/condição ou encaminhar para agenda, valide o nome aqui. Repetir o nome dito pelo lead NÃO comprova existência: clínica de pequenos animais não equivale a clínica de bovinos. Use curso_consulta para consultar sem alterar interesse, inclusive dúvidas sobre outra pós. Use trocar_para SOMENTE quando o lead tiver escolhido explicitamente aquela pós. Sem parâmetros lista catálogo e modalidades. Não passe os dois campos juntos. Respeite status: só curso_confirmado/interesse_atualizado autoriza adotar o curso; semelhança textual exige esclarecimento, nunca troca automática. Se não encontrado, diga que não temos essa pós e ofereça apenas alternativas reais pertinentes, aguardando escolha. Não invente modalidade, conteúdo, cidade, frequência ou carga horária. O retorno específico prevalece sobre frases genéricas de objeção ou conhecimento anterior. Depois de responder, siga qualificando e agendando conforme o interesse validado."
  },
  "verificar_compatibilidade_curso__abertura": {
    "name": "verificar_compatibilidade_curso",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "formacao_academica",
        "curso_interesse"
      ],
      "properties": {
        "area_trabalho": {
          "type": "string",
          "description": "OPCIONAL. Área de atuação profissional do lead. Informar quando já foi coletada no fluxo."
        },
        "curso_interesse": {
          "type": "string",
          "description": "Nome EXATO da pós que o lead quer AGORA. Use o curso_alternativo se ele aceitou a troca. A decisão será registrada para esse curso; informe o mesmo curso em confirmar_agendamento."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Mês e ano em que o lead conclui a graduação, no formato \"MM/AAAA\" (ex.: \"12/2026\"), conforme VOCÊ entendeu a resposta dele. Informe junto com conclusao_graduacao_bruta sempre que o lead ainda estiver cursando. Só preencha quando a resposta trouxer ANO (\"2027.1\", \"dezembro de 2026\") ou prazo explícito (\"em uns 2 anos\", \"faltam 6 meses\"). NUNCA converta um número de semestre/período em data por conta própria: \"2 semestre\" não diz o ano, e chutar já agendou aluno de 1º ano."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "O que o lead declarou sobre a graduação. normal = graduação CONCLUÍDA: declarada (\"me formei\", \"já concluí\", \"sim\" à pergunta sobre conclusão) OU título profissional dito sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária). Auxiliar/técnico, profissão de outra pessoa, intenção, negação e cargo genérico não contam; nome isolado do curso e trabalho na área não confirmam conclusão. Quem AINDA CURSA nunca usa normal. estudante_apto = conclui até a DATA-LIMITE que vem no contexto temporal; estudante_fora_do_prazo = conclui depois dela (\"ano que vem\" sozinho não reprova: compare com a data do contexto, não recalcule). Envie a resposta literal em conclusao_graduacao_bruta e o MM/AAAA em conclusao_graduacao. Se faltar saber se concluiu ou quando conclui, pergunte só isso. Semestre/período não é data. correcao_sem_formacao = estava marcado Sem Formação e confirmou graduação concluída com o nome do curso. Este campo descreve o que o lead disse; quem decide é a ferramenta."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "OBRIGATÓRIO quando contexto_qualificacao for estudante_apto ou estudante_fora_do_prazo. Cole aqui, LITERALMENTE, o que o lead respondeu sobre quando conclui a graduação — sem interpretar, sem normalizar, sem corrigir (ex.: \"2 semestre\", \"tô no último ano, termino em 2027.1\", \"faltam uns 6 meses\"). O sistema relê esta resposta e é ELE quem decide o prazo. Se a resposta for a posição no curso e não uma data, ele devolve PRECISA_DATA_CONCLUSAO e você pergunta o mês/ano ao lead."
        }
      }
    },
    "description": "PRIMEIRA função depois que a graduação do lead está identificada, e SEMPRE ANTES de confirmar_agendamento. Verifica se a formação permite cursar a pós de interesse e registra a decisão para este lead e este curso.\n\nQUANDO CHAMAR: assim que o lead informar a graduação, ou quando ele se apresentar com título profissional sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária): nesse caso a graduação conta como concluída e você chama direto, sem perguntar de novo qual é a graduação nem se concluiu. Chame de novo se a pós mudou ou se ele aceitou o curso_alternativo. NÃO chame junto com confirmar_agendamento: aguarde o resultado. NÃO chame sem o nome específico da graduação, nem em conversa que é só sobre aula aberta.\n\nO QUE O RETORNO LIBERA: APROVADO = pode seguir para confirmar_agendamento do MESMO curso (não cria reunião por si só). REPROVADO com curso_alternativo = ofereça a alternativa e, se ele aceitar, verifique essa pós antes de agendar. REPROVADO sem alternativa = encerre pelo caminho previsto. REPROVADO_PRAZO = estudante que conclui depois da data-limite: não agende e chame agendar_retorno com tipo=\"formatura\". PRECISA_DATA_CONCLUSAO = pergunte só o mês e o ano em que ele conclui. FALHA_TECNICA ou pendência = não trate como apto nem agende; tente de novo na próxima rodada.\n\nNunca cite prazo, data-limite, régua ou elegibilidade ao lead, e não comente o resultado com ele."
  },
  "consulta_disponibilidade__abertura": {
    "name": "consulta_disponibilidade",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "data_desejada"
      ],
      "properties": {
        "data_desejada": {
          "type": "string",
          "description": "Data no formato YYYY-MM-DD, calculada a partir do contexto temporal. Nunca null. Nunca a mais de dois dias da data atual."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "periodo_desejado": {
          "enum": [
            "manhã",
            "tarde",
            "noite",
            "qualquer"
          ],
          "type": "string",
          "description": "Período do dia: manhã (até 12h), tarde (12h às 19h), noite (após 19h) ou qualquer. Use o que o lead pediu; se não especificou, qualquer."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional. Horário no formato HH:mm (ex.: 20:00). Tem prioridade sobre periodo_desejado; a busca traz horários a partir dele."
        }
      }
    },
    "description": "Esta ferramenta consulta horários de REUNIÃO, não de retorno por mensagem. Ausência momentânea (\"agora não posso atender\") exige perguntar quando pode chamar por aqui, sem consultar agenda. Uma data/hora respondida a essa pergunta é retorno no canal, não aceite de Meet. Só consulte para interesse explícito em agendar a reunião.\nFINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nFunção única do fluxo de horários. Chame assim que o lead aceitar marcar a conversa. A partir da pós de interesse, retorna os horários livres (slots de 30 min) já com o monitor selecionado por menor carga, considerando todos os monitores que atendem a pós. Apresente somente horários retornados, identificando que são para a conversa com o monitor sobre a pós, no fuso de Brasília, sem citar nomes de monitores. Nunca ofereça horário sem antes executar esta função. IMPORTANTE: consultar disponibilidade NAO reserva nada. Voce NAO tem a funcao de agendar (confirmar_agendamento nao existe nesta etapa): o horario so fica marcado quando a etapa seguinte cria o agendamento. Depois que o lead escolher um horario, e PROIBIDO dizer que a reuniao esta marcada, confirmada, reservada ou encaixada, prometer que vai \"encaminhar o encaixe\", que \"o link chega em breve\" ou que \"o monitor entra em contato\", e mandar qualquer link de meet. Repita o horario escolhido e diga que falta um passo rapido pra fechar. REGRA OBRIGATORIA PARA PEDIDO IMPOSSIVEL: compare o pedido mais recente do lead com os horarios de funcionamento do contexto temporal. Se ele pedir domingo, sabado a tarde/noite ou madrugada, NAO consulte a data ou o periodo impossivel. Explique de forma curta que nao ha atendimento nesse periodo, escolha o proximo periodo valido permitido pelo contexto e CHAME esta funcao para essa data valida. So depois ofereca os horarios exatos retornados. Deixe claro que sao uma alternativa; nunca troque a data silenciosamente. Exemplo: para \"domingo as 22h\", avise que domingo nao tem atendimento, consulte o proximo periodo valido e ofereca apenas os slots retornados.\nSe o lead propôs data e hora concretas para a reunião, consulte exatamente essa opção, mesmo sem oferta anterior do SDR. Não desloque 13:00 para 13:30 por uma tabela genérica. Se o mesmo dia e horário aparecer em slots_raw, preserve a escolha e avance apenas nas pendências de qualificação; não abra um novo menu de horários. Disponibilidade não é aprovação nem agendamento. Se a opção estiver ausente, ofereça alternativas reais e aguarde nova escolha.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome."
  },
  "consulta_objecoes__abertura": {
    "name": "consulta_objecoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "mensagem_lead",
        "tipo_objecao"
      ],
      "properties": {
        "tipo_objecao": {
          "enum": [
            "objecao_tempo",
            "objecao_canal",
            "pergunta_preco",
            "objecao_financeira",
            "objecao_adiamento",
            "objecao_desconfianca",
            "objecao_duvida",
            "pergunta_condicao",
            "objecao_terceiro",
            "pergunta_modalidade",
            "pergunta_instituicao"
          ],
          "type": "string",
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (quanto custa/qual valor — o lead PERGUNTA o preço), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (vou pensar/depois te falo), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (online/presencial/EAD), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
        },
        "mensagem_lead": {
          "type": "string",
          "description": "A mensagem EXATA e completa do lead, do jeito que ele escreveu, sem reformular. É essa frase que busca a melhor resposta no RAG por similaridade de significado — então mande o texto cru. Ex: 'não tenho tempo agora', 'quanto custa essa pós?', 'prefiro por whatsapp', 'vou ver com minha esposa', 'nunca ouvi falar de vocês'."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome da pós mencionada na dúvida de modalidade; não altera o interesse."
        }
      }
    },
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso."
  },
  "pausa_ia__abertura": {
    "name": "pausa_ia",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo",
        "tipo"
      ],
      "properties": {
        "tipo": {
          "enum": [
            "pausa",
            "nao_perturbe",
            "sem_graduacao"
          ],
          "type": "string",
          "description": "Tipo de parada. \"sem_graduacao\" = o lead NÃO tem graduação nenhuma e NÃO está cursando uma (só ensino médio e/ou técnico): como a pós é lato sensu, ele nunca vai poder se matricular. ARQUIVA o contato, RESOLVE a conversa e tira o lead de TODOS os disparos, campanhas e follow-ups. ⚠️ NUNCA use \"sem_graduacao\" para quem está CURSANDO a graduação — esse volta a ser elegível quando se formar, e o caminho dele é a tool agendar_retorno com tipo=\"formatura\". \"nao_perturbe\" = OPT-OUT: o lead não quer mais ser contatado. ARQUIVA o contato, resolve as conversas e tira o lead de TODOS os disparos, campanhas e follow-ups — use sempre que o lead confirmar desinteresse (depois da pergunta de retenção) ou pedir pra não ser mais notificado. \"pausa\" = apenas parar a automação para atendimento humano/personalizado (pediu ligação, pagou a matrícula, quer falar com alguém, já é aluno, ou é graduado em área incompatível com AQUELA pós): o lead CONTINUA no fluxo e SEGUE recebendo disparos e campanhas, então NUNCA use \"pausa\" para quem pediu pra parar de receber mensagens nem para quem não tem graduação nenhuma."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "Para tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPausar o atendimento automático. Use quando o lead pedir atendimento humano, pedir ligação, informar que pagou a matrícula, pedir cancelamento/remarcação, ou for desqualificado (não tem graduação nenhuma / é graduado em área incompatível). ⚠️ DESINTERESSE/OPT-OUT ('não quero mais', 'não me notifique', 'pode parar', 'me tira da lista', 'perdi o interesse'): NÃO use esta tool de primeira. Antes, faça a pergunta de retenção EXPLÍCITA: o lead não tem interesse mesmo, ou prefere ser chamado quando abrir a PRÓXIMA TURMA? Só pause por desinteresse se essa pergunta já aparece LITERALMENTE no histórico (nunca conte como feita 'implicitamente') e o lead reiterou o não. Se o lead preferir a próxima turma, use temporizador_proxima_turma em vez desta. Escolha tipo=\"nao_perturbe\" quando o lead claramente não quer ser contatado (desinteresse confirmado após a retenção); tipo=\"sem_graduacao\" quando ele NÃO tem graduação nenhuma e nem está cursando uma (só ensino médio e/ou técnico) — nunca será elegível, então o contato é ARQUIVADO e a conversa RESOLVIDA; tipo=\"pausa\" para atendimento humano/personalizado, ligação, lead que já é aluno, ou formação incompatível (ele É graduado, mas a área não atende AQUELA pós — pode servir pra outra). ⚠️ Lead que ainda está CURSANDO a graduação NÃO entra nesta tool: o caminho dele é agendar_retorno com tipo=\"formatura\". ⚠️ LEAD QUE JÁ É ALUNO (diz que já faz/cursa uma pós da PPG, que \"já estou no Nº mês\", que já é matriculado): use ESTA tool com tipo=\"pausa\" IMEDIATAMENTE, logo na primeira vez que ele disser. Antes de pausar, mande UMA mensagem curta assumindo o engano (\"esse convite era pra quem ainda não é aluno, desculpa a confusão\") e diga que alguém do suporte fala com ele. É PROIBIDO seguir qualificando, oferecer horário, agendar reunião ou inventar qualquer outro motivo pra conversa (ex.: dizer que a reunião é \"com o monitor do seu curso\" ou \"pra ver como está sua experiência\" — isso NÃO existe). Aluno que quer OUTRA pós também para aqui: quem cuida disso é o humano. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "agendar_retorno__abertura": {
    "name": "agendar_retorno",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "tipo"
      ],
      "properties": {
        "dias": {
          "type": "integer",
          "maximum": 7,
          "minimum": 1,
          "description": "Só para tipo=\"analise\": em quantos dias o lead pediu pra ser chamado (1 a 7)."
        },
        "tipo": {
          "enum": [
            "analise",
            "formatura"
          ],
          "type": "string",
          "description": "\"analise\" = pediu tempo pra ver o material (use `dias`). \"formatura\" = ainda cursando a graduação (use `meses`)."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só para tipo=\"formatura\": quantos meses faltam pra ele concluir a graduação. O sistema limita ao teto de 12."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Não use para ausência momentânea ou para registrar uma hora de retorno por WhatsApp. Sem prazo informado, pergunte quando pode chamar; não invente dias. Esta ferramenta não agenda hora exata nem reunião.\nAgendar o RETORNO do lead pra uma data futura, em dois casos. CASO 1 (tipo=\"analise\"): o lead pediu tempo pra analisar/ler/ver o material ou pra pensar. Pergunte ANTES quando pode chamá-lo e só chame esta função DEPOIS que ele disser o prazo; converta em dias (\"amanhã\"=1, \"semana que vem\"=7, \"uns dias\"=3). O máximo é 7 dias — prazo maior que isso NÃO usa este caso: negocie pra dentro da semana ou use temporizador_proxima_turma. CASO 2 (tipo=\"formatura\"): o lead AINDA ESTÁ CURSANDO a graduação e conclui longe demais pra entrar agora. Ele NÃO está desinteressado — vai poder cursar quando se formar, então NUNCA use pausa_ia nesse caso. Informe em `meses` quantos meses faltam pra ele concluir (conclui em 2028 e estamos em 2026 → 24); o sistema limita ao teto de 12 meses sozinho. Não pergunte prazo ao lead aqui: use o que ele já disse sobre quando termina o curso. Nos dois casos o lead fica fora dos disparos até a data e o time o retoma. Chame UMA vez só, na mesma resposta em que se despede. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "atualizar_dados_lead__abertura": {
    "name": "atualizar_dados_lead",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "nome": {
          "type": "string",
          "description": "Nome do lead exatamente como ele informou (ex.: \"Carlos Badia\"). Só o nome, sem saudação nem frase."
        },
        "formacao": {
          "type": "string",
          "description": "Nome do curso de GRADUAÇÃO do lead (ex.: \"Medicina Veterinária\", \"Zootecnia\"). Nunca valores vagos como \"formado\", \"estudante\" ou \"graduação\" — se ele responder assim, pergunte qual é o curso."
        },
        "qual_pos": {
          "type": "string",
          "description": "Qual pós-graduação ele já tem, se disse (ex.: 'clínica de pequenos animais')."
        },
        "possui_pos": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se o lead já possui alguma pós-graduação, com as palavras dele. Pergunte só depois de enviar o cronograma e só quando a graduação está concluída."
        },
        "area_atuacao": {
          "type": "string",
          "description": "Área em que o lead atua HOJE, com as palavras dele (ex.: 'clínica de pequenos animais', 'venda de insumos', 'não trabalha na área'). Registre assim que ele disser."
        },
        "atua_na_area": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se ele atua na área da pós de interesse: 'sim' quando ficou claro na conversa que trabalha nela; 'nao' quando disse que não atua ou atua em outra área."
        },
        "tempo_formacao": {
          "type": "string",
          "description": "O que o lead disse sobre a CONCLUSÃO da graduação, em poucas palavras (ex.: \"formado há 2 anos\", \"formado\", \"cursando, conclui em dez/2026\"). É isso que separa graduado de quem ainda cursa."
        },
        "graduacao_concluida": {
          "enum": [
            "sim",
            "cursando",
            "nao"
          ],
          "type": "string",
          "description": "'sim' = graduação concluída (formado); 'cursando' = ainda na faculdade (mande também tempo_formacao com a previsão de conclusão); 'nao' = disse que não tem graduação nenhuma (só ensino médio/técnico)."
        }
      }
    },
    "description": "Registra no cadastro o NOME, a GRADUAÇÃO e o TEMPO DE FORMAÇÃO que o lead informou. Chame assim que souber cada dado. NÃO puxe o assunto só para preencher. Roda em segundo plano: nunca comente com o lead que salvou os dados.\nFICHA DO ATENDIMENTO: registre também area_atuacao, atua_na_area e graduacao_concluida assim que o lead informar. É isso que libera o envio do cronograma e evita repetir pergunta já respondida."
  },
  "consulta_objecoes__fechamento": {
    "name": "consulta_objecoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "mensagem_lead",
        "tipo_objecao"
      ],
      "properties": {
        "tipo_objecao": {
          "enum": [
            "objecao_tempo",
            "objecao_canal",
            "pergunta_preco",
            "objecao_financeira",
            "objecao_adiamento",
            "objecao_desconfianca",
            "objecao_duvida",
            "pergunta_condicao",
            "objecao_terceiro",
            "pergunta_modalidade",
            "pergunta_instituicao"
          ],
          "type": "string",
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (quanto custa/qual valor — o lead PERGUNTA o preço), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (vou pensar/depois te falo), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (online/presencial/EAD), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
        },
        "mensagem_lead": {
          "type": "string",
          "description": "A mensagem EXATA e completa do lead, do jeito que ele escreveu, sem reformular. É essa frase que busca a melhor resposta no RAG por similaridade de significado — então mande o texto cru. Ex: 'não tenho tempo agora', 'quanto custa essa pós?', 'prefiro por whatsapp', 'vou ver com minha esposa', 'nunca ouvi falar de vocês'."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome da pós mencionada na dúvida de modalidade; não altera o interesse."
        }
      }
    },
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso."
  },
  "pausa_ia__fechamento": {
    "name": "pausa_ia",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo",
        "tipo"
      ],
      "properties": {
        "tipo": {
          "enum": [
            "pausa",
            "nao_perturbe",
            "sem_graduacao"
          ],
          "type": "string",
          "description": "Tipo de parada. \"sem_graduacao\" = o lead NÃO tem graduação nenhuma e NÃO está cursando uma (só ensino médio e/ou técnico): como a pós é lato sensu, ele nunca vai poder se matricular. ARQUIVA o contato, RESOLVE a conversa e tira o lead de TODOS os disparos, campanhas e follow-ups. ⚠️ NUNCA use \"sem_graduacao\" para quem está CURSANDO a graduação — esse volta a ser elegível quando se formar, e o caminho dele é a tool agendar_retorno com tipo=\"formatura\". \"nao_perturbe\" = OPT-OUT: o lead não quer mais ser contatado. ARQUIVA o contato, resolve as conversas e tira o lead de TODOS os disparos, campanhas e follow-ups — use sempre que o lead confirmar desinteresse (depois da pergunta de retenção) ou pedir pra não ser mais notificado. \"pausa\" = apenas parar a automação para atendimento humano/personalizado (pediu ligação, pagou a matrícula, quer falar com alguém, já é aluno, ou é graduado em área incompatível com AQUELA pós): o lead CONTINUA no fluxo e SEGUE recebendo disparos e campanhas, então NUNCA use \"pausa\" para quem pediu pra parar de receber mensagens nem para quem não tem graduação nenhuma."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "Para tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPausar o atendimento automático. Use quando o lead pedir atendimento humano, pedir ligação, informar que pagou a matrícula, pedir cancelamento/remarcação, ou for desqualificado (não tem graduação nenhuma / é graduado em área incompatível). ⚠️ DESINTERESSE/OPT-OUT ('não quero mais', 'não me notifique', 'pode parar', 'me tira da lista', 'perdi o interesse'): NÃO use esta tool de primeira. Antes, faça a pergunta de retenção EXPLÍCITA: o lead não tem interesse mesmo, ou prefere ser chamado quando abrir a PRÓXIMA TURMA? Só pause por desinteresse se essa pergunta já aparece LITERALMENTE no histórico (nunca conte como feita 'implicitamente') e o lead reiterou o não. Se o lead preferir a próxima turma, use temporizador_proxima_turma em vez desta. Escolha tipo=\"nao_perturbe\" quando o lead claramente não quer ser contatado (desinteresse confirmado após a retenção); tipo=\"sem_graduacao\" quando ele NÃO tem graduação nenhuma e nem está cursando uma (só ensino médio e/ou técnico) — nunca será elegível, então o contato é ARQUIVADO e a conversa RESOLVIDA; tipo=\"pausa\" para atendimento humano/personalizado, ligação, lead que já é aluno, ou formação incompatível (ele É graduado, mas a área não atende AQUELA pós — pode servir pra outra). ⚠️ Lead que ainda está CURSANDO a graduação NÃO entra nesta tool: o caminho dele é agendar_retorno com tipo=\"formatura\". ⚠️ LEAD QUE JÁ É ALUNO (diz que já faz/cursa uma pós da PPG, que \"já estou no Nº mês\", que já é matriculado): use ESTA tool com tipo=\"pausa\" IMEDIATAMENTE, logo na primeira vez que ele disser. Antes de pausar, mande UMA mensagem curta assumindo o engano (\"esse convite era pra quem ainda não é aluno, desculpa a confusão\") e diga que alguém do suporte fala com ele. É PROIBIDO seguir qualificando, oferecer horário, agendar reunião ou inventar qualquer outro motivo pra conversa (ex.: dizer que a reunião é \"com o monitor do seu curso\" ou \"pra ver como está sua experiência\" — isso NÃO existe). Aluno que quer OUTRA pós também para aqui: quem cuida disso é o humano. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "envia_informacoes__fechamento": {
    "name": "envia_informacoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "conteudo"
      ],
      "properties": {
        "conteudo": {
          "enum": [
            "cronograma",
            "valor",
            "cronograma_e_valor"
          ],
          "type": "string",
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' (valor integral retornado pra você informar na conversa), 'cronograma_e_valor' (ambos)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia informações da pós de interesse ao lead. Três modos: 'cronograma' solicita o envio do PDF do cronograma detalhado no WhatsApp do lead; 'valor' retorna o valor integral (sem desconto) para VOCÊ informar com suas palavras; 'cronograma_e_valor' faz os dois. Use 'cronograma' quando o lead pedir cronograma, grade, conteúdo programático, ementa, datas das aulas ou 'me manda mais informações'. Use 'valor' sempre que o lead perguntar preço, valor ou investimento. Use 'cronograma_e_valor' quando o lead pedir explicitamente as duas coisas. Quando o lead INSISTIR que só pode resolver pelo WhatsApp (segunda objeção de canal), chame esta função com 'cronograma' E a consulta_objecoes NA MESMA resposta: o cronograma atende o pedido dele e a quebra de objeção reforça que a condição do primeiro lote promocional é apresentada na reunião com o monitor. Se a pendência for recebimento ou acesso ao material, resolva essa dificuldade antes de retomar a objeção ou o agendamento.\n\nConfira o curso e o histórico antes de enviar. Não repita o mesmo material sem novo pedido ou falha. Se o lead pedir novamente, disser que não recebeu, não encontrou ou não consegue abrir, faça uma nova tentativa com 'cronograma', mesmo que exista um tool_result antigo ou registro de envio humano. O relato do lead permite o reenvio; nunca insista que ele recebeu, que o sistema confirma a entrega ou que basta procurar acima na conversa. Depois da tentativa, aguarde a confirmação de acesso antes de perguntar sobre leitura, opinião ou agendamento. Se ela falhar ou o arquivo estiver indisponível, explique a dificuldade e encaminhe para ajuda humana pela ferramenta apropriada, sem repetir envios em loop.\n\nResponda conforme o status atual retornado pela função. Solicitação aceita não comprova entrega; entrega registrada não comprova que o lead abriu o arquivo. Se o retorno indicar falha, reconheça que o material não foi enviado e não prometa envio posterior sem providenciar uma ação efetiva. Só confirme entrega quando houver confirmação de entrega; nunca transforme um registro antigo de envio em prova contra o relato do lead. NUNCA invente valor, parcela ou desconto que não esteja no retorno; a condição especial em cima do valor integral é apresentada apenas no Meet.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome.\nFICHA DO ATENDIMENTO: antes de chamar para cronograma, leia o bloco [FICHA DO ATENDIMENTO] no fim da última mensagem. Se houver FALTA COLETAR, faça a pergunta indicada e só chame depois da resposta (ou se ele insistir sem responder). O sistema recusa o envio enquanto faltar dado e devolve PRECISA_COLETAR com o que perguntar."
  },
  "temporizador_proxima_turma__fechamento": {
    "name": "temporizador_proxima_turma",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo"
      ],
      "properties": {
        "curso": {
          "type": "string",
          "description": "Curso de interesse do lead, se você souber. Vazio = usa o curso já conhecido da conversa."
        },
        "motivo": {
          "type": "string",
          "description": "Frase curta com o que o lead pediu. Ex.: 'Lead pediu pra ser chamado quando abrir a próxima turma'."
        }
      }
    },
    "description": "Agendar o recontato do lead para a PRÓXIMA TURMA do curso dele. Use SEMPRE que o lead disser que prefere ser chamado quando abrir a próxima turma, \"me chama mais pra frente\", \"agora não posso, me procura depois\" — em vez de pausa_ia. A função busca a data real da próxima turma no sistema, agenda o temporizador de recontato (o lead fica FORA de todos os disparos em massa até lá) e a IA é pausada em seguida. Chame UMA vez só, na mesma resposta da sua mensagem de despedida. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "consulta_pos_disponiveis__fechamento": {
    "name": "consulta_pos_disponiveis",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "trocar_para": {
          "type": "string",
          "description": "Pós explicitamente escolhida pelo lead. Valida e registra; não use só porque ele perguntou se existe ou como funciona."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome exato dito pelo lead para verificar existência/modalidade. Somente consulta, sem mudar o interesse."
        }
      },
      "additionalProperties": false
    },
    "description": "Fonte obrigatória do catálogo de pós ATIVAS e modalidades por curso. Chame quando o lead mencionar uma pós ainda não validada, inclusive na PRIMEIRA escolha de interesse, ou perguntar se temos uma pós, quais existem, qual é online ou semipresencial. Antes de confirmar que oferecemos, falar em matrícula/condição ou encaminhar para agenda, valide o nome aqui. Repetir o nome dito pelo lead NÃO comprova existência: clínica de pequenos animais não equivale a clínica de bovinos. Use curso_consulta para consultar sem alterar interesse, inclusive dúvidas sobre outra pós. Use trocar_para SOMENTE quando o lead tiver escolhido explicitamente aquela pós. Sem parâmetros lista catálogo e modalidades. Não passe os dois campos juntos. Respeite status: só curso_confirmado/interesse_atualizado autoriza adotar o curso; semelhança textual exige esclarecimento, nunca troca automática. Se não encontrado, diga que não temos essa pós e ofereça apenas alternativas reais pertinentes, aguardando escolha. Não invente modalidade, conteúdo, cidade, frequência ou carga horária. O retorno específico prevalece sobre frases genéricas de objeção ou conhecimento anterior. Depois de responder, siga qualificando e agendando conforme o interesse validado."
  },
  "confirmar_agendamento__fechamento": {
    "name": "confirmar_agendamento",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "data_escolhida",
        "horario_escolhido",
        "vendedor_id"
      ],
      "properties": {
        "vendedor_id": {
          "type": "string",
          "description": "UUID do monitor retornado no slot por consulta_disponibilidade(). Garante que o mesmo monitor que foi oferecido ao lead seja reservado."
        },
        "data_escolhida": {
          "type": "string",
          "description": "Data do slot escolhido, YYYY-MM-DD (ex: 2026-06-10). Extraia do campo 'inicio' que consulta_disponibilidade retornou, convertendo para horario de Brasilia (UTC-3)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Horario do slot em HH:mm no horario de Brasilia (ex: 15:00). Extraia do campo 'inicio' que consulta_disponibilidade retornou, convertendo UTC -> Brasilia (-3h)."
        }
      }
    },
    "description": "FINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nQuarta e ULTIMA funcao da sequencia de agendamento. Executar SOMENTE apos o lead escolher um horario retornado por consulta_disponibilidade(). Agenda a reuniao no sistema PPGVET com o monitor ja definido no slot escolhido. NUNCA executar antes do lead confirmar. Use exatamente a data, horario, pos e vendedor_id que consulta_disponibilidade retornou. A reuniao SO existe depois que esta funcao retorna com sucesso nesta conversa, e o link do meet e SEMPRE o que ela devolveu. Antes desse retorno e PROIBIDO dizer que a reuniao esta marcada/confirmada/reservada/agendada, prometer que \"o link chega em breve\" ou que \"o monitor entra em contato pra passar o link\", e mandar qualquer link de meet - inclusive reaproveitar o link de uma reuniao ANTIGA que apareca no historico (link antigo e de reuniao antiga). Se o lead perguntar sobre uma reuniao e voce nao tiver o retorno desta funcao nesta conversa, nao confirme nada: trate como nao marcada e refaca o fluxo de horarios. CONTRATO DE APROVACAO POR CURSO: esta função RECUSA criar a reunião sem aprovação persistida para o MESMO lead e o MESMO curso_escolhido. Formação preenchida ou aprovação de outra pós não bastam. Antes de chamar, aguarde verificar_compatibilidade_curso retornar APROVADO com decisão registrada para esta pós. Em recusa por falta de aprovação válida, verifique novamente usando os dados já confirmados no histórico/cadastro; pergunte apenas o que faltar. Reprovação, conclusão pendente e falha técnica não autorizam agendar. Não contorne a recusa trocando identificadores, usando aprovação de outro curso ou repetindo a chamada sem resolver a pendência.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome."
  },
  "consulta_disponibilidade__fechamento": {
    "name": "consulta_disponibilidade",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "data_desejada"
      ],
      "properties": {
        "data_desejada": {
          "type": "string",
          "description": "Data YYYY-MM-DD do horario que o lead escolheu/pediu. Se ja passou, calcule a proxima valida. Nunca a mais de dois dias da data atual."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "periodo_desejado": {
          "enum": [
            "manha",
            "tarde",
            "noite",
            "qualquer"
          ],
          "type": "string",
          "description": "Periodo: manha (ate 12h), tarde (12-19h), noite (apos 19h) ou qualquer."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional HH:mm (ex: 14:30). Preencha com o horario exato que o lead escolheu pra confirmar se ainda esta livre. Tem prioridade sobre periodo_desejado."
        }
      }
    },
    "description": "Esta ferramenta consulta horários de REUNIÃO, não de retorno por mensagem. Ausência momentânea (\"agora não posso atender\") exige perguntar quando pode chamar por aqui, sem consultar agenda. Uma data/hora respondida a essa pergunta é retorno no canal, não aceite de Meet. Só consulte para interesse explícito em agendar a reunião.\nFINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nRe-checa os horarios disponiveis antes de fechar, ou quando o lead pedir outro horario / o escolhido ja tiver passado. A partir da pos, retorna os horarios livres (slots de 30 min) ja com o monitor selecionado por menor carga. Apresente somente horários retornados, identificando que são para a conversa com o monitor sobre a pós, no fuso de Brasília, sem citar nomes de monitores. Nunca confirme nem ofereca um horario sem antes executar esta funcao; se o horario escolhido nao voltar, ofereca o mais proximo que voltar. REGRA OBRIGATORIA PARA PEDIDO IMPOSSIVEL: compare o pedido mais recente do lead com os horarios de funcionamento do contexto temporal. Se ele pedir domingo, sabado a tarde/noite ou madrugada, NAO consulte a data ou o periodo impossivel. Explique de forma curta que nao ha atendimento nesse periodo, escolha o proximo periodo valido permitido pelo contexto e CHAME esta funcao para essa data valida. So depois ofereca os horarios exatos retornados. Deixe claro que sao uma alternativa; nunca troque a data silenciosamente. Exemplo: para \"domingo as 22h\", avise que domingo nao tem atendimento, consulte o proximo periodo valido e ofereca apenas os slots retornados.\nSe o lead propôs data e hora concretas para a reunião, consulte exatamente essa opção, mesmo sem oferta anterior do SDR. Não desloque 13:00 para 13:30 por uma tabela genérica. Se o mesmo dia e horário aparecer em slots_raw, preserve a escolha e avance apenas nas pendências de qualificação; não abra um novo menu de horários. Disponibilidade não é aprovação nem agendamento. Se a opção estiver ausente, ofereça alternativas reais e aguarde nova escolha.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome."
  },
  "verificar_compatibilidade_curso__fechamento": {
    "name": "verificar_compatibilidade_curso",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "formacao_academica",
        "curso_interesse"
      ],
      "properties": {
        "area_trabalho": {
          "type": "string",
          "description": "OPCIONAL. Área de atuação profissional do lead. Informar quando já foi coletada no fluxo."
        },
        "curso_interesse": {
          "type": "string",
          "description": "Nome EXATO da pós que o lead quer AGORA. Use o curso_alternativo se ele aceitou a troca. A decisão será registrada para esse curso; informe o mesmo curso em confirmar_agendamento."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Mês e ano em que o lead conclui a graduação, no formato \"MM/AAAA\" (ex.: \"12/2026\"), conforme VOCÊ entendeu a resposta dele. Informe junto com conclusao_graduacao_bruta sempre que o lead ainda estiver cursando. Só preencha quando a resposta trouxer ANO (\"2027.1\", \"dezembro de 2026\") ou prazo explícito (\"em uns 2 anos\", \"faltam 6 meses\"). NUNCA converta um número de semestre/período em data por conta própria: \"2 semestre\" não diz o ano, e chutar já agendou aluno de 1º ano."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "O que o lead declarou sobre a graduação. normal = graduação CONCLUÍDA: declarada (\"me formei\", \"já concluí\", \"sim\" à pergunta sobre conclusão) OU título profissional dito sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária). Auxiliar/técnico, profissão de outra pessoa, intenção, negação e cargo genérico não contam; nome isolado do curso e trabalho na área não confirmam conclusão. Quem AINDA CURSA nunca usa normal. estudante_apto = conclui até a DATA-LIMITE que vem no contexto temporal; estudante_fora_do_prazo = conclui depois dela (\"ano que vem\" sozinho não reprova: compare com a data do contexto, não recalcule). Envie a resposta literal em conclusao_graduacao_bruta e o MM/AAAA em conclusao_graduacao. Se faltar saber se concluiu ou quando conclui, pergunte só isso. Semestre/período não é data. correcao_sem_formacao = estava marcado Sem Formação e confirmou graduação concluída com o nome do curso. Este campo descreve o que o lead disse; quem decide é a ferramenta."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "OBRIGATÓRIO quando contexto_qualificacao for estudante_apto ou estudante_fora_do_prazo. Cole aqui, LITERALMENTE, o que o lead respondeu sobre quando conclui a graduação — sem interpretar, sem normalizar, sem corrigir (ex.: \"2 semestre\", \"tô no último ano, termino em 2027.1\", \"faltam uns 6 meses\"). O sistema relê esta resposta e é ELE quem decide o prazo. Se a resposta for a posição no curso e não uma data, ele devolve PRECISA_DATA_CONCLUSAO e você pergunta o mês/ano ao lead."
        }
      }
    },
    "description": "PRIMEIRA função depois que a graduação do lead está identificada, e SEMPRE ANTES de confirmar_agendamento. Verifica se a formação permite cursar a pós de interesse e registra a decisão para este lead e este curso.\n\nQUANDO CHAMAR: assim que o lead informar a graduação, ou quando ele se apresentar com título profissional sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária): nesse caso a graduação conta como concluída e você chama direto, sem perguntar de novo qual é a graduação nem se concluiu. Chame de novo se a pós mudou ou se ele aceitou o curso_alternativo. NÃO chame junto com confirmar_agendamento: aguarde o resultado. NÃO chame sem o nome específico da graduação, nem em conversa que é só sobre aula aberta.\n\nO QUE O RETORNO LIBERA: APROVADO = pode seguir para confirmar_agendamento do MESMO curso (não cria reunião por si só). REPROVADO com curso_alternativo = ofereça a alternativa e, se ele aceitar, verifique essa pós antes de agendar. REPROVADO sem alternativa = encerre pelo caminho previsto. REPROVADO_PRAZO = estudante que conclui depois da data-limite: não agende e chame agendar_retorno com tipo=\"formatura\". PRECISA_DATA_CONCLUSAO = pergunte só o mês e o ano em que ele conclui. FALHA_TECNICA ou pendência = não trate como apto nem agende; tente de novo na próxima rodada.\n\nNunca cite prazo, data-limite, régua ou elegibilidade ao lead, e não comente o resultado com ele."
  },
  "remarcar_agendamento__fechamento": {
    "name": "remarcar_agendamento",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "data_escolhida",
        "horario_escolhido",
        "vendedor_id"
      ],
      "properties": {
        "vendedor_id": {
          "type": "string",
          "description": "UUID do monitor do slot escolhido em consulta_disponibilidade(). Pode ser o mesmo de antes ou outro; garante reservar o monitor certo no novo horario."
        },
        "data_escolhida": {
          "type": "string",
          "description": "Nova data do slot escolhido, YYYY-MM-DD (Brasilia). Extraia do campo 'inicio' que consulta_disponibilidade retornou, convertendo UTC -> Brasilia (-3h)."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Novo horario em HH:mm no horario de Brasilia (ex: 19:00). Extraia do 'inicio' do slot, convertendo UTC -> Brasilia (-3h)."
        }
      }
    },
    "description": "FINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nRemarca (muda o dia/horario de) uma reuniao JA agendada deste lead. Use SEMPRE que o lead pedir pra mudar o horario de uma reuniao que ele ja tem marcada. NUNCA use confirmar_agendamento pra remarcar (isso criaria uma SEGUNDA reuniao duplicada). Fluxo correto: 1) chame consulta_disponibilidade pro novo dia/horario que o lead quer; 2) ofereca os horarios livres; 3) SO depois do lead escolher, chame remarcar_agendamento com o slot escolhido. O novo horario passa a valer: a reuniao existente e atualizada e os lembretes seguem o novo horario."
  },
  "agendar_retorno__fechamento": {
    "name": "agendar_retorno",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "tipo"
      ],
      "properties": {
        "dias": {
          "type": "integer",
          "maximum": 7,
          "minimum": 1,
          "description": "Só para tipo=\"analise\": em quantos dias o lead pediu pra ser chamado (1 a 7)."
        },
        "tipo": {
          "enum": [
            "analise",
            "formatura"
          ],
          "type": "string",
          "description": "\"analise\" = pediu tempo pra ver o material (use `dias`). \"formatura\" = ainda cursando a graduação (use `meses`)."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só para tipo=\"formatura\": quantos meses faltam pra ele concluir a graduação. O sistema limita ao teto de 12."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Não use para ausência momentânea ou para registrar uma hora de retorno por WhatsApp. Sem prazo informado, pergunte quando pode chamar; não invente dias. Esta ferramenta não agenda hora exata nem reunião.\nAgendar o RETORNO do lead pra uma data futura, em dois casos. CASO 1 (tipo=\"analise\"): o lead pediu tempo pra analisar/ler/ver o material ou pra pensar. Pergunte ANTES quando pode chamá-lo e só chame esta função DEPOIS que ele disser o prazo; converta em dias (\"amanhã\"=1, \"semana que vem\"=7, \"uns dias\"=3). O máximo é 7 dias — prazo maior que isso NÃO usa este caso: negocie pra dentro da semana ou use temporizador_proxima_turma. CASO 2 (tipo=\"formatura\"): o lead AINDA ESTÁ CURSANDO a graduação e conclui longe demais pra entrar agora. Ele NÃO está desinteressado — vai poder cursar quando se formar, então NUNCA use pausa_ia nesse caso. Informe em `meses` quantos meses faltam pra ele concluir (conclui em 2028 e estamos em 2026 → 24); o sistema limita ao teto de 12 meses sozinho. Não pergunte prazo ao lead aqui: use o que ele já disse sobre quando termina o curso. Nos dois casos o lead fica fora dos disparos até a data e o time o retoma. Chame UMA vez só, na mesma resposta em que se despede. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "atualizar_dados_lead__fechamento": {
    "name": "atualizar_dados_lead",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "nome": {
          "type": "string",
          "description": "Nome do lead exatamente como ele informou (ex.: \"Carlos Badia\"). Só o nome, sem saudação nem frase."
        },
        "formacao": {
          "type": "string",
          "description": "Nome do curso de GRADUAÇÃO do lead (ex.: \"Medicina Veterinária\", \"Zootecnia\"). Nunca valores vagos como \"formado\", \"estudante\" ou \"graduação\" — se ele responder assim, pergunte qual é o curso."
        },
        "qual_pos": {
          "type": "string",
          "description": "Qual pós-graduação ele já tem, se disse (ex.: 'clínica de pequenos animais')."
        },
        "possui_pos": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se o lead já possui alguma pós-graduação, com as palavras dele. Pergunte só depois de enviar o cronograma e só quando a graduação está concluída."
        },
        "area_atuacao": {
          "type": "string",
          "description": "Área em que o lead atua HOJE, com as palavras dele (ex.: 'clínica de pequenos animais', 'venda de insumos', 'não trabalha na área'). Registre assim que ele disser."
        },
        "atua_na_area": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se ele atua na área da pós de interesse: 'sim' quando ficou claro na conversa que trabalha nela; 'nao' quando disse que não atua ou atua em outra área."
        },
        "tempo_formacao": {
          "type": "string",
          "description": "O que o lead disse sobre a CONCLUSÃO da graduação, em poucas palavras (ex.: \"formado há 2 anos\", \"formado\", \"cursando, conclui em dez/2026\"). É isso que separa graduado de quem ainda cursa."
        },
        "graduacao_concluida": {
          "enum": [
            "sim",
            "cursando",
            "nao"
          ],
          "type": "string",
          "description": "'sim' = graduação concluída (formado); 'cursando' = ainda na faculdade (mande também tempo_formacao com a previsão de conclusão); 'nao' = disse que não tem graduação nenhuma (só ensino médio/técnico)."
        }
      }
    },
    "description": "Registra no cadastro o NOME, a GRADUAÇÃO e o TEMPO DE FORMAÇÃO que o lead informou. Chame assim que souber cada dado. NÃO puxe o assunto só para preencher. Roda em segundo plano: nunca comente com o lead que salvou os dados.\nFICHA DO ATENDIMENTO: registre também area_atuacao, atua_na_area e graduacao_concluida assim que o lead informar. É isso que libera o envio do cronograma e evita repetir pergunta já respondida."
  },
  "consulta_disponibilidade__aula": {
    "name": "consulta_disponibilidade",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "data_desejada"
      ],
      "properties": {
        "data_desejada": {
          "type": "string",
          "description": "Data no formato YYYY-MM-DD, calculada a partir do contexto temporal. Nunca null. Nunca a mais de dois dias da data atual."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "periodo_desejado": {
          "enum": [
            "manhã",
            "tarde",
            "noite",
            "qualquer"
          ],
          "type": "string",
          "description": "Período do dia: manhã (até 12h), tarde (12h às 19h), noite (após 19h) ou qualquer. Use o que o lead pediu; se não especificou, qualquer."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional. Horário no formato HH:mm (ex.: 20:00). Tem prioridade sobre periodo_desejado; a busca traz horários a partir dele."
        }
      }
    },
    "description": "Esta ferramenta consulta horários de REUNIÃO, não de retorno por mensagem. Ausência momentânea (\"agora não posso atender\") exige perguntar quando pode chamar por aqui, sem consultar agenda. Uma data/hora respondida a essa pergunta é retorno no canal, não aceite de Meet. Só consulte para interesse explícito em agendar a reunião.\nFINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nFunção única do fluxo de horários. Chame assim que o lead aceitar marcar a conversa. A partir da pós de interesse, retorna os horários livres (slots de 30 min) já com o monitor selecionado por menor carga, considerando todos os monitores que atendem a pós. Apresente somente horários retornados, identificando que são para a conversa com o monitor sobre a pós, no fuso de Brasília, sem citar nomes de monitores. Nunca ofereça horário sem antes executar esta função. IMPORTANTE: consultar disponibilidade NAO reserva nada. Voce NAO tem a funcao de agendar (confirmar_agendamento nao existe nesta etapa): o horario so fica marcado quando a etapa seguinte cria o agendamento. Depois que o lead escolher um horario, e PROIBIDO dizer que a reuniao esta marcada, confirmada, reservada ou encaixada, prometer que vai \"encaminhar o encaixe\", que \"o link chega em breve\" ou que \"o monitor entra em contato\", e mandar qualquer link de meet. Repita o horario escolhido e diga que falta um passo rapido pra fechar. REGRA OBRIGATORIA PARA PEDIDO IMPOSSIVEL: compare o pedido mais recente do lead com os horarios de funcionamento do contexto temporal. Se ele pedir domingo, sabado a tarde/noite ou madrugada, NAO consulte a data ou o periodo impossivel. Explique de forma curta que nao ha atendimento nesse periodo, escolha o proximo periodo valido permitido pelo contexto e CHAME esta funcao para essa data valida. So depois ofereca os horarios exatos retornados. Deixe claro que sao uma alternativa; nunca troque a data silenciosamente. Exemplo: para \"domingo as 22h\", avise que domingo nao tem atendimento, consulte o proximo periodo valido e ofereca apenas os slots retornados.\nSe o lead propôs data e hora concretas para a reunião, consulte exatamente essa opção, mesmo sem oferta anterior do SDR. Não desloque 13:00 para 13:30 por uma tabela genérica. Se o mesmo dia e horário aparecer em slots_raw, preserve a escolha e avance apenas nas pendências de qualificação; não abra um novo menu de horários. Disponibilidade não é aprovação nem agendamento. Se a opção estiver ausente, ofereça alternativas reais e aguarde nova escolha.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome."
  },
  "consulta_objecoes__aula": {
    "name": "consulta_objecoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "mensagem_lead",
        "tipo_objecao"
      ],
      "properties": {
        "tipo_objecao": {
          "enum": [
            "objecao_tempo",
            "objecao_canal",
            "pergunta_preco",
            "objecao_financeira",
            "objecao_adiamento",
            "objecao_desconfianca",
            "objecao_duvida",
            "pergunta_condicao",
            "objecao_terceiro",
            "pergunta_modalidade",
            "pergunta_instituicao"
          ],
          "type": "string",
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (quanto custa/qual valor — o lead PERGUNTA o preço), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (vou pensar/depois te falo), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (online/presencial/EAD), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
        },
        "mensagem_lead": {
          "type": "string",
          "description": "A mensagem EXATA e completa do lead, do jeito que ele escreveu, sem reformular. É essa frase que busca a melhor resposta no RAG por similaridade de significado — então mande o texto cru. Ex: 'não tenho tempo agora', 'quanto custa essa pós?', 'prefiro por whatsapp', 'vou ver com minha esposa', 'nunca ouvi falar de vocês'."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome da pós mencionada na dúvida de modalidade; não altera o interesse."
        }
      }
    },
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso."
  },
  "envia_informacoes__aula": {
    "name": "envia_informacoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "conteudo"
      ],
      "properties": {
        "conteudo": {
          "enum": [
            "cronograma",
            "valor",
            "cronograma_e_valor",
            "portfolio"
          ],
          "type": "string",
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' (valor integral retornado pra você informar na conversa), 'cronograma_e_valor' (ambos), 'portfolio' (PDF com todas as pós e MBAs da PPGVET; só na aula sem pós relacionada, e com curso_escolhido = \"portfolio\")."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia informações da pós de interesse ao lead. Três modos: 'cronograma' solicita o envio do PDF do cronograma detalhado no WhatsApp do lead; 'valor' retorna o valor integral (sem desconto) para VOCÊ informar com suas palavras; 'cronograma_e_valor' faz os dois. Use 'cronograma' quando o lead pedir cronograma, grade, conteúdo programático, ementa, datas das aulas ou 'me manda mais informações'. Use 'valor' sempre que o lead perguntar preço, valor ou investimento. Use 'cronograma_e_valor' quando o lead pedir explicitamente as duas coisas. Quando o lead INSISTIR que só pode resolver pelo WhatsApp (segunda objeção de canal), chame esta função com 'cronograma' E a consulta_objecoes NA MESMA resposta: o cronograma atende o pedido dele e a quebra de objeção reforça que a condição do primeiro lote promocional é apresentada na reunião com o monitor. Se a pendência for recebimento ou acesso ao material, resolva essa dificuldade antes de retomar a objeção ou o agendamento.\n\nConfira o curso e o histórico antes de enviar. Não repita o mesmo material sem novo pedido ou falha. Se o lead pedir novamente, disser que não recebeu, não encontrou ou não consegue abrir, faça uma nova tentativa com 'cronograma', mesmo que exista um tool_result antigo ou registro de envio humano. O relato do lead permite o reenvio; nunca insista que ele recebeu, que o sistema confirma a entrega ou que basta procurar acima na conversa. Depois da tentativa, aguarde a confirmação de acesso antes de perguntar sobre leitura, opinião ou agendamento. Se ela falhar ou o arquivo estiver indisponível, explique a dificuldade e encaminhe para ajuda humana pela ferramenta apropriada, sem repetir envios em loop.\n\nResponda conforme o status atual retornado pela função. Solicitação aceita não comprova entrega; entrega registrada não comprova que o lead abriu o arquivo. Se o retorno indicar falha, reconheça que o material não foi enviado e não prometa envio posterior sem providenciar uma ação efetiva. Só confirme entrega quando houver confirmação de entrega; nunca transforme um registro antigo de envio em prova contra o relato do lead. NUNCA invente valor, parcela ou desconto que não esteja no retorno; a condição especial em cima do valor integral é apresentada apenas no Meet.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome.\nFICHA DO ATENDIMENTO: antes de chamar para cronograma, leia o bloco [FICHA DO ATENDIMENTO] no fim da última mensagem. Se houver FALTA COLETAR, faça a pergunta indicada e só chame depois da resposta (ou se ele insistir sem responder). O sistema recusa o envio enquanto faltar dado e devolve PRECISA_COLETAR com o que perguntar."
  },
  "temporizador_proxima_turma__aula": {
    "name": "temporizador_proxima_turma",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo"
      ],
      "properties": {
        "curso": {
          "type": "string",
          "description": "Curso de interesse do lead, se você souber. Vazio = usa o curso já conhecido da conversa."
        },
        "motivo": {
          "type": "string",
          "description": "Frase curta com o que o lead pediu. Ex.: 'Lead pediu pra ser chamado quando abrir a próxima turma'."
        }
      }
    },
    "description": "Agendar o recontato do lead para a PRÓXIMA TURMA do curso dele. Use SEMPRE que o lead disser que prefere ser chamado quando abrir a próxima turma, \"me chama mais pra frente\", \"agora não posso, me procura depois\" — em vez de pausa_ia. A função busca a data real da próxima turma no sistema, agenda o temporizador de recontato (o lead fica FORA de todos os disparos em massa até lá) e a IA é pausada em seguida. Chame UMA vez só, na mesma resposta da sua mensagem de despedida. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "consulta_pos_disponiveis__aula": {
    "name": "consulta_pos_disponiveis",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "trocar_para": {
          "type": "string",
          "description": "Pós explicitamente escolhida pelo lead. Valida e registra; não use só porque ele perguntou se existe ou como funciona."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome exato dito pelo lead para verificar existência/modalidade. Somente consulta, sem mudar o interesse."
        }
      },
      "additionalProperties": false
    },
    "description": "Fonte obrigatória do catálogo de pós ATIVAS e modalidades por curso. Chame quando o lead mencionar uma pós ainda não validada, inclusive na PRIMEIRA escolha de interesse, ou perguntar se temos uma pós, quais existem, qual é online ou semipresencial. Antes de confirmar que oferecemos, falar em matrícula/condição ou encaminhar para agenda, valide o nome aqui. Repetir o nome dito pelo lead NÃO comprova existência: clínica de pequenos animais não equivale a clínica de bovinos. Use curso_consulta para consultar sem alterar interesse, inclusive dúvidas sobre outra pós. Use trocar_para SOMENTE quando o lead tiver escolhido explicitamente aquela pós. Sem parâmetros lista catálogo e modalidades. Não passe os dois campos juntos. Respeite status: só curso_confirmado/interesse_atualizado autoriza adotar o curso; semelhança textual exige esclarecimento, nunca troca automática. Se não encontrado, diga que não temos essa pós e ofereça apenas alternativas reais pertinentes, aguardando escolha. Não invente modalidade, conteúdo, cidade, frequência ou carga horária. O retorno específico prevalece sobre frases genéricas de objeção ou conhecimento anterior. Depois de responder, siga qualificando e agendando conforme o interesse validado."
  },
  "pausa_ia__aula": {
    "name": "pausa_ia",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo",
        "tipo"
      ],
      "properties": {
        "tipo": {
          "enum": [
            "pausa",
            "nao_perturbe",
            "sem_graduacao"
          ],
          "type": "string",
          "description": "Tipo de parada. \"sem_graduacao\" = o lead NÃO tem graduação nenhuma e NÃO está cursando uma (só ensino médio e/ou técnico): como a pós é lato sensu, ele nunca vai poder se matricular. ARQUIVA o contato, RESOLVE a conversa e tira o lead de TODOS os disparos, campanhas e follow-ups. ⚠️ NUNCA use \"sem_graduacao\" para quem está CURSANDO a graduação — esse volta a ser elegível quando se formar, e o caminho dele é a tool agendar_retorno com tipo=\"formatura\". \"nao_perturbe\" = OPT-OUT: o lead não quer mais ser contatado. ARQUIVA o contato, resolve as conversas e tira o lead de TODOS os disparos, campanhas e follow-ups — use sempre que o lead confirmar desinteresse (depois da pergunta de retenção) ou pedir pra não ser mais notificado. \"pausa\" = apenas parar a automação para atendimento humano/personalizado (pediu ligação, pagou a matrícula, quer falar com alguém, já é aluno, ou é graduado em área incompatível com AQUELA pós): o lead CONTINUA no fluxo e SEGUE recebendo disparos e campanhas, então NUNCA use \"pausa\" para quem pediu pra parar de receber mensagens nem para quem não tem graduação nenhuma."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "Para tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPausar o atendimento automático. Use quando o lead pedir atendimento humano, pedir ligação, informar que pagou a matrícula, pedir cancelamento/remarcação, ou for desqualificado (não tem graduação nenhuma / é graduado em área incompatível). ⚠️ DESINTERESSE/OPT-OUT ('não quero mais', 'não me notifique', 'pode parar', 'me tira da lista', 'perdi o interesse'): NÃO use esta tool de primeira. Antes, faça a pergunta de retenção EXPLÍCITA: o lead não tem interesse mesmo, ou prefere ser chamado quando abrir a PRÓXIMA TURMA? Só pause por desinteresse se essa pergunta já aparece LITERALMENTE no histórico (nunca conte como feita 'implicitamente') e o lead reiterou o não. Se o lead preferir a próxima turma, use temporizador_proxima_turma em vez desta. Escolha tipo=\"nao_perturbe\" quando o lead claramente não quer ser contatado (desinteresse confirmado após a retenção); tipo=\"sem_graduacao\" quando ele NÃO tem graduação nenhuma e nem está cursando uma (só ensino médio e/ou técnico) — nunca será elegível, então o contato é ARQUIVADO e a conversa RESOLVIDA; tipo=\"pausa\" para atendimento humano/personalizado, ligação, lead que já é aluno, ou formação incompatível (ele É graduado, mas a área não atende AQUELA pós — pode servir pra outra). ⚠️ Lead que ainda está CURSANDO a graduação NÃO entra nesta tool: o caminho dele é agendar_retorno com tipo=\"formatura\". ⚠️ LEAD QUE JÁ É ALUNO (diz que já faz/cursa uma pós da PPG, que \"já estou no Nº mês\", que já é matriculado): use ESTA tool com tipo=\"pausa\" IMEDIATAMENTE, logo na primeira vez que ele disser. Antes de pausar, mande UMA mensagem curta assumindo o engano (\"esse convite era pra quem ainda não é aluno, desculpa a confusão\") e diga que alguém do suporte fala com ele. É PROIBIDO seguir qualificando, oferecer horário, agendar reunião ou inventar qualquer outro motivo pra conversa (ex.: dizer que a reunião é \"com o monitor do seu curso\" ou \"pra ver como está sua experiência\" — isso NÃO existe). Aluno que quer OUTRA pós também para aqui: quem cuida disso é o humano. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "atualizar_dados_lead__aula": {
    "name": "atualizar_dados_lead",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "nome": {
          "type": "string",
          "description": "Nome do lead exatamente como ele informou (ex.: \"Carlos Badia\"). Só o nome, sem saudação nem frase."
        },
        "formacao": {
          "type": "string",
          "description": "Nome do curso de GRADUAÇÃO do lead (ex.: \"Medicina Veterinária\", \"Zootecnia\"). Nunca valores vagos como \"formado\", \"estudante\" ou \"graduação\" — se ele responder assim, pergunte qual é o curso."
        },
        "qual_pos": {
          "type": "string",
          "description": "Qual pós-graduação ele já tem, se disse (ex.: 'clínica de pequenos animais')."
        },
        "possui_pos": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se o lead já possui alguma pós-graduação, com as palavras dele. Pergunte só depois de enviar o cronograma e só quando a graduação está concluída."
        },
        "area_atuacao": {
          "type": "string",
          "description": "Área em que o lead atua HOJE, com as palavras dele (ex.: 'clínica de pequenos animais', 'venda de insumos', 'não trabalha na área'). Registre assim que ele disser."
        },
        "atua_na_area": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se ele atua na área da pós de interesse: 'sim' quando ficou claro na conversa que trabalha nela; 'nao' quando disse que não atua ou atua em outra área."
        },
        "tempo_formacao": {
          "type": "string",
          "description": "O que o lead disse sobre a CONCLUSÃO da graduação, em poucas palavras (ex.: \"formado há 2 anos\", \"formado\", \"cursando, conclui em dez/2026\"). É isso que separa graduado de quem ainda cursa."
        },
        "graduacao_concluida": {
          "enum": [
            "sim",
            "cursando",
            "nao"
          ],
          "type": "string",
          "description": "'sim' = graduação concluída (formado); 'cursando' = ainda na faculdade (mande também tempo_formacao com a previsão de conclusão); 'nao' = disse que não tem graduação nenhuma (só ensino médio/técnico)."
        }
      }
    },
    "description": "Registra no cadastro o NOME, a GRADUAÇÃO e o TEMPO DE FORMAÇÃO que o lead informou. Chame assim que souber cada dado. NÃO puxe o assunto só para preencher. Roda em segundo plano: nunca comente com o lead que salvou os dados.\nFICHA DO ATENDIMENTO: registre também area_atuacao, atua_na_area e graduacao_concluida assim que o lead informar. É isso que libera o envio do cronograma e evita repetir pergunta já respondida."
  },
  "verificar_compatibilidade_curso__aula": {
    "name": "verificar_compatibilidade_curso",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "formacao_academica",
        "curso_interesse"
      ],
      "properties": {
        "area_trabalho": {
          "type": "string",
          "description": "OPCIONAL. Área de atuação profissional do lead. Informar quando já foi coletada no fluxo."
        },
        "curso_interesse": {
          "type": "string",
          "description": "Nome EXATO da pós que o lead quer AGORA. Use o curso_alternativo se ele aceitou a troca. A decisão será registrada para esse curso; informe o mesmo curso em confirmar_agendamento."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Mês e ano em que o lead conclui a graduação, no formato \"MM/AAAA\" (ex.: \"12/2026\"), conforme VOCÊ entendeu a resposta dele. Informe junto com conclusao_graduacao_bruta sempre que o lead ainda estiver cursando. Só preencha quando a resposta trouxer ANO (\"2027.1\", \"dezembro de 2026\") ou prazo explícito (\"em uns 2 anos\", \"faltam 6 meses\"). NUNCA converta um número de semestre/período em data por conta própria: \"2 semestre\" não diz o ano, e chutar já agendou aluno de 1º ano."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "O que o lead declarou sobre a graduação. normal = graduação CONCLUÍDA: declarada (\"me formei\", \"já concluí\", \"sim\" à pergunta sobre conclusão) OU título profissional dito sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária). Auxiliar/técnico, profissão de outra pessoa, intenção, negação e cargo genérico não contam; nome isolado do curso e trabalho na área não confirmam conclusão. Quem AINDA CURSA nunca usa normal. estudante_apto = conclui até a DATA-LIMITE que vem no contexto temporal; estudante_fora_do_prazo = conclui depois dela (\"ano que vem\" sozinho não reprova: compare com a data do contexto, não recalcule). Envie a resposta literal em conclusao_graduacao_bruta e o MM/AAAA em conclusao_graduacao. Se faltar saber se concluiu ou quando conclui, pergunte só isso. Semestre/período não é data. correcao_sem_formacao = estava marcado Sem Formação e confirmou graduação concluída com o nome do curso. Este campo descreve o que o lead disse; quem decide é a ferramenta."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "OBRIGATÓRIO quando contexto_qualificacao for estudante_apto ou estudante_fora_do_prazo. Cole aqui, LITERALMENTE, o que o lead respondeu sobre quando conclui a graduação — sem interpretar, sem normalizar, sem corrigir (ex.: \"2 semestre\", \"tô no último ano, termino em 2027.1\", \"faltam uns 6 meses\"). O sistema relê esta resposta e é ELE quem decide o prazo. Se a resposta for a posição no curso e não uma data, ele devolve PRECISA_DATA_CONCLUSAO e você pergunta o mês/ano ao lead."
        }
      }
    },
    "description": "PRIMEIRA função depois que a graduação do lead está identificada, e SEMPRE ANTES de confirmar_agendamento. Verifica se a formação permite cursar a pós de interesse e registra a decisão para este lead e este curso.\n\nQUANDO CHAMAR: assim que o lead informar a graduação, ou quando ele se apresentar com título profissional sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária): nesse caso a graduação conta como concluída e você chama direto, sem perguntar de novo qual é a graduação nem se concluiu. Chame de novo se a pós mudou ou se ele aceitou o curso_alternativo. NÃO chame junto com confirmar_agendamento: aguarde o resultado. NÃO chame sem o nome específico da graduação, nem em conversa que é só sobre aula aberta.\n\nO QUE O RETORNO LIBERA: APROVADO = pode seguir para confirmar_agendamento do MESMO curso (não cria reunião por si só). REPROVADO com curso_alternativo = ofereça a alternativa e, se ele aceitar, verifique essa pós antes de agendar. REPROVADO sem alternativa = encerre pelo caminho previsto. REPROVADO_PRAZO = estudante que conclui depois da data-limite: não agende e chame agendar_retorno com tipo=\"formatura\". PRECISA_DATA_CONCLUSAO = pergunte só o mês e o ano em que ele conclui. FALHA_TECNICA ou pendência = não trate como apto nem agende; tente de novo na próxima rodada.\n\nNunca cite prazo, data-limite, régua ou elegibilidade ao lead, e não comente o resultado com ele."
  },
  "agendar_retorno__aula": {
    "name": "agendar_retorno",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "tipo"
      ],
      "properties": {
        "dias": {
          "type": "integer",
          "maximum": 7,
          "minimum": 1,
          "description": "Só para tipo=\"analise\": em quantos dias o lead pediu pra ser chamado (1 a 7)."
        },
        "tipo": {
          "enum": [
            "analise",
            "formatura"
          ],
          "type": "string",
          "description": "\"analise\" = pediu tempo pra ver o material (use `dias`). \"formatura\" = ainda cursando a graduação (use `meses`)."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só para tipo=\"formatura\": quantos meses faltam pra ele concluir a graduação. O sistema limita ao teto de 12."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Não use para ausência momentânea ou para registrar uma hora de retorno por WhatsApp. Sem prazo informado, pergunte quando pode chamar; não invente dias. Esta ferramenta não agenda hora exata nem reunião.\nAgendar o RETORNO do lead pra uma data futura, em dois casos. CASO 1 (tipo=\"analise\"): o lead pediu tempo pra analisar/ler/ver o material ou pra pensar. Pergunte ANTES quando pode chamá-lo e só chame esta função DEPOIS que ele disser o prazo; converta em dias (\"amanhã\"=1, \"semana que vem\"=7, \"uns dias\"=3). O máximo é 7 dias — prazo maior que isso NÃO usa este caso: negocie pra dentro da semana ou use temporizador_proxima_turma. CASO 2 (tipo=\"formatura\"): o lead AINDA ESTÁ CURSANDO a graduação e conclui longe demais pra entrar agora. Ele NÃO está desinteressado — vai poder cursar quando se formar, então NUNCA use pausa_ia nesse caso. Informe em `meses` quantos meses faltam pra ele concluir (conclui em 2028 e estamos em 2026 → 24); o sistema limita ao teto de 12 meses sozinho. Não pergunte prazo ao lead aqui: use o que ele já disse sobre quando termina o curso. Nos dois casos o lead fica fora dos disparos até a data e o time o retoma. Chame UMA vez só, na mesma resposta em que se despede. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "envia_informacoes__campanha": {
    "name": "envia_informacoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "conteudo"
      ],
      "properties": {
        "conteudo": {
          "enum": [
            "cronograma",
            "valor",
            "cronograma_e_valor"
          ],
          "type": "string",
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' (valor integral retornado pra você informar na conversa), 'cronograma_e_valor' (ambos)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia informações da pós de interesse ao lead. Três modos: 'cronograma' solicita o envio do PDF do cronograma detalhado no WhatsApp do lead; 'valor' retorna o valor integral (sem desconto) para VOCÊ informar com suas palavras; 'cronograma_e_valor' faz os dois. Use 'cronograma' quando o lead pedir cronograma, grade, conteúdo programático, ementa, datas das aulas ou 'me manda mais informações'. Use 'valor' sempre que o lead perguntar preço, valor ou investimento. Use 'cronograma_e_valor' quando o lead pedir explicitamente as duas coisas. Quando o lead INSISTIR que só pode resolver pelo WhatsApp (segunda objeção de canal), chame esta função com 'cronograma' E a consulta_objecoes NA MESMA resposta: o cronograma atende o pedido dele e a quebra de objeção reforça que a condição do primeiro lote promocional é apresentada na reunião com o monitor. Se a pendência for recebimento ou acesso ao material, resolva essa dificuldade antes de retomar a objeção ou o agendamento.\n\nConfira o curso e o histórico antes de enviar. Não repita o mesmo material sem novo pedido ou falha. Se o lead pedir novamente, disser que não recebeu, não encontrou ou não consegue abrir, faça uma nova tentativa com 'cronograma', mesmo que exista um tool_result antigo ou registro de envio humano. O relato do lead permite o reenvio; nunca insista que ele recebeu, que o sistema confirma a entrega ou que basta procurar acima na conversa. Depois da tentativa, aguarde a confirmação de acesso antes de perguntar sobre leitura, opinião ou agendamento. Se ela falhar ou o arquivo estiver indisponível, explique a dificuldade e encaminhe para ajuda humana pela ferramenta apropriada, sem repetir envios em loop.\n\nResponda conforme o status atual retornado pela função. Solicitação aceita não comprova entrega; entrega registrada não comprova que o lead abriu o arquivo. Se o retorno indicar falha, reconheça que o material não foi enviado e não prometa envio posterior sem providenciar uma ação efetiva. Só confirme entrega quando houver confirmação de entrega; nunca transforme um registro antigo de envio em prova contra o relato do lead. NUNCA invente valor, parcela ou desconto que não esteja no retorno; a condição especial em cima do valor integral é apresentada apenas no Meet.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome.\nFICHA DO ATENDIMENTO: antes de chamar para cronograma, leia o bloco [FICHA DO ATENDIMENTO] no fim da última mensagem. Se houver FALTA COLETAR, faça a pergunta indicada e só chame depois da resposta (ou se ele insistir sem responder). O sistema recusa o envio enquanto faltar dado e devolve PRECISA_COLETAR com o que perguntar."
  },
  "temporizador_proxima_turma__campanha": {
    "name": "temporizador_proxima_turma",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo"
      ],
      "properties": {
        "curso": {
          "type": "string",
          "description": "Curso de interesse do lead, se você souber. Vazio = usa o curso já conhecido da conversa."
        },
        "motivo": {
          "type": "string",
          "description": "Frase curta com o que o lead pediu. Ex.: 'Lead pediu pra ser chamado quando abrir a próxima turma'."
        }
      }
    },
    "description": "Agendar o recontato do lead para a PRÓXIMA TURMA do curso dele. Use SEMPRE que o lead disser que prefere ser chamado quando abrir a próxima turma, \"me chama mais pra frente\", \"agora não posso, me procura depois\" — em vez de pausa_ia. A função busca a data real da próxima turma no sistema, agenda o temporizador de recontato (o lead fica FORA de todos os disparos em massa até lá) e a IA é pausada em seguida. Chame UMA vez só, na mesma resposta da sua mensagem de despedida. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "consulta_pos_disponiveis__campanha": {
    "name": "consulta_pos_disponiveis",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "trocar_para": {
          "type": "string",
          "description": "Pós explicitamente escolhida pelo lead. Valida e registra; não use só porque ele perguntou se existe ou como funciona."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome exato dito pelo lead para verificar existência/modalidade. Somente consulta, sem mudar o interesse."
        }
      },
      "additionalProperties": false
    },
    "description": "Fonte obrigatória do catálogo de pós ATIVAS e modalidades por curso. Chame quando o lead mencionar uma pós ainda não validada, inclusive na PRIMEIRA escolha de interesse, ou perguntar se temos uma pós, quais existem, qual é online ou semipresencial. Antes de confirmar que oferecemos, falar em matrícula/condição ou encaminhar para agenda, valide o nome aqui. Repetir o nome dito pelo lead NÃO comprova existência: clínica de pequenos animais não equivale a clínica de bovinos. Use curso_consulta para consultar sem alterar interesse, inclusive dúvidas sobre outra pós. Use trocar_para SOMENTE quando o lead tiver escolhido explicitamente aquela pós. Sem parâmetros lista catálogo e modalidades. Não passe os dois campos juntos. Respeite status: só curso_confirmado/interesse_atualizado autoriza adotar o curso; semelhança textual exige esclarecimento, nunca troca automática. Se não encontrado, diga que não temos essa pós e ofereça apenas alternativas reais pertinentes, aguardando escolha. Não invente modalidade, conteúdo, cidade, frequência ou carga horária. O retorno específico prevalece sobre frases genéricas de objeção ou conhecimento anterior. Depois de responder, siga qualificando e agendando conforme o interesse validado."
  },
  "verificar_compatibilidade_curso__campanha": {
    "name": "verificar_compatibilidade_curso",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "formacao_academica",
        "curso_interesse"
      ],
      "properties": {
        "area_trabalho": {
          "type": "string",
          "description": "OPCIONAL. Área de atuação profissional do lead. Informar quando já foi coletada no fluxo."
        },
        "curso_interesse": {
          "type": "string",
          "description": "Nome EXATO da pós que o lead quer AGORA. Use o curso_alternativo se ele aceitou a troca. A decisão será registrada para esse curso; informe o mesmo curso em confirmar_agendamento."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Mês e ano em que o lead conclui a graduação, no formato \"MM/AAAA\" (ex.: \"12/2026\"), conforme VOCÊ entendeu a resposta dele. Informe junto com conclusao_graduacao_bruta sempre que o lead ainda estiver cursando. Só preencha quando a resposta trouxer ANO (\"2027.1\", \"dezembro de 2026\") ou prazo explícito (\"em uns 2 anos\", \"faltam 6 meses\"). NUNCA converta um número de semestre/período em data por conta própria: \"2 semestre\" não diz o ano, e chutar já agendou aluno de 1º ano."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "O que o lead declarou sobre a graduação. normal = graduação CONCLUÍDA: declarada (\"me formei\", \"já concluí\", \"sim\" à pergunta sobre conclusão) OU título profissional dito sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária). Auxiliar/técnico, profissão de outra pessoa, intenção, negação e cargo genérico não contam; nome isolado do curso e trabalho na área não confirmam conclusão. Quem AINDA CURSA nunca usa normal. estudante_apto = conclui até a DATA-LIMITE que vem no contexto temporal; estudante_fora_do_prazo = conclui depois dela (\"ano que vem\" sozinho não reprova: compare com a data do contexto, não recalcule). Envie a resposta literal em conclusao_graduacao_bruta e o MM/AAAA em conclusao_graduacao. Se faltar saber se concluiu ou quando conclui, pergunte só isso. Semestre/período não é data. correcao_sem_formacao = estava marcado Sem Formação e confirmou graduação concluída com o nome do curso. Este campo descreve o que o lead disse; quem decide é a ferramenta."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "OBRIGATÓRIO quando contexto_qualificacao for estudante_apto ou estudante_fora_do_prazo. Cole aqui, LITERALMENTE, o que o lead respondeu sobre quando conclui a graduação — sem interpretar, sem normalizar, sem corrigir (ex.: \"2 semestre\", \"tô no último ano, termino em 2027.1\", \"faltam uns 6 meses\"). O sistema relê esta resposta e é ELE quem decide o prazo. Se a resposta for a posição no curso e não uma data, ele devolve PRECISA_DATA_CONCLUSAO e você pergunta o mês/ano ao lead."
        }
      }
    },
    "description": "PRIMEIRA função depois que a graduação do lead está identificada, e SEMPRE ANTES de confirmar_agendamento. Verifica se a formação permite cursar a pós de interesse e registra a decisão para este lead e este curso.\n\nQUANDO CHAMAR: assim que o lead informar a graduação, ou quando ele se apresentar com título profissional sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária): nesse caso a graduação conta como concluída e você chama direto, sem perguntar de novo qual é a graduação nem se concluiu. Chame de novo se a pós mudou ou se ele aceitou o curso_alternativo. NÃO chame junto com confirmar_agendamento: aguarde o resultado. NÃO chame sem o nome específico da graduação, nem em conversa que é só sobre aula aberta.\n\nO QUE O RETORNO LIBERA: APROVADO = pode seguir para confirmar_agendamento do MESMO curso (não cria reunião por si só). REPROVADO com curso_alternativo = ofereça a alternativa e, se ele aceitar, verifique essa pós antes de agendar. REPROVADO sem alternativa = encerre pelo caminho previsto. REPROVADO_PRAZO = estudante que conclui depois da data-limite: não agende e chame agendar_retorno com tipo=\"formatura\". PRECISA_DATA_CONCLUSAO = pergunte só o mês e o ano em que ele conclui. FALHA_TECNICA ou pendência = não trate como apto nem agende; tente de novo na próxima rodada.\n\nNunca cite prazo, data-limite, régua ou elegibilidade ao lead, e não comente o resultado com ele."
  },
  "consulta_disponibilidade__campanha": {
    "name": "consulta_disponibilidade",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "data_desejada"
      ],
      "properties": {
        "data_desejada": {
          "type": "string",
          "description": "Data no formato YYYY-MM-DD, calculada a partir do contexto temporal. Nunca null. Nunca a mais de dois dias da data atual."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "periodo_desejado": {
          "enum": [
            "manhã",
            "tarde",
            "noite",
            "qualquer"
          ],
          "type": "string",
          "description": "Período do dia: manhã (até 12h), tarde (12h às 19h), noite (após 19h) ou qualquer. Use o que o lead pediu; se não especificou, qualquer."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional. Horário no formato HH:mm (ex.: 20:00). Tem prioridade sobre periodo_desejado; a busca traz horários a partir dele."
        }
      }
    },
    "description": "Esta ferramenta consulta horários de REUNIÃO, não de retorno por mensagem. Ausência momentânea (\"agora não posso atender\") exige perguntar quando pode chamar por aqui, sem consultar agenda. Uma data/hora respondida a essa pergunta é retorno no canal, não aceite de Meet. Só consulte para interesse explícito em agendar a reunião.\nFINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nFunção única do fluxo de horários. Chame assim que o lead aceitar marcar a conversa. A partir da pós de interesse, retorna os horários livres (slots de 30 min) já com o monitor selecionado por menor carga, considerando todos os monitores que atendem a pós. Apresente somente horários retornados, identificando que são para a conversa com o monitor sobre a pós, no fuso de Brasília, sem citar nomes de monitores. Nunca ofereça horário sem antes executar esta função. IMPORTANTE: consultar disponibilidade NAO reserva nada. Voce NAO tem a funcao de agendar (confirmar_agendamento nao existe nesta etapa): o horario so fica marcado quando a etapa seguinte cria o agendamento. Depois que o lead escolher um horario, e PROIBIDO dizer que a reuniao esta marcada, confirmada, reservada ou encaixada, prometer que vai \"encaminhar o encaixe\", que \"o link chega em breve\" ou que \"o monitor entra em contato\", e mandar qualquer link de meet. Repita o horario escolhido e diga que falta um passo rapido pra fechar. REGRA OBRIGATORIA PARA PEDIDO IMPOSSIVEL: compare o pedido mais recente do lead com os horarios de funcionamento do contexto temporal. Se ele pedir domingo, sabado a tarde/noite ou madrugada, NAO consulte a data ou o periodo impossivel. Explique de forma curta que nao ha atendimento nesse periodo, escolha o proximo periodo valido permitido pelo contexto e CHAME esta funcao para essa data valida. So depois ofereca os horarios exatos retornados. Deixe claro que sao uma alternativa; nunca troque a data silenciosamente. Exemplo: para \"domingo as 22h\", avise que domingo nao tem atendimento, consulte o proximo periodo valido e ofereca apenas os slots retornados.\nSe o lead propôs data e hora concretas para a reunião, consulte exatamente essa opção, mesmo sem oferta anterior do SDR. Não desloque 13:00 para 13:30 por uma tabela genérica. Se o mesmo dia e horário aparecer em slots_raw, preserve a escolha e avance apenas nas pendências de qualificação; não abra um novo menu de horários. Disponibilidade não é aprovação nem agendamento. Se a opção estiver ausente, ofereça alternativas reais e aguarde nova escolha.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome."
  },
  "consulta_objecoes__campanha": {
    "name": "consulta_objecoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "mensagem_lead",
        "tipo_objecao"
      ],
      "properties": {
        "tipo_objecao": {
          "enum": [
            "objecao_tempo",
            "objecao_canal",
            "pergunta_preco",
            "objecao_financeira",
            "objecao_adiamento",
            "objecao_desconfianca",
            "objecao_duvida",
            "pergunta_condicao",
            "objecao_terceiro",
            "pergunta_modalidade",
            "pergunta_instituicao"
          ],
          "type": "string",
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (quanto custa/qual valor — o lead PERGUNTA o preço), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (vou pensar/depois te falo), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (online/presencial/EAD), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
        },
        "mensagem_lead": {
          "type": "string",
          "description": "A mensagem EXATA e completa do lead, do jeito que ele escreveu, sem reformular. É essa frase que busca a melhor resposta no RAG por similaridade de significado — então mande o texto cru. Ex: 'não tenho tempo agora', 'quanto custa essa pós?', 'prefiro por whatsapp', 'vou ver com minha esposa', 'nunca ouvi falar de vocês'."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome da pós mencionada na dúvida de modalidade; não altera o interesse."
        }
      }
    },
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso."
  },
  "pausa_ia__campanha": {
    "name": "pausa_ia",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo",
        "tipo"
      ],
      "properties": {
        "tipo": {
          "enum": [
            "pausa",
            "nao_perturbe",
            "sem_graduacao"
          ],
          "type": "string",
          "description": "Tipo de parada. \"sem_graduacao\" = o lead NÃO tem graduação nenhuma e NÃO está cursando uma (só ensino médio e/ou técnico): como a pós é lato sensu, ele nunca vai poder se matricular. ARQUIVA o contato, RESOLVE a conversa e tira o lead de TODOS os disparos, campanhas e follow-ups. ⚠️ NUNCA use \"sem_graduacao\" para quem está CURSANDO a graduação — esse volta a ser elegível quando se formar, e o caminho dele é a tool agendar_retorno com tipo=\"formatura\". \"nao_perturbe\" = OPT-OUT: o lead não quer mais ser contatado. ARQUIVA o contato, resolve as conversas e tira o lead de TODOS os disparos, campanhas e follow-ups — use sempre que o lead confirmar desinteresse (depois da pergunta de retenção) ou pedir pra não ser mais notificado. \"pausa\" = apenas parar a automação para atendimento humano/personalizado (pediu ligação, pagou a matrícula, quer falar com alguém, já é aluno, ou é graduado em área incompatível com AQUELA pós): o lead CONTINUA no fluxo e SEGUE recebendo disparos e campanhas, então NUNCA use \"pausa\" para quem pediu pra parar de receber mensagens nem para quem não tem graduação nenhuma."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "Para tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPausar o atendimento automático. Use quando o lead pedir atendimento humano, pedir ligação, informar que pagou a matrícula, pedir cancelamento/remarcação, ou for desqualificado (não tem graduação nenhuma / é graduado em área incompatível). ⚠️ DESINTERESSE/OPT-OUT ('não quero mais', 'não me notifique', 'pode parar', 'me tira da lista', 'perdi o interesse'): NÃO use esta tool de primeira. Antes, faça a pergunta de retenção EXPLÍCITA: o lead não tem interesse mesmo, ou prefere ser chamado quando abrir a PRÓXIMA TURMA? Só pause por desinteresse se essa pergunta já aparece LITERALMENTE no histórico (nunca conte como feita 'implicitamente') e o lead reiterou o não. Se o lead preferir a próxima turma, use temporizador_proxima_turma em vez desta. Escolha tipo=\"nao_perturbe\" quando o lead claramente não quer ser contatado (desinteresse confirmado após a retenção); tipo=\"sem_graduacao\" quando ele NÃO tem graduação nenhuma e nem está cursando uma (só ensino médio e/ou técnico) — nunca será elegível, então o contato é ARQUIVADO e a conversa RESOLVIDA; tipo=\"pausa\" para atendimento humano/personalizado, ligação, lead que já é aluno, ou formação incompatível (ele É graduado, mas a área não atende AQUELA pós — pode servir pra outra). ⚠️ Lead que ainda está CURSANDO a graduação NÃO entra nesta tool: o caminho dele é agendar_retorno com tipo=\"formatura\". ⚠️ LEAD QUE JÁ É ALUNO (diz que já faz/cursa uma pós da PPG, que \"já estou no Nº mês\", que já é matriculado): use ESTA tool com tipo=\"pausa\" IMEDIATAMENTE, logo na primeira vez que ele disser. Antes de pausar, mande UMA mensagem curta assumindo o engano (\"esse convite era pra quem ainda não é aluno, desculpa a confusão\") e diga que alguém do suporte fala com ele. É PROIBIDO seguir qualificando, oferecer horário, agendar reunião ou inventar qualquer outro motivo pra conversa (ex.: dizer que a reunião é \"com o monitor do seu curso\" ou \"pra ver como está sua experiência\" — isso NÃO existe). Aluno que quer OUTRA pós também para aqui: quem cuida disso é o humano. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "atualizar_dados_lead__campanha": {
    "name": "atualizar_dados_lead",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "nome": {
          "type": "string",
          "description": "Nome do lead exatamente como ele informou (ex.: \"Carlos Badia\", \"Ana Paula\"). Só o nome, sem saudação nem frase."
        },
        "formacao": {
          "type": "string",
          "description": "Nome do curso de GRADUAÇÃO do lead (ex.: \"Medicina Veterinária\", \"Zootecnia\"). Nunca valores vagos como \"formado\", \"estudante\" ou \"graduação\" — se ele responder assim, pergunte qual é o curso."
        },
        "qual_pos": {
          "type": "string",
          "description": "Qual pós-graduação ele já tem, se disse (ex.: 'clínica de pequenos animais')."
        },
        "possui_pos": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se o lead já possui alguma pós-graduação, com as palavras dele. Pergunte só depois de enviar o cronograma e só quando a graduação está concluída."
        },
        "area_atuacao": {
          "type": "string",
          "description": "Área em que o lead atua HOJE, com as palavras dele (ex.: 'clínica de pequenos animais', 'venda de insumos', 'não trabalha na área'). Registre assim que ele disser."
        },
        "atua_na_area": {
          "enum": [
            "sim",
            "nao"
          ],
          "type": "string",
          "description": "Se ele atua na área da pós de interesse: 'sim' quando ficou claro na conversa que trabalha nela; 'nao' quando disse que não atua ou atua em outra área."
        },
        "tempo_formacao": {
          "type": "string",
          "description": "O que o lead disse sobre a CONCLUSÃO da graduação, em poucas palavras (ex.: \"formado há 2 anos\", \"formado\", \"cursando, conclui em dez/2026\", \"cursando, conclui em 2027.1\"). Preencha assim que souber: é isso que separa graduado de quem ainda cursa."
        },
        "graduacao_concluida": {
          "enum": [
            "sim",
            "cursando",
            "nao"
          ],
          "type": "string",
          "description": "'sim' = graduação concluída (formado); 'cursando' = ainda na faculdade (mande também tempo_formacao com a previsão de conclusão); 'nao' = disse que não tem graduação nenhuma (só ensino médio/técnico)."
        }
      }
    },
    "description": "Registra no cadastro o NOME, a GRADUAÇÃO e o TEMPO DE FORMAÇÃO que o lead informou. Este número é de anúncio e o cadastro chega VAZIO, então SEM esta função os dados se perdem: o time acaba chamando o lead pelo apelido do WhatsApp (\"Morro😎😎\", \"Tio Júlio\") e ninguém sabe a formação dele. Chame IMEDIATAMENTE a cada dado novo, e SEMPRE na mesma volta em que enviar o cronograma (o cronograma é a troca pelos dados). Pode mandar os campos juntos quando vierem juntos. Passe os valores como o lead escreveu, sem inventar sobrenome. NÃO chame com \"não sei\", \"sim\", saudação, telefone ou a frase inteira do lead. Registrar a graduação aqui NÃO substitui a verificar_compatibilidade_curso, que continua obrigatória pra decidir a elegibilidade. Roda em segundo plano: NUNCA comente com o lead que registrou ou salvou os dados dele.\nFICHA DO ATENDIMENTO: registre também area_atuacao, atua_na_area e graduacao_concluida assim que o lead informar. É isso que libera o envio do cronograma e evita repetir pergunta já respondida."
  },
  "agendar_retorno__campanha": {
    "name": "agendar_retorno",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "tipo"
      ],
      "properties": {
        "dias": {
          "type": "integer",
          "maximum": 7,
          "minimum": 1,
          "description": "Só para tipo=\"analise\": em quantos dias o lead pediu pra ser chamado (1 a 7)."
        },
        "tipo": {
          "enum": [
            "analise",
            "formatura"
          ],
          "type": "string",
          "description": "\"analise\" = pediu tempo pra ver o material (use `dias`). \"formatura\" = ainda cursando a graduação (use `meses`)."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só para tipo=\"formatura\": quantos meses faltam pra ele concluir a graduação. O sistema limita ao teto de 12."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Não use para ausência momentânea ou para registrar uma hora de retorno por WhatsApp. Sem prazo informado, pergunte quando pode chamar; não invente dias. Esta ferramenta não agenda hora exata nem reunião.\nAgendar o RETORNO do lead pra uma data futura, em dois casos. CASO 1 (tipo=\"analise\"): o lead pediu tempo pra analisar/ler/ver o material ou pra pensar. Pergunte ANTES quando pode chamá-lo e só chame esta função DEPOIS que ele disser o prazo; converta em dias (\"amanhã\"=1, \"semana que vem\"=7, \"uns dias\"=3). O máximo é 7 dias — prazo maior que isso NÃO usa este caso: negocie pra dentro da semana ou use temporizador_proxima_turma. CASO 2 (tipo=\"formatura\"): o lead AINDA ESTÁ CURSANDO a graduação e conclui longe demais pra entrar agora. Ele NÃO está desinteressado — vai poder cursar quando se formar, então NUNCA use pausa_ia nesse caso. Informe em `meses` quantos meses faltam pra ele concluir (conclui em 2028 e estamos em 2026 → 24); o sistema limita ao teto de 12 meses sozinho. Não pergunte prazo ao lead aqui: use o que ele já disse sobre quando termina o curso. Nos dois casos o lead fica fora dos disparos até a data e o time o retoma. Chame UMA vez só, na mesma resposta em que se despede. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "temporizador_proxima_turma__recontato": {
    "name": "temporizador_proxima_turma",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo"
      ],
      "properties": {
        "curso": {
          "type": "string",
          "description": "Curso de interesse do lead, se você souber. Vazio = usa o curso já conhecido da conversa."
        },
        "motivo": {
          "type": "string",
          "description": "Frase curta com o que o lead pediu. Ex.: 'Lead pediu pra ser chamado quando abrir a próxima turma'."
        }
      }
    },
    "description": "Agendar o recontato do lead para a PRÓXIMA TURMA do curso dele. Use SEMPRE que o lead disser que prefere ser chamado quando abrir a próxima turma, \"me chama mais pra frente\", \"agora não posso, me procura depois\" — em vez de pausa_ia. A função busca a data real da próxima turma no sistema, agenda o temporizador de recontato (o lead fica FORA de todos os disparos em massa até lá) e a IA é pausada em seguida. Chame UMA vez só, na mesma resposta da sua mensagem de despedida. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "consulta_pos_disponiveis__recontato": {
    "name": "consulta_pos_disponiveis",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "properties": {
        "trocar_para": {
          "type": "string",
          "description": "Pós explicitamente escolhida pelo lead. Valida e registra; não use só porque ele perguntou se existe ou como funciona."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome exato dito pelo lead para verificar existência/modalidade. Somente consulta, sem mudar o interesse."
        }
      },
      "additionalProperties": false
    },
    "description": "Fonte obrigatória do catálogo de pós ATIVAS e modalidades por curso. Chame quando o lead mencionar uma pós ainda não validada, inclusive na PRIMEIRA escolha de interesse, ou perguntar se temos uma pós, quais existem, qual é online ou semipresencial. Antes de confirmar que oferecemos, falar em matrícula/condição ou encaminhar para agenda, valide o nome aqui. Repetir o nome dito pelo lead NÃO comprova existência: clínica de pequenos animais não equivale a clínica de bovinos. Use curso_consulta para consultar sem alterar interesse, inclusive dúvidas sobre outra pós. Use trocar_para SOMENTE quando o lead tiver escolhido explicitamente aquela pós. Sem parâmetros lista catálogo e modalidades. Não passe os dois campos juntos. Respeite status: só curso_confirmado/interesse_atualizado autoriza adotar o curso; semelhança textual exige esclarecimento, nunca troca automática. Se não encontrado, diga que não temos essa pós e ofereça apenas alternativas reais pertinentes, aguardando escolha. Não invente modalidade, conteúdo, cidade, frequência ou carga horária. O retorno específico prevalece sobre frases genéricas de objeção ou conhecimento anterior. Depois de responder, siga qualificando e agendando conforme o interesse validado."
  },
  "consulta_objecoes__recontato": {
    "name": "consulta_objecoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "mensagem_lead",
        "tipo_objecao"
      ],
      "properties": {
        "tipo_objecao": {
          "enum": [
            "objecao_tempo",
            "objecao_canal",
            "pergunta_preco",
            "objecao_financeira",
            "objecao_adiamento",
            "objecao_desconfianca",
            "objecao_duvida",
            "pergunta_condicao",
            "objecao_terceiro",
            "pergunta_modalidade",
            "pergunta_instituicao"
          ],
          "type": "string",
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (quanto custa/qual valor — o lead PERGUNTA o preço), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (vou pensar/depois te falo), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (online/presencial/EAD), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
        },
        "mensagem_lead": {
          "type": "string",
          "description": "A mensagem EXATA e completa do lead, do jeito que ele escreveu, sem reformular. É essa frase que busca a melhor resposta no RAG por similaridade de significado — então mande o texto cru. Ex: 'não tenho tempo agora', 'quanto custa essa pós?', 'prefiro por whatsapp', 'vou ver com minha esposa', 'nunca ouvi falar de vocês'."
        },
        "curso_consulta": {
          "type": "string",
          "description": "Nome da pós mencionada na dúvida de modalidade; não altera o interesse."
        }
      }
    },
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso."
  },
  "pausa_ia__recontato": {
    "name": "pausa_ia",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "motivo",
        "tipo"
      ],
      "properties": {
        "tipo": {
          "enum": [
            "pausa",
            "nao_perturbe",
            "sem_graduacao"
          ],
          "type": "string",
          "description": "Tipo de parada. \"sem_graduacao\" = o lead NÃO tem graduação nenhuma e NÃO está cursando uma (só ensino médio e/ou técnico): como a pós é lato sensu, ele nunca vai poder se matricular. ARQUIVA o contato, RESOLVE a conversa e tira o lead de TODOS os disparos, campanhas e follow-ups. ⚠️ NUNCA use \"sem_graduacao\" para quem está CURSANDO a graduação — esse volta a ser elegível quando se formar, e o caminho dele é a tool agendar_retorno com tipo=\"formatura\". \"nao_perturbe\" = OPT-OUT: o lead não quer mais ser contatado. ARQUIVA o contato, resolve as conversas e tira o lead de TODOS os disparos, campanhas e follow-ups — use sempre que o lead confirmar desinteresse (depois da pergunta de retenção) ou pedir pra não ser mais notificado. \"pausa\" = apenas parar a automação para atendimento humano/personalizado (pediu ligação, pagou a matrícula, quer falar com alguém, já é aluno, ou é graduado em área incompatível com AQUELA pós): o lead CONTINUA no fluxo e SEGUE recebendo disparos e campanhas, então NUNCA use \"pausa\" para quem pediu pra parar de receber mensagens nem para quem não tem graduação nenhuma."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "Para tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPausar o atendimento automático. Use quando o lead pedir atendimento humano, pedir ligação, informar que pagou a matrícula, pedir cancelamento/remarcação, ou for desqualificado (não tem graduação nenhuma / é graduado em área incompatível). ⚠️ DESINTERESSE/OPT-OUT ('não quero mais', 'não me notifique', 'pode parar', 'me tira da lista', 'perdi o interesse'): NÃO use esta tool de primeira. Antes, faça a pergunta de retenção EXPLÍCITA: o lead não tem interesse mesmo, ou prefere ser chamado quando abrir a PRÓXIMA TURMA? Só pause por desinteresse se essa pergunta já aparece LITERALMENTE no histórico (nunca conte como feita 'implicitamente') e o lead reiterou o não. Se o lead preferir a próxima turma, use temporizador_proxima_turma em vez desta. Escolha tipo=\"nao_perturbe\" quando o lead claramente não quer ser contatado (desinteresse confirmado após a retenção); tipo=\"sem_graduacao\" quando ele NÃO tem graduação nenhuma e nem está cursando uma (só ensino médio e/ou técnico) — nunca será elegível, então o contato é ARQUIVADO e a conversa RESOLVIDA; tipo=\"pausa\" para atendimento humano/personalizado, ligação, lead que já é aluno, ou formação incompatível (ele É graduado, mas a área não atende AQUELA pós — pode servir pra outra). ⚠️ Lead que ainda está CURSANDO a graduação NÃO entra nesta tool: o caminho dele é agendar_retorno com tipo=\"formatura\". ⚠️ LEAD QUE JÁ É ALUNO (diz que já faz/cursa uma pós da PPG, que \"já estou no Nº mês\", que já é matriculado): use ESTA tool com tipo=\"pausa\" IMEDIATAMENTE, logo na primeira vez que ele disser. Antes de pausar, mande UMA mensagem curta assumindo o engano (\"esse convite era pra quem ainda não é aluno, desculpa a confusão\") e diga que alguém do suporte fala com ele. É PROIBIDO seguir qualificando, oferecer horário, agendar reunião ou inventar qualquer outro motivo pra conversa (ex.: dizer que a reunião é \"com o monitor do seu curso\" ou \"pra ver como está sua experiência\" — isso NÃO existe). Aluno que quer OUTRA pós também para aqui: quem cuida disso é o humano. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  },
  "envia_informacoes__recontato": {
    "name": "envia_informacoes",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "conteudo"
      ],
      "properties": {
        "conteudo": {
          "enum": [
            "cronograma",
            "valor",
            "cronograma_e_valor"
          ],
          "type": "string",
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' (valor integral retornado pra você informar na conversa), 'cronograma_e_valor' (ambos)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia informações da pós de interesse ao lead. Três modos: 'cronograma' solicita o envio do PDF do cronograma detalhado no WhatsApp do lead; 'valor' retorna o valor integral (sem desconto) para VOCÊ informar com suas palavras; 'cronograma_e_valor' faz os dois. Use 'cronograma' quando o lead pedir cronograma, grade, conteúdo programático, ementa, datas das aulas ou 'me manda mais informações'. Use 'valor' sempre que o lead perguntar preço, valor ou investimento. Use 'cronograma_e_valor' quando o lead pedir explicitamente as duas coisas. Quando o lead INSISTIR que só pode resolver pelo WhatsApp (segunda objeção de canal), chame esta função com 'cronograma' E a consulta_objecoes NA MESMA resposta: o cronograma atende o pedido dele e a quebra de objeção reforça que a condição do primeiro lote promocional é apresentada na reunião com o monitor. Se a pendência for recebimento ou acesso ao material, resolva essa dificuldade antes de retomar a objeção ou o agendamento.\n\nConfira o curso e o histórico antes de enviar. Não repita o mesmo material sem novo pedido ou falha. Se o lead pedir novamente, disser que não recebeu, não encontrou ou não consegue abrir, faça uma nova tentativa com 'cronograma', mesmo que exista um tool_result antigo ou registro de envio humano. O relato do lead permite o reenvio; nunca insista que ele recebeu, que o sistema confirma a entrega ou que basta procurar acima na conversa. Depois da tentativa, aguarde a confirmação de acesso antes de perguntar sobre leitura, opinião ou agendamento. Se ela falhar ou o arquivo estiver indisponível, explique a dificuldade e encaminhe para ajuda humana pela ferramenta apropriada, sem repetir envios em loop.\n\nResponda conforme o status atual retornado pela função. Solicitação aceita não comprova entrega; entrega registrada não comprova que o lead abriu o arquivo. Se o retorno indicar falha, reconheça que o material não foi enviado e não prometa envio posterior sem providenciar uma ação efetiva. Só confirme entrega quando houver confirmação de entrega; nunca transforme um registro antigo de envio em prova contra o relato do lead. NUNCA invente valor, parcela ou desconto que não esteja no retorno; a condição especial em cima do valor integral é apresentada apenas no Meet.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome.\nFICHA DO ATENDIMENTO: antes de chamar para cronograma, leia o bloco [FICHA DO ATENDIMENTO] no fim da última mensagem. Se houver FALTA COLETAR, faça a pergunta indicada e só chame depois da resposta (ou se ele insistir sem responder). O sistema recusa o envio enquanto faltar dado e devolve PRECISA_COLETAR com o que perguntar."
  },
  "confirmar_agendamento__recontato": {
    "name": "confirmar_agendamento",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "data_escolhida",
        "horario_escolhido",
        "vendedor_id"
      ],
      "properties": {
        "vendedor_id": {
          "type": "string",
          "description": "UUID do monitor retornado no slot por consulta_disponibilidade(). Garante que o mesmo monitor que foi oferecido ao lead seja reservado."
        },
        "data_escolhida": {
          "type": "string",
          "description": "Data do slot escolhido, YYYY-MM-DD (ex: 2026-06-10). Extraia do campo 'inicio' que consulta_disponibilidade retornou, convertendo para horario de Brasilia (UTC-3)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Horario do slot em HH:mm no horario de Brasilia (ex: 15:00). Extraia do campo 'inicio' que consulta_disponibilidade retornou, convertendo UTC -> Brasilia (-3h)."
        }
      }
    },
    "description": "FINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nQuarta e ULTIMA funcao da sequencia de agendamento. Executar SOMENTE apos o lead escolher um horario retornado por consulta_disponibilidade(). Agenda a reuniao no sistema PPGVET com o monitor ja definido no slot escolhido. NUNCA executar antes do lead confirmar. Use exatamente a data, horario, pos e vendedor_id que consulta_disponibilidade retornou. A reuniao SO existe depois que esta funcao retorna com sucesso nesta conversa, e o link do meet e SEMPRE o que ela devolveu. Antes desse retorno e PROIBIDO dizer que a reuniao esta marcada/confirmada/reservada/agendada, prometer que \"o link chega em breve\" ou que \"o monitor entra em contato pra passar o link\", e mandar qualquer link de meet - inclusive reaproveitar o link de uma reuniao ANTIGA que apareca no historico (link antigo e de reuniao antiga). Se o lead perguntar sobre uma reuniao e voce nao tiver o retorno desta funcao nesta conversa, nao confirme nada: trate como nao marcada e refaca o fluxo de horarios. CONTRATO DE APROVACAO POR CURSO: esta função RECUSA criar a reunião sem aprovação persistida para o MESMO lead e o MESMO curso_escolhido. Formação preenchida ou aprovação de outra pós não bastam. Antes de chamar, aguarde verificar_compatibilidade_curso retornar APROVADO com decisão registrada para esta pós. Em recusa por falta de aprovação válida, verifique novamente usando os dados já confirmados no histórico/cadastro; pergunte apenas o que faltar. Reprovação, conclusão pendente e falha técnica não autorizam agendar. Não contorne a recusa trocando identificadores, usando aprovação de outro curso ou repetindo a chamada sem resolver a pendência.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome."
  },
  "consulta_disponibilidade__recontato": {
    "name": "consulta_disponibilidade",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "curso_escolhido",
        "data_desejada"
      ],
      "properties": {
        "data_desejada": {
          "type": "string",
          "description": "Data YYYY-MM-DD do horario que o lead escolheu/pediu. Se ja passou, calcule a proxima valida. Nunca a mais de dois dias da data atual."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "periodo_desejado": {
          "enum": [
            "manha",
            "tarde",
            "noite",
            "qualquer"
          ],
          "type": "string",
          "description": "Periodo: manha (ate 12h), tarde (12-19h), noite (apos 19h) ou qualquer."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional HH:mm (ex: 14:30). Preencha com o horario exato que o lead escolheu pra confirmar se ainda esta livre. Tem prioridade sobre periodo_desejado."
        }
      }
    },
    "description": "Esta ferramenta consulta horários de REUNIÃO, não de retorno por mensagem. Ausência momentânea (\"agora não posso atender\") exige perguntar quando pode chamar por aqui, sem consultar agenda. Uma data/hora respondida a essa pergunta é retorno no canal, não aceite de Meet. Só consulte para interesse explícito em agendar a reunião.\nFINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nRe-checa os horarios disponiveis antes de fechar, ou quando o lead pedir outro horario / o escolhido ja tiver passado. A partir da pos, retorna os horarios livres (slots de 30 min) ja com o monitor selecionado por menor carga. Apresente somente horários retornados, identificando que são para a conversa com o monitor sobre a pós, no fuso de Brasília, sem citar nomes de monitores. Nunca confirme nem ofereca um horario sem antes executar esta funcao; se o horario escolhido nao voltar, ofereca o mais proximo que voltar. REGRA OBRIGATORIA PARA PEDIDO IMPOSSIVEL: compare o pedido mais recente do lead com os horarios de funcionamento do contexto temporal. Se ele pedir domingo, sabado a tarde/noite ou madrugada, NAO consulte a data ou o periodo impossivel. Explique de forma curta que nao ha atendimento nesse periodo, escolha o proximo periodo valido permitido pelo contexto e CHAME esta funcao para essa data valida. So depois ofereca os horarios exatos retornados. Deixe claro que sao uma alternativa; nunca troque a data silenciosamente. Exemplo: para \"domingo as 22h\", avise que domingo nao tem atendimento, consulte o proximo periodo valido e ofereca apenas os slots retornados.\nSe o lead propôs data e hora concretas para a reunião, consulte exatamente essa opção, mesmo sem oferta anterior do SDR. Não desloque 13:00 para 13:30 por uma tabela genérica. Se o mesmo dia e horário aparecer em slots_raw, preserve a escolha e avance apenas nas pendências de qualificação; não abra um novo menu de horários. Disponibilidade não é aprovação nem agendamento. Se a opção estiver ausente, ofereça alternativas reais e aguarde nova escolha.\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome."
  },
  "verificar_compatibilidade_curso__recontato": {
    "name": "verificar_compatibilidade_curso",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "formacao_academica",
        "curso_interesse"
      ],
      "properties": {
        "area_trabalho": {
          "type": "string",
          "description": "OPCIONAL. Área de atuação profissional do lead. Informar quando já foi coletada no fluxo."
        },
        "curso_interesse": {
          "type": "string",
          "description": "Nome EXATO da pós que o lead quer AGORA. Use o curso_alternativo se ele aceitou a troca. A decisão será registrada para esse curso; informe o mesmo curso em confirmar_agendamento."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Mês e ano em que o lead conclui a graduação, no formato \"MM/AAAA\" (ex.: \"12/2026\"), conforme VOCÊ entendeu a resposta dele. Informe junto com conclusao_graduacao_bruta sempre que o lead ainda estiver cursando. Só preencha quando a resposta trouxer ANO (\"2027.1\", \"dezembro de 2026\") ou prazo explícito (\"em uns 2 anos\", \"faltam 6 meses\"). NUNCA converta um número de semestre/período em data por conta própria: \"2 semestre\" não diz o ano, e chutar já agendou aluno de 1º ano."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "O que o lead declarou sobre a graduação. normal = graduação CONCLUÍDA: declarada (\"me formei\", \"já concluí\", \"sim\" à pergunta sobre conclusão) OU título profissional dito sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária). Auxiliar/técnico, profissão de outra pessoa, intenção, negação e cargo genérico não contam; nome isolado do curso e trabalho na área não confirmam conclusão. Quem AINDA CURSA nunca usa normal. estudante_apto = conclui até a DATA-LIMITE que vem no contexto temporal; estudante_fora_do_prazo = conclui depois dela (\"ano que vem\" sozinho não reprova: compare com a data do contexto, não recalcule). Envie a resposta literal em conclusao_graduacao_bruta e o MM/AAAA em conclusao_graduacao. Se faltar saber se concluiu ou quando conclui, pergunte só isso. Semestre/período não é data. correcao_sem_formacao = estava marcado Sem Formação e confirmou graduação concluída com o nome do curso. Este campo descreve o que o lead disse; quem decide é a ferramenta."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "OBRIGATÓRIO quando contexto_qualificacao for estudante_apto ou estudante_fora_do_prazo. Cole aqui, LITERALMENTE, o que o lead respondeu sobre quando conclui a graduação — sem interpretar, sem normalizar, sem corrigir (ex.: \"2 semestre\", \"tô no último ano, termino em 2027.1\", \"faltam uns 6 meses\"). O sistema relê esta resposta e é ELE quem decide o prazo. Se a resposta for a posição no curso e não uma data, ele devolve PRECISA_DATA_CONCLUSAO e você pergunta o mês/ano ao lead."
        }
      }
    },
    "description": "PRIMEIRA função depois que a graduação do lead está identificada, e SEMPRE ANTES de confirmar_agendamento. Verifica se a formação permite cursar a pós de interesse e registra a decisão para este lead e este curso.\n\nQUANDO CHAMAR: assim que o lead informar a graduação, ou quando ele se apresentar com título profissional sobre si (médico(a) veterinário(a), veterinário(a), zootecnista, chefe ou subchefe de veterinária): nesse caso a graduação conta como concluída e você chama direto, sem perguntar de novo qual é a graduação nem se concluiu. Chame de novo se a pós mudou ou se ele aceitou o curso_alternativo. NÃO chame junto com confirmar_agendamento: aguarde o resultado. NÃO chame sem o nome específico da graduação, nem em conversa que é só sobre aula aberta.\n\nO QUE O RETORNO LIBERA: APROVADO = pode seguir para confirmar_agendamento do MESMO curso (não cria reunião por si só). REPROVADO com curso_alternativo = ofereça a alternativa e, se ele aceitar, verifique essa pós antes de agendar. REPROVADO sem alternativa = encerre pelo caminho previsto. REPROVADO_PRAZO = estudante que conclui depois da data-limite: não agende e chame agendar_retorno com tipo=\"formatura\". PRECISA_DATA_CONCLUSAO = pergunte só o mês e o ano em que ele conclui. FALHA_TECNICA ou pendência = não trate como apto nem agende; tente de novo na próxima rodada.\n\nNunca cite prazo, data-limite, régua ou elegibilidade ao lead, e não comente o resultado com ele."
  },
  "remarcar_agendamento__recontato": {
    "name": "remarcar_agendamento",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "data_escolhida",
        "horario_escolhido",
        "vendedor_id"
      ],
      "properties": {
        "vendedor_id": {
          "type": "string",
          "description": "UUID do monitor do slot escolhido em consulta_disponibilidade(). Pode ser o mesmo de antes ou outro; garante reservar o monitor certo no novo horario."
        },
        "data_escolhida": {
          "type": "string",
          "description": "Nova data do slot escolhido, YYYY-MM-DD (Brasilia). Extraia do campo 'inicio' que consulta_disponibilidade retornou, convertendo UTC -> Brasilia (-3h)."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Novo horario em HH:mm no horario de Brasilia (ex: 19:00). Extraia do 'inicio' do slot, convertendo UTC -> Brasilia (-3h)."
        }
      }
    },
    "description": "FINALIDADE DA AGENDA — AULA/EVENTO NÃO É REUNIÃO:\nEsta ferramenta trata exclusivamente da conversa individual com o monitor sobre a pós; NÃO consulta, confirma nem altera programação, presença ou inscrição de aula, live, palestra, webinar ou evento. \"Confirmar Participação\", \"confirmo\", \"sim\" e horários respondidos ao convite da aula dizem respeito à aula, inclusive quando o convite vem citado em [Em resposta à mensagem: ...]. Não use esta ferramenta nem colete formação para transformar essa resposta em reunião. A citação não é aceite do lead. Responda primeiro à aula com os dados reais do convite, sem inventar data, link, inscrição ou mudança de horário. Convite antigo com \"hoje\" não confirma a data atual. Se já houve confusão, diferencie o horário informado da aula dos horários da conversa e esclareça o que falta; não chame a agenda para corrigir a aula. Antes de oferecer a conversa, explique que é um compromisso individual com o monitor, separado da aula, e aguarde aceite específico ou pedido explícito de reunião. Toda lista de horários deve dizer \"para a conversa com o monitor\", além do fuso de Brasília; nunca apresente apenas os horários sem sua finalidade. A agenda só pode ser confirmada após escolha vigente de data e hora para a reunião e todas as verificações obrigatórias. Uma reunião confirmada não altera a programação da aula. Estas regras prevalecem sobre qualquer instrução posterior de apresentar APENAS os horários ou avançar diretamente da confirmação de participação para o agendamento.\n\nRemarca (muda o dia/horario de) uma reuniao JA agendada deste lead. Use SEMPRE que o lead pedir pra mudar o horario de uma reuniao que ele ja tem marcada. NUNCA use confirmar_agendamento pra remarcar (isso criaria uma SEGUNDA reuniao duplicada). Fluxo correto: 1) chame consulta_disponibilidade pro novo dia/horario que o lead quer; 2) ofereca os horarios livres; 3) SO depois do lead escolher, chame remarcar_agendamento com o slot escolhido. O novo horario passa a valer: a reuniao existente e atualizada e os lembretes seguem o novo horario."
  },
  "agendar_retorno__recontato": {
    "name": "agendar_retorno",
    "type": "function",
    "strict": false,
    "parameters": {
      "type": "object",
      "required": [
        "tipo"
      ],
      "properties": {
        "dias": {
          "type": "integer",
          "maximum": 7,
          "minimum": 1,
          "description": "Só para tipo=\"analise\": em quantos dias o lead pediu pra ser chamado (1 a 7)."
        },
        "tipo": {
          "enum": [
            "analise",
            "formatura"
          ],
          "type": "string",
          "description": "\"analise\" = pediu tempo pra ver o material (use `dias`). \"formatura\" = ainda cursando a graduação (use `meses`)."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só para tipo=\"formatura\": quantos meses faltam pra ele concluir a graduação. O sistema limita ao teto de 12."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Não use para ausência momentânea ou para registrar uma hora de retorno por WhatsApp. Sem prazo informado, pergunte quando pode chamar; não invente dias. Esta ferramenta não agenda hora exata nem reunião.\nAgendar o RETORNO do lead pra uma data futura, em dois casos. CASO 1 (tipo=\"analise\"): o lead pediu tempo pra analisar/ler/ver o material ou pra pensar. Pergunte ANTES quando pode chamá-lo e só chame esta função DEPOIS que ele disser o prazo; converta em dias (\"amanhã\"=1, \"semana que vem\"=7, \"uns dias\"=3). O máximo é 7 dias — prazo maior que isso NÃO usa este caso: negocie pra dentro da semana ou use temporizador_proxima_turma. CASO 2 (tipo=\"formatura\"): o lead AINDA ESTÁ CURSANDO a graduação e conclui longe demais pra entrar agora. Ele NÃO está desinteressado — vai poder cursar quando se formar, então NUNCA use pausa_ia nesse caso. Informe em `meses` quantos meses faltam pra ele concluir (conclui em 2028 e estamos em 2026 → 24); o sistema limita ao teto de 12 meses sozinho. Não pergunte prazo ao lead aqui: use o que ele já disse sobre quando termina o curso. Nos dois casos o lead fica fora dos disparos até a data e o time o retoma. Chame UMA vez só, na mesma resposta em que se despede. ⚠️ PRESENTE DA ESCOLA (obrigatório): esta conversa está se encerrando SEM reunião marcada, então a MESMA resposta em que você se despede tem que levar o convite da biblioteca gratuita da PPGVET — mais de 10 cursos gratuitos, artigos científicos, resumos, e-books, materiais didáticos, aulas abertas de pós e certificados, em https://escoladeespecializacao.ppgvet.com.br . Mande o endereço literal (nunca outro, nunca encurtado), uma vez só por conversa, e nunca prometa \"mandar depois\". Não mande se a reunião foi marcada, se o lead já é aluno, se ele informou que pagou a matrícula, ou se você já mandou o convite nesta conversa."
  }
};

/** Quais ferramentas cada persona recebe, NA ORDEM (a ordem faz parte do prefixo de cache). */
export const FERRAMENTAS_POR_AGENTE: Record<string, string[]> = {
  "agente_validacao": [
    "envia_informacoes__abertura",
    "temporizador_proxima_turma__abertura",
    "consulta_pos_disponiveis__abertura",
    "verificar_compatibilidade_curso__abertura",
    "consulta_disponibilidade__abertura",
    "consulta_objecoes__abertura",
    "pausa_ia__abertura",
    "agendar_retorno__abertura",
    "atualizar_dados_lead__abertura"
  ],
  "agente_qualificador": [
    "consulta_objecoes__fechamento",
    "pausa_ia__fechamento",
    "envia_informacoes__fechamento",
    "temporizador_proxima_turma__fechamento",
    "consulta_pos_disponiveis__fechamento",
    "confirmar_agendamento__fechamento",
    "consulta_disponibilidade__fechamento",
    "verificar_compatibilidade_curso__fechamento",
    "remarcar_agendamento__fechamento",
    "agendar_retorno__fechamento",
    "atualizar_dados_lead__fechamento"
  ],
  "agente_aula": [
    "consulta_disponibilidade__aula",
    "consulta_objecoes__aula",
    "envia_informacoes__aula",
    "temporizador_proxima_turma__aula",
    "consulta_pos_disponiveis__aula",
    "pausa_ia__aula",
    "atualizar_dados_lead__aula",
    "verificar_compatibilidade_curso__aula",
    "agendar_retorno__aula"
  ],
  "agente_campanha_direta": [
    "envia_informacoes__campanha",
    "temporizador_proxima_turma__campanha",
    "consulta_pos_disponiveis__campanha",
    "verificar_compatibilidade_curso__campanha",
    "consulta_disponibilidade__campanha",
    "consulta_objecoes__campanha",
    "pausa_ia__campanha",
    "atualizar_dados_lead__campanha",
    "agendar_retorno__campanha"
  ],
  "agente_recontato": [
    "temporizador_proxima_turma__recontato",
    "consulta_pos_disponiveis__recontato",
    "consulta_objecoes__recontato",
    "pausa_ia__recontato",
    "envia_informacoes__recontato",
    "confirmar_agendamento__recontato",
    "consulta_disponibilidade__recontato",
    "verificar_compatibilidade_curso__recontato",
    "remarcar_agendamento__recontato",
    "agendar_retorno__recontato"
  ]
};
