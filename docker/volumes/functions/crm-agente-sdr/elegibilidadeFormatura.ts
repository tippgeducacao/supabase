// FONTE ÚNICA da janela de elegibilidade do ESTUDANTE que ainda cursa a graduação.
//
// Régua (decisão do usuário 2026-08-06): elegível quem conclui a graduação
//   • nos próximos 3 meses, **OU**
//   • até 31/12 do ano corrente
// — o que for MAIOR. Ou seja, "quem se forma em dezembro já pode conhecer a pós".
//
// Antes era um teto fixo de 90 dias, e ele recusava justamente quem se forma no fim do
// ano: em 21 dias o agente reprovou 434 pessoas por prazo (contra 604 aprovadas no fluxo
// normal), e a faixa "conclui em 4-6 meses" — dezembro/janeiro — era a mais populosa entre
// as que informaram a data.
//
// ⚠️ O PISO DE 3 MESES NÃO É DETALHE: sem ele, a régua "até dezembro" ficaria mais
// RESTRITIVA que a antiga no fim do ano (em 20/12 sobrariam 10 dias, e quem se forma em
// fevereiro passaria a ser recusado — uma regressão silenciosa a cada novembro). Com o
// piso, a janela nunca encolhe abaixo do que já valia.
//
// ⚠️ A DATA É CALCULADA EM CÓDIGO e entregue pronta ao modelo dentro do contexto temporal
// (contexto.ts → montarContextoTemporal). O LLM erra conta de calendário — foi o caso de
// 2026-07-04, em que ele achou que 07/07 era segunda. Ele só compara a data que o lead
// disse com a data-limite que já recebeu mastigada.
//
// ⚠️ Espelhos: a régua aparece nos prompts das 4 personas, na tool-description do parâmetro
// `contexto_qualificacao` (banco, `lista_tools_claude`) e na rubrica de teste. Mudou aqui →
// reflita lá. Quem REPROVA continua sendo o código (tools.ts, ramo REPROVADO_PRAZO); esta
// função só diz até quando o lead é considerado apto.

const MESES_MINIMOS = 3;

/** Data-limite de conclusão da graduação para o lead ser elegível AGORA. */
export function limiteFormatura(agora: Date = new Date()): Date {
  // Brasília = UTC-3 fixo (mesma convenção de agoraBrasilia em contexto.ts).
  const br = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const ano = br.getUTCFullYear();

  // Fim do ano corrente (31/12, último instante).
  const fimDoAno = new Date(Date.UTC(ano, 11, 31, 23, 59, 59));

  // Piso: hoje + 3 meses. setUTCMonth normaliza a virada de ano sozinho (out+3 = jan).
  const piso = new Date(br.getTime());
  piso.setUTCMonth(piso.getUTCMonth() + MESES_MINIMOS);

  return piso > fimDoAno ? piso : fimDoAno;
}

/** "31/12/2026" — formato que o lead e o modelo leem. */
export function limiteFormaturaFormatado(agora: Date = new Date()): string {
  const d = limiteFormatura(agora);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Bloco injetado no contexto temporal das 4 personas (e do webchat). */
export function blocoElegibilidadeFormatura(agora: Date = new Date()): string {
  return `**ELEGIBILIDADE DE QUEM AINDA CURSA A GRADUAÇÃO (régua interna, NUNCA cite ao lead):**
Estudante que conclui a graduação **até ${limiteFormaturaFormatado(agora)}** (incluindo TCC) é ELEGÍVEL:
trate como apto (\`contexto_qualificacao\` = "estudante_apto"), siga o fluxo normal e pode agendar.
Quem conclui DEPOIS dessa data ainda não pode — encerre pelo caminho do retorno na formatura.
Use ESTA data, não calcule prazo de cabeça.

⛔ APROVOU? NÃO COMENTE. A checagem roda em segundo plano: é PROIBIDO dizer ao lead que a
formação dele "atende", que ele "pode fazer", que "dezembro está dentro do prazo" ou qualquer
variação — inclusive quando ele mesmo puxa o assunto ("posso mesmo ainda cursando?"). Responda
o que ele perguntou em meia frase, sem laudo ("tranquilo, dá pra seguir"), e emende no próximo
passo (a condição especial e a conversa no meet).
> ERRADO: "show, sua formação atende sim, dezembro tá dentro do prazo certinho."
> Certo: "tranquilo, dá pra seguir normal. a secretaria liberou uma condição especial…"`;
}
