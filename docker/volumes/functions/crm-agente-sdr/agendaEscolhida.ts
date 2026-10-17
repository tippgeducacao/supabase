// O lead escolheu um dos horários oferecidos (17/10/2026, caso Manu).
//
// A IA ofereceu "segunda às 10h, 10h30 ou 11h". O follow-up voltou um passo ("ainda faz sentido procurar um
// horário na segunda de manhã…?"), a lead respondeu "Pode ser às 10" e o router manteve a abertura, que não
// agenda: saiu "beleza, vc escolheu segunda às 10h…" e nada foi marcado. Duas peças:
//  1. com a escolha de um horário oferecido e a formação APROVADA, o código passa para o agente que agenda,
//     sem depender do router (`escolheuHorarioOfertado`);
//  2. o follow-up de quem recebeu horários que ainda valem oferece os mesmos horários de novo, em vez de
//     perguntar se faz sentido procurar (`followupDosHorarios`).
import type { Msg } from './historico.ts';
import { horariosDoLead, opcoesDeAgenda, resultadosDeFerramenta, type OpcaoAgenda } from './travasDeterministicas.ts';

const inicioDe = (o: OpcaoAgenda) => Date.parse(`${o.data}T${o.horario}:00-03:00`);

/** Horários oferecidos que ainda não passaram (com folga de `folgaMin`). */
export function horariosAindaValidos(historico: readonly Msg[], agora: number, folgaMin = 30): OpcaoAgenda[] {
  return (opcoesDeAgenda(historico) ?? []).filter((o) => Number.isFinite(inicioDe(o)) && inicioDe(o) - agora > folgaMin * 60_000);
}

/** A compatibilidade da formação foi APROVADA nesta conversa? */
export function aprovadoNaConversa(historico: readonly Msg[]): boolean {
  return resultadosDeFerramenta(historico).some((r) => r?.compativel === true || r?.output === 'APROVADO');
}

/** A fala do lead escolhe um dos horários oferecidos que ainda valem? */
export function escolheuHorarioOfertado(historico: readonly Msg[], fala: string, agora: number): boolean {
  const horas = horariosDoLead(String(fala ?? ''));
  if (!horas.size) return false;
  return horariosAindaValidos(historico, agora, 0).some((o) => horas.has(o.horario));
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const falaDaHora = (h: string) => { const [hh, mm] = h.split(':'); return `${Number(hh)}h${mm === '00' ? '' : mm}`; };

function falaDoDia(data: string, agora: number): string {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(agora));
  const amanha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(agora + 86_400_000));
  if (data === hoje) return 'hoje';
  if (data === amanha) return 'amanhã';
  return DIAS[new Date(`${data}T12:00:00-03:00`).getUTCDay()];
}

/**
 * A retomada de quem recebeu horários que ainda valem: os mesmos horários, até três, do mesmo dia da última
 * oferta. '' quando não há horário válido (o follow-up segue como sempre).
 */
export function followupDosHorarios(historico: readonly Msg[], nome: string, agora: number): string {
  const validos = horariosAindaValidos(historico, agora, 60);
  if (!validos.length) return '';
  const dia = validos.at(-1)!.data;
  const horas = [...new Set(validos.filter((o) => o.data === dia).map((o) => o.horario))].sort().slice(0, 3).map(falaDaHora);
  const lista = horas.length === 1 ? horas[0] : `${horas.slice(0, -1).join(', ')} ou ${horas.at(-1)}`;
  const quem = nome ? `${nome}, ` : '';
  const livres = horas.length === 1 ? 'ainda está livre' : 'ainda estão livres';
  return `${quem}pra sua conversa com o monitor, ${falaDoDia(dia, agora)} às ${lista} ${livres}. qual fica melhor pra vc?`;
}

/** A última fala nossa (fora os marcadores do follow-up) ofereceu horário? */
export function ultimaFalaOfereceuHorario(historico: readonly Msg[]): boolean {
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m?.role !== 'assistant') continue;
    const t = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ') : '';
    if (!t.trim()) continue;
    return /\b\d{1,2}h(?:\d{2})?\b/.test(t) && /qual fica melhor|funciona|prefere/i.test(t);
  }
  return false;
}
