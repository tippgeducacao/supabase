// ============================================================================
// respostaModelo — a régua que decide o que, da saída do modelo, pode virar
// mensagem para uma pessoa de verdade.
// ----------------------------------------------------------------------------
// Um agente de conversa tem DOIS canais: o texto, que vai para o WhatsApp da
// pessoa, e as chamadas de ferramenta, que são estrutura e nunca deveriam ser
// lidas por ninguém. O modelo erra o canal de vez em quando, e as duas vezes em
// que isso aconteceu aqui chegaram ao candidato:
//
//   • raciocínio embrulhado em <thinking> dentro do bloco de texto (agente do
//     João, e por isso a régua existe);
//   • 14/09/2026 — a chamada inteira escrita como texto:
//       <invoke name="salvar_dados_candidato">
//       <parameter name="cidade">Ampére/PR</parameter>
//       </invoke>
//     entregue no WhatsApp da candidata, 144 caracteres de XML no lugar da
//     pergunta que ela deveria ter recebido.
//
// Instrução no prompt não resolve sempre — "quase sempre" não serve para o que
// sai de casa. Isto aqui é determinístico e fica no funil por onde todo balão
// passa, na SAÍDA (antes de enviar) e na ENTRADA (o histórico é remontado das
// mensagens já enviadas: um vazamento gravado uma vez volta como exemplo do
// próprio jeito de responder, e o modelo aprende a repetir).
// ============================================================================

const TAGS = '(?:antml:)?(?:thinking|thought|thoughts|scratchpad|reasoning|reflection)';

export type ToolVazada = { name: string; input: Record<string, string> };

/**
 * Separa, do texto, as chamadas de ferramenta que o modelo escreveu no canal
 * errado. Devolve o texto sem elas e o que dava para remontar.
 *
 * Apagar não basta: quando a resposta INTEIRA é a chamada, apagar deixa a
 * pessoa no vácuo. Quem chama usa `chamadas` para executar o que o modelo
 * queria e devolver o laço a ele, que aí escreve a mensagem de verdade.
 */
export function extrairToolsVazadas(texto: string): { limpo: string; chamadas: ToolVazada[] } {
  const chamadas: ToolVazada[] = [];
  // Regex local, não de módulo: `lastIndex` de regex global é ESTADO, e estado
  // compartilhado aqui significaria pular uma chamada na mensagem seguinte.
  const reInvoke =
    /<(?:antml:)?invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:antml:)?invoke>/gi;

  let limpo = (texto ?? '').replace(reInvoke, (_todo: string, nome: string, corpo: string) => {
    const reParam =
      /<(?:antml:)?parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:antml:)?parameter>/gi;
    const input: Record<string, string> = {};
    for (const p of String(corpo).matchAll(reParam)) input[p[1]] = String(p[2]).trim();
    chamadas.push({ name: String(nome).trim(), input });
    return '';
  });

  // Sobras: o embrulho <function_calls>, um <invoke> que o modelo não fechou,
  // um <parameter> solto. Não dá para remontar a chamada, mas nada disso chega
  // ao destinatário.
  limpo = limpo
    .replace(/<\/?(?:antml:)?function_calls[^>]*>/gi, '')
    .replace(/<\/?(?:antml:)?invoke[^>]*>/gi, '')
    .replace(/<\/?(?:antml:)?parameter[^>]*>/gi, '');

  return { limpo: limpo.trim(), chamadas };
}

/**
 * Tudo que não é mensagem sai daqui: raciocínio simulado e chamada de
 * ferramenta escrita no texto. Rede de segurança final — o que o laço do agente
 * não conseguiu recuperar morre aqui em vez de virar mensagem.
 *
 * O que ela NÃO faz: mexer no que o modelo escreveu de verdade. Sinal de menor,
 * emoji, quebra de linha e acento passam intactos.
 */
export function limparResposta(texto: string): string {
  let t = texto ?? '';
  t = t.replace(new RegExp(`<${TAGS}[^>]*>[\\s\\S]*?</${TAGS}>`, 'gi'), '');
  // 14/09/2026 (agente de RH): só tirar a tag órfã deixava o raciocínio inteiro à vista.
  // Abertura sem fechamento descarta dali em diante; fechamento sem abertura, do começo até ele.
  t = t.replace(new RegExp(`<${TAGS}[^>]*>[\\s\\S]*$`, 'i'), '');
  t = t.replace(new RegExp(`^[\\s\\S]*?</${TAGS}[^>]*>`, 'i'), '');
  t = t.replace(new RegExp(`</?${TAGS}[^>]*>`, 'gi'), '');
  t = extrairToolsVazadas(t).limpo;
  return t.trim();
}
