// Cliente do Jev (TypeSafe) — compartilhado pelo router (routerJev.ts) e pela leitura do lead
// para a ficha (leituraJev.ts). O Jev é um classificador: recebe um estado e perguntas fechadas
// (choice / score / noul) e devolve probabilidades, nunca texto. ~0,4 s e US$ 0,042 por milhão
// de tokens de entrada (saída não é cobrada).
import { INICIO_HISTORICO_HUMANO, MARCADOR_ATENDIMENTO_HUMANO, MARCADOR_FOLLOWUP, type Msg } from './historico.ts';

export const URL_JEV = 'https://api.typesafe.ai/v1/systemone';
export const PRAZO_JEV_MS = 3000;

// Dado pessoal não muda nenhuma decisão: link, e-mail e número longo (telefone, CPF) saem mascarados.
const RE_LINK = /https?:\/\/\S+|www\.\S+/gi;
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const RE_NUMERO_LONGO = /\+?\d(?:[\s().-]?\d){9,}/g;
const RE_CABECALHO_HUMANO = /\[ATENDIMENTO_HUMANO\][^\n]*\n?/g;
export const mascarar = (t: string) => t.replace(RE_LINK, '[LINK]').replace(RE_EMAIL, '[EMAIL]').replace(RE_NUMERO_LONGO, '[NUMERO]');

export type TurnoJev = { de: string; texto: string };

/**
 * Histórico JÁ limpo pelo `limparParaRouter` → turnos rotulados (`lead` / `sdr` / `vendedor`),
 * mascarados, sem marcadores internos. A nota de troca de número, que o `comNotaParaRouter`
 * funde na fala do lead, sai do texto (quem chama decide se ela vira campo próprio).
 */
export function conversaParaJev(historicoLimpo: readonly Msg[], opts: { nota?: string | null; janela: number }): TurnoJev[] {
  const conversa: TurnoJev[] = [];
  for (const m of historicoLimpo) {
    let texto = typeof m.content === 'string' ? m.content : '';
    if (opts.nota) texto = texto.replace(opts.nota, '');
    texto = texto.replace(MARCADOR_FOLLOWUP, '').replace(INICIO_HISTORICO_HUMANO, '').trim();
    if (!texto) continue;
    const de = m.role === 'user' ? 'lead'
      : texto.includes(MARCADOR_ATENDIMENTO_HUMANO) ? 'vendedor (humano da equipe)' : 'sdr';
    // O cabeçalho da fala humana ("[ATENDIMENTO_HUMANO] Nome · data") já está no rótulo `de`.
    texto = texto.replace(RE_CABECALHO_HUMANO, '').trim();
    if (!texto) continue;
    conversa.push({ de, texto: mascarar(texto).slice(0, 1500) });
  }
  return conversa.slice(-opts.janela);
}

export type RespostaJev = { answers: Record<string, any>; modelo: string | null; tokens_entrada: number | null };

/** Uma chamada, todas as perguntas em paralelo. Erro diz só o status: o corpo pode ecoar a conversa. */
export async function chamarJev(
  estado: unknown,
  perguntas: Record<string, unknown>,
  chave: string,
  fetchFn: typeof fetch = fetch,
  prazoMs = PRAZO_JEV_MS,
): Promise<RespostaJev> {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), prazoMs);
  try {
    const res = await fetchFn(URL_JEV, {
      method: 'POST',
      signal: controle.signal,
      headers: { authorization: `Bearer ${chave}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: estado, questions: perguntas }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Jev: HTTP ${res.status}`);
    }
    const dados = await res.json();
    return {
      answers: dados?.answers && typeof dados.answers === 'object' ? dados.answers : {},
      modelo: typeof dados?.model === 'string' ? dados.model : null,
      tokens_entrada: typeof dados?.usage?.input_tokens === 'number' ? dados.usage.input_tokens : null,
    };
  } catch (e) {
    if (controle.signal.aborted) throw new Error(`Jev: sem resposta em ${prazoMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Resposta de escolha: a opção e a confiança, ou null se veio fora do formato. */
export function escolhaDoJev(resposta: any): { valor: string; confianca: number } | null {
  const valor = resposta?.choice;
  const confianca = resposta?.confidence;
  if (typeof valor !== 'string' || typeof confianca !== 'number' || !Number.isFinite(confianca)) return null;
  return { valor, confianca };
}

/** Resposta sim/não: a probabilidade do sim, ou null. */
export function simDoJev(resposta: any): number | null {
  const p = resposta?.noul;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
}
