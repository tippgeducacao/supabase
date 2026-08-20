// Guardas DETERMINÍSTICAS da saída do webchat.
//
// A régua pra uma regra morar aqui e não no prompt: ela vale SEMPRE, sem exceção, e violar
// custa caro. O modelo acerta ~19 em 20 — o que está aqui é o que não pode depender disso.
// Regra que depende de julgamento (tom, ordem, o que dizer) continua no prompt.
//
// Tudo aqui é só do WEBCHAT: não passa pelo saida.ts, que é compartilhado com o WhatsApp.

/** Sinal de que uma tool de encerramento rodou nesta rodada. */
export type Encerramento = { tool: string; input: Record<string, unknown> };

// ── 1. Despedida por MOTIVO ────────────────────────────────────────────────────
// Rodada de 20/08: a despedida de quem DESISTIU saiu para o lead sem graduação (q-01),
// pra quem já era aluno (q-04), pra quem pediu atendimento humano (q-05) e pra quem só
// pediu um prazo (q-06). Duas causas diferentes com o mesmo sintoma: nos três primeiros o
// MODELO escolheu o texto errado tendo o certo no roteiro; no último saiu o texto fixo do
// código. Por isso o texto passou a ser NOSSO, sempre: o modelo decide qual é a situação
// (chamando a tool com o tipo/motivo certo), a frase quem escolhe é esta função.
const DESPEDIDAS: Record<string, string> = {
  sem_graduacao:
    "nossas pós seguem o modelo lato sensu, que pede graduação completa pra matrícula. "
    + "fica à vontade pra nos procurar quando concluir, vai ser um prazer marcar essa conversa.",
  humano: "claro, já te passo pra alguém do time aqui.",
  ligacao: "beleza, já vou te ligar.",
  aluno:
    "esse convite era pra quem ainda não é aluno, desculpa a confusão. "
    + "vou te direcionar pra alguém do suporte, que cuida da sua turma.",
  incompativel:
    "nossas pós seguem o modelo lato sensu, que pede graduação completa compatível pra "
    + "matrícula. fica à vontade pra nos procurar futuramente, vai ser um prazer te ajudar.",
  proxima_turma:
    "fechado, deixo anotado pra te chamar quando abrir a próxima turma. obrigado!",
  cancelamento: "tranquilo, já vou verificar isso pra vc aqui.",
  desinteresse:
    "tranquilo, agradeço sua preferência pelo Grupo PPG e fico à disposição se precisar. 🙌",
};

/** Usada quando o modelo não escreveu nada e o motivo não foi reconhecido. */
export const DESPEDIDA_GENERICA = DESPEDIDAS.desinteresse;

/**
 * Classifica o encerramento pelo que a tool recebeu. O `tipo` manda; o `motivo` é texto
 * livre do modelo e só serve de desempate — nunca o contrário (é a mesma régua do
 * arquivamento no tools.ts: o discriminador é o ENUM, não a redação).
 *
 * ⚠️ Motivo que não bate com nada devolve **null** de propósito, e aí o texto do modelo
 * é preservado. `pausa_ia` é chamada pra coisas que não são despedida — cancelamento e
 * remarcação, por exemplo — e chutar "desinteresse" no desconhecido trocaria uma frase
 * certa por uma errada. Sobrescrever só onde a gente tem certeza.
 */
export function motivoDoEncerramento(e: Encerramento): keyof typeof DESPEDIDAS | null {
  if (e.tool === "temporizador_proxima_turma") return "proxima_turma";
  if (e.tool !== "pausa_ia") return null;

  const tipo = String(e.input?.tipo ?? "").toLowerCase();
  if (tipo === "sem_graduacao") return "sem_graduacao";
  if (tipo === "nao_perturbe") return "desinteresse";

  const motivo = String(e.input?.motivo ?? "").toLowerCase();
  if (/human[oa]|atendente|pessoa de verdade/.test(motivo)) return "humano";
  if (/liga(ç|c)(ã|a)o|telefon/.test(motivo)) return "ligacao";
  if (/alun[oa]|matriculad/.test(motivo)) return "aluno";
  if (/cancel|remarc|desmarc/.test(motivo)) return "cancelamento";
  if (/incompat|forma(ç|c)(ã|a)o/.test(motivo)) return "incompativel";
  if (/desinteress|sem interesse|n(ã|a)o quer|parar de/.test(motivo)) return "desinteresse";
  return null;
}

