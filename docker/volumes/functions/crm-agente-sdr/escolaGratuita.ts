// FONTE ÚNICA do "presente da Escola" — o convite para a biblioteca gratuita da PPGVET
// que o João manda ANTES de encerrar um atendimento que terminou SEM reunião marcada
// (decisão do usuário 2026-08-05: "antes de decidir se vai temporizar, pausar ou arquivar,
// envie o link e a informação do curso gratuito").
//
// Por que aqui e não dentro de cada prompt: são QUATRO personas
// (validacao/qualificador/recontato/campanha_direta) + o webchat, e o prompts.ts é um
// arquivo GERADO pela extração do n8n (edição manual lá é apagada numa reextração). O bloco
// é apensado ao system prompt no ponto único onde ele é montado (index.ts), então a régua e
// o LINK vivem em UM lugar só e nenhuma persona pode divergir.
//
// ⚠️ ESPELHO: a mesma régua está nas tool-descriptions de `pausa_ia`,
// `temporizador_proxima_turma` e `agendar_retorno` (banco, `lista_tools_claude`, migration
// agente_presente_escola_gratuita_antes_de_encerrar) — a description pesa MAIS que o prompt
// na decisão do modelo. Mudou o texto/link aqui → reflita lá (e na rubrica de teste).

export const LINK_ESCOLA_GRATUITA = 'https://escoladeespecializacao.ppgvet.com.br';

/** Bloco apensado ao system prompt de TODAS as personas do agente (e do webchat). */
export const BLOCO_ESCOLA_GRATUITA = [
  '',
  '---',
  '',
  '## 🎁 ANTES DE ENCERRAR: o presente da Escola (regra dura, vale sobre tudo que veio acima)',
  '',
  'Toda conversa que termina SEM reunião marcada leva um presente de despedida: a biblioteca'
    + ' gratuita da PPGVET. Mande o convite **na MESMA resposta** em que você se despede e chama'
    + ' `pausa_ia`, `temporizador_proxima_turma` ou `agendar_retorno` — nunca depois, nunca'
    + ' "te mando em seguida".',
  '',
  '**Vale em TODO encerramento sem agendamento**, seja ele qual for: desinteresse confirmado'
    + ' depois da retenção, pedido pra parar de receber mensagem, formação incompatível, lead'
    + ' sem graduação nenhuma (o que arquiva o contato), estudante que conclui fora do prazo,'
    + ' "me chama quando abrir a próxima turma", "vou pensar/analisar", pedido de ligação ou de'
    + ' atendimento humano.',
  '',
  '**NÃO mande** quando: a reunião foi marcada (aí a conversa não acabou), o lead já é aluno'
    + ' nosso, ele informou que pagou a matrícula, ou você já mandou esse convite nesta conversa'
    + ' — é UMA vez só.',
  '',
  'Modelo (adapte ao seu tom de sempre; o LINK é literal e não muda):',
  '',
  '> "antes de te deixar ir: a ppgvet tem uma biblioteca de conteúdo aberta e'
    + ' totalmente gratuita, que fica à sua disposição de qualquer jeito.',
  '> são mais de 30 cursos gratuitos, além de artigos científicos, resumos, e-books, materiais'
    + ' didáticos, aulas abertas de pós-graduação e certificados, tudo num lugar só.',
  `> ${LINK_ESCOLA_GRATUITA}`,
  '> é um presente da ppgvet educação pra vc, aproveita."',
  '',
  `⛔ O endereço é EXATAMENTE ${LINK_ESCOLA_GRATUITA}. Nunca invente outro, nunca encurte,`
    + ' nunca troque por "link na bio" ou por uma promessa de mandar depois.',
  '',
  '⛔ Isso é DESPEDIDA, não é moeda de troca. É PROIBIDO oferecer a biblioteca no meio da'
    + ' conversa pra contornar objeção, e PROIBIDO apresentá-la como alternativa à reunião'
    + ' ("em vez da call, te mando um curso grátis" é proibido). Enquanto existir chance de'
    + ' marcar a reunião, sua missão continua sendo a reunião — o presente só entra quando a'
    + ' conversa já acabou.',
].join('\n');

/**
 * Anexa o presente ao prompt JÁ RENDERIZADO da persona.
 * ⚠️ Por isso o bloco NÃO usa placeholders `{{ $json.* }}`: ele entra depois do
 * `renderPrompt`, então um placeholder aqui chegaria cru ao modelo (e ao lead).
 */
export function comPresenteEscola(promptRenderizado: string): string {
  return `${promptRenderizado}\n${BLOCO_ESCOLA_GRATUITA}`;
}
