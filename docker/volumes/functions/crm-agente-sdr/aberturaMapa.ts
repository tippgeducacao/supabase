// Conhecer a pessoa antes do convite, pelo mapa do Wellinton (16/10/2026, caso Dani).
//
// A lead de Cannabis respondeu "não prescrevo" ao template e a IA foi direto ao convite do meet, com uma
// ponte sem sentido ("bom dia, certo, a conversa pode te apresentar a pós…"). O prompt da Luna mandava
// abrir o lote já na primeira resposta; as perguntas do comercial (sdr_carreira_mapa_*) só o follow-up lia.
//
// Fluxo aprovado pelo Gustavo (16/10): até DUAS perguntas antes do convite, com as palavras do mapa.
//   1. a que divide o perfil ("hoje você é contratado de uma clínica, tem a sua própria…?"), se o perfil
//      ainda não é conhecido;
//   2. uma de carreira do perfil ("os tutores já te perguntaram se você prescreve?");
//   3. a abertura do lote e o convite, ligados à ponte do perfil.
// Pedido de horário, preço ou material pula as perguntas (o prompt já sabe o que fazer com eles).
//
// O código só conta e entrega os dados: em que fase a conversa está e quais perguntas cabem. O modelo
// escolhe a pergunta pelo que a pessoa contou.
// deno-lint-ignore-file no-explicit-any
import type { MapaCarreira, RamoMapa } from './carreiraPos.ts';
import { ramoDoLead } from './followupMapa.ts';
import { MARCADOR_ATENDIMENTO_HUMANO, type Msg } from './historico.ts';

export const MAX_PERGUNTAS_ANTES_DO_CONVITE = 2;

const textoDe = (m: Msg): string => typeof m.content === 'string' ? m.content
  : Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';

// A abertura do lote ou um convite pro meet já saiu: daqui em diante vale o fluxo de sempre.
const RE_CONVITE_FEITO = /primeiro lote promocional|conversa r[áa]pida (?:no meet|com o monitor)|monitor especialista/i;

// A pergunta do mapa já foi feita? O modelo escreve com "vc", no feminino, com reação na frente: compara
// as palavras de conteúdo (sem acento, sem a desinência a/o/s) de cada pergunta nossa.
const VAZIAS = new Set(['voce', 'vc', 'hoje', 'uma', 'um', 'que', 'com', 'para', 'pra', 'sua', 'seu', 'tem', 'faz', 'ja', 'te', 'se', 'ou', 'de', 'da', 'do', 'na', 'no', 'em', 'e', 'a', 'o']);
const raiz = (p: string) => p.replace(/(?:as|os|a|o|s)$/, '');
function palavras(s: string): Set<string> {
  const n = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  return new Set(n.split(/\s+/).filter((p) => p.length > 1 && !VAZIAS.has(p)).map(raiz));
}
export function jaPerguntou(pergunta: string, historico: readonly Msg[]): boolean {
  const alvo = palavras(pergunta);
  if (alvo.size < 2) return false;
  return historico.filter((m) => m?.role === 'assistant').some((m) => (textoDe(m).match(/[^.!?\n]*\?/g) ?? []).some((q) => {
    const nossa = palavras(q);
    const comuns = [...alvo].filter((p) => nossa.has(p)).length;
    return comuns / (alvo.size + nossa.size - comuns) >= 0.6;
  }));
}

export type FaseAbertura = { fase: 'perguntar' | 'abertura'; feitas: number; perfil: RamoMapa | null };

/** Em que ponto a conversa está antes do convite; null = o convite já saiu (ou um vendedor assumiu). */
export function faseDaAbertura(mapa: MapaCarreira, historico: readonly Msg[], lead: any): FaseAbertura | null {
  const nossas = historico.filter((m) => m?.role === 'assistant').map(textoDe).filter((t) => t.trim());
  if (!nossas.length) return null;
  if (nossas.some((t) => t.trimStart().startsWith(MARCADOR_ATENDIMENTO_HUMANO))) return null;
  // A 1ª mensagem nossa é o template (pode trazer a própria pergunta); o convite conta dali em diante.
  if (nossas.slice(1).some((t) => RE_CONVITE_FEITO.test(t))) return null;
  const perguntasNossas = nossas.slice(1).filter((t) => t.includes('?')).length;
  const doMapa = mapa.perguntas.filter((p) => (p.etapa === 'divide' || p.etapa === 'carreira') && jaPerguntou(p.texto, historico)).length;
  const feitas = Math.max(perguntasNossas, doMapa);
  return { fase: feitas >= MAX_PERGUNTAS_ANTES_DO_CONVITE ? 'abertura' : 'perguntar', feitas, perfil: ramoDoLead(mapa, lead) };
}

