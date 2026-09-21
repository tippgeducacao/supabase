// Contratos versionados junto dos executores. A lista/permissões continua vindo
// de lista_tools_claude; a descrição efetiva não depende de editar produção para testar.
import { INSTRUCAO_AGENDA_EVENTOS } from './instrucaoEventos.ts';
import { INSTRUCAO_TITULOS_PROFISSIONAIS } from './fatosLead.ts';
type Propriedade = { description?: string; [chave: string]: unknown };
type ToolSdr = {
  name: string;
  description?: string;
  input_schema: { properties?: Record<string, Propriedade>; [chave: string]: unknown };
  [chave: string]: unknown;
};
export function descreverToolsSdr(tools: ToolSdr[]): ToolSdr[] {
  return tools.map(original => {
    const tool = structuredClone(original);
    if (tool.name === 'verificar_compatibilidade_curso') {
      // 15/09/2026, Luciana: o catálogo antigo exigia perguntar conclusão até
      // após a autodeclaração profissional. A descrição efetiva acompanha a
      // regra comercial sem depender de migration nem alterar o contrato JSON.
      if (!tool.description?.includes(INSTRUCAO_TITULOS_PROFISSIONAIS)) {
        tool.description = INSTRUCAO_TITULOS_PROFISSIONAIS + '\n\n' + (tool.description ?? '');
      }
      const contexto = tool.input_schema.properties?.contexto_qualificacao;
      if (contexto) {
        contexto.description = 'Informe a situação realmente declarada pelo lead. normal = graduação concluída explicitamente declarada ou título autodeclarado de médico veterinário/veterinário, zootecnista ou chefe/subchefe de veterinária, conforme a regra da descrição desta ferramenta. Auxiliar/técnico, terceiro, intenção, negação e cargo genérico não equivalem a título concluído. Quem ainda cursa essa graduação nunca usa normal. Nome do curso isolado e trabalho na área não confirmam conclusão. Para estudante, use a DATA-LIMITE DE ELEGIBILIDADE calculada no contexto temporal; não recalcule nem reprove apenas por ser ano que vem. estudante_apto = conclusão dentro dessa data-limite; estudante_fora_do_prazo = conclusão depois dela. Envie a resposta literal em conclusao_graduacao_bruta e a data sustentada por ela em conclusao_graduacao. Se faltar saber se já concluiu ou em que mês/ano conclui, pergunte só isso, usando a graduação já conhecida. Semestre/período e respostas ambíguas não permitem deduzir conclusão. correcao_sem_formacao só vale quando estava marcado Sem Formação, mas declarou graduação concluída ou título profissional aceito e informou o curso correspondente. Esses contextos descrevem a informação recebida; não substituem a aprovação da ferramenta para o mesmo lead e pós. Não cite a régua, data-limite ou elegibilidade ao lead.';
      }
    }
    if (['consulta_disponibilidade', 'confirmar_agendamento', 'remarcar_agendamento'].includes(tool.name)
      && !tool.description?.includes(INSTRUCAO_AGENDA_EVENTOS)) {
      tool.description = INSTRUCAO_AGENDA_EVENTOS + '\n\n' + (tool.description ?? '');
    }
    if (tool.name === 'pausa_ia') {
      tool.description = 'Para tipo=sem_graduacao, exige declaração explícita do próprio lead de nunca ter cursado graduação ou ter somente ensino médio/técnico, sem graduação em andamento nem outra concluída. O executor confere o histórico e bloqueia sem evidência. Não atuar/trabalhar em nenhuma área, pretender atuar, cadastro vazio e resposta curta sobre trabalho NÃO informam formação. Interesse somente na aula aberta não autoriza desqualificar nem arquivar. Se faltar informação, preserve o atendimento e esclareça somente o necessário para o objetivo atual.\n' + (tool.description ?? '');
    }
    if (tool.name === 'consulta_disponibilidade') {
      tool.description = 'Esta ferramenta consulta horários de REUNIÃO, não de retorno por mensagem. Ausência momentânea ("agora não posso atender") exige perguntar quando pode chamar por aqui, sem consultar agenda. Uma data/hora respondida a essa pergunta é retorno no canal, não aceite de Meet. Só consulte para interesse explícito em agendar a reunião.\n' + (tool.description ?? '');
      tool.description = (tool.description ?? '') + '\nSe o lead propôs data e hora concretas para a reunião, consulte exatamente essa opção, mesmo sem oferta anterior do SDR. Não desloque 13:00 para 13:30 por uma tabela genérica. Se o mesmo dia e horário aparecer em slots_raw, preserve a escolha e avance apenas nas pendências de qualificação; não abra um novo menu de horários. Disponibilidade não é aprovação nem agendamento. Se a opção estiver ausente, ofereça alternativas reais e aguarde nova escolha.';
    }
    if (tool.name === 'agendar_retorno') {
      tool.description = 'Não use para ausência momentânea ou para registrar uma hora de retorno por WhatsApp. Sem prazo informado, pergunte quando pode chamar; não invente dias. Esta ferramenta não agenda hora exata nem reunião.\n' + (tool.description ?? '');
    }
    if (tool.name === 'consulta_pos_disponiveis') {
      tool.description = `Fonte obrigatória do catálogo de pós ATIVAS e modalidades por curso. Chame quando o lead mencionar uma pós ainda não validada, inclusive na PRIMEIRA escolha de interesse, ou perguntar se temos uma pós, quais existem, qual é online ou semipresencial. Antes de confirmar que oferecemos, falar em matrícula/condição ou encaminhar para agenda, valide o nome aqui. Repetir o nome dito pelo lead NÃO comprova existência: clínica de pequenos animais não equivale a clínica de bovinos. Use curso_consulta para consultar sem alterar interesse, inclusive dúvidas sobre outra pós. Use trocar_para SOMENTE quando o lead tiver escolhido explicitamente aquela pós. Sem parâmetros lista catálogo e modalidades. Não passe os dois campos juntos. Respeite status: só curso_confirmado/interesse_atualizado autoriza adotar o curso; semelhança textual exige esclarecimento, nunca troca automática. Se não encontrado, diga que não temos essa pós e ofereça apenas alternativas reais pertinentes, aguardando escolha. Não invente modalidade, conteúdo, cidade, frequência ou carga horária. O retorno específico prevalece sobre frases genéricas de objeção ou conhecimento anterior. Depois de responder, siga qualificando e agendando conforme o interesse validado.`;
      tool.input_schema = { type: 'object', properties: {
        curso_consulta: { type: 'string', description: 'Nome exato dito pelo lead para verificar existência/modalidade. Somente consulta, sem mudar o interesse.' },
        trocar_para: { type: 'string', description: 'Pós explicitamente escolhida pelo lead. Valida e registra; não use só porque ele perguntou se existe ou como funciona.' },
      }, additionalProperties: false };
    }
    if (tool.name === 'consulta_objecoes') {
      tool.description = `Consulta a base de argumentos para uma objeção REAL do lead: falta de tempo, preferência por mensagem, desconfiança, adiamento, terceiro ou dificuldade financeira. Use mensagem_lead literal e completa, inclusive negações; classifique a intenção atual, não a etapa do funil. Acolha e use apenas o argumento pertinente retornado, com resposta curta e natural; depois retome a pendência do atendimento sem pressionar ou repetir convite ignorando a dúvida. Pergunta factual não é automaticamente objeção: existência/nome e online/semipresencial vão PRIMEIRO em consulta_pos_disponiveis; cronograma/grade/conteúdo, duração ou preço integral vão em envia_informacoes (cronograma ou valor). Se chegar pergunta_modalidade aqui, informe curso_consulta: o executor consulta o catálogo, não usa a resposta genérica da base. 'Quanto custa?' é preço; 'não consigo pagar' é objecao_financeira; 'não estou sem dinheiro' não é dor financeira. Não invente descontos, bolsas, parcelas, urgência, características ou resultados do curso. Sem evidência pertinente (CONFIANCA_BAIXA/INDISPONIVEL), reconheça a dúvida sem fabricar argumento nem reutilizar uma resposta de outro assunto. Não chame só por saudação, aceite de horário ou pedido de reenvio de material. Pergunta sobre a instituição (quem são vocês, de onde falam, onde fica a sede, é reconhecida, nunca ouvi falar, tem credibilidade) é tipo_objecao pergunta_instituicao: consulte ANTES de responder e use só o que a base devolver; sede, cidade, número de alunos e reconhecimento nunca saem de cabeça.`;
      tool.input_schema.properties ??= {};
      tool.description += '\nNão use para ausência momentânea ou mensagem automática de indisponibilidade: "não posso atender agora" pede acolhimento e pergunta de quando retomar por aqui, sem quebra de objeção. Diferencie de "não tenho tempo para cursar a pós", que é objeção real.';
      tool.input_schema.properties.curso_consulta = { type: 'string', description: 'Nome da pós mencionada na dúvida de modalidade; não altera o interesse.' };
    }
    if (tool.input_schema?.properties?.curso_escolhido) {
      tool.input_schema.properties.curso_escolhido.description = 'Nome oficial/natural de uma pós confirmada por consulta_pos_disponiveis e escolhida pelo lead. Não use nome inventado ou resultado aproximado sem confirmação.';
      tool.description += '\nAntes de usar um nome de pós novo na conversa, valide-o em consulta_pos_disponiveis. Não confirme oferta, qualificação ou agenda de curso inexistente; não substitua a área pedida por outra só por semelhança do nome.';
    }
    return tool;
  });
}
