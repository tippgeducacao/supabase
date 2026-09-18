// ── Gancho do "primeiro lote promocional" no João de VENDAS (canário, 19/09/2026) ─────────
//
// Decisão do usuário (18/09/2026): trocar "a secretaria liberou hoje uma condição especial" por
// "estamos no fechamento do primeiro lote promocional", a mesma abordagem que a persona Aula já
// usa desde 17/09 (prompts-aula.ts). Lá a troca é feita na composição do prompt; aqui ela é
// feita sobre o prompt JÁ RENDERIZADO (validação, qualificador ou campanha direta), só para o
// lead do canário. Produção (Claude) segue com o texto antigo até a promoção.
//
// O fecho do convite ("ainda hoje" × "amanhã cedo") NÃO é escrito pelo modelo: vem da frase
// CONVITE DE AGENDA do contexto temporal (contexto.ts → fraseConviteAgenda), relida a cada volta.

const TROCAS_DO_GANCHO: [RegExp, string][] = [
  [/a secretaria liberou hoje uma condição especial pra matrícula na pós/g, 'estamos no fechamento do primeiro lote promocional da pós'],
  [/a secretaria liberou hoje uma condição especial/g, 'estamos no fechamento do primeiro lote promocional'],
  [/a condição especial que a secretaria liberou hoje/g, 'a condição do primeiro lote promocional'],
  [/a condição especial liberada hoje/g, 'a condição do primeiro lote promocional'],
  [/condição especial liberada hoje/g, 'condição do primeiro lote promocional'],
  [/a condição especial/g, 'a condição do primeiro lote promocional'],
  [/condição especial/g, 'condição do primeiro lote promocional'],
];

// Passo 1 da validação ("Abra pela condição"), já com o curso renderizado no lugar do placeholder.
const RE_PASSO_ABERTURA = /diga primeiro o que ele tem em mãos: a secretaria liberou hoje uma condição especial pra matrícula na pós em \*\*([^*]+)\*\*\. Só então apresente o Meet como o caminho pra acessar isso: uma conversa rápida de poucos minutos com um monitor especialista, onde ele vê a condição, a metodologia, o cronograma das aulas, os professores e tira as dúvidas\. Feche puxando a confirmação \("me confirma que já procuro um encaixe pra hj\?"\)\./;
const PASSO_ABERTURA_NOVO = 'diga primeiro o que está acontecendo: estamos no fechamento do primeiro lote promocional da pós em **$1**, e você gostaria de apresentar a condição, a metodologia, o cronograma das aulas, os professores e tirar as dúvidas dele. Só então apresente o Meet como o caminho: pra passar isso direitinho, precisa marcar uma conversa rápida com um monitor especialista. Feche com a frase CONVITE DE AGENDA do contexto, copiada sem mudar uma palavra.';

// Exemplo "Abertura mais confirmação" da validação.
const RE_EXEMPLO_ABERTURA = /> a secretaria liberou hoje uma condição especial pra matrícula na pós em ([^\n]+?) e pra te passar isso direitinho preciso marcar uma conversa rápida no meet com um dos nossos monitores especialistas, onde vc vê a condição, a metodologia, o cronograma das aulas, os professores e tira todas as dúvidas\. me confirma seu interesse que já procuro um encaixe pra ainda hoje\?/;
const EXEMPLO_ABERTURA_NOVO = '> estamos no fechamento do primeiro lote promocional da pós em $1, e eu gostaria de te apresentar a condição, a metodologia, o cronograma das aulas, os professores e tirar suas dúvidas. pra te passar isso direitinho, preciso marcar uma conversa rápida no meet com um monitor especialista. + a frase CONVITE DE AGENDA';

// Campanha direta (passo 4) e qualquer outro "feche puxando a confirmação".
const RE_FECHO_ANTIGO = /Feche puxando a confirmação \("me confirma que já procuro um encaixe pra hj\?"\)\./g;
const FECHO_NOVO = 'Feche com a frase CONVITE DE AGENDA do contexto, copiada sem mudar uma palavra.';

export function secaoGanchoLote(vars: { nome: string; curso: string }): string {
  const nome = vars.nome.trim() || 'lead';
  const curso = vars.curso.trim() || 'pós de interesse';
  return [
    '## Gancho e convite (primeiro lote promocional)',
    '⛔ **O nome da oferta é "primeiro lote promocional".** Diga "estamos no fechamento do primeiro lote promocional" e "a condição do primeiro lote promocional". As expressões "condição especial", "condição da secretaria" e "a secretaria liberou" NÃO existem nesta conversa: não as use nem misturadas. Você diz que o lote está fechando; o que é a condição, só o monitor apresenta.',
    `- **1ª abordagem (uma mensagem só):** "estamos no fechamento do primeiro lote promocional da pós em ${curso}, e eu gostaria de te apresentar a condição, a metodologia, o cronograma das aulas, os professores e tirar suas dúvidas. pra te passar isso direitinho, preciso marcar uma conversa rápida no meet com um monitor especialista." + a frase CONVITE DE AGENDA.`,
    '- **Todo convite para a reunião termina com a frase CONVITE DE AGENDA** que vem no contexto do sistema: ela já diz "ainda hoje" ou "amanhã cedo" conforme o relógio. Copie a frase; nunca escreva "ainda hoje" por conta própria.',
    `- **2ª abordagem:** ele respondeu sem confirmar (tirou uma dúvida, comentou, você tratou uma objeção, o material já foi resolvido). Reconduza em uma frase: "${nome}, vamos marcar sua conversa pra garantir essa condição promocional?" + a frase CONVITE DE AGENDA. O nome dele no máximo duas vezes na conversa.`,
  ].join('\n');
}

export type ResultadoGancho = { prompt: string; trocas: { abertura: number; exemplo: number; fecho: number; gancho: number } };

/** Aplica o gancho ao prompt RENDERIZADO do João de vendas. Idempotente: rodar duas vezes não muda nada. */
export function comGanchoDoLote(prompt: string, vars: { nome: string; curso: string }): ResultadoGancho {
  const secao = secaoGanchoLote(vars);
  if (prompt.includes('## Gancho e convite (primeiro lote promocional)')) {
    return { prompt, trocas: { abertura: 0, exemplo: 0, fecho: 0, gancho: 0 } };
  }
  const contar = (re: RegExp, texto: string) => (texto.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;
  const abertura = contar(RE_PASSO_ABERTURA, prompt);
  const exemplo = contar(RE_EXEMPLO_ABERTURA, prompt);
  let texto = prompt.replace(RE_PASSO_ABERTURA, PASSO_ABERTURA_NOVO).replace(RE_EXEMPLO_ABERTURA, EXEMPLO_ABERTURA_NOVO);
  const fecho = contar(RE_FECHO_ANTIGO, texto);
  texto = texto.replace(RE_FECHO_ANTIGO, FECHO_NOVO);
  let gancho = 0;
  for (const [de, para] of TROCAS_DO_GANCHO) {
    gancho += contar(de, texto);
    texto = texto.replace(de, para);
  }
  return { prompt: `${texto}\n\n${secao}`, trocas: { abertura, exemplo, fecho, gancho } };
}
