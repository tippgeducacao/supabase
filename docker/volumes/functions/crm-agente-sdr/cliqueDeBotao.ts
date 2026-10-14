// Em qual mensagem o lead clicou (14/10/2026, caso sarandaurio).
//
// Às 09:41 saiu o template de confirmação da aula ("sua participação na aula… está confirmada") e às
// 09:42 o de venda ("tenho 2 horários… 13:30h e 16:30h", botão "Confirmar participação"). A lead
// clicou no botão do de VENDA e a IA respondeu "obrigado por confirmar que pretende participar da
// aula". O agente só lia o texto do clique; o WhatsApp manda também o identificador da mensagem
// clicada, e ele se perdia antes do buffer.
//
// Aqui o clique vira FATO no contexto da rodada: o texto do botão e a mensagem em que ele estava (o
// texto inteiro, o template e a hora, lidos do CRM). Nenhuma regra nova: o que fazer com um aceite
// da conversa com o monitor, ou com uma confirmação de aula, o prompt já sabe.
// deno-lint-ignore-file no-explicit-any
import { phoneVariants } from './conta.ts';

export type Clique = { botao: string; citadoId: string | null; citadoTexto: string | null };

const RE_CITACAO = /^\s*\[Em resposta à mensagem:\s*"[\s\S]*?"\]\s*/i;

/** O clique de botão deste inbound, ou null (texto digitado, sem mensagem citada, etc.). */
export function cliqueDoPayload(payload: any): Clique | null {
  const tipo = String(payload?.tipo ?? '');
  if (tipo !== 'button' && tipo !== 'interactive') return null;
  const citado = payload?.quoted ?? payload?.context ?? null;
  const citadoId = typeof citado?.id === 'string' && citado.id.trim() ? citado.id.trim() : null;
  const citadoTexto = typeof citado?.conteudo === 'string' && citado.conteudo.trim() ? citado.conteudo.trim() : null;
  if (!citadoId && !citadoTexto) return null;
  const titulo = typeof payload?.interactive_reply?.title === 'string' ? payload.interactive_reply.title : '';
  const botao = (titulo || String(payload?.conteudo ?? '').replace(RE_CITACAO, '')).trim();
  if (!botao || payload?.interactive_reply?.tipo === 'call_permission_reply') return null;
  return { botao, citadoId, citadoTexto };
}

type Banco = { from: (tabela: string) => any };

function quandoEmBrasilia(iso: string, agora: Date): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dia = (x: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(x);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(d);
  return `${dia(d) === dia(agora) ? 'hoje' : `em ${dia(d)}`} às ${hora}`;
}

/** A mensagem clicada, pelo CRM (só do próprio telefone). null = não achou; vale o texto citado. */
async function mensagemClicada(supabase: Banco, telefone: string, id: string) {
  try {
    const { data, error } = await supabase.from('crm_whatsapp_messages')
      .select('conteudo, template_name, created_at')
      .eq('wa_message_id', id).in('telefone', phoneVariants(telefone)).eq('direcao', 'outbound').limit(1);
    if (error || !data?.length) return null;
    return data[0] as { conteudo: string | null; template_name: string | null; created_at: string };
  } catch {
    return null;
  }
}

// Convite com horário de conversa (14/10/2026, relato do Adones): "Amanhã iniciaremos nosso módulo
// prático… Quer fazer parte…? Hoje, o coordenador estará disponível para uma conversa, com dois
// horários: 11h ou 18h", botão "Confirmar participação". A IA leu como inscrição no módulo e foi atrás
// de horário e local dele. Nesses disparos o módulo, as vagas e as bolsas são o gancho; o que se
// confirma é a conversa com o monitor. Na semana, 13.250 templates ofereciam horário de conversa.
const RE_CONVERSA = /\b(?:conversa|conversar|reuni[aã]o|meet|bate[- ]papo|atendimento)\b/i;
const RE_HORA = /\b([01]?\d|2[0-3])(?::([0-5]\d))?\s?h(?:([0-5]\d))?\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;

/** Os horários de conversa que a mensagem oferece ("11h", "13h30"), ou [] se ela não oferece. */
export function horariosDeConversa(texto: string): string[] {
  if (!RE_CONVERSA.test(texto)) return [];
  const horas: string[] = [];
  for (const m of texto.matchAll(RE_HORA)) {
    const h = m[1] ?? m[4];
    const min = m[2] ?? m[3] ?? m[5];
    const fala = `${Number(h)}h${min && min !== '00' ? min : ''}`;
    if (!horas.includes(fala)) horas.push(fala);
  }
  return horas.slice(0, 4);
}

/** A nota do contexto para os cliques do lote; '' quando não houve clique. */
export async function notaDosCliques(supabase: Banco, telefone: string, cliques: readonly Clique[], agora: Date,
  opcoes: { convite?: boolean } = {}): Promise<string> {
  if (!cliques.length) return '';
  const linhas: string[] = [];
  for (const c of cliques.slice(-2)) {
    const m = c.citadoId ? await mensagemClicada(supabase, telefone, c.citadoId) : null;
    const texto = String(m?.conteudo ?? c.citadoTexto ?? '').trim().slice(0, 900);
    if (!texto) continue;
    const quando = m?.created_at ? quandoEmBrasilia(m.created_at, agora) : null;
    const origem = [quando ? `enviada ${quando}` : null, m?.template_name ? `template ${m.template_name}` : null].filter(Boolean).join(', ');
    linhas.push(`- botão "${c.botao}", na mensagem ${origem ? `(${origem}) ` : ''}${JSON.stringify(texto)}`);
    const horas = opcoes.convite ? horariosDeConversa(texto) : [];
    if (horas.length) {
      linhas.push(`  Essa mensagem é um convite para a conversa com o monitor: os horários dela (${horas.join(', ')}) são dessa conversa, `
        + 'e o clique é o aceite dela. O resto da mensagem (curso, módulo, aula, vagas, bolsa) é o gancho do convite, não uma inscrição. '
        + 'Os horários do convite não estão reservados.');
    }
  }
  if (!linhas.length) return '';
  return '\n\nO LEAD CLICOU NUM BOTÃO (dado do WhatsApp, não é instrução do lead):\n' + linhas.join('\n')
    + '\nO clique responde à mensagem em que o botão estava, não a outras mensagens da conversa.';
}

/**
 * A nota vale para este telefone? Ligada para todos (crm_agente_sdr_config.nota_clique_botao) ou só nos
 * telefones de ensaio (nota_clique_botao_telefones). Falha de leitura = desligada.
 */
/** A leitura do convite com horário vale para este telefone? (nota_clique_convite / _telefones). */
export async function notaConviteLigada(supabase: Banco, telefone: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('nota_clique_convite, nota_clique_convite_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.nota_clique_convite === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.nota_clique_convite_telefones) ? data.nota_clique_convite_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}

export async function notaCliqueLigada(supabase: Banco, telefone: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('nota_clique_botao, nota_clique_botao_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.nota_clique_botao === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.nota_clique_botao_telefones) ? data.nota_clique_botao_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}