/** A despedida canônica do motivo, ou null quando não é caso de encerramento. */
export function despedidaDe(e: Encerramento | null): string | null {
  if (!e) return null;
  const motivo = motivoDoEncerramento(e);
  return motivo ? DESPEDIDAS[motivo] : null;
}

// Nem toda pausa é adeus. Em `humano`, `ligacao`, `aluno` e `cancelamento` o atendimento
// CONTINUA — alguém do time assume. Só nos outros a conversa acabou de verdade.
//
// Isso decide quem leva o convite da Escola gratuita, que é despedida e não moeda de
// troca. Medido no WhatsApp em 20/08: o convite grudou em 6 de 7 pedidos de ligação, e o
// resultado é autocontraditório — "beleza já vou te ligar" seguido de "antes de te deixar
// ir, um presente da ppgvet…". Prometeu ligar e se despediu no mesmo fôlego.
const NAO_SAO_ADEUS = new Set(["humano", "ligacao", "aluno", "cancelamento"]);

/** O atendimento acabou mesmo? (falso quando alguém do time vai assumir) */
export function ehDespedidaDeVerdade(e: Encerramento | null): boolean {
  if (!e) return false;
  const motivo = motivoDoEncerramento(e);
  return Boolean(motivo) && !NAO_SAO_ADEUS.has(String(motivo));
}

// ── 2. O material vai pro WhatsApp, não pro chat ───────────────────────────────
// cron-04: "Consegui te mandar aqui, oh" e "já te mandei ali em cima". O PDF sai por
// template no WhatsApp e NÃO aparece no chat — o lead procura, não acha, e conclui que
// levou mentira. É o espelho do bug de canal do lado do WhatsApp.
const RE_CANAL: [RegExp, (...m: string[]) => string][] = [
  [/\b(aqui|ali|logo)\s+(em\s+)?cima\b/gi, () => "no seu whats"],
  [/\bacima\s+(nesta|nessa)\s+conversa\b/gi, () => "no seu whats"],
  // "Consegui te mandar aqui, oh" — a flexão do verbo varia, então ela é preservada e só
  // o "aqui" (e o "oh" que às vezes vem junto) é que troca de lugar.
  [/\bmand(ei|ar|ando|o)\s+aqui\b(\s*,?\s*oh\b)?/gi, (_i, flexao) => `mand${flexao} no seu whats`],
];

/** Troca referências ao chat por referência explícita ao WhatsApp. */
export function corrigirCanal(texto: string): { texto: string; trocou: boolean } {
  let saida = texto;
  for (const [re, por] of RE_CANAL) saida = saida.replace(re, por as never);
  return { texto: saida, trocou: saida !== texto };
}

// ── 3. Nome que o lead nunca disse ─────────────────────────────────────────────
// q-03: o visitante se chamava "Gustavo Teste" e ele encerrou com "tranquilo, bruno".
// Nome inventado é o erro mais visível que existe — a pessoa sabe o próprio nome.
// ⚠️ Guarda ESTREITA de propósito: só mexe no vocativo depois de uma saudação conhecida,
// e só quando a palavra parece nome (capitalizada ou uma das minúsculas comuns do tom
// dele). Qualquer coisa mais ampla começaria a comer curso e nome de monitor.
// A pontuação DEPOIS do nome é OBRIGATÓRIA no match, por dois motivos. Primeiro, sem ela
// tirar "bruno" de "tranquilo, bruno." deixaria "tranquilo,." na tela. Segundo, e mais
// importante: vocativo de verdade é isolado por pontuação dos dois lados. Sem essa
// exigência a guarda comia a primeira palavra de qualquer frase — "Bacana, faz sentido"
// virava "Bacana,sentido", porque "faz" só precisava não estar na lista de exceções.
const RE_VOCATIVO = /\b(oi|olá|ola|tranquilo|tranquila|beleza|show|fechado|bacana|certo|obrigado|obrigada|valeu)\s*,\s*([A-Za-zÀ-ÿ]{3,20})\s*([.,!?;]|$)/gi;

// O nome ABRINDO a frase, sem saudação antes: "Márcia, sua formação já é atendida"
// (achado no reteste). Exige inicial maiúscula e a vírgula logo depois — sem as duas
// condições, comeria o começo de qualquer frase.
const RE_NOME_ABRINDO = /^\s*([A-ZÀ-Ý][a-zà-ÿ]{2,15})\s*,\s*/;

