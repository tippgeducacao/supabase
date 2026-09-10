import type { Msg } from './historico.ts';

// 10/09/2026: nos ensaios o modelo prometeu "já te confirmo" mesmo com o
// retorno explícito de falha. Uma consulta que falhou não agenda trabalho futuro.
// Esta resposta é operacional e fixa; só se aplica ao retorno real da ferramenta,
// nunca a texto do lead, resultado antigo ou erro de outro tipo de operação.
export function respostaParaFalhaCatalogo(messages: Msg[]): string | null {
  const ultima = messages.at(-1);
  const anterior = messages.at(-2);
  if (ultima?.role !== 'user' || anterior?.role !== 'assistant'
    || !Array.isArray(ultima.content) || !Array.isArray(anterior.content)) return null;
  // Não ocultar o resultado de outra ação na mesma rodada (ex.: material enviado).
  if (ultima.content.filter(b => b.type === 'tool_result').length !== 1) return null;
  const consultas = new Set(anterior.content.filter(b => b.type === 'tool_use'
    && ['consulta_pos_disponiveis', 'consulta_objecoes'].includes(b.name)).map(b => b.id));
  for (const bloco of ultima.content) {
    if (bloco.type !== 'tool_result' || !consultas.has(bloco.tool_use_id) || typeof bloco.content !== 'string') continue;
    try {
      const resultado = JSON.parse(bloco.content);
      if (resultado.status === 'catalogo_indisponivel' && resultado.consulta_realizada_com_sucesso === false) {
        return 'Não consegui confirmar essas informações agora. Prefiro verificar antes de te passar algo incorreto.';
      }
    } catch { /* Retorno de outro formato segue o fluxo normal. */ }
  }
  return null;
}
