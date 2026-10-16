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

export const ETIQUETA_RESPOSTA_AUTOMATICA = '[RESPOSTA AUTOMÁTICA do WhatsApp do lead (mensagem pronta de empresa/clínica). Não foi a pessoa que escreveu: ela ainda não respondeu nada, nem a nossa última pergunta, e esta mensagem não diz nada sobre ela]';

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

/** Chave de ensaio genérica: `coluna` ligada para todos, ou o telefone em `coluna_telefones`. Falha = desligada. */
export async function chaveDeEnsaioLigada(supabase: { from: (tabela: string) => any }, coluna: string, telefone: string | null | undefined): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select(`${coluna}, ${coluna}_telefones`).eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data[coluna] === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data[`${coluna}_telefones`]) ? data[`${coluna}_telefones`] : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}

/**
 * O lote do agente é só mensagem pronta (16/10/2026)? A IA respondia "fico no aguardo" ao robô (34 vezes
 * em 28 leads numa tarde, às vezes duas seguidas) e, ao "não estamos disponíveis no momento", perguntava
 * "qual o melhor horário pra eu te chamar de novo?", que deixava o follow-up esperando para sempre (13
 * leads). Arquivo ou clique de botão nunca é mensagem pronta.
 */
export function loteSoDeRespostaAutomatica(itens: readonly any[]): boolean {
  return itens.length > 0 && itens.every((i) => !i?.arquivo && !i?.clique && ehRespostaAutomatica(String(i?.mensagem ?? '')));
}

// Pedido do Gustavo (16/10/2026): a mensagem pronta do lead TEM resposta, "fico no aguardo", e o follow-up
// desse lead segue uma sequência própria, sem pergunta genérica. A fala sai do código, uma vez só até o lead
// escrever de verdade, para não virar conversa entre o João e o robô.
export const FALA_PARA_ROBO = 'fico no aguardo';
const SEQUENCIA_DO_ROBO = ['pode conversar agora?', 'temos uma condição promocional liberada hoje, eu preciso falar com você hoje.'];

const ehFalaDeGente = (t: string) => Boolean(t.trim()) && !t.includes('AUTO_IGNORE') && !t.startsWith(ETIQUETA_RESPOSTA_AUTOMATICA)
  && !ehRespostaAutomatica(t);

/** Já mandamos "fico no aguardo" depois da última fala de gente do lead? */
export function jaAguardandoRobo(history: readonly Msg[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = textoDe(history[i]?.content) ?? '';
    if (history[i]?.role === 'assistant' && /fico no aguardo/i.test(t)) return true;
    if (history[i]?.role === 'user' && ehFalaDeGente(t)) return false;
  }
  return false;
}

/** O lead só respondeu com mensagem pronta (nenhuma fala de gente no histórico, ao menos uma de robô)? */
export function soRoboRespondeu(history: readonly Msg[]): boolean {
  let robo = false;
  for (const m of history) {
    if (m?.role !== 'user') continue;
    const t = textoDe(m.content);
    if (t === null || !t.trim() || t.includes('AUTO_IGNORE') || t.startsWith('[início')) continue;
    if (t.startsWith(ETIQUETA_RESPOSTA_AUTOMATICA) || ehRespostaAutomatica(t)) { robo = true; continue; }
    return false;
  }
  return robo;
}

/** O toque `tentativa` (1, 2) do follow-up de quem só tem robô; '' depois do 2º. */
export function falaDoFollowupDoRobo(tentativa: number, nome: string): string {
  const fala = SEQUENCIA_DO_ROBO[tentativa - 1];
  if (!fala) return '';
  return nome ? `${nome}, ${fala}` : fala.charAt(0).toUpperCase() + fala.slice(1);
}

// Atendente falando com o lead (16/10/2026, caso Antônio). A pausa por prazo venceu às 16h54 enquanto a Amanda
// conversava com ele (16h47 a 17h01); o lead respondeu a ela e a IA respondeu no lugar. Duas falas ou mais de
// atendente nos últimos `minutos` = conversa em andamento, a vez é do atendente. Uma fala só não conta: o disparo
// em massa de um vendedor (Welinton, 15:58 UTC de 16/10) deixaria sem IA todo lead que respondesse a ele.
const RE_FALA_HUMANA = /^\[ATENDIMENTO_HUMANO\][^·\n]*·\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/;

export function atendenteFalouHaPouco(history: readonly Msg[], agora: number, minutos = 30): boolean {
  let falas = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role !== 'assistant') continue;
    const m = (textoDe(history[i].content) ?? '').trimStart().match(RE_FALA_HUMANA);
    if (!m) continue;
    const quando = Date.parse(`${m[1].replace(' ', 'T')}Z`);
    if (!Number.isFinite(quando) || agora - quando > minutos * 60_000) break;
    if (++falas >= 2) return true;
  }
  return false;
}