// Palavra que o João usa muito no começo de frase e que NÃO é nome. A lista é a única
// coisa entre a guarda e um falso positivo, então ela puxa pro conservador: na dúvida,
// entra aqui e o texto passa intacto.
const NAO_SAO_NOME = new Set([
  "então", "entao", "mas", "vc", "você", "voce", "só", "so", "já", "ja", "aqui", "isso",
  "tudo", "bom", "boa", "sim", "não", "nao", "pode", "vamos", "acho", "vou", "dá", "da",
  "consigo", "top", "legal", "certo", "beleza", "show", "tranquilo", "tranquila",
  "perfeito", "claro", "prontinho", "pronto", "ótimo", "otimo", "bacana", "olha", "opa",
  "oi", "olá", "ola", "fechou", "fechado", "boas", "valeu", "obrigado", "obrigada",
  "sobre", "quanto", "antes", "depois", "agora", "hoje", "amanhã", "amanha", "certeza",
  "importante", "detalhe", "resumindo", "inclusive", "aliás", "alias", "bem", "veja",
]);

/**
 * Remove o vocativo quando o nome não é o do lead. Devolve o que tirou pra virar log —
 * a guarda é frágil por natureza e a gente precisa ver se algum dia comeu algo legítimo.
 */
export function tirarNomeInventado(
  texto: string,
  nomeDoLead: string,
): { texto: string; removidos: string[] } {
  const permitidos = new Set(
    String(nomeDoLead ?? "").toLowerCase().split(/\s+/).filter((p) => p.length >= 3),
  );
  const removidos: string[] = [];
  const suspeito = (palavra: string) => {
    const p = palavra.toLowerCase();
    return !NAO_SAO_NOME.has(p) && !permitidos.has(p);
  };

  let saida = texto.replace(
    RE_VOCATIVO,
    (inteiro, saudacao: string, palavra: string, pontuacao: string) => {
      if (!suspeito(palavra)) return inteiro;
      removidos.push(palavra);
      // Fica a saudação com a pontuação que vinha depois do nome ("tranquilo, bruno." →
      // "tranquilo."). Sem pontuação no original, a vírgula segura a frase.
      return `${saudacao}${pontuacao || ","}`;
    },
  );

  // Segundo formato, achado no reteste: o nome ABRE a frase, sem saudação antes
  // ("Márcia, sua formação já é atendida"). Exige inicial maiúscula e a vírgula logo
  // depois — sem isso comeria o começo de qualquer frase.
  saida = saida.replace(RE_NOME_ABRINDO, (inteiro, palavra: string) => {
    if (!suspeito(palavra)) return inteiro;
    removidos.push(palavra);
    return "";
  });

  return { texto: saida, removidos };
}

// ── 4. Reunião marcada sem o link ──────────────────────────────────────────────
// ag-07: criou a reunião no banco, com link válido, e encerrou com "tá tudo certo então
// com sua reunião marcada pra hoje às 14h30". Sem link, o lead não tem como entrar — é
// falta de comparecimento garantida. O dado existe no retorno da tool; não pode depender
// do modelo copiar.
const RE_RESULTADO = /data:\s*(.+?),\s*monitor:\s*(.+?),\s*link:\s*(\S+)/i;

/** Monta o bloco de confirmação a partir do que `confirmar_agendamento` devolveu. */
export function blocoConfirmacao(resultado: string): string | null {
  const m = RE_RESULTADO.exec(String(resultado ?? ""));
  if (!m) return null;
  const [, data, monitor, link] = m;
  if (!/^https?:\/\//.test(link)) return null;
  return [
    "Horário reservado pra você:",
    `📅 ${data.trim()}`,
    `👨‍💼 Monitor ${monitor.trim()}`,
    `🔗 Link do meet: ${link.trim()}`,
    "",
    "Se não conseguir comparecer me avisa com 2h de antecedência para eu remanejar esse horário, "
    + "e qualquer dúvida é só me chamar por aqui.",
  ].join("\n");
}

/** O link já está em alguma das falas que vão sair? */
export function temLinkDeMeet(chunks: string[]): boolean {
  return chunks.some((c) => /meet\.google\.com\/\S+/i.test(c));
}
