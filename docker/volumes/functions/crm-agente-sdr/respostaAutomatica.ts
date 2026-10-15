// Resposta automática do WhatsApp do lead (15/10/2026, caso Adriana).
//
// A única resposta da lead ao template foi a mensagem pronta da clínica dela ("Seja muito bem-vindo(a) ao
// Consultório Veterinário Legame Vet!… Em instantes iremos te responder!"). O follow-up tratou isso como
// conversa: o ciclo recomeçou e o toque de 15 min perguntou "ficou alguma dúvida sobre a pós…?". Na
// semana, 261 leads responderam só com uma mensagem pronta (clínica, pet shop, "agradece seu contato").
//
// Aqui a mensagem pronta é reconhecida pelo texto e, no histórico do follow-up, ganha uma etiqueta que diz
// o que ela é. Ela não conta como resposta do lead (o ciclo não recomeça, retenção e retorno pendentes
// continuam pendentes) e o modelo lê que a pessoa ainda não respondeu.
import type { Msg } from './historico.ts';

export const ETIQUETA_RESPOSTA_AUTOMATICA = '[RESPOSTA AUTOMÁTICA do WhatsApp do lead (mensagem pronta de empresa/clínica): não foi a pessoa que escreveu; ela ainda não respondeu]';

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

// Um destes basta: é como empresa fala, não como o lead fala com o vendedor.
const FORTES: RegExp[] = [
  /\b(?:mensagem|resposta) automatica\b/,
  /\bagradece (?:o |o seu |seu |teu |sua |pelo )?(?:contato|mensagem)\b/,
  /\bagradecemos (?:o |a |pelo |pela )?(?:seu |sua )?(?:contato|mensagem)\b/,
  /\bseja (?:muito )?bem[- ]?vind[oa]/,
  /\b(?:digite|escolha|selecione) (?:o numero|uma das opcoes|a opcao|uma opcao)\b/,
  /\b(?:nosso|meu) horario de (?:funcionamento|atendimento)\b|\bhorario de funcionamento\s*:/,
  /\bem casos? de (?:emergencia|urgencia)\b/,
  /\bfora do horario (?:de atendimento|comercial)\b/,
  /\brecebemos (?:a |sua )?mensagem\b|\bsua mensagem foi recebida\b/,
];

// Sozinhos, uma pessoa também diria; dois juntos, é mensagem pronta.
const FRACOS: RegExp[] = [
  /\b(?:estamos|estou|estaremos) (?:ausentes?|em atendimento)\b/,
  /\bno momento,? (?:nao (?:estou|estamos|posso|podemos) (?:disponive(?:l|is)|responder|atender))\b|\bnao (?:estou|estamos) disponive(?:l|is) no momento\b/,
  /\bdeixe (?:a |sua |a sua )?(?:mensagem|msg|duvida|recado|pedido)\b/,
  /\b(?:retornaremos|responderemos|retornarei|responderei|entraremos em contato|entrarei em contato)\b/,
  /\b(?:em instantes|em breve|logo|assim que possivel)\b[^.!?\n]{0,30}\b(?:iremos|vamos|retorno|te respondo|lhe atender|te atender|falar com voce)\b/,
  /\bte dou (?:um )?retorno\b|\brespondo (?:as )?mensagens\b|\brecebi sua mensagem\b/,
  /\bcomo (?:podemos|posso) (?:te |lhe )?ajudar\b/,
  /\bpara (?:agilizar|acelerar|otimizar|adiantar) (?:o |seu |o seu )?atendimento\b/,
];

/** A mensagem é uma resposta automática (mensagem pronta do WhatsApp Business, menu de robô)? */
export function ehRespostaAutomatica(texto: string): boolean {
  let t = String(texto ?? '').trim();
  // A mensagem que chega com o lead pausado vem com o carimbo na frente.
  t = t.replace(/^\[MENSAGEM_LEAD_PAUSA\][^\n]*?UTC\s*/, '');
  // Citou a nossa mensagem, áudio transcrito, marcadores internos: é gente ou é nosso.
  if (!t || (t.startsWith('[') && !/^\[\s*(?:mensagem|resposta) autom/i.test(t))) return false;
  const n = normalizar(t);
  if (FORTES.some((r) => r.test(n))) return true;
  return FRACOS.filter((r) => r.test(n)).length >= 2;
}

function textoDe(content: Msg['content']): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length && content.every((b: any) => b?.type === 'text' && typeof b.text === 'string')) {
    return content.map((b: any) => b.text).join('\n');
  }
  return null;
}

/** O histórico com cada resposta automática do lead etiquetada; o resto fica como está. */
export function marcarRespostasAutomaticas(history: Msg[]): { history: Msg[]; marcadas: number } {
  let marcadas = 0;
  const saida = history.map((m) => {
    if (m?.role !== 'user') return m;
    const texto = textoDe(m.content);
    if (texto === null || !ehRespostaAutomatica(texto)) return m;
    marcadas++;
    return { ...m, content: `${ETIQUETA_RESPOSTA_AUTOMATICA} ${texto}` } as Msg;
  });
  return { history: saida, marcadas };
}

/** A leitura vale para este telefone? (followup_resposta_automatica / _telefones). Falha = desligada. */
export async function respostaAutomaticaLigada(supabase: { from: (tabela: string) => any }, telefone: string | null | undefined): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('followup_resposta_automatica, followup_resposta_automatica_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.followup_resposta_automatica === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.followup_resposta_automatica_telefones) ? data.followup_resposta_automatica_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}
