import type { Msg } from './historico.ts';

// 22/09/2026: a matriz sem saldo virava "vou confirmar, tudo bem?" a cada OK.
// A tentativa terminou; nenhuma tarefa futura foi criada. Falta de aprovação
// continua bloqueando agenda, mas não transforma dado já respondido em pergunta.
export const INSTRUCAO_FALHA_COMPATIBILIDADE =
  'A última checagem de compatibilidade TERMINOU COM FALHA. Não está em andamento e não agendou retorno automático. '
  + 'Falha técnica não é falta de formação nem reprovação: preserve os dados que o lead já confirmou. '
  + 'Não diga "vou confirmar", "estou conferindo", "assim que concluir te passo" nem prometa procurar ou avisar depois. '
  + 'Responda ao que o lead perguntou agora. Se perguntou por que coletou a graduação, explique brevemente que é um requisito da pós. '
  + 'Para a consulta que falhou, diga com transparência que não conseguiu concluir a verificação agora, sem citar provedor, saldo ou códigos internos. '
  + 'Não ofereça horários nem trate como aprovado sem uma checagem bem-sucedida. '
  + 'Não repita perguntas acadêmicas respondidas, pitch, convite ou "tudo bem?" para preencher a falha. '
  + 'Esta situação é EXCEÇÃO à regra de terminar com pergunta. Se o lead apenas disser OK, agradeça ou confirme brevemente e encerre a vez. '
  + 'Só tente a ferramenta novamente diante de um novo pedido concreto ou mudança de dados, nunca por um simples aceite da mensagem anterior.';

/** Só pares nativos tool_use/tool_result contam; texto do lead não cria estado. */
export function ultimaCompatibilidadeFalhou(messages: readonly Msg[]): boolean {
  const chamadas = new Set<string>();
  let falhou = false;
  for (const mensagem of messages) {
    if (!Array.isArray(mensagem.content)) continue;
    for (const bloco of mensagem.content) {
      if (mensagem.role === 'assistant' && bloco?.type === 'tool_use'
        && bloco.name === 'verificar_compatibilidade_curso' && typeof bloco.id === 'string') chamadas.add(bloco.id);
      if (mensagem.role !== 'user' || bloco?.type !== 'tool_result' || !chamadas.delete(bloco.tool_use_id)) continue;
      try {
        const retorno = typeof bloco.content === 'string' ? JSON.parse(bloco.content) : null;
        falhou = retorno?.output === 'FALHA_TECNICA';
      } catch { falhou = false; }
    }
  }
  return falhou;
}

/** Um aceite curto depois da falha não exige LLM nem outra tentativa da matriz. */
export function respostaAoAceiteAposFalha(messages: readonly Msg[]): string | null {
  const ultima = messages.at(-1);
  if (ultima?.role !== 'user') return null;
  if (Array.isArray(ultima.content) && ultima.content.some((b) => b?.type !== 'text')) return null;
  const texto = (typeof ultima.content === 'string' ? ultima.content
    : ultima.content.map((b) => b.text ?? '').join(' ')).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[.!?,]/g, '').replace(/\s+/g, ' ').trim();
  if (!/^(?:ok(?: entao)?|okay|certo|ta(?: bom| bem)?|tudo bem|entendi|beleza|combinado|obrigad[oa]|valeu)$/.test(texto)) return null;
  const anterior = messages.at(-2);
  if (anterior?.role !== 'assistant') return null;
  if (Array.isArray(anterior.content) && anterior.content.some((b) => b?.type !== 'text')) return null;
  const fala = typeof anterior.content === 'string' ? anterior.content : anterior.content.map((b) => b.text ?? '').join(' ');
  if (fala.includes('[ATENDIMENTO_HUMANO]')) return null;
  // OK a uma pergunta concreta continua sendo resposta à pergunta, não mero aceite.
  if (fala.replace(/\b(?:tudo bem|pode ser|ok)\?\s*$/i, '').includes('?')) return null;
  if (!ultimaCompatibilidadeFalhou(messages)) return null;
  // Corrige a expectativa criada por respostas antigas já enviadas, sem reescrever memória.
  if (/\b(?:vou|estou|to|tô|ainda estou)\b[^.?!]{0,60}\b(?:confirm|confer|verific)|assim que[^.?!]{0,40}(?:conclu|confirm)/i.test(fala)) {
    return 'não consegui concluir essa verificação agora. desculpa por te deixar esperando.';
  }
  return /^(?:obrigad[oa]|valeu)$/.test(texto) ? 'por nada' : 'certo';
}
