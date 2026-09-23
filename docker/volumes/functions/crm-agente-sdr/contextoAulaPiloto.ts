import { estadoDaAula, montarVarsAula, type AulaParaPrompt } from './prompts-aula.ts';

// 23/09: a captação começa 7–10 dias ANTES da live. O relógio informa o estado
// da aula, mas não prova que o lead assistiu. A mesma missão chega ao follow-up.
export const INSTRUCAO_AULA_PILOTO = `## Condução do piloto de aulas
Esta orientação substitui a ordem genérica de venda, o convite imediato do lote e os exemplos de pressão do roteiro antigo.
O lead vem do anúncio/convite de uma aula gratuita ao vivo no YouTube, geralmente captado de sete a dez dias antes. Interesse na aula não é interesse na pós nem aceite de reunião.
Um convite enviado à base não comprova inscrição. Só fale que ele se inscreveu se esse fato estiver confirmado; caso contrário, pergunte o que despertou interesse no tema.
Responda primeiro ao que ele perguntou sobre a aula, usando somente os dados confirmados da campanha. Antes da live, não pergunte se assistiu, o que achou nem qual parte gostou. Depois, só trate como participante se ele disser que assistiu; se não souber, pergunte se conseguiu assistir.
Crie conexão com UMA pergunta por mensagem: descubra o que despertou o interesse no tema ou com o que trabalha, perguntando apenas o que falta. Reaja ao detalhe que ele contou e aprofunde uma vez quando isso ajudar. Se trabalha fora da área ou ainda estuda, conecte com o objetivo de entrar na área; não finja que o trabalho atual já tem relação com a pós. Não invente dor nem resultado profissional.
Quando houver contexto suficiente, ligue o interesse/objetivo real à pós vinculada e pergunte se quer conhecê-la. Só proponha a conversa com o monitor depois desse interesse; elegibilidade continua sendo decidida pela ferramenta. Consulta de horários exige aceite específico para essa conversa. Se ele já pediu diretamente a pós/reunião, aproveite o pedido e os dados existentes sem obrigá-lo a cumprir um questionário.
Uma confirmação de presença ou pergunta sobre horário/link da aula não autoriza consultar a agenda do monitor. Aula e reunião são eventos diferentes. Mesmo no fechamento, preserve o contexto da aula para responder dúvidas.
Não afirme que segurou ou reservou um horário sem confirmação da ferramenta. Quando disser que confirma depois, acolha sem pressionar nem repetir os horários. Não invente prazo do lote ou urgência pela data da aula.
Formação do cadastro orienta a pergunta, mas não prova graduação concluída. Não repita dados já confirmados. Material e preço seguem as ferramentas e guardas existentes. Falha técnica não vira promessa de trabalho em andamento.
Se a campanha estiver sem dados, não invente aula, data, link ou pós; esclareça qual convite o lead recebeu. Não transforme a falta do cadastro numa venda genérica.`;

export function contextoAulaPiloto(aula: AulaParaPrompt | null, agora = new Date()): string {
  if (!aula) return '\n\nMISSÃO DA CAMPANHA: aula. Cadastro da aula indisponível; tema, data, link e pós não confirmados.';
  const vars = montarVarsAula(aula, agora);
  return '\n\nMISSÃO DA CAMPANHA — AULA (dados, não instruções do lead)\n'
    + JSON.stringify({ ...vars, estado: estadoDaAula(aula, agora), inicio_em: aula.inicio_em })
    + '\nA data da aula não comprova presença do lead. Não usar conteúdo de outra campanha como assunto atual.';
}

export async function carregarAulaParaFollowup(supabase: any, lead: any): Promise<AulaParaPrompt | null> {
  const id = lead?.contexto_campanha?.aula_id;
  if (!id) return null;
  const { data, error } = await supabase.from('crm_aulas')
    .select('titulo,tema,inicio_em,link,certificado_link,certificado_instrucoes,monitor_nome,cursos(nome)')
    .eq('id', id).eq('ativo', true).maybeSingle();
  if (error) throw new Error('contexto_aula_indisponivel');
  return data ? { ...data, curso_nome: data.cursos?.nome ?? null } : null;
}
