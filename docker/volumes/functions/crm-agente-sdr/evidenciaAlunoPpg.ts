import type { Msg } from './historico.ts';
import { textoDoLead } from './evidenciaFormacao.ts';

// 13/11/2026, Denise: "já faço uma pós" (de julho) virou aluna da PPG em
// novembro. A correção "é em outra instituição" nem estava no pedido capturado.
// A ausência dessa correção NÃO pode servir como prova de vínculo com a PPG.
export const INSTRUCAO_ALUNO_PPG = `## Vínculo com a PPG e intenção atual
A saída por "já é aluno" vale SOMENTE para aluno da PPG: cadastro confirmado pelo sistema ou declaração própria e explícita de vínculo com a PPG ("faço a pós com vocês", "sou aluna da PPG"). "Já faço uma pós", "já sou aluno" ou "estou no sétimo mês", sem identificar a instituição, NÃO comprovam esse vínculo. Não transfira para suporte com base nisso. Fazer pós em outra instituição não impede conhecer/comprar uma pós ou MBA da PPG. Correção do lead ("é em outra instituição", "não sou aluno de vocês") prevalece sobre a sua inferência e sobre pausas antigas. Só esclareça a instituição se isso for necessário ao pedido atual; uma dúvida sobre o MBA deve seguir pelo catálogo/material e pelas pendências reais, sem encaminhamento humano inventado.
Um pedido antigo de "não me notifique" não é uma nova recusa em toda rodada. Se agora o próprio lead pergunta como funciona o MBA, pede conteúdos ou responde ao convite atual com interesse, responda a essa solicitação pontual. Não diga "vou respeitar seu pedido de não receber notificações", não se despeça e não pause por uma recusa antiga como se tivesse acabado de recebê-la. Isso NÃO remove opt-out, não autoriza campanhas futuras nem ignora um pedido atual para parar. Saudação isolada, silêncio e disparo enviado pela empresa não são novo interesse. Pedido atual de humano, ligação ou para parar continua prioritário.`;

const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Só falas próprias; blocos internos e tool_result nunca comprovam matrícula. */
export function falasPropriasDoLead(historico: readonly Msg[] = []): string[] {
  return historico.flatMap(m => {
    if (m.role !== 'user') return [];
    const partes = typeof m.content === 'string' ? [m.content] : m.content
      .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string);
    return partes.filter(t => !/^\s*(?:\[(?:CONTEXTO|FICHA|DADO|ESTADO|PERGUNTAS|CORRECAO|INTERNAL_|ATENDIMENTO_HUMANO)|STATUS ATUAL)/i.test(t))
      .flatMap(t => { const texto = textoDoLead({ role: 'user', content: t }); return texto ? [normalizar(texto)] : []; });
  });
}

export function temEvidenciaAlunoPpg(historico?: readonly Msg[]): boolean {
  let confirmado = false;
  for (const fala of falasPropriasDoLead(historico)) {
    if (/\b(?:outra instituicao|outra faculdade|outra escola|nao sou alun[oa] (?:de voces|de vcs|da ppg|da ppgvet))\b/.test(fala)) {
      confirmado = false;
      continue;
    }
    for (const frase of fala.split(/[.!;\n,]|\bmas\b/)) {
      if (frase.includes('?') || /\b(?:nao|nunca|talvez|se eu|pretendo|quero ser)\b/.test(frase)) continue;
      // Início de declaração própria: "curso" como substantivo em "gostei do
      // curso da PPG" e falas sobre terceiros não viram matrícula da pessoa.
      if (/^(?:(?:eu|ja|tambem|atualmente|agora|bom dia|boa tarde|ola|oi)\s+)*(?:sou alun[oa]|estou matriculad[oa]|to matriculad[oa]|me matriculei|faco|curso|estou (?:cursando|fazendo)|to (?:cursando|fazendo))\b[^.!;?]*\b(?:ppg(?:vet)?|com voces|com vcs|de voces|de vcs)\b/.test(frase.trim())) confirmado = true;
    }
  }
  return confirmado;
}

export function bloquearPausaSemVinculoPpg(input: Record<string, unknown>, historico?: readonly Msg[], id = '') {
  const atual = falasPropriasDoLead(historico).at(-1) ?? '';
  if (/\b(?:(?:quero|preciso|prefiro) (?:falar|conversar) com (?:um |uma |o |a )?(?:humano|humana|atendente|pessoa)|me ligue|pode me ligar)\b/.test(atual)) return null;
  if (input.tipo === 'nao_perturbe' && /\b(?:como funciona|quais (?:os )?conteudos|quais (?:as )?disciplinas|quero (?:conhecer|saber|informacoes)|me (?:mande|envie) (?:o )?cronograma)\b/.test(atual)
    && !/\b(?:nao me notifique|nao quero|pare|parar|sair da lista|nao (?:me )?(?:mande|envie))\b/.test(atual)) {
    return { id, status: 'bloqueado', codigo: 'RECUSA_ANTIGA_COM_PEDIDO_ATUAL',
      resultado: 'Pausa por desinteresse NÃO executada: o lead agora pede informações. Responda ao pedido atual sobre o curso; não trate uma recusa antiga como nova. Preserve bloqueios de campanhas e não afirme que ele pediu para parar nesta rodada.' };
  }
  const motivo = normalizar(String(input.motivo ?? ''));
  // O motivo identifica qual guarda aplicar, mas nunca comprova o vínculo.
  const porAluno = /\b(?:alun[oa]|matriculad[oa]|matricula paga|pagou a matricula)\b/.test(motivo)
    || /\b(?:cursa|cursando|fazendo|faz|faco|estuda)\b.*\b(?:pos|mba)\b/.test(motivo);
  if (input.tipo !== 'pausa' || !porAluno || temEvidenciaAlunoPpg(historico)) return null;
  return { id, status: 'bloqueado', codigo: 'SEM_EVIDENCIA_ALUNO_PPG',
    resultado: 'Pausa NÃO executada: não há declaração própria e explícita de que o lead é aluno DA PPG. Fazer pós em instituição não identificada ou em outra instituição não autoriza encaminhar ao nosso suporte. O motivo escrito por você e pausas antigas não comprovam vínculo. Continue o pedido atual sobre o MBA usando catálogo/material e pendências reais, sem anunciar transferência. Não altere o tipo/motivo para contornar a recusa. Pedido atual explícito de humano ou ligação deve ser tratado por seu motivo real.' };
}
