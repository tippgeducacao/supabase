// 23/09/2026: as perguntas por pós entram na esteira existente junto de agenda e
// abordagens gerais. IDs estáveis permitem registrar só o que teve envio aceito.
export const PERGUNTAS_RETOMADA = [
  { id: 'retomada:agenda_interesse', tipo: 'agenda',
    exemplo: 'faz sentido procurar um horário para sua conversa com o monitor?',
    quando: 'Já houve convite contextualizado, sem recusa. Não presumir aceite nem oferecer reunião a quem só quer a aula gratuita.' },
  { id: 'retomada:agenda_periodo', tipo: 'agenda',
    exemplo: 'qual período costuma funcionar melhor para conversar com o monitor?',
    quando: 'Há interesse na reunião e a preferência de período ainda não foi respondida.' },
  { id: 'retomada:agenda_reconsultar', tipo: 'agenda',
    exemplo: 'quer que eu confira novos horários para aquela conversa com o monitor?',
    quando: 'Retomar convite anterior; só o principal consulta e oferece disponibilidade atual.' },
  { id: 'retomada:geral_duvida', tipo: 'geral',
    exemplo: 'ficou alguma dúvida sobre o que conversamos?',
    quando: 'Não há dúvida já formulada aguardando resposta nossa; não pedir para repetir a dúvida.' },
  { id: 'retomada:geral_prioridade', tipo: 'geral',
    exemplo: 'o que mais pesa para você decidir seu próximo passo nessa área?',
    quando: 'A pessoa ainda não explicou o que pesa na decisão; não insistir em uma recusa.' },
  { id: 'retomada:geral_experiencia', tipo: 'geral',
    exemplo: 'você já fez alguma pós ou está pensando na primeira?',
    quando: 'A informação não está na coleta nem foi respondida na conversa; não transformar em entrevista.' },
  { id: 'retomada:geral_material', tipo: 'geral',
    exemplo: 'conseguiu abrir o cronograma que recebeu?',
    quando: 'O envio do cronograma está registrado e o lead ainda não confirmou acesso; não inventar envio nem ignorar falha pendente.' },
] as const;

// Tentativas realmente feitas, não o stage do cron: recuperar uma janela atrasada
// não obriga sete abordagens nem transforma a primeira mensagem na sétima.
export function preferenciaFollowup(tentativa: number): 'retomada' | 'carreira' | 'geral' | 'agenda' {
  const tipos = ['retomada', 'carreira', 'geral', 'retomada', 'carreira', 'geral', 'agenda'] as const;
  const indice = Number.isFinite(tentativa) ? Math.max(0, Math.min(6, Math.floor(tentativa) - 1)) : 0;
  return tipos[indice];
}
