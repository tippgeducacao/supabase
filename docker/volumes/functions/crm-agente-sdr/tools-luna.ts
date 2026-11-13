// FERRAMENTAS DO SDR — catálogo por persona, compartilhado por Luna, Terra e demais modelos.
//
// 29/09/2026: saiu da tabela lista_tools_openai (que a Luna deixou de ler) para o código, para ter
// histórico no git, teste antes de valer e edição pelo Markdown, como o prompts-luna.ts. Nasceu
// idêntico às 48 linhas da tabela (conferido persona a persona). Desde 14/10/2026 o conjunto
// 'luna' usa este catálogo para qualquer modelo; o nome do arquivo é histórico.
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
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' e 'cronograma_e_valor' (também enviam o PDF: o valor integral vai dentro do cronograma e não é escrito na conversa)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia o PDF da pós confirmada: cronograma, valor e cronograma_e_valor enviam o mesmo documento com o investimento. Não escreva preço, parcela ou matrícula na conversa. Pedido de conteúdo, duração, grade ou investimento usa esta ferramenta; não invente dados do PDF.\nSiga a FICHA: com FALTA COLETAR, pergunte o dado necessário e registre com atualizar_dados_lead antes do primeiro envio. Insistência sem resposta segue a liberação ou PRECISA_COLETAR do executor; não ignore a recusa. Reenvio para recuperar material já enviado não refaz a entrevista. Uma tentativa por material na rodada, sem loop.\nQuando o lead pedir novamente, disser que não recebeu, não encontra ou não abre, faça uma tentativa de recuperação, mesmo após envio humano ou registro antigo. Não contradiga o relato dizendo que já recebeu ou que está acima. Após essa tentativa, pergunte se conseguiu abrir e aguarde antes de retomar a agenda.\nEnvio normal aceito/entregue/lido permite a fala de envio e, com APROVADO e sem recusa do Meet, convite e até três horários reais na mesma mensagem. Recuperação de acesso é a exceção acima. Aceite não comprova entrega; entrega não comprova abertura. Use o status atual, não um sucesso antigo. Se recusou o Meet e só quer o PDF, diga a fala do envio e pare, sem novo convite.\nFalhou/desconhecido: não confirme envio, não pause nem encaminhe ao humano só pela falha. Explique a dificuldade e pergunte se pode continuar com o agendamento enquanto isso; aguarde resposta, sem emendar coleta ou horário. Pedido explícito de humano continua usando pausa_ia tipo=pausa. Só prometa nova tentativa automática se o retorno atual confirmar reenvio_agendado_id. O roteiro e a distinção entre envio normal, recuperação e falha estão em ENVIO DE MATERIAIS."
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
    "description": "Agenda o recontato na data real da próxima turma, exclui o lead dos disparos até lá e pausa a IA. Use somente quando o lead pedir explicitamente a próxima turma ou aceitar essa opção. \"Agora não posso\", \"me chama depois\", falta de dinheiro ou prazo longo, sozinhos, não autorizam escolher a próxima turma: esclareça o pedido. Ausência momentânea não chama ferramenta; análise de material com prazo combinado de até 7 dias usa agendar_retorno. Estudante fora do prazo usa agendar_retorno tipo=formatura. Chame uma vez e só confirme o que o retorno efetivamente agendou."
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
          "description": "Nome oficial da pós de interesse atual, validado no catálogo. A decisão fica vinculada a essa pós. Se aceitar uma alternativa, registre o novo interesse e faça nova checagem."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Opcional: MM/AAAA apenas quando o lead informou mês/ano ou duração explícita que permita normalizar sem adivinhar. Envie também o texto literal em conclusao_graduacao_bruta. Se só informou posição no curso (\"2º semestre\") ou não deu previsão, deixe vazio: não invente data. Para ano/semestre ou expressão relativa, preserve a resposta bruta para o código interpretar."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "Informe o fato, não a decisão: estudante = ainda cursa, com ou sem previsão; o código decide prazo ou devolve PRECISA_DATA_CONCLUSAO. normal = graduação concluída declarada (inclusive \"sim\" à pergunta de conclusão) ou título profissional sobre si permitido pela regra de autodeclaração: médico(a) veterinário(a), veterinário(a), zootecnista, chefe/subchefe de veterinária. Nome isolado de curso, trabalho na área, auxiliar/técnico, intenção, negação ou profissão de outra pessoa não comprovam conclusão. Sem saber se concluiu, pergunte. correcao_sem_formacao = estava Sem Formação e confirmou graduação concluída com nome do curso. estudante_apto e estudante_fora_do_prazo são rótulos legados; prefira estudante."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "Para quem ainda cursa, copie literalmente a resposta sobre conclusão, se houver: \"2º semestre\", \"finalizo em 2027.1\", \"faltam 6 meses\". Sem resposta, deixe vazio. O código decide o prazo; posição no curso ou ausência de previsão retorna PRECISA_DATA_CONCLUSAO, sem aprovação nem reprovação inventada."
        }
      }
    },
    "description": "Verifica a formação e registra a decisão para este lead e esta pós. Após registrar os dados conhecidos em atualizar_dados_lead, chame antes de oferecer horários ou criar reunião. Exige nome específico da graduação e pós validada no catálogo. Título profissional declarado pelo próprio lead conforme a regra de autodeclaração dispensa repetir a coleta. Não use para confirmação de aula aberta. Nunca chame junto com a criação de reunião: aguarde o resultado.\nAPROVADO: consulte a agenda e obtenha a escolha do lead; a etapa seguinte cria a reunião. Esta etapa não cria nem confirma reunião.\nREPROVADO com curso_alternativo ou outras_pos_compativeis: ofereça somente as opções retornadas; se ele escolher, valide a nova pós e repita a checagem antes de agendar. Sem alternativa ou após recusa, pausa_ia tipo=pausa para atendimento humano, sem arquivar por falta de graduação. REPROVADO_PRAZO: agendar_retorno tipo=formatura. PRECISA_DATA_CONCLUSAO: pergunte apenas o mês/ano que falta, sem adivinhar semestre. FALHA_TECNICA: informe que não conseguiu concluir a verificação agora; não diga que há uma tarefa em andamento ou retorno automático, não ofereça horários e preserve os dados. Nova tentativa só com pedido concreto ou mudança de dados, não com um simples \"ok\".\nNão exponha laudo, régua ou data-limite. Se o lead só informou os dados, prossiga sem comentar a aprovação. Se perguntou se pode cursar, responda brevemente pelo retorno. Ao oferecer alternativa, use a justificativa pública devolvida; não invente equivalência entre cursos."
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
          "description": "Data YYYY-MM-DD pelo contexto temporal. Sem preferência, priorize hoje e até dois dias à frente. Com data explícita do lead, consulte essa data se válida; fora do funcionamento, explique e consulte o próximo período válido. Não é um teto absoluto de dois dias."
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
          "description": "manha = antes de 12h; tarde = de 12h até antes de 19h; noite = a partir de 19h; qualquer = sem preferência. A disponibilidade real vem da agenda. Se houver horário exato, horario_inicio_desejado tem prioridade."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional. Horário no formato HH:mm (ex.: 20:00). Tem prioridade sobre periodo_desejado; a busca traz horários a partir dele."
        }
      }
    },
    "description": "Consulta horários da conversa individual com o monitor sobre a pós. Não trata de programação ou participação em aula/evento; veja AULA OU EVENTO. Use após aceite específico da conversa e compatibilidade APROVADA, para oferecer opções ou conferir a escolha do lead. Esta etapa só consulta e coleta a escolha; não cria nem confirma reunião.\nUse a data/hora pedida pelo lead quando estiver no funcionamento do contexto temporal. Domingo, sábado à tarde/noite e madrugada: explique a restrição, consulte o próximo período válido e apresente-o como alternativa, sem trocar o pedido silenciosamente. Priorize hoje e os próximos dois dias quando não houver preferência; data explícita do lead ou próximo dia válido retornado pela agenda pode superar essa preferência. Restrição de período/hora vai nos parâmetros.\nSe a escolha exata voltar em slots_raw, preserve-a e resolva só a pendência restante, sem novo menu. Se não voltar, ofereça alternativas reais e aguarde nova escolha. Mostre até três horários retornados, dizendo que são para a conversa com o monitor no horário de Brasília, sem nome de monitor. O retorno já traz data e horario em Brasília: não desconte três horas novamente. Ausência momentânea não chama a agenda."
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
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (rótulo legado; pergunta de valor integral vai em envia_informacoes), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (adiamento com objeção explícita a tratar; simples pedido de tempo não chama esta ferramenta), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (rótulo legado; consulte modalidade em consulta_pos_disponiveis), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
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
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso.\n\"Vou pensar/ler/ver com alguém\" sem motivo adicional segue PEDIDO DE TEMPO: pergunte o prazo, não chame esta ferramenta só para vencer a decisão. Com motivo explícito (preço, tempo para cursar, desconfiança), trate esse motivo uma vez; só agende retorno após prazo combinado. Preço integral vai somente em envia_informacoes e modalidade em consulta_pos_disponiveis; não chame ambas por rotina."
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
          "description": "pausa = interrompe a IA para atendimento humano; não cancela campanhas. nao_perturbe = opt-out: arquiva, resolve conversas e retira de campanhas/follow-ups; pedido explícito para parar mensagens não exige retenção. sem_graduacao = arquiva e resolve somente com declaração comprovada de nenhuma graduação concluída ou em andamento; não se aplica a estudante. Quem ainda cursa segue a checagem e, se REPROVADO_PRAZO, agendar_retorno tipo=formatura."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "A saída por \"já é aluno\" vale SOMENTE para aluno da PPG: cadastro confirmado pelo sistema ou declaração própria e explícita de vínculo com a PPG (\"faço a pós com vocês\", \"sou aluna da PPG\"). \"Já faço uma pós\", \"já sou aluno\" ou \"estou no sétimo mês\", sem identificar a instituição, NÃO comprovam esse vínculo. Não transfira para suporte com base nisso. Fazer pós em outra instituição não impede conhecer/comprar uma pós ou MBA da PPG. Correção do lead (\"é em outra instituição\", \"não sou aluno de vocês\") prevalece sobre a sua inferência e sobre pausas antigas. Só esclareça a instituição se isso for necessário ao pedido atual; uma dúvida sobre o MBA deve seguir pelo catálogo/material e pelas pendências reais, sem encaminhamento humano inventado.\nPara tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPara a automação: pausa = atendimento humano, ligação, matrícula paga, vínculo comprovado com a PPG ou formação incompatível sem alternativa aceita. Incompatibilidade só encerra após o resultado da checagem: ofereça curso_alternativo/outras_pos_compativeis antes, quando existirem. Cancelamento ou remarcação de reunião existente exige atendimento humano com tipo=pausa; esta etapa não dispõe de ferramenta para alterar a reunião.\nPedido explícito para PARAR mensagens (\"não me notifique\", \"pare de enviar\", \"me tira da lista\") usa tipo=nao_perturbe imediatamente, sem retenção, oferta de próxima turma ou mensagem promocional. Desinteresse apenas na pós, sem pedido de interromper contato: uma única pergunta de retenção; se ele reiterar que não quer contato/interesse, nao_perturbe. Tempo ou dinheiro não autorizam programar a próxima turma sem aceite. Não use pausa para pedido de análise, ausência momentânea ou graduação ainda em andamento. Uma informação antiga não substitui o pedido atual do lead. Execute a ferramenta antes de confirmar a ação e responda conforme o retorno."
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
          "description": "analise = tempo para ler/analisar o material, pensar ou consultar outra pessoa, com prazo combinado em dias; formatura = graduação em andamento com conclusão fora da janela, conforme REPROVADO_PRAZO."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só em formatura: meses até a conclusão informada pelo lead (1 a 36). O sistema aplica teto de 12; confirme o prazo efetivamente retornado, sem prometer a data maior."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Programa retorno por DIA para análise de material, ou por MESES para formatura; não reserva reunião nem uma hora de WhatsApp. analise: o lead quer ler, pensar ou consultar alguém e já informou/aceitou quando retomar; envie dias entre 1 e 7. Se já deu o prazo, não pergunte de novo. Sem prazo, pergunte; não invente. Acima de 7 dias, proponha uma data dentro da semana sem pressão. Se não aceitar, ofereça a próxima turma e use temporizador_proxima_turma somente após aceite; se precisar manter outro prazo, encaminhe ao humano por pausa_ia tipo=pausa, sem prometer retorno agendado. formatura: use após REPROVADO_PRAZO, com meses baseados na conclusão informada; sem previsão, esclareça antes. Só confirme a data após sucesso. A IA permanece disponível se ele voltar antes: não chame pausa_ia depois de um retorno agendado. Ausência momentânea segue DISPONIBILIDADE e não usa esta ferramenta."
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
          "description": "Normalize para sim ou nao a declaração do lead sobre já possuir pós-graduação. Não envie a frase literal neste enum; o nome da pós vai em qual_pos. Não pergunte só para preencher cadastro."
        },
        "vinculo": {
          "enum": [
            "clt",
            "autonomo",
            "consultor",
            "proprietario",
            "servidor_publico",
            "sem_trabalho"
          ],
          "type": "string",
          "description": "Vínculo de trabalho dele hoje, assim que ele disser: clt (carteira assinada), autonomo (atende ou trabalha por conta), consultor, proprietario (dono do próprio negócio: clínica, consultório, granja, fazenda, empresa), servidor_publico, sem_trabalho (não trabalha no momento). Não deduza: sem pista clara, deixe vazio."
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
    "description": "Registra somente dados declarados pelo lead: nome, graduação, conclusão e atuação. Registre assim que forem informados, antes da compatibilidade ou do envio que depende da ficha; não diga ao lead que salvou. Não puxe assunto só para completar cadastro. Se FALTA COLETAR indicar dado necessário ao material solicitado ou à reunião aceita, pergunte somente o dado pendente, registre a resposta e prossiga. Campo vazio na ficha não apaga informação já declarada no histórico."
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
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (rótulo legado; pergunta de valor integral vai em envia_informacoes), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (adiamento com objeção explícita a tratar; simples pedido de tempo não chama esta ferramenta), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (rótulo legado; consulte modalidade em consulta_pos_disponiveis), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
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
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso.\n\"Vou pensar/ler/ver com alguém\" sem motivo adicional segue PEDIDO DE TEMPO: pergunte o prazo, não chame esta ferramenta só para vencer a decisão. Com motivo explícito (preço, tempo para cursar, desconfiança), trate esse motivo uma vez; só agende retorno após prazo combinado. Preço integral vai somente em envia_informacoes e modalidade em consulta_pos_disponiveis; não chame ambas por rotina."
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
          "description": "pausa = interrompe a IA para atendimento humano; não cancela campanhas. nao_perturbe = opt-out: arquiva, resolve conversas e retira de campanhas/follow-ups; pedido explícito para parar mensagens não exige retenção. sem_graduacao = arquiva e resolve somente com declaração comprovada de nenhuma graduação concluída ou em andamento; não se aplica a estudante. Quem ainda cursa segue a checagem e, se REPROVADO_PRAZO, agendar_retorno tipo=formatura."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "A saída por \"já é aluno\" vale SOMENTE para aluno da PPG: cadastro confirmado pelo sistema ou declaração própria e explícita de vínculo com a PPG (\"faço a pós com vocês\", \"sou aluna da PPG\"). \"Já faço uma pós\", \"já sou aluno\" ou \"estou no sétimo mês\", sem identificar a instituição, NÃO comprovam esse vínculo. Não transfira para suporte com base nisso. Fazer pós em outra instituição não impede conhecer/comprar uma pós ou MBA da PPG. Correção do lead (\"é em outra instituição\", \"não sou aluno de vocês\") prevalece sobre a sua inferência e sobre pausas antigas. Só esclareça a instituição se isso for necessário ao pedido atual; uma dúvida sobre o MBA deve seguir pelo catálogo/material e pelas pendências reais, sem encaminhamento humano inventado.\nPara tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPara a automação: pausa = atendimento humano, ligação, matrícula paga, vínculo comprovado com a PPG ou formação incompatível sem alternativa aceita. Incompatibilidade só encerra após o resultado da checagem: ofereça curso_alternativo/outras_pos_compativeis antes, quando existirem. Pedido de mudar uma reunião existente usa consulta_disponibilidade e remarcar_agendamento, sem pausar. Cancelamento de reunião exige atendimento humano com tipo=pausa.\nPedido explícito para PARAR mensagens (\"não me notifique\", \"pare de enviar\", \"me tira da lista\") usa tipo=nao_perturbe imediatamente, sem retenção, oferta de próxima turma ou mensagem promocional. Desinteresse apenas na pós, sem pedido de interromper contato: uma única pergunta de retenção; se ele reiterar que não quer contato/interesse, nao_perturbe. Tempo ou dinheiro não autorizam programar a próxima turma sem aceite. Não use pausa para pedido de análise, ausência momentânea ou graduação ainda em andamento. Uma informação antiga não substitui o pedido atual do lead. Execute a ferramenta antes de confirmar a ação e responda conforme o retorno."
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
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' e 'cronograma_e_valor' (também enviam o PDF: o valor integral vai dentro do cronograma e não é escrito na conversa)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia o PDF da pós confirmada: cronograma, valor e cronograma_e_valor enviam o mesmo documento com o investimento. Não escreva preço, parcela ou matrícula na conversa. Pedido de conteúdo, duração, grade ou investimento usa esta ferramenta; não invente dados do PDF.\nSiga a FICHA: com FALTA COLETAR, pergunte o dado necessário e registre com atualizar_dados_lead antes do primeiro envio. Insistência sem resposta segue a liberação ou PRECISA_COLETAR do executor; não ignore a recusa. Reenvio para recuperar material já enviado não refaz a entrevista. Uma tentativa por material na rodada, sem loop.\nQuando o lead pedir novamente, disser que não recebeu, não encontra ou não abre, faça uma tentativa de recuperação, mesmo após envio humano ou registro antigo. Não contradiga o relato dizendo que já recebeu ou que está acima. Após essa tentativa, pergunte se conseguiu abrir e aguarde antes de retomar a agenda.\nEnvio normal aceito/entregue/lido permite a fala de envio e, com APROVADO e sem recusa do Meet, convite e até três horários reais na mesma mensagem. Recuperação de acesso é a exceção acima. Aceite não comprova entrega; entrega não comprova abertura. Use o status atual, não um sucesso antigo. Se recusou o Meet e só quer o PDF, diga a fala do envio e pare, sem novo convite.\nFalhou/desconhecido: não confirme envio, não pause nem encaminhe ao humano só pela falha. Explique a dificuldade e pergunte se pode continuar com o agendamento enquanto isso; aguarde resposta, sem emendar coleta ou horário. Pedido explícito de humano continua usando pausa_ia tipo=pausa. Só prometa nova tentativa automática se o retorno atual confirmar reenvio_agendado_id. O roteiro e a distinção entre envio normal, recuperação e falha estão em ENVIO DE MATERIAIS."
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
    "description": "Agenda o recontato na data real da próxima turma, exclui o lead dos disparos até lá e pausa a IA. Use somente quando o lead pedir explicitamente a próxima turma ou aceitar essa opção. \"Agora não posso\", \"me chama depois\", falta de dinheiro ou prazo longo, sozinhos, não autorizam escolher a próxima turma: esclareça o pedido. Ausência momentânea não chama ferramenta; análise de material com prazo combinado de até 7 dias usa agendar_retorno. Estudante fora do prazo usa agendar_retorno tipo=formatura. Chame uma vez e só confirme o que o retorno efetivamente agendou."
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
          "description": "Copie data (YYYY-MM-DD) do slot escolhido em slots_raw de consulta_disponibilidade. Já está no fuso de Brasília; não converta UTC nem procure campo inicio."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Copie horario (HH:mm) do mesmo slot escolhido em slots_raw. Já está em Brasília; não desconte três horas."
        }
      }
    },
    "description": "Cria uma NOVA reunião individual com o monitor, nunca uma aula/evento. Chame somente após APROVADO persistido para este lead e a mesma pós, escolha vigente de data/hora pelo lead e consulta_disponibilidade confirmando esse slot. Aguarde o resultado de cada etapa; não chame junto da compatibilidade. Copie data, horario e vendedor_id de slots_raw, já em Brasília, sem conversão de fuso. Não transfira o aceite para outra opção. Reunião existente que precisa mudar usa remarcar_agendamento, sem duplicar.\nSó confirme criação e envie link após sucesso desta chamada: use exclusivamente o link retornado, nunca link antigo do histórico. Erro ou recusa não cria reunião e não autoriza dizer \"marcada\", \"reservada\" ou prometer link posterior. Falta de aprovação: verifique a mesma pós com os dados já confirmados e pergunte somente o que falta; não contorne trocando curso/identificadores. Para reunião existente, consulte o estado atual do atendimento antes de negar sua existência ou criar outra."
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
          "description": "Data YYYY-MM-DD pelo contexto temporal. Sem preferência, priorize hoje e até dois dias à frente. Com data explícita do lead, consulte essa data se válida; fora do funcionamento, explique e consulte o próximo período válido. Não é um teto absoluto de dois dias."
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
          "description": "manha = antes de 12h; tarde = de 12h até antes de 19h; noite = a partir de 19h; qualquer = sem preferência. A disponibilidade real vem da agenda. Se houver horário exato, horario_inicio_desejado tem prioridade."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional HH:mm (ex: 14:30). Preencha com o horario exato que o lead escolheu pra confirmar se ainda esta livre. Tem prioridade sobre periodo_desejado."
        }
      }
    },
    "description": "Consulta horários da conversa individual com o monitor sobre a pós. Não trata de programação ou participação em aula/evento; veja AULA OU EVENTO. Use após aceite específico da conversa e compatibilidade APROVADA, para oferecer opções ou conferir a escolha do lead. Consulta não reserva: a reunião depende da criação com sucesso.\nUse a data/hora pedida pelo lead quando estiver no funcionamento do contexto temporal. Domingo, sábado à tarde/noite e madrugada: explique a restrição, consulte o próximo período válido e apresente-o como alternativa, sem trocar o pedido silenciosamente. Priorize hoje e os próximos dois dias quando não houver preferência; data explícita do lead ou próximo dia válido retornado pela agenda pode superar essa preferência. Restrição de período/hora vai nos parâmetros.\nSe a escolha exata voltar em slots_raw, preserve-a e resolva só a pendência restante, sem novo menu. Se não voltar, ofereça alternativas reais e aguarde nova escolha. Mostre até três horários retornados, dizendo que são para a conversa com o monitor no horário de Brasília, sem nome de monitor. O retorno já traz data e horario em Brasília: não desconte três horas novamente. Ausência momentânea não chama a agenda."
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
          "description": "Nome oficial da pós de interesse atual, validado no catálogo. A decisão fica vinculada a essa pós. Se aceitar uma alternativa, registre o novo interesse e faça nova checagem."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Opcional: MM/AAAA apenas quando o lead informou mês/ano ou duração explícita que permita normalizar sem adivinhar. Envie também o texto literal em conclusao_graduacao_bruta. Se só informou posição no curso (\"2º semestre\") ou não deu previsão, deixe vazio: não invente data. Para ano/semestre ou expressão relativa, preserve a resposta bruta para o código interpretar."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "Informe o fato, não a decisão: estudante = ainda cursa, com ou sem previsão; o código decide prazo ou devolve PRECISA_DATA_CONCLUSAO. normal = graduação concluída declarada (inclusive \"sim\" à pergunta de conclusão) ou título profissional sobre si permitido pela regra de autodeclaração: médico(a) veterinário(a), veterinário(a), zootecnista, chefe/subchefe de veterinária. Nome isolado de curso, trabalho na área, auxiliar/técnico, intenção, negação ou profissão de outra pessoa não comprovam conclusão. Sem saber se concluiu, pergunte. correcao_sem_formacao = estava Sem Formação e confirmou graduação concluída com nome do curso. estudante_apto e estudante_fora_do_prazo são rótulos legados; prefira estudante."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "Para quem ainda cursa, copie literalmente a resposta sobre conclusão, se houver: \"2º semestre\", \"finalizo em 2027.1\", \"faltam 6 meses\". Sem resposta, deixe vazio. O código decide o prazo; posição no curso ou ausência de previsão retorna PRECISA_DATA_CONCLUSAO, sem aprovação nem reprovação inventada."
        }
      }
    },
    "description": "Verifica a formação e registra a decisão para este lead e esta pós. Após registrar os dados conhecidos em atualizar_dados_lead, chame antes de oferecer horários ou criar reunião. Exige nome específico da graduação e pós validada no catálogo. Título profissional declarado pelo próprio lead conforme a regra de autodeclaração dispensa repetir a coleta. Não use para confirmação de aula aberta. Nunca chame junto com a criação de reunião: aguarde o resultado.\nAPROVADO: com escolha vigente do lead e slot da agenda, pode chamar confirmar_agendamento para a mesma pós.\nREPROVADO com curso_alternativo ou outras_pos_compativeis: ofereça somente as opções retornadas; se ele escolher, valide a nova pós e repita a checagem antes de agendar. Sem alternativa ou após recusa, pausa_ia tipo=pausa para atendimento humano, sem arquivar por falta de graduação. REPROVADO_PRAZO: agendar_retorno tipo=formatura. PRECISA_DATA_CONCLUSAO: pergunte apenas o mês/ano que falta, sem adivinhar semestre. FALHA_TECNICA: informe que não conseguiu concluir a verificação agora; não diga que há uma tarefa em andamento ou retorno automático, não ofereça horários e preserve os dados. Nova tentativa só com pedido concreto ou mudança de dados, não com um simples \"ok\".\nNão exponha laudo, régua ou data-limite. Se o lead só informou os dados, prossiga sem comentar a aprovação. Se perguntou se pode cursar, responda brevemente pelo retorno. Ao oferecer alternativa, use a justificativa pública devolvida; não invente equivalência entre cursos."
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
          "description": "Nova data: copie data (YYYY-MM-DD) do slot escolhido em slots_raw. Já está em Brasília; sem conversão de UTC."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Novo horário: copie horario (HH:mm) do mesmo slot escolhido em slots_raw. Já está em Brasília; não desconte três horas."
        }
      }
    },
    "description": "Altera uma reunião individual JÁ existente, sem criar uma segunda reunião; não altera aula/evento. Pedido de trocar uma reunião usa esta ferramenta, não pausa_ia nem confirmar_agendamento. Consulte a disponibilidade para a nova preferência; com a escolha vigente do lead e o slot retornado, chame com data, horario e vendedor_id desse slot. Não repita a pergunta de escolha se ele já propôs a opção e ela voltou disponível. Copie os campos de slots_raw já em Brasília, sem conversão de UTC. Só confirme a remarcação e o link conforme o sucesso retornado. Sem reunião existente ou em falha, não alegue que remarcou; siga o retorno, sem criar duplicata."
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
          "description": "analise = tempo para ler/analisar o material, pensar ou consultar outra pessoa, com prazo combinado em dias; formatura = graduação em andamento com conclusão fora da janela, conforme REPROVADO_PRAZO."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só em formatura: meses até a conclusão informada pelo lead (1 a 36). O sistema aplica teto de 12; confirme o prazo efetivamente retornado, sem prometer a data maior."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Programa retorno por DIA para análise de material, ou por MESES para formatura; não reserva reunião nem uma hora de WhatsApp. analise: o lead quer ler, pensar ou consultar alguém e já informou/aceitou quando retomar; envie dias entre 1 e 7. Se já deu o prazo, não pergunte de novo. Sem prazo, pergunte; não invente. Acima de 7 dias, proponha uma data dentro da semana sem pressão. Se não aceitar, ofereça a próxima turma e use temporizador_proxima_turma somente após aceite; se precisar manter outro prazo, encaminhe ao humano por pausa_ia tipo=pausa, sem prometer retorno agendado. formatura: use após REPROVADO_PRAZO, com meses baseados na conclusão informada; sem previsão, esclareça antes. Só confirme a data após sucesso. A IA permanece disponível se ele voltar antes: não chame pausa_ia depois de um retorno agendado. Ausência momentânea segue DISPONIBILIDADE e não usa esta ferramenta."
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
          "description": "Normalize para sim ou nao a declaração do lead sobre já possuir pós-graduação. Não envie a frase literal neste enum; o nome da pós vai em qual_pos. Não pergunte só para preencher cadastro."
        },
        "vinculo": {
          "enum": [
            "clt",
            "autonomo",
            "consultor",
            "proprietario",
            "servidor_publico",
            "sem_trabalho"
          ],
          "type": "string",
          "description": "Vínculo de trabalho dele hoje, assim que ele disser: clt (carteira assinada), autonomo (atende ou trabalha por conta), consultor, proprietario (dono do próprio negócio: clínica, consultório, granja, fazenda, empresa), servidor_publico, sem_trabalho (não trabalha no momento). Não deduza: sem pista clara, deixe vazio."
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
    "description": "Registra somente dados declarados pelo lead: nome, graduação, conclusão e atuação. Registre assim que forem informados, antes da compatibilidade ou do envio que depende da ficha; não diga ao lead que salvou. Não puxe assunto só para completar cadastro. Se FALTA COLETAR indicar dado necessário ao material solicitado ou à reunião aceita, pergunte somente o dado pendente, registre a resposta e prossiga. Campo vazio na ficha não apaga informação já declarada no histórico."
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
          "description": "Data YYYY-MM-DD pelo contexto temporal. Sem preferência, priorize hoje e até dois dias à frente. Com data explícita do lead, consulte essa data se válida; fora do funcionamento, explique e consulte o próximo período válido. Não é um teto absoluto de dois dias."
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
          "description": "manha = antes de 12h; tarde = de 12h até antes de 19h; noite = a partir de 19h; qualquer = sem preferência. A disponibilidade real vem da agenda. Se houver horário exato, horario_inicio_desejado tem prioridade."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional. Horário no formato HH:mm (ex.: 20:00). Tem prioridade sobre periodo_desejado; a busca traz horários a partir dele."
        }
      }
    },
    "description": "Consulta horários da conversa individual com o monitor sobre a pós. Não trata de programação ou participação em aula/evento; veja AULA OU EVENTO. Use após aceite específico da conversa e compatibilidade APROVADA, para oferecer opções ou conferir a escolha do lead. Esta etapa só consulta e coleta a escolha; não cria nem confirma reunião.\nUse a data/hora pedida pelo lead quando estiver no funcionamento do contexto temporal. Domingo, sábado à tarde/noite e madrugada: explique a restrição, consulte o próximo período válido e apresente-o como alternativa, sem trocar o pedido silenciosamente. Priorize hoje e os próximos dois dias quando não houver preferência; data explícita do lead ou próximo dia válido retornado pela agenda pode superar essa preferência. Restrição de período/hora vai nos parâmetros.\nSe a escolha exata voltar em slots_raw, preserve-a e resolva só a pendência restante, sem novo menu. Se não voltar, ofereça alternativas reais e aguarde nova escolha. Mostre até três horários retornados, dizendo que são para a conversa com o monitor no horário de Brasília, sem nome de monitor. O retorno já traz data e horario em Brasília: não desconte três horas novamente. Ausência momentânea não chama a agenda."
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
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (rótulo legado; pergunta de valor integral vai em envia_informacoes), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (adiamento com objeção explícita a tratar; simples pedido de tempo não chama esta ferramenta), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (rótulo legado; consulte modalidade em consulta_pos_disponiveis), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
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
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso.\n\"Vou pensar/ler/ver com alguém\" sem motivo adicional segue PEDIDO DE TEMPO: pergunte o prazo, não chame esta ferramenta só para vencer a decisão. Com motivo explícito (preço, tempo para cursar, desconfiança), trate esse motivo uma vez; só agende retorno após prazo combinado. Preço integral vai somente em envia_informacoes e modalidade em consulta_pos_disponiveis; não chame ambas por rotina."
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
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' e 'cronograma_e_valor' (também enviam o PDF: o valor integral vai dentro do cronograma e não é escrito na conversa), 'portfolio' (PDF com todas as pós e MBAs da PPGVET; só na aula sem pós relacionada, e com curso_escolhido = \"portfolio\")."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia o PDF da pós confirmada: cronograma, valor e cronograma_e_valor enviam o mesmo documento com o investimento. Não escreva preço, parcela ou matrícula na conversa. Pedido de conteúdo, duração, grade ou investimento usa esta ferramenta; não invente dados do PDF.\nSiga a FICHA: com FALTA COLETAR, pergunte o dado necessário e registre com atualizar_dados_lead antes do primeiro envio. Insistência sem resposta segue a liberação ou PRECISA_COLETAR do executor; não ignore a recusa. Reenvio para recuperar material já enviado não refaz a entrevista. Uma tentativa por material na rodada, sem loop.\nQuando o lead pedir novamente, disser que não recebeu, não encontra ou não abre, faça uma tentativa de recuperação, mesmo após envio humano ou registro antigo. Não contradiga o relato dizendo que já recebeu ou que está acima. Após essa tentativa, pergunte se conseguiu abrir e aguarde antes de retomar a agenda.\nEnvio normal aceito/entregue/lido permite a fala de envio e, com APROVADO e sem recusa do Meet, convite e até três horários reais na mesma mensagem. Recuperação de acesso é a exceção acima. Aceite não comprova entrega; entrega não comprova abertura. Use o status atual, não um sucesso antigo. Se recusou o Meet e só quer o PDF, diga a fala do envio e pare, sem novo convite.\nFalhou/desconhecido: não confirme envio, não pause nem encaminhe ao humano só pela falha. Explique a dificuldade e pergunte se pode continuar com o agendamento enquanto isso; aguarde resposta, sem emendar coleta ou horário. Pedido explícito de humano continua usando pausa_ia tipo=pausa. Só prometa nova tentativa automática se o retorno atual confirmar reenvio_agendado_id. O roteiro e a distinção entre envio normal, recuperação e falha estão em ENVIO DE MATERIAIS.\nNa aula sem pós vinculada, após aceite e coleta necessária, portfolio com curso_escolhido=portfolio envia o catálogo de pós/MBAs. Não invente uma pós ligada à aula."
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
    "description": "Agenda o recontato na data real da próxima turma, exclui o lead dos disparos até lá e pausa a IA. Use somente quando o lead pedir explicitamente a próxima turma ou aceitar essa opção. \"Agora não posso\", \"me chama depois\", falta de dinheiro ou prazo longo, sozinhos, não autorizam escolher a próxima turma: esclareça o pedido. Ausência momentânea não chama ferramenta; análise de material com prazo combinado de até 7 dias usa agendar_retorno. Estudante fora do prazo usa agendar_retorno tipo=formatura. Chame uma vez e só confirme o que o retorno efetivamente agendou."
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
          "description": "pausa = interrompe a IA para atendimento humano; não cancela campanhas. nao_perturbe = opt-out: arquiva, resolve conversas e retira de campanhas/follow-ups; pedido explícito para parar mensagens não exige retenção. sem_graduacao = arquiva e resolve somente com declaração comprovada de nenhuma graduação concluída ou em andamento; não se aplica a estudante. Quem ainda cursa segue a checagem e, se REPROVADO_PRAZO, agendar_retorno tipo=formatura."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "A saída por \"já é aluno\" vale SOMENTE para aluno da PPG: cadastro confirmado pelo sistema ou declaração própria e explícita de vínculo com a PPG (\"faço a pós com vocês\", \"sou aluna da PPG\"). \"Já faço uma pós\", \"já sou aluno\" ou \"estou no sétimo mês\", sem identificar a instituição, NÃO comprovam esse vínculo. Não transfira para suporte com base nisso. Fazer pós em outra instituição não impede conhecer/comprar uma pós ou MBA da PPG. Correção do lead (\"é em outra instituição\", \"não sou aluno de vocês\") prevalece sobre a sua inferência e sobre pausas antigas. Só esclareça a instituição se isso for necessário ao pedido atual; uma dúvida sobre o MBA deve seguir pelo catálogo/material e pelas pendências reais, sem encaminhamento humano inventado.\nPara tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPara a automação: pausa = atendimento humano, ligação, matrícula paga, vínculo comprovado com a PPG ou formação incompatível sem alternativa aceita. Incompatibilidade só encerra após o resultado da checagem: ofereça curso_alternativo/outras_pos_compativeis antes, quando existirem. Cancelamento ou remarcação de reunião existente exige atendimento humano com tipo=pausa; esta etapa não dispõe de ferramenta para alterar a reunião.\nPedido explícito para PARAR mensagens (\"não me notifique\", \"pare de enviar\", \"me tira da lista\") usa tipo=nao_perturbe imediatamente, sem retenção, oferta de próxima turma ou mensagem promocional. Desinteresse apenas na pós, sem pedido de interromper contato: uma única pergunta de retenção; se ele reiterar que não quer contato/interesse, nao_perturbe. Tempo ou dinheiro não autorizam programar a próxima turma sem aceite. Não use pausa para pedido de análise, ausência momentânea ou graduação ainda em andamento. Uma informação antiga não substitui o pedido atual do lead. Execute a ferramenta antes de confirmar a ação e responda conforme o retorno."
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
          "description": "Normalize para sim ou nao a declaração do lead sobre já possuir pós-graduação. Não envie a frase literal neste enum; o nome da pós vai em qual_pos. Não pergunte só para preencher cadastro."
        },
        "vinculo": {
          "enum": [
            "clt",
            "autonomo",
            "consultor",
            "proprietario",
            "servidor_publico",
            "sem_trabalho"
          ],
          "type": "string",
          "description": "Vínculo de trabalho dele hoje, assim que ele disser: clt (carteira assinada), autonomo (atende ou trabalha por conta), consultor, proprietario (dono do próprio negócio: clínica, consultório, granja, fazenda, empresa), servidor_publico, sem_trabalho (não trabalha no momento). Não deduza: sem pista clara, deixe vazio."
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
    "description": "Registra somente dados declarados pelo lead: nome, graduação, conclusão e atuação. Registre assim que forem informados, antes da compatibilidade ou do envio que depende da ficha; não diga ao lead que salvou. Não puxe assunto só para completar cadastro. Se FALTA COLETAR indicar dado necessário ao material solicitado ou à reunião aceita, pergunte somente o dado pendente, registre a resposta e prossiga. Campo vazio na ficha não apaga informação já declarada no histórico."
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
          "description": "Nome oficial da pós de interesse atual, validado no catálogo. A decisão fica vinculada a essa pós. Se aceitar uma alternativa, registre o novo interesse e faça nova checagem."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Opcional: MM/AAAA apenas quando o lead informou mês/ano ou duração explícita que permita normalizar sem adivinhar. Envie também o texto literal em conclusao_graduacao_bruta. Se só informou posição no curso (\"2º semestre\") ou não deu previsão, deixe vazio: não invente data. Para ano/semestre ou expressão relativa, preserve a resposta bruta para o código interpretar."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "Informe o fato, não a decisão: estudante = ainda cursa, com ou sem previsão; o código decide prazo ou devolve PRECISA_DATA_CONCLUSAO. normal = graduação concluída declarada (inclusive \"sim\" à pergunta de conclusão) ou título profissional sobre si permitido pela regra de autodeclaração: médico(a) veterinário(a), veterinário(a), zootecnista, chefe/subchefe de veterinária. Nome isolado de curso, trabalho na área, auxiliar/técnico, intenção, negação ou profissão de outra pessoa não comprovam conclusão. Sem saber se concluiu, pergunte. correcao_sem_formacao = estava Sem Formação e confirmou graduação concluída com nome do curso. estudante_apto e estudante_fora_do_prazo são rótulos legados; prefira estudante."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "Para quem ainda cursa, copie literalmente a resposta sobre conclusão, se houver: \"2º semestre\", \"finalizo em 2027.1\", \"faltam 6 meses\". Sem resposta, deixe vazio. O código decide o prazo; posição no curso ou ausência de previsão retorna PRECISA_DATA_CONCLUSAO, sem aprovação nem reprovação inventada."
        }
      }
    },
    "description": "Verifica a formação e registra a decisão para este lead e esta pós. Após registrar os dados conhecidos em atualizar_dados_lead, chame antes de oferecer horários ou criar reunião. Exige nome específico da graduação e pós validada no catálogo. Título profissional declarado pelo próprio lead conforme a regra de autodeclaração dispensa repetir a coleta. Não use para confirmação de aula aberta. Nunca chame junto com a criação de reunião: aguarde o resultado.\nAPROVADO: consulte a agenda e obtenha a escolha do lead; a etapa seguinte cria a reunião. Esta etapa não cria nem confirma reunião.\nREPROVADO com curso_alternativo ou outras_pos_compativeis: ofereça somente as opções retornadas; se ele escolher, valide a nova pós e repita a checagem antes de agendar. Sem alternativa ou após recusa, pausa_ia tipo=pausa para atendimento humano, sem arquivar por falta de graduação. REPROVADO_PRAZO: agendar_retorno tipo=formatura. PRECISA_DATA_CONCLUSAO: pergunte apenas o mês/ano que falta, sem adivinhar semestre. FALHA_TECNICA: informe que não conseguiu concluir a verificação agora; não diga que há uma tarefa em andamento ou retorno automático, não ofereça horários e preserve os dados. Nova tentativa só com pedido concreto ou mudança de dados, não com um simples \"ok\".\nNão exponha laudo, régua ou data-limite. Se o lead só informou os dados, prossiga sem comentar a aprovação. Se perguntou se pode cursar, responda brevemente pelo retorno. Ao oferecer alternativa, use a justificativa pública devolvida; não invente equivalência entre cursos."
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
          "description": "analise = tempo para ler/analisar o material, pensar ou consultar outra pessoa, com prazo combinado em dias; formatura = graduação em andamento com conclusão fora da janela, conforme REPROVADO_PRAZO."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só em formatura: meses até a conclusão informada pelo lead (1 a 36). O sistema aplica teto de 12; confirme o prazo efetivamente retornado, sem prometer a data maior."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Programa retorno por DIA para análise de material, ou por MESES para formatura; não reserva reunião nem uma hora de WhatsApp. analise: o lead quer ler, pensar ou consultar alguém e já informou/aceitou quando retomar; envie dias entre 1 e 7. Se já deu o prazo, não pergunte de novo. Sem prazo, pergunte; não invente. Acima de 7 dias, proponha uma data dentro da semana sem pressão. Se não aceitar, ofereça a próxima turma e use temporizador_proxima_turma somente após aceite; se precisar manter outro prazo, encaminhe ao humano por pausa_ia tipo=pausa, sem prometer retorno agendado. formatura: use após REPROVADO_PRAZO, com meses baseados na conclusão informada; sem previsão, esclareça antes. Só confirme a data após sucesso. A IA permanece disponível se ele voltar antes: não chame pausa_ia depois de um retorno agendado. Ausência momentânea segue DISPONIBILIDADE e não usa esta ferramenta."
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
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' e 'cronograma_e_valor' (também enviam o PDF: o valor integral vai dentro do cronograma e não é escrito na conversa)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia o PDF da pós confirmada: cronograma, valor e cronograma_e_valor enviam o mesmo documento com o investimento. Não escreva preço, parcela ou matrícula na conversa. Pedido de conteúdo, duração, grade ou investimento usa esta ferramenta; não invente dados do PDF.\nSiga a FICHA: com FALTA COLETAR, pergunte o dado necessário e registre com atualizar_dados_lead antes do primeiro envio. Insistência sem resposta segue a liberação ou PRECISA_COLETAR do executor; não ignore a recusa. Reenvio para recuperar material já enviado não refaz a entrevista. Uma tentativa por material na rodada, sem loop.\nQuando o lead pedir novamente, disser que não recebeu, não encontra ou não abre, faça uma tentativa de recuperação, mesmo após envio humano ou registro antigo. Não contradiga o relato dizendo que já recebeu ou que está acima. Após essa tentativa, pergunte se conseguiu abrir e aguarde antes de retomar a agenda.\nEnvio normal aceito/entregue/lido permite a fala de envio e, com APROVADO e sem recusa do Meet, convite e até três horários reais na mesma mensagem. Recuperação de acesso é a exceção acima. Aceite não comprova entrega; entrega não comprova abertura. Use o status atual, não um sucesso antigo. Se recusou o Meet e só quer o PDF, diga a fala do envio e pare, sem novo convite.\nFalhou/desconhecido: não confirme envio, não pause nem encaminhe ao humano só pela falha. Explique a dificuldade e pergunte se pode continuar com o agendamento enquanto isso; aguarde resposta, sem emendar coleta ou horário. Pedido explícito de humano continua usando pausa_ia tipo=pausa. Só prometa nova tentativa automática se o retorno atual confirmar reenvio_agendado_id. O roteiro e a distinção entre envio normal, recuperação e falha estão em ENVIO DE MATERIAIS."
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
    "description": "Agenda o recontato na data real da próxima turma, exclui o lead dos disparos até lá e pausa a IA. Use somente quando o lead pedir explicitamente a próxima turma ou aceitar essa opção. \"Agora não posso\", \"me chama depois\", falta de dinheiro ou prazo longo, sozinhos, não autorizam escolher a próxima turma: esclareça o pedido. Ausência momentânea não chama ferramenta; análise de material com prazo combinado de até 7 dias usa agendar_retorno. Estudante fora do prazo usa agendar_retorno tipo=formatura. Chame uma vez e só confirme o que o retorno efetivamente agendou."
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
          "description": "Nome oficial da pós de interesse atual, validado no catálogo. A decisão fica vinculada a essa pós. Se aceitar uma alternativa, registre o novo interesse e faça nova checagem."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Opcional: MM/AAAA apenas quando o lead informou mês/ano ou duração explícita que permita normalizar sem adivinhar. Envie também o texto literal em conclusao_graduacao_bruta. Se só informou posição no curso (\"2º semestre\") ou não deu previsão, deixe vazio: não invente data. Para ano/semestre ou expressão relativa, preserve a resposta bruta para o código interpretar."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "Informe o fato, não a decisão: estudante = ainda cursa, com ou sem previsão; o código decide prazo ou devolve PRECISA_DATA_CONCLUSAO. normal = graduação concluída declarada (inclusive \"sim\" à pergunta de conclusão) ou título profissional sobre si permitido pela regra de autodeclaração: médico(a) veterinário(a), veterinário(a), zootecnista, chefe/subchefe de veterinária. Nome isolado de curso, trabalho na área, auxiliar/técnico, intenção, negação ou profissão de outra pessoa não comprovam conclusão. Sem saber se concluiu, pergunte. correcao_sem_formacao = estava Sem Formação e confirmou graduação concluída com nome do curso. estudante_apto e estudante_fora_do_prazo são rótulos legados; prefira estudante."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "Para quem ainda cursa, copie literalmente a resposta sobre conclusão, se houver: \"2º semestre\", \"finalizo em 2027.1\", \"faltam 6 meses\". Sem resposta, deixe vazio. O código decide o prazo; posição no curso ou ausência de previsão retorna PRECISA_DATA_CONCLUSAO, sem aprovação nem reprovação inventada."
        }
      }
    },
    "description": "Verifica a formação e registra a decisão para este lead e esta pós. Após registrar os dados conhecidos em atualizar_dados_lead, chame antes de oferecer horários ou criar reunião. Exige nome específico da graduação e pós validada no catálogo. Título profissional declarado pelo próprio lead conforme a regra de autodeclaração dispensa repetir a coleta. Não use para confirmação de aula aberta. Nunca chame junto com a criação de reunião: aguarde o resultado.\nAPROVADO: consulte a agenda e obtenha a escolha do lead; a etapa seguinte cria a reunião. Esta etapa não cria nem confirma reunião.\nREPROVADO com curso_alternativo ou outras_pos_compativeis: ofereça somente as opções retornadas; se ele escolher, valide a nova pós e repita a checagem antes de agendar. Sem alternativa ou após recusa, pausa_ia tipo=pausa para atendimento humano, sem arquivar por falta de graduação. REPROVADO_PRAZO: agendar_retorno tipo=formatura. PRECISA_DATA_CONCLUSAO: pergunte apenas o mês/ano que falta, sem adivinhar semestre. FALHA_TECNICA: informe que não conseguiu concluir a verificação agora; não diga que há uma tarefa em andamento ou retorno automático, não ofereça horários e preserve os dados. Nova tentativa só com pedido concreto ou mudança de dados, não com um simples \"ok\".\nNão exponha laudo, régua ou data-limite. Se o lead só informou os dados, prossiga sem comentar a aprovação. Se perguntou se pode cursar, responda brevemente pelo retorno. Ao oferecer alternativa, use a justificativa pública devolvida; não invente equivalência entre cursos."
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
          "description": "Data YYYY-MM-DD pelo contexto temporal. Sem preferência, priorize hoje e até dois dias à frente. Com data explícita do lead, consulte essa data se válida; fora do funcionamento, explique e consulte o próximo período válido. Não é um teto absoluto de dois dias."
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
          "description": "manha = antes de 12h; tarde = de 12h até antes de 19h; noite = a partir de 19h; qualquer = sem preferência. A disponibilidade real vem da agenda. Se houver horário exato, horario_inicio_desejado tem prioridade."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional. Horário no formato HH:mm (ex.: 20:00). Tem prioridade sobre periodo_desejado; a busca traz horários a partir dele."
        }
      }
    },
    "description": "Consulta horários da conversa individual com o monitor sobre a pós. Não trata de programação ou participação em aula/evento; veja AULA OU EVENTO. Use após aceite específico da conversa e compatibilidade APROVADA, para oferecer opções ou conferir a escolha do lead. Esta etapa só consulta e coleta a escolha; não cria nem confirma reunião.\nUse a data/hora pedida pelo lead quando estiver no funcionamento do contexto temporal. Domingo, sábado à tarde/noite e madrugada: explique a restrição, consulte o próximo período válido e apresente-o como alternativa, sem trocar o pedido silenciosamente. Priorize hoje e os próximos dois dias quando não houver preferência; data explícita do lead ou próximo dia válido retornado pela agenda pode superar essa preferência. Restrição de período/hora vai nos parâmetros.\nSe a escolha exata voltar em slots_raw, preserve-a e resolva só a pendência restante, sem novo menu. Se não voltar, ofereça alternativas reais e aguarde nova escolha. Mostre até três horários retornados, dizendo que são para a conversa com o monitor no horário de Brasília, sem nome de monitor. O retorno já traz data e horario em Brasília: não desconte três horas novamente. Ausência momentânea não chama a agenda."
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
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (rótulo legado; pergunta de valor integral vai em envia_informacoes), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (adiamento com objeção explícita a tratar; simples pedido de tempo não chama esta ferramenta), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (rótulo legado; consulte modalidade em consulta_pos_disponiveis), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
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
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso.\n\"Vou pensar/ler/ver com alguém\" sem motivo adicional segue PEDIDO DE TEMPO: pergunte o prazo, não chame esta ferramenta só para vencer a decisão. Com motivo explícito (preço, tempo para cursar, desconfiança), trate esse motivo uma vez; só agende retorno após prazo combinado. Preço integral vai somente em envia_informacoes e modalidade em consulta_pos_disponiveis; não chame ambas por rotina."
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
          "description": "pausa = interrompe a IA para atendimento humano; não cancela campanhas. nao_perturbe = opt-out: arquiva, resolve conversas e retira de campanhas/follow-ups; pedido explícito para parar mensagens não exige retenção. sem_graduacao = arquiva e resolve somente com declaração comprovada de nenhuma graduação concluída ou em andamento; não se aplica a estudante. Quem ainda cursa segue a checagem e, se REPROVADO_PRAZO, agendar_retorno tipo=formatura."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "A saída por \"já é aluno\" vale SOMENTE para aluno da PPG: cadastro confirmado pelo sistema ou declaração própria e explícita de vínculo com a PPG (\"faço a pós com vocês\", \"sou aluna da PPG\"). \"Já faço uma pós\", \"já sou aluno\" ou \"estou no sétimo mês\", sem identificar a instituição, NÃO comprovam esse vínculo. Não transfira para suporte com base nisso. Fazer pós em outra instituição não impede conhecer/comprar uma pós ou MBA da PPG. Correção do lead (\"é em outra instituição\", \"não sou aluno de vocês\") prevalece sobre a sua inferência e sobre pausas antigas. Só esclareça a instituição se isso for necessário ao pedido atual; uma dúvida sobre o MBA deve seguir pelo catálogo/material e pelas pendências reais, sem encaminhamento humano inventado.\nPara tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPara a automação: pausa = atendimento humano, ligação, matrícula paga, vínculo comprovado com a PPG ou formação incompatível sem alternativa aceita. Incompatibilidade só encerra após o resultado da checagem: ofereça curso_alternativo/outras_pos_compativeis antes, quando existirem. Cancelamento ou remarcação de reunião existente exige atendimento humano com tipo=pausa; esta etapa não dispõe de ferramenta para alterar a reunião.\nPedido explícito para PARAR mensagens (\"não me notifique\", \"pare de enviar\", \"me tira da lista\") usa tipo=nao_perturbe imediatamente, sem retenção, oferta de próxima turma ou mensagem promocional. Desinteresse apenas na pós, sem pedido de interromper contato: uma única pergunta de retenção; se ele reiterar que não quer contato/interesse, nao_perturbe. Tempo ou dinheiro não autorizam programar a próxima turma sem aceite. Não use pausa para pedido de análise, ausência momentânea ou graduação ainda em andamento. Uma informação antiga não substitui o pedido atual do lead. Execute a ferramenta antes de confirmar a ação e responda conforme o retorno."
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
          "description": "Normalize para sim ou nao a declaração do lead sobre já possuir pós-graduação. Não envie a frase literal neste enum; o nome da pós vai em qual_pos. Não pergunte só para preencher cadastro."
        },
        "vinculo": {
          "enum": [
            "clt",
            "autonomo",
            "consultor",
            "proprietario",
            "servidor_publico",
            "sem_trabalho"
          ],
          "type": "string",
          "description": "Vínculo de trabalho dele hoje, assim que ele disser: clt (carteira assinada), autonomo (atende ou trabalha por conta), consultor, proprietario (dono do próprio negócio: clínica, consultório, granja, fazenda, empresa), servidor_publico, sem_trabalho (não trabalha no momento). Não deduza: sem pista clara, deixe vazio."
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
    "description": "Registra somente dados declarados pelo lead: nome, graduação, conclusão e atuação. Registre assim que forem informados, antes da compatibilidade ou do envio que depende da ficha; não diga ao lead que salvou. Não puxe assunto só para completar cadastro. Se FALTA COLETAR indicar dado necessário ao material solicitado ou à reunião aceita, pergunte somente o dado pendente, registre a resposta e prossiga. Campo vazio na ficha não apaga informação já declarada no histórico."
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
          "description": "analise = tempo para ler/analisar o material, pensar ou consultar outra pessoa, com prazo combinado em dias; formatura = graduação em andamento com conclusão fora da janela, conforme REPROVADO_PRAZO."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só em formatura: meses até a conclusão informada pelo lead (1 a 36). O sistema aplica teto de 12; confirme o prazo efetivamente retornado, sem prometer a data maior."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Programa retorno por DIA para análise de material, ou por MESES para formatura; não reserva reunião nem uma hora de WhatsApp. analise: o lead quer ler, pensar ou consultar alguém e já informou/aceitou quando retomar; envie dias entre 1 e 7. Se já deu o prazo, não pergunte de novo. Sem prazo, pergunte; não invente. Acima de 7 dias, proponha uma data dentro da semana sem pressão. Se não aceitar, ofereça a próxima turma e use temporizador_proxima_turma somente após aceite; se precisar manter outro prazo, encaminhe ao humano por pausa_ia tipo=pausa, sem prometer retorno agendado. formatura: use após REPROVADO_PRAZO, com meses baseados na conclusão informada; sem previsão, esclareça antes. Só confirme a data após sucesso. A IA permanece disponível se ele voltar antes: não chame pausa_ia depois de um retorno agendado. Ausência momentânea segue DISPONIBILIDADE e não usa esta ferramenta."
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
    "description": "Agenda o recontato na data real da próxima turma, exclui o lead dos disparos até lá e pausa a IA. Use somente quando o lead pedir explicitamente a próxima turma ou aceitar essa opção. \"Agora não posso\", \"me chama depois\", falta de dinheiro ou prazo longo, sozinhos, não autorizam escolher a próxima turma: esclareça o pedido. Ausência momentânea não chama ferramenta; análise de material com prazo combinado de até 7 dias usa agendar_retorno. Estudante fora do prazo usa agendar_retorno tipo=formatura. Chame uma vez e só confirme o que o retorno efetivamente agendou."
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
          "description": "Classifique a fala do lead. ⚠️ ESTA CLASSIFICAÇÃO FILTRA A BUSCA: a quebra devolvida vem do grupo que você escolher, então rótulo errado devolve resposta de outro assunto. Opções: 'objecao_tempo' (sem tempo/ocupado/correria), 'objecao_canal' (prefere whatsapp/não quer reunião), 'pergunta_preco' (rótulo legado; pergunta de valor integral vai em envia_informacoes), 'objecao_financeira' (o lead diz que NÃO CONSEGUE PAGAR: 'não tenho condições', 'essa parcela eu não consigo assumir', 'tô desempregado/entre empregos', 'fora do meu orçamento' — é dor de dinheiro, NÃO é pergunta de preço, e mandar o valor cheio aqui piora), 'objecao_adiamento' (adiamento com objeção explícita a tratar; simples pedido de tempo não chama esta ferramenta), 'objecao_desconfianca' (é golpe?/nunca ouvi falar/é confiável?), 'objecao_duvida' (vale a pena?/será que faço), 'pergunta_condicao' (tem desconto/bolsa/promoção/condição), 'objecao_terceiro' (vou ver com esposa/marido/sócio/chefe/família), 'pergunta_modalidade' (rótulo legado; consulte modalidade em consulta_pos_disponiveis), 'pergunta_instituicao' (quem é a PPG/de onde são/é reconhecida)."
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
    "description": "Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: \"não posso atender agora\" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de \"não tenho tempo para cursar a pós\", que é objeção real.\nFalta de tempo JUNTO com pedido de material ('tô sem tempo, manda por aqui'): classifique como objecao_tempo e trate a falta de tempo primeiro; objecao_canal só se ele insistir no WhatsApp depois disso.\n\"Vou pensar/ler/ver com alguém\" sem motivo adicional segue PEDIDO DE TEMPO: pergunte o prazo, não chame esta ferramenta só para vencer a decisão. Com motivo explícito (preço, tempo para cursar, desconfiança), trate esse motivo uma vez; só agende retorno após prazo combinado. Preço integral vai somente em envia_informacoes e modalidade em consulta_pos_disponiveis; não chame ambas por rotina."
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
          "description": "pausa = interrompe a IA para atendimento humano; não cancela campanhas. nao_perturbe = opt-out: arquiva, resolve conversas e retira de campanhas/follow-ups; pedido explícito para parar mensagens não exige retenção. sem_graduacao = arquiva e resolve somente com declaração comprovada de nenhuma graduação concluída ou em andamento; não se aplica a estudante. Quem ainda cursa segue a checagem e, se REPROVADO_PRAZO, agendar_retorno tipo=formatura."
        },
        "motivo": {
          "type": "string",
          "description": "Motivo da pausa baseado na mensagem do lead. Ex: 'Lead pediu atendimento humano', 'Lead demonstrou desinteresse total', 'Lead não possui graduação nenhuma, apenas ensino médio', 'Lead com formação incompatível'. Seja específico: se ele não tem graduação, diga se é por não ter cursado nenhuma (e não por estar cursando)."
        }
      }
    },
    "description": "A saída por \"já é aluno\" vale SOMENTE para aluno da PPG: cadastro confirmado pelo sistema ou declaração própria e explícita de vínculo com a PPG (\"faço a pós com vocês\", \"sou aluna da PPG\"). \"Já faço uma pós\", \"já sou aluno\" ou \"estou no sétimo mês\", sem identificar a instituição, NÃO comprovam esse vínculo. Não transfira para suporte com base nisso. Fazer pós em outra instituição não impede conhecer/comprar uma pós ou MBA da PPG. Correção do lead (\"é em outra instituição\", \"não sou aluno de vocês\") prevalece sobre a sua inferência e sobre pausas antigas. Só esclareça a instituição se isso for necessário ao pedido atual; uma dúvida sobre o MBA deve seguir pelo catálogo/material e pelas pendências reais, sem encaminhamento humano inventado.\nPara tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\nPara a automação: pausa = atendimento humano, ligação, matrícula paga, vínculo comprovado com a PPG ou formação incompatível sem alternativa aceita. Incompatibilidade só encerra após o resultado da checagem: ofereça curso_alternativo/outras_pos_compativeis antes, quando existirem. Pedido de mudar uma reunião existente usa consulta_disponibilidade e remarcar_agendamento, sem pausar. Cancelamento de reunião exige atendimento humano com tipo=pausa.\nPedido explícito para PARAR mensagens (\"não me notifique\", \"pare de enviar\", \"me tira da lista\") usa tipo=nao_perturbe imediatamente, sem retenção, oferta de próxima turma ou mensagem promocional. Desinteresse apenas na pós, sem pedido de interromper contato: uma única pergunta de retenção; se ele reiterar que não quer contato/interesse, nao_perturbe. Tempo ou dinheiro não autorizam programar a próxima turma sem aceite. Não use pausa para pedido de análise, ausência momentânea ou graduação ainda em andamento. Uma informação antiga não substitui o pedido atual do lead. Execute a ferramenta antes de confirmar a ação e responda conforme o retorno."
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
          "description": "O que enviar: 'cronograma' (PDF enviado direto ao lead), 'valor' e 'cronograma_e_valor' (também enviam o PDF: o valor integral vai dentro do cronograma e não é escrito na conversa)."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        }
      }
    },
    "description": "Envia o PDF da pós confirmada: cronograma, valor e cronograma_e_valor enviam o mesmo documento com o investimento. Não escreva preço, parcela ou matrícula na conversa. Pedido de conteúdo, duração, grade ou investimento usa esta ferramenta; não invente dados do PDF.\nSiga a FICHA: com FALTA COLETAR, pergunte o dado necessário e registre com atualizar_dados_lead antes do primeiro envio. Insistência sem resposta segue a liberação ou PRECISA_COLETAR do executor; não ignore a recusa. Reenvio para recuperar material já enviado não refaz a entrevista. Uma tentativa por material na rodada, sem loop.\nQuando o lead pedir novamente, disser que não recebeu, não encontra ou não abre, faça uma tentativa de recuperação, mesmo após envio humano ou registro antigo. Não contradiga o relato dizendo que já recebeu ou que está acima. Após essa tentativa, pergunte se conseguiu abrir e aguarde antes de retomar a agenda.\nEnvio normal aceito/entregue/lido permite a fala de envio e, com APROVADO e sem recusa do Meet, convite e até três horários reais na mesma mensagem. Recuperação de acesso é a exceção acima. Aceite não comprova entrega; entrega não comprova abertura. Use o status atual, não um sucesso antigo. Se recusou o Meet e só quer o PDF, diga a fala do envio e pare, sem novo convite.\nFalhou/desconhecido: não confirme envio, não pause nem encaminhe ao humano só pela falha. Explique a dificuldade e pergunte se pode continuar com o agendamento enquanto isso; aguarde resposta, sem emendar coleta ou horário. Pedido explícito de humano continua usando pausa_ia tipo=pausa. Só prometa nova tentativa automática se o retorno atual confirmar reenvio_agendado_id. O roteiro e a distinção entre envio normal, recuperação e falha estão em ENVIO DE MATERIAIS."
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
          "description": "Copie data (YYYY-MM-DD) do slot escolhido em slots_raw de consulta_disponibilidade. Já está no fuso de Brasília; não converta UTC nem procure campo inicio."
        },
        "curso_escolhido": {
          "type": "string",
          "description": "Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Copie horario (HH:mm) do mesmo slot escolhido em slots_raw. Já está em Brasília; não desconte três horas."
        }
      }
    },
    "description": "Cria uma NOVA reunião individual com o monitor, nunca uma aula/evento. Chame somente após APROVADO persistido para este lead e a mesma pós, escolha vigente de data/hora pelo lead e consulta_disponibilidade confirmando esse slot. Aguarde o resultado de cada etapa; não chame junto da compatibilidade. Copie data, horario e vendedor_id de slots_raw, já em Brasília, sem conversão de fuso. Não transfira o aceite para outra opção. Reunião existente que precisa mudar usa remarcar_agendamento, sem duplicar.\nSó confirme criação e envie link após sucesso desta chamada: use exclusivamente o link retornado, nunca link antigo do histórico. Erro ou recusa não cria reunião e não autoriza dizer \"marcada\", \"reservada\" ou prometer link posterior. Falta de aprovação: verifique a mesma pós com os dados já confirmados e pergunte somente o que falta; não contorne trocando curso/identificadores. Para reunião existente, consulte o estado atual do atendimento antes de negar sua existência ou criar outra."
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
          "description": "Data YYYY-MM-DD pelo contexto temporal. Sem preferência, priorize hoje e até dois dias à frente. Com data explícita do lead, consulte essa data se válida; fora do funcionamento, explique e consulte o próximo período válido. Não é um teto absoluto de dois dias."
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
          "description": "manha = antes de 12h; tarde = de 12h até antes de 19h; noite = a partir de 19h; qualquer = sem preferência. A disponibilidade real vem da agenda. Se houver horário exato, horario_inicio_desejado tem prioridade."
        },
        "horario_inicio_desejado": {
          "type": "string",
          "description": "Opcional HH:mm (ex: 14:30). Preencha com o horario exato que o lead escolheu pra confirmar se ainda esta livre. Tem prioridade sobre periodo_desejado."
        }
      }
    },
    "description": "Consulta horários da conversa individual com o monitor sobre a pós. Não trata de programação ou participação em aula/evento; veja AULA OU EVENTO. Use após aceite específico da conversa e compatibilidade APROVADA, para oferecer opções ou conferir a escolha do lead. Consulta não reserva: a reunião depende da criação com sucesso.\nUse a data/hora pedida pelo lead quando estiver no funcionamento do contexto temporal. Domingo, sábado à tarde/noite e madrugada: explique a restrição, consulte o próximo período válido e apresente-o como alternativa, sem trocar o pedido silenciosamente. Priorize hoje e os próximos dois dias quando não houver preferência; data explícita do lead ou próximo dia válido retornado pela agenda pode superar essa preferência. Restrição de período/hora vai nos parâmetros.\nSe a escolha exata voltar em slots_raw, preserve-a e resolva só a pendência restante, sem novo menu. Se não voltar, ofereça alternativas reais e aguarde nova escolha. Mostre até três horários retornados, dizendo que são para a conversa com o monitor no horário de Brasília, sem nome de monitor. O retorno já traz data e horario em Brasília: não desconte três horas novamente. Ausência momentânea não chama a agenda."
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
          "description": "Nome oficial da pós de interesse atual, validado no catálogo. A decisão fica vinculada a essa pós. Se aceitar uma alternativa, registre o novo interesse e faça nova checagem."
        },
        "formacao_academica": {
          "type": "string",
          "description": "Nome ESPECÍFICO do curso de graduação do lead. OBRIGATÓRIO usar o nome completo do curso (ex: 'Medicina Veterinária', 'Zootecnia', 'Agronomia', 'Biologia'). NUNCA aceitar valores vagos como: 'estudante', 'graduação', 'formado', 'cursando'. Se você não tem o nome específico do curso, NÃO execute esta função - pergunte ao lead primeiro: 'Qual é o nome do seu curso de graduação?'"
        },
        "conclusao_graduacao": {
          "type": "string",
          "description": "Opcional: MM/AAAA apenas quando o lead informou mês/ano ou duração explícita que permita normalizar sem adivinhar. Envie também o texto literal em conclusao_graduacao_bruta. Se só informou posição no curso (\"2º semestre\") ou não deu previsão, deixe vazio: não invente data. Para ano/semestre ou expressão relativa, preserve a resposta bruta para o código interpretar."
        },
        "contexto_qualificacao": {
          "enum": [
            "normal",
            "estudante",
            "estudante_apto",
            "estudante_fora_do_prazo",
            "correcao_sem_formacao"
          ],
          "type": "string",
          "description": "Informe o fato, não a decisão: estudante = ainda cursa, com ou sem previsão; o código decide prazo ou devolve PRECISA_DATA_CONCLUSAO. normal = graduação concluída declarada (inclusive \"sim\" à pergunta de conclusão) ou título profissional sobre si permitido pela regra de autodeclaração: médico(a) veterinário(a), veterinário(a), zootecnista, chefe/subchefe de veterinária. Nome isolado de curso, trabalho na área, auxiliar/técnico, intenção, negação ou profissão de outra pessoa não comprovam conclusão. Sem saber se concluiu, pergunte. correcao_sem_formacao = estava Sem Formação e confirmou graduação concluída com nome do curso. estudante_apto e estudante_fora_do_prazo são rótulos legados; prefira estudante."
        },
        "objetivos_profissionais": {
          "type": "string",
          "description": "OPCIONAL. O principal objetivo de carreira mencionado pelo lead. O que ele espera alcançar com a pós-graduação (ex: 'promoção', 'aumento salarial', 'transição de carreira', 'abrir clínica própria', 'concurso público'). Capture se o lead mencionar."
        },
        "conclusao_graduacao_bruta": {
          "type": "string",
          "description": "Para quem ainda cursa, copie literalmente a resposta sobre conclusão, se houver: \"2º semestre\", \"finalizo em 2027.1\", \"faltam 6 meses\". Sem resposta, deixe vazio. O código decide o prazo; posição no curso ou ausência de previsão retorna PRECISA_DATA_CONCLUSAO, sem aprovação nem reprovação inventada."
        }
      }
    },
    "description": "Verifica a formação e registra a decisão para este lead e esta pós. Após registrar os dados conhecidos em atualizar_dados_lead, chame antes de oferecer horários ou criar reunião. Exige nome específico da graduação e pós validada no catálogo. Título profissional declarado pelo próprio lead conforme a regra de autodeclaração dispensa repetir a coleta. Não use para confirmação de aula aberta. Nunca chame junto com a criação de reunião: aguarde o resultado.\nAPROVADO: com escolha vigente do lead e slot da agenda, pode chamar confirmar_agendamento para a mesma pós.\nREPROVADO com curso_alternativo ou outras_pos_compativeis: ofereça somente as opções retornadas; se ele escolher, valide a nova pós e repita a checagem antes de agendar. Sem alternativa ou após recusa, pausa_ia tipo=pausa para atendimento humano, sem arquivar por falta de graduação. REPROVADO_PRAZO: agendar_retorno tipo=formatura. PRECISA_DATA_CONCLUSAO: pergunte apenas o mês/ano que falta, sem adivinhar semestre. FALHA_TECNICA: informe que não conseguiu concluir a verificação agora; não diga que há uma tarefa em andamento ou retorno automático, não ofereça horários e preserve os dados. Nova tentativa só com pedido concreto ou mudança de dados, não com um simples \"ok\".\nNão exponha laudo, régua ou data-limite. Se o lead só informou os dados, prossiga sem comentar a aprovação. Se perguntou se pode cursar, responda brevemente pelo retorno. Ao oferecer alternativa, use a justificativa pública devolvida; não invente equivalência entre cursos."
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
          "description": "Nova data: copie data (YYYY-MM-DD) do slot escolhido em slots_raw. Já está em Brasília; sem conversão de UTC."
        },
        "horario_escolhido": {
          "type": "string",
          "description": "Novo horário: copie horario (HH:mm) do mesmo slot escolhido em slots_raw. Já está em Brasília; não desconte três horas."
        }
      }
    },
    "description": "Altera uma reunião individual JÁ existente, sem criar uma segunda reunião; não altera aula/evento. Pedido de trocar uma reunião usa esta ferramenta, não pausa_ia nem confirmar_agendamento. Consulte a disponibilidade para a nova preferência; com a escolha vigente do lead e o slot retornado, chame com data, horario e vendedor_id desse slot. Não repita a pergunta de escolha se ele já propôs a opção e ela voltou disponível. Copie os campos de slots_raw já em Brasília, sem conversão de UTC. Só confirme a remarcação e o link conforme o sucesso retornado. Sem reunião existente ou em falha, não alegue que remarcou; siga o retorno, sem criar duplicata."
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
          "description": "analise = tempo para ler/analisar o material, pensar ou consultar outra pessoa, com prazo combinado em dias; formatura = graduação em andamento com conclusão fora da janela, conforme REPROVADO_PRAZO."
        },
        "meses": {
          "type": "integer",
          "maximum": 36,
          "minimum": 1,
          "description": "Só em formatura: meses até a conclusão informada pelo lead (1 a 36). O sistema aplica teto de 12; confirme o prazo efetivamente retornado, sem prometer a data maior."
        },
        "motivo": {
          "type": "string",
          "description": "O que o lead disse, em poucas palavras. Ex: \"conclui a graduação em 2028\"."
        }
      }
    },
    "description": "Programa retorno por DIA para análise de material, ou por MESES para formatura; não reserva reunião nem uma hora de WhatsApp. analise: o lead quer ler, pensar ou consultar alguém e já informou/aceitou quando retomar; envie dias entre 1 e 7. Se já deu o prazo, não pergunte de novo. Sem prazo, pergunte; não invente. Acima de 7 dias, proponha uma data dentro da semana sem pressão. Se não aceitar, ofereça a próxima turma e use temporizador_proxima_turma somente após aceite; se precisar manter outro prazo, encaminhe ao humano por pausa_ia tipo=pausa, sem prometer retorno agendado. formatura: use após REPROVADO_PRAZO, com meses baseados na conclusão informada; sem previsão, esclareça antes. Só confirme a data após sucesso. A IA permanece disponível se ele voltar antes: não chame pausa_ia depois de um retorno agendado. Ausência momentânea segue DISPONIBILIDADE e não usa esta ferramenta."
  },
  "atualizar_dados_lead__recontato": {
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
          "description": "Normalize para sim ou nao a declaração do lead sobre já possuir pós-graduação. Não envie a frase literal neste enum; o nome da pós vai em qual_pos. Não pergunte só para preencher cadastro."
        },
        "vinculo": {
          "enum": [
            "clt",
            "autonomo",
            "consultor",
            "proprietario",
            "servidor_publico",
            "sem_trabalho"
          ],
          "type": "string",
          "description": "Vínculo de trabalho dele hoje, assim que ele disser: clt (carteira assinada), autonomo (atende ou trabalha por conta), consultor, proprietario (dono do próprio negócio: clínica, consultório, granja, fazenda, empresa), servidor_publico, sem_trabalho (não trabalha no momento). Não deduza: sem pista clara, deixe vazio."
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
    "description": "Registra somente dados declarados pelo lead: nome, graduação, conclusão e atuação. Registre assim que forem informados, antes da compatibilidade ou do envio que depende da ficha; não diga ao lead que salvou. Não puxe assunto só para completar cadastro. Se FALTA COLETAR indicar dado necessário ao material solicitado ou à reunião aceita, pergunte somente o dado pendente, registre a resposta e prossiga. Campo vazio na ficha não apaga informação já declarada no histórico."
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
    "agendar_retorno__recontato",
    "atualizar_dados_lead__recontato"
  ]
};
