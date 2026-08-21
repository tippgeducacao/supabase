// Guardas DETERMINÍSTICAS da saída do webchat.
//
// A régua pra uma regra morar aqui e não no prompt: ela vale SEMPRE, sem exceção, e violar
// custa caro. O modelo acerta ~19 em 20 — o que está aqui é o que não pode depender disso.
// Regra que depende de julgamento (tom, ordem, o que dizer) continua no prompt.
//
// Tudo aqui é só do WEBCHAT: não passa pelo saida.ts, que é compartilhado com o WhatsApp.

// Encerramento e nome são COMPARTILHADOS com o agente de WhatsApp — moram em
// ../crm-agente-sdr/ (mesmo padrão do escolaGratuita.ts, que este agente já importa de lá).
// Reexportados aqui pra que o resto do webchat continue enxergando um lugar só.
export type { Encerramento } from '../crm-agente-sdr/encerramento.ts';
export { ehDespedidaDeVerdade, motivoDoEncerramento } from '../crm-agente-sdr/encerramento.ts';
export { notaDoNome } from '../crm-agente-sdr/nomeDoLead.ts';
import type { Encerramento, MotivoEncerramento } from '../crm-agente-sdr/encerramento.ts';
import { motivoDoEncerramento } from '../crm-agente-sdr/encerramento.ts';

// ── 1. Despedida por MOTIVO ────────────────────────────────────────────────────
// Rodada de 20/08: a despedida de quem DESISTIU saiu para o lead sem graduação (q-01),
// pra quem já era aluno (q-04), pra quem pediu atendimento humano (q-05) e pra quem só
// pediu um prazo (q-06). Duas causas diferentes com o mesmo sintoma: nos três primeiros o
// MODELO escolheu o texto errado tendo o certo no roteiro; no último saiu o texto fixo do
// código. Por isso o texto passou a ser NOSSO, sempre: o modelo decide qual é a situação
// (chamando a tool com o tipo/motivo certo), a frase quem escolhe é esta função.
const DESPEDIDAS: Record<MotivoEncerramento, string> = {
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

/** A despedida canônica do motivo, ou null quando não é caso de encerramento. */
export function despedidaDe(e: Encerramento | null): string | null {
  if (!e) return null;
  const motivo = motivoDoEncerramento(e);
  return motivo ? DESPEDIDAS[motivo] : null;
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

// O nome ABRINDO a frase, sem saudação antes: "Márcia, sua formação já é atendida".
//
// ⚠️ Aceita MINÚSCULA também (21/08/2026). A versão anterior exigia inicial maiúscula e
// deixou passar "vitória, então segue assim:" numa conversa real — a lead respondeu "e não
// me chamo vitória". O João escreve tudo em caixa baixa por regra de persona, então exigir
// maiúscula era pedir justamente o que ele nunca produz.
//
// O que segura o falso positivo não é a caixa, é a vírgula colada + a lista de exceções:
// "beleza,", "então,", "certo," e companhia estão todas em NAO_SAO_NOME.
const RE_NOME_ABRINDO = /^\s*([a-zà-ÿA-ZÀ-Ý][a-zà-ÿ]{2,15})\s*,\s*/;

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
