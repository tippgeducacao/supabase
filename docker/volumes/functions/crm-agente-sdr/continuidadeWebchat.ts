// Bloco apensado ao prompt quando ESTA conversa começou no CHAT DO SITE e migrou pro
// WhatsApp (continuidade semeada por crm-webchat).
//
// Por que existe: no primeiro caso real (2026-08-20) o João disse "mas já te adiantei o
// cronograma e o valor integral pelo whats" — conversando NO WhatsApp, com o PDF logo acima
// na tela. Ele havia herdado a linguagem do site, onde "te mandei no seu whats" era verdade.
// É o espelho do bug do "aqui em cima": a mesma frase é verdadeira num canal e falsa no
// outro, e sem contexto ele não tem como saber onde a conversa virou.
//
// Fica no PROMPT, não só no histórico: uma nota entre mensagens é uma linha perdida no meio
// de dezenas, enquanto o prompt é relido a cada turno. A nota no histórico continua lá como
// reforço, mas quem sustenta a regra é este bloco.
//
// Mesmo padrão de escolaGratuita.ts: apensado DEPOIS do render, no ponto único das personas.

/** Depois disso, a conversa do site é história velha e o bloco só polui o contexto. */
const JANELA_DIAS = 7;

const BLOCO = [
  "",
  "---",
  "",
  "## 🔀 ESTA CONVERSA COMEÇOU NO CHAT DO SITE",
  "",
  "O trecho inicial do histórico aconteceu no **chat do site da PPG**, não aqui. A pessoa escolheu a pós por botão, falou com você por lá, e a conversa MIGROU para o WhatsApp. Para ela é a MESMA conversa, só mudou de tela.",
  "",
  "O que isso muda na sua fala:",
  "",
  "- A mudança para o WhatsApp **não comprova envio de cronograma ou valor**. Só afirme envio do que estiver confirmado no histórico; uma mensagem de continuidade pode ter sido o único envio.",
  "- Se o histórico confirmar material enviado no WhatsApp, trate-o como enviado **nesta conversa**. Não afirme que está 'logo acima' sem evidência da posição atual.",
  "- ⛔ É PROIBIDO dizer que mandou \"pelo whats\", \"no seu whatsapp\" ou \"no seu número\": é exatamente onde vocês estão, e ela vai achar que você se perdeu.",
  "- ⛔ Também não mande ela \"voltar ao site\" nem trate o chat como um lugar separado onde algo ficou. O que foi combinado lá vale aqui.",
  "- ⛔ NÃO se reapresente nem repita perguntas já respondidas no site. Continue do estágio real: valide os dados ainda ausentes, sem presumir graduação concluída ou qualificação por causa da mudança de canal.",
].join("\n");

/**
 * Apensa o bloco quando a conversa veio do webchat há pouco tempo.
 * `veioEm` é `cliente_ppg_leads_sdr.veio_do_webchat_em`; nulo = conversa nasceu no WhatsApp.
 */
export function comContinuidadeWebchat(prompt: string, veioEm: string | null | undefined): string {
  if (!veioEm) return prompt;
  const quando = Date.parse(String(veioEm));
  if (!Number.isFinite(quando)) return prompt;
  const dias = (Date.now() - quando) / 86_400_000;
  // Data futura (relógio torto) também não deve ligar o bloco.
  if (dias < 0 || dias > JANELA_DIAS) return prompt;
  return prompt + BLOCO;
}
