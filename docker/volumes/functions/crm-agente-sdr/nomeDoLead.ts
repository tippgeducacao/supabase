// FONTE ÚNICA do lembrete de nome — usado pelo agente de WhatsApp e pelo webchat.
//
// Caso Flávia (21/08/2026): o João a chamou de "vitória" e ela respondeu "e não me chamo
// vitória". Varrendo profiles, leads, sac_contatos, cliente_ppg_leads_sdr, os retornos das
// tools e as 28 mensagens, "Vitória" não existe em lugar nenhum — não foi dado trocado,
// foi preenchimento de lacuna. Nas 14 mensagens anteriores ele NUNCA usara o nome dela: o
// nome vivia só no topo do prompt, renderizado uma vez, e na hora de escrever
// "saudação, NOME," estava a dezenas de turnos de distância. O modelo completou pelo
// FORMATO, não pela memória.
//
// Por isso o lembrete volta A CADA RODADA, junto do contexto temporal, que entra DEPOIS do
// breakpoint de cache — no fim, onde a recência ajuda.

/** Lembrete do nome, apensado ao contexto temporal (reinjetado toda rodada). */
export function notaDoNome(nome: string | null | undefined): string {
  const limpo = String(nome ?? '').trim();
  if (!limpo) {
    return '\n\n**⛔ VOCÊ NÃO SABE O NOME DESTA PESSOA.**\n'
      + 'Não escreva nome nenhum — nem chute, nem "amigo", nem "colega". Fale sem vocativo.';
  }
  const primeiro = limpo.split(/\s+/)[0];
  return `\n\n**A PESSOA COM QUEM VOCÊ ESTÁ FALANDO SE CHAMA: ${primeiro}**\n`
    + `É o ÚNICO nome que existe nesta conversa. Se for usar nome, use "${primeiro}" — mais nenhum.\n`
    + '⛔ Na dúvida, NÃO use nome: falar sem nome é neutro, falar o nome errado é o erro mais '
    + 'visível que existe. A pessoa sabe o próprio nome e percebe na hora.';
}
