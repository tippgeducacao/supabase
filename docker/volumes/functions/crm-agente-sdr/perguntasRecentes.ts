// Perguntas que já foram feitas nesta conversa e o que o lead respondeu (24/09/2026).
//
// Medido em 7 dias: das falas com pergunta, a Luna refez uma pergunta das 3 falas anteriores em
// 5,88% (Claude: 0,98%) — "antes, qual é a sua graduação?" e "vc já é formado em Medicina
// Veterinária?" de novo depois da resposta, "procuro um encaixe pra ainda hoje?" repetido.
// Pergunta de escolha de horário ("qual fica melhor pra vc?") ficou fora da conta: repete por
// natureza a cada oferta nova.
//
// Derivado do histórico a cada volta (nada novo é gravado) e anexado ao bloco da ficha, que a
// Luna lê em toda chamada. Módulo puro.
import { MARCADOR_ATENDIMENTO_HUMANO, type Msg } from './historico.ts';

const MAX_PERGUNTAS = 5;
const RE_ESCOLHA_HORARIO = /qual (fica|seria|funciona) melhor|algum desses|qual desses|qual (dos|das) (dois|duas|tres)|qual horario|qual prefere/;

function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
}

const palavras = (t: string) => new Set(normalizar(t).split(/\s+/).filter((p) => p.length > 2));

function parecidas(a: string, b: string): boolean {
  const pa = palavras(a); const pb = palavras(b);
  const comum = [...pa].filter((p) => pb.has(p)).length;
  return comum / Math.max(1, new Set([...pa, ...pb]).size) >= 0.7;
}

function textoDe(m: Msg): string {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

/** Perguntas de uma fala, sem as de escolha de horário e sem as curtas demais ("né?"). */
export function perguntasDaFala(texto: string): string[] {
  return (texto.match(/[^.!?\n]*\?/g) ?? [])
    .map((p) => p.trim())
    .filter((p) => palavras(p).size >= 3 && !RE_ESCOLHA_HORARIO.test(normalizar(p)));
}

/** Registro interno no papel de user (correção, contexto) não é resposta do lead. */
const ehInterno = (t: string) => /^\[(?:CORRECAO|CONTEXTO|FICHA|ESTADO|MARCADOR)/i.test(t.trimStart());

/** Fala do lead sem cabeçalhos técnicos: citação do WhatsApp e marca de mensagem na pausa. */
function falaDoLead(t: string): string {
  return t
    .replace(/^\[Em resposta à mensagem: "[\s\S]*?"\]\s*/, '')
    .replace(/^\[MENSAGEM_LEAD_PAUSA\][^\n]*\n?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** O que o LEAD escreveu, em ordem, sem registros internos nem cabeçalho de citação. */
export function falasDoLead(messages: readonly Msg[]): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => textoDe(m))
    .filter((t) => t && !ehInterno(t))
    .map(falaDoLead)
    .filter(Boolean);
}

type Pergunta = { pergunta: string; autor: 'voce' | 'atendente'; respostas: string[] };

export function blocoPerguntasRecentes(messages: readonly Msg[], limite = MAX_PERGUNTAS): string {
  const todas: Pergunta[] = [];
  let abertas: Pergunta[] = [];
  for (const m of messages) {
    const t = textoDe(m).trim();
    if (!t) continue;
    if (m.role === 'assistant') {
      const humano = t.startsWith(MARCADOR_ATENDIMENTO_HUMANO);
      // Fala humana chega como "[ATENDIMENTO_HUMANO] Nome · data\ntexto".
      const corpo = humano ? t.split('\n').slice(1).join('\n') : t;
      abertas = perguntasDaFala(corpo).map((pergunta) => ({ pergunta, autor: humano ? 'atendente' : 'voce', respostas: [] }));
      todas.push(...abertas);
    } else if (!ehInterno(t)) {
      const fala = falaDoLead(t);
      if (fala) for (const p of abertas) p.respostas.push(fala);
    }
  }
  // A mesma pergunta feita de novo conta uma vez só, com a resposta mais recente.
  const unicas = todas.filter((p, i) => !todas.slice(i + 1).some((depois) => parecidas(p.pergunta, depois.pergunta)));
  const ultimas = unicas.slice(-limite);
  if (!ultimas.length) return '';
  const corta = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const linhas = ultimas.map((p) => {
    const quem = p.autor === 'voce' ? 'você' : 'atendente';
    const depois = p.respostas.length ? `"${corta(p.respostas.join(' / '), 160)}"` : '(nada ainda)';
    return `- ${quem}: "${corta(p.pergunta, 160)}" → o lead escreveu depois: ${depois}`;
  });
  return '[PERGUNTAS JÁ FEITAS NESTA CONVERSA — tirado do histórico; não é fala do lead]\n'
    + linhas.join('\n')
    + '\nSe o que o lead escreveu depois já responde a pergunta, não a refaça, nem com outras palavras: use a resposta e siga. '
    + 'Se não responde, você pode retomá-la uma vez, de outro jeito.';
}
