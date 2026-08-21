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

import { alguemDoTimeAssume, type Encerramento } from './encerramento.ts';

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

// ── O presente sai em CÓDIGO, não por instrução ────────────────────────────────
// Medido em 30 dias (21/08/2026), sobre 4.732 chamadas de `pausa_ia`: das despedidas que
// DEVIAM levar o convite, só 25%–35% levaram. Em número absoluto são ~3.260 encerramentos
// legítimos que saíram sem a biblioteca. Dois casos chamam atenção porque a régua acima os
// cita nominalmente e mesmo assim deu ZERO: "conclui a graduação fora do prazo de 90 dias"
// (162 pausas, 0%) e "não possui graduação completa" (54 pausas, 0%).
//
// O bloco de prompt continua — ele ensina o tom e o contexto. Mas quem GARANTE o envio é
// esta função, pelo mesmo princípio do bloco de confirmação de reunião: o que vale sempre
// e não pode depender do modelo lembrar sai em código.

/** O convite, palavra por palavra igual ao modelo do prompt (nenhuma voz nova). */
export const CONVITE_ESCOLA = [
  'antes de te deixar ir: a ppgvet tem uma biblioteca de conteúdo aberta e totalmente'
    + ' gratuita, que fica à sua disposição de qualquer jeito.',
  'são mais de 30 cursos gratuitos, além de artigos científicos, resumos, e-books,'
    + ' materiais didáticos, aulas abertas de pós-graduação e certificados, tudo num lugar só.',
  LINK_ESCOLA_GRATUITA,
  'é um presente da ppgvet educação pra vc, aproveita.',
].join('\n');

/** Já foi mandado? Basta o link aparecer — é o que a régua chama de "UMA vez só". */
export function jaTemOPresente(texto: string | null | undefined): boolean {
  return String(texto ?? '').includes(LINK_ESCOLA_GRATUITA);
}

/**
 * Este encerramento leva o presente?
 *
 * ⚠️ **Default-SIM**, ao contrário de `ehDespedidaDeVerdade`. A assimetria é deliberada e
 * vem do custo de cada erro:
 *   • errar pra MENOS (não mandar numa despedida real) custa um lead que ia embora sem
 *     nada — e é o erro que está acontecendo ~3.260 vezes por mês;
 *   • errar pra MAIS (mandar quando alguém do time vai assumir) custa uma mensagem
 *     autocontraditória — "beleza, já vou te ligar" seguido de "antes de te deixar ir".
 *     Medido: 46 casos em 30 dias.
 * Um é 70× o outro. Então só os quatro casos RECONHECIDOS de continuação ficam de fora;
 * motivo que ninguém classificou leva o presente.
 */
export function mereceOPresente(e: Encerramento | null, jaEstaNaEscola = false): boolean {
  // Quem já tem o acesso não é convidado de novo (decisão do diretor, 21/08/2026): o
  // convite é captação, e mandá-lo pra quem já está dentro é o agente mostrando que não
  // sabe com quem fala. Medido no dia: 2.607 contatos com a tag da Escola, 2.351 deles
  // (92%) também leads do SDR — sem este gate, quase toda a base da Escola receberia.
  if (jaEstaNaEscola) return false;
  if (!e) return false;
  // `agendar_retorno` e o temporizador encerram a conversa sem reunião (o lead volta lá na
  // frente) — a régua os cita nominalmente: "me chama quando abrir a próxima turma" e o
  // estudante que conclui fora do prazo.
  if (e.tool === 'agendar_retorno' || e.tool === 'temporizador_proxima_turma') return true;
  if (e.tool !== 'pausa_ia') return false;
  return !alguemDoTimeAssume(e);
}

/** Anexa o presente ao que o modelo escreveu, se ainda não foi mandado nesta conversa. */
export function comPresenteNaDespedida(
  texto: string,
  encerramento: Encerramento | null,
  conversaAteAgora: string,
  jaEstaNaEscola = false,
): { texto: string; anexou: boolean } {
  if (!mereceOPresente(encerramento, jaEstaNaEscola)) return { texto, anexou: false };
  if (jaTemOPresente(texto) || jaTemOPresente(conversaAteAgora)) return { texto, anexou: false };
  return { texto: `${texto.trimEnd()}\n\n${CONVITE_ESCOLA}`, anexou: true };
}

/**
 * Substitui o bloco do presente quando a pessoa JÁ tem acesso à Escola.
 * Sem isto o modelo continuaria oferecendo por conta própria — a guarda de código só
 * impede o anexo automático, não o que ele escreve espontaneamente.
 */
export const NOTA_JA_ESTA_NA_ESCOLA = [
  '',
  '---',
  '',
  '## 🎁 O presente da Escola: ESTA PESSOA JÁ TEM ACESSO',
  '',
  'Ela já se cadastrou na Escola de Especialização e já recebeu o link de acesso.',
  '',
  '⛔ **NÃO ofereça a biblioteca gratuita, não mande o link e não a apresente como novidade** —'
    + ' nem na despedida, nem no meio da conversa. Oferecer acesso a quem já tem é o jeito mais'
    + ' rápido de mostrar que você não sabe com quem está falando.',
  '',
  'Se ELA puxar o assunto do conteúdo gratuito, fale com naturalidade de quem sabe que ela já'
    + ' está lá dentro ("aproveita que já tá tudo liberado aí"). A conversa segue sendo sobre a pós.',
].join('\n');

/** Apensa ao prompt o bloco certo: o convite, ou o aviso de que ela já está dentro. */
export function comBlocoDaEscola(promptRenderizado: string, jaEstaNaEscola: boolean): string {
  return jaEstaNaEscola
    ? `${promptRenderizado}\n${NOTA_JA_ESTA_NA_ESCOLA}`
    : comPresenteEscola(promptRenderizado);
}
