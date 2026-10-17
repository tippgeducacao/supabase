// Follow-up antes do convite (17/10/2026, caso José).
//
// "Sou nutricionista" → "bacana, como nutricionista, vc trabalha numa empresa do agro ou em outra área?" → sem
// resposta → o toque de 15 min mandou "José, ainda faz sentido procurar um horário para sua conversa com o monitor
// sobre o MBA em Postura Comercial?". Ninguém tinha falado de monitor nem de reunião: a condição da opção ("já houve
// convite") só estava no texto que o modelo lê.
//  1. Sem convite feito na conversa, as retomadas de agenda saem das opções do modelo (`conviteFeito`).
//  2. Quem parou numa pergunta nossa antes do convite recebe a pergunta de novo com o gancho do lote na frente
//     (`followupDaPendencia`), no estilo da retomada do cronograma que o Gustavo aprovou.
import type { Msg } from './historico.ts';
import { MARCADOR_ATENDIMENTO_HUMANO } from './historico.ts';
import { cursoDaConversa } from './ganchoLote.ts';

const textoDe = (m: Msg): string => typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';

// "primeiro lote" sozinho não é convite: o próprio toque da pendência fala dele. Convite = meet, monitor ou horário.
const RE_CONVITE = /\bno meet\b|monitor especialista|conversa (?:r[aá]pida |individual )?com o monitor|\b\d{1,2}(?::\d{2})?h(?:\d{2})?\b[^?]*\?/i;

/** Já houve convite pro meet nesta conversa (lote apresentado, conversa com o monitor ou horário oferecido)? */
export function conviteFeito(historico: readonly Msg[]): boolean {
  return historico.some((m) => m?.role === 'assistant' && RE_CONVITE.test(textoDe(m)));
}

const ehFalaDoLead = (t: string) => Boolean(t.trim()) && !t.includes('AUTO_IGNORE') && !t.startsWith('[RESPOSTA AUTOM') && !t.startsWith('[início');

/**
 * A pergunta nossa que ficou sem resposta, se ela foi a resposta a uma fala do lead e veio antes do convite.
 * '' quando a última fala nossa não é uma pergunta assim.
 */
export function perguntaPendente(historico: readonly Msg[]): string {
  if (conviteFeito(historico)) return '';
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    const t = textoDe(m).trim();
    if (m?.role === 'user') {
      if (!t || t.includes('AUTO_IGNORE')) continue;      // ferramenta ou marcador do follow-up
      return '';                                          // o lead falou depois da nossa pergunta
    }
    if (m?.role !== 'assistant' || !t) continue;
    if (t.startsWith(MARCADOR_ATENDIMENTO_HUMANO) || !t.includes('?')) return '';
    // A pergunta precisa ter sido a resposta a uma fala de gente do lead (não o template nem um disparo).
    let respondeuAoLead = false;
    for (let j = i - 1; j >= 0; j--) {
      const u = textoDe(historico[j]).trim();
      if (historico[j]?.role === 'assistant' && u) break;
      if (historico[j]?.role === 'user' && ehFalaDoLead(u)) { respondeuAoLead = true; break; }
    }
    if (!respondeuAoLead) return '';
    const ultima = (t.match(/[^.!?\n]*\?/g) ?? []).at(-1)?.trim() ?? '';
    return ultima.replace(/^(?:bacana|certo|legal|beleza|tranquilo|show|perfeito)[,.!]?\s*/i, '');
  }
  return '';
}

/** O toque: o gancho do lote e a pergunta pendente. '' quando não há pergunta pendente. */
export function followupDaPendencia(historico: readonly Msg[], nome: string, curso: string): string {
  const pergunta = perguntaPendente(historico);
  if (!pergunta) return '';
  return `${nome ? `${nome}, ` : ''}estamos em fechamento do primeiro lote promocional ${cursoDaConversa(curso)}. me conta, ${pergunta}`;
}