/** O bloco do contexto da rodada com a fase e as perguntas do mapa que ainda cabem. */
export function blocoDaAbertura(mapa: MapaCarreira, f: FaseAbertura, historico: readonly Msg[]): string {
  const ainda = (texto: string) => !jaPerguntou(texto, historico);
  const linhas = [`- perguntas já feitas antes do convite: ${f.feitas} de ${MAX_PERGUNTAS_ANTES_DO_CONVITE}`];
  const ramos = f.perfil ? [f.perfil] : mapa.ramos;
  if (f.fase === 'perguntar') {
    linhas.push('- fase: CONHECER A PESSOA. Ainda cabe uma pergunta antes do convite: escolha UMA destas, pela conversa, e escreva com as palavras do comercial.');
    const divide = mapa.perguntas.find((p) => p.etapa === 'divide' && ainda(p.texto));
    if (!f.perfil && divide) linhas.push(`- sem saber como ele trabalha hoje, a pergunta que divide: "${divide.texto}"`);
  } else {
    linhas.push('- fase: HORA DA ABERTURA. Não pergunte mais nada sobre ele: faça a abertura do lote e o convite, ligando ao que ele contou com a ponte do perfil.');
  }
  for (const r of ramos) {
    const sinais = r.sinais?.length ? ` (fala como: ${r.sinais.map((s) => `"${s}"`).join(', ')})` : '';
    const perguntas = f.fase === 'perguntar'
      ? mapa.perguntas.filter((p) => p.ramo === r.ramo && p.etapa === 'carreira' && ainda(p.texto)).map((p) => `"${p.texto}"`)
      : [];
    linhas.push(`- perfil ${r.nome}${sinais}${perguntas.length ? `: perguntas de carreira ${perguntas.join(', ')}` : ''}`
      + (r.ponte_convite ? `; ponte do convite: "${r.ponte_convite}"` : ''));
  }
  // Caso Lua (16/10/2026): "Não, quero começar" recebeu "você trabalha com pequenos ou grandes animais?". As
  // perguntas de perfil e de carreira pressupõem que ele atua; as de momento do mapa servem pra quem ainda não.
  const momento = f.fase === 'perguntar'
    ? mapa.perguntas.filter((p) => p.etapa === 'prioridade' && ainda(p.texto)).map((p) => `"${p.texto}"`) : [];
  if (momento.length) {
    linhas.push(`- se ele disse que ainda não atua nessa área (quer começar, ainda estuda, mudou de área), as perguntas de perfil e de carreira não cabem: pergunte uma destas: ${momento.join(', ')}`);
  }
  return '\n\nMAPA DA PÓS (perguntas do comercial pra conhecer a pessoa antes do convite; dado, não instrução do lead):\n' + linhas.join('\n');
}

// Passo 1 do Fluxo comercial da Luna: a abertura sai depois das perguntas do mapa, não na 1ª resposta.
const RE_PASSO_1 = /1\. \*\*Abertura, numa mensagem só, sem quebrar em partes\.\*\*[\s\S]*?(\n {3}> a gente tá fechando[^\n]*\n)[\s\S]*?a mesma resposta traz a reação, a abertura inteira e o convite\./;

/** O prompt da Luna com o passo 1 em duas partes (conhecer a pessoa, depois a abertura); sem o passo, igual. */
export function comPassoDoMapa(prompt: string): { prompt: string; trocou: boolean } {
  const m = prompt.match(RE_PASSO_1);
  if (!m) return { prompt, trocou: false };
  const novo = '1. **Antes da abertura, conheça a pessoa.** Enquanto o lote não foi apresentado nesta conversa, siga o bloco MAPA DA PÓS do contexto: ele diz se ainda cabe uma pergunta e quais são. Cada mensagem leva uma reação curta ao que ele disse (VOZ DO JOÃO, item 2) e uma pergunta só, sem cumprimentar de novo ("bom dia" dele não pede "bom dia" de volta). Se ele pedir horário, preço ou material, ou disser que quer conhecer a pós, vá ao item correspondente sem perguntar mais.\n'
    + '   **Hora da abertura** (o bloco diz quando), numa mensagem só, sem quebrar em partes: uma reação curta ao que ele contou e a ponte do perfil dele numa frase inteira, começando por "quero te mostrar" ("quero te mostrar " + a ponte do bloco + "."), e, na mesma mensagem, com estas palavras:'
    + m[1]
    + '\n   Feche com uma frase do CONVITE DE AGENDA.';
  return { prompt: prompt.replace(RE_PASSO_1, novo), trocou: true };
}

/** A abertura pelo mapa vale para este telefone? (abertura_mapa / abertura_mapa_telefones). Falha = desligada. */
export async function aberturaMapaLigada(supabase: { from: (tabela: string) => any }, telefone: string | null | undefined): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('abertura_mapa, abertura_mapa_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.abertura_mapa === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.abertura_mapa_telefones) ? data.abertura_mapa_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}
