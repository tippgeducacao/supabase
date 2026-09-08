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
    return '\n\n**NOME DO LEAD AINDA NÃO INFORMADO NO CADASTRO.**\n'
      + 'Isso não apaga uma resposta no histórico: use apenas o primeiro nome da autoidentificação '
      + 'explícita mais recente do próprio lead, se houver. Nome do vendedor, de terceiro ou citado '
      + 'só pelo atendente não identifica o lead. Sem essa autoidentificação, fale sem vocativo: '
      + 'não invente nome — nem chute, nem "amigo", nem "colega".';
  }
  const primeiro = limpo.split(/\s+/)[0];
  return `\n\n**NOME DO LEAD NO CADASTRO: ${primeiro}**\n`
    + `Se for usar nome, use "${primeiro}", salvo autoidentificação ou correção explícita mais recente `
    + 'do próprio lead no histórico; nesse caso, use o primeiro nome que ele informou. '
    + 'Não substitua pelo nome do vendedor ou de terceiros.\n'
    + '⛔ Na dúvida, NÃO use nome: falar sem nome é neutro, falar o nome errado é o erro mais '
    + 'visível que existe. A pessoa sabe o próprio nome e percebe na hora.';
}
