/**
 * Regras de FORMATO para a IA que reescreve texto dentro dos editores do Gestor de Tarefas
 * (descrição da tarefa → `gt-ai-improve`; Documentos → `gt-ai-doc`).
 *
 * Até 26/11/2026 a IA recebia o trecho como texto corrido e devolvia texto puro: lista virava
 * parágrafo, @menção sumia, negrito/cor/link caíam, e o ✨ da descrição inteira apagava fotos,
 * anexos e prévias de link. Agora o editor manda o trecho em HTML (o mesmo que ele grava), com as
 * peças que a IA não pode reescrever trocadas por marcadores ⟦n …⟧, e diz quais ferramentas de
 * edição ele tem (`recursos`). A resposta volta em HTML e o editor recoloca as peças no lugar.
 *
 * Módulo puro (sem Deno/rede): o vitest testa o texto montado aqui.
 */

/** Ferramentas que o editor pode declarar. Chave desconhecida é ignorada (nunca entra no prompt). */
export const FERRAMENTAS_DO_EDITOR: Record<string, string> = {
  titulos: 'Títulos: <h1>, <h2>, <h3>.',
  listas: 'Lista com marcadores: <ul><li><p>…</p></li></ul> (subitem = outra <ul> dentro do <li>).',
  numerada: 'Lista numerada: <ol><li><p>…</p></li></ol>.',
  checklist: 'Checklist: <ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>…</p></li></ul> (data-checked="true" = item feito).',
  citacao: 'Citação: <blockquote><p>…</p></blockquote>.',
  codigo: 'Bloco de código: <pre><code>…</code></pre> (só para código ou comando de verdade).',
  divisoria: 'Linha divisória: <hr>.',
  tabela: 'Tabela: <table><tbody><tr><th><p>…</p></th></tr><tr><td><p>…</p></td></tr></tbody></table>.',
  destaque: 'Caixa de destaque: <div data-type="callout" data-emoji="💡"><div class="gt-callout-corpo"><p>…</p></div></div> (emojis: 💡 📌 ⚠️ ❗ ✅ ❌ ℹ️ 🔥 📝 🎯 📣 🚀 🔒 ⏰ 💬 ⭐).',
  recolhivel: 'Lista recolhível: <details data-type="toggle" open><summary>título</summary><div data-toggle-corpo><p>…</p></div></details>.',
  colunas: 'Colunas (de 2 a 5): <div data-type="colunas"><div data-type="coluna"><p>…</p></div><div data-type="coluna"><p>…</p></div></div>.',
  corDeBloco: 'Cor de bloco: data-cor="azul" (cor do texto) ou data-cor="fundo-amarelo" (cor de fundo) em <p>, <h1>–<h3>, <li>, <blockquote>, caixa de destaque e lista recolhível. Cores: cinza, marrom, laranja, amarelo, verde, azul, roxo, rosa, vermelho.',
  alinhamento: 'Alinhamento: style="text-align: center" (ou right, justify) em <p> e títulos.',
  negrito: 'Negrito: <strong>…</strong>.',
  italico: 'Itálico: <em>…</em>.',
  sublinhado: 'Sublinhado: <u>…</u>.',
  riscado: 'Riscado: <s>…</s>.',
  codigoInline: 'Código no meio da frase: <code>…</code>.',
  link: 'Link: <a href="…">…</a> (só endereços que já estavam no texto).',
  marcaTexto: 'Marca-texto: <mark data-color="#fde04766">…</mark>.',
  corDoTexto: 'Cor do texto: <span style="color: #f87171">…</span>.',
};

/** Só as chaves conhecidas, sem repetição, na ordem da tabela acima. */
export function ferramentasValidas(recursos: unknown): string[] {
  const pedidos = new Set(Array.isArray(recursos) ? recursos.filter((r): r is string => typeof r === 'string') : []);
  return Object.keys(FERRAMENTAS_DO_EDITOR).filter((k) => pedidos.has(k));
}

/**
 * Bloco de regras que vai no fim do system prompt quando o editor manda `formato: 'html'`.
 * `recursos` vem do front (derivado do esquema do editor); sem nenhum, vale o básico de texto.
 */
export function regrasDeHtmlDoEditor(recursos: unknown): string {
  const chaves = ferramentasValidas(recursos);
  const lista = (chaves.length ? chaves : ['listas', 'numerada', 'negrito', 'italico', 'link'])
    .map((k) => `- ${FERRAMENTAS_DO_EDITOR[k]}`)
    .join('\n');
  return `FORMATO DA RESPOSTA (obrigatório)
O texto chega em HTML do editor do sistema. Responda SOMENTE com o HTML do resultado, no mesmo formato: sem \`\`\`, sem comentários, sem "Aqui está".
1. Mantenha a estrutura que já existe: lista continua lista, checklist continua checklist (com os mesmos itens marcados), título continua título, tabela mantém as linhas e colunas. Só mude a estrutura quando o pedido for exatamente isso.
2. Mantenha a formatação de cada trecho que continuar no texto (negrito, itálico, cor, marca-texto, link com o mesmo endereço) e copie sem mudar os atributos data-*, style, open e colwidth que vierem.
3. Ferramentas que este editor tem. Use-as quando o pedido pedir (ex.: "transforme em checklist", "destaque o prazo") ou quando for expandir/gerar texto novo; em correção e melhoria de escrita, mantenha a formatação que já existe. Não use nada fora desta lista:
${lista}
4. Marcadores ⟦n …⟧ são peças fixas do documento (menção a pessoa, cartão de tarefa, foto, anexo, prévia de link, vídeo, bloco de código). Copie cada um exatamente como veio, uma única vez, no ponto do texto novo em que ele faz sentido. Nunca apague, traduza, junte nem invente marcador. Se ele estava sozinho num parágrafo, continua sozinho num <p>.
5. Não invente links, fotos, vídeos, anexos nem menções.
6. Devolva o conteúdo COMPLETO. Nunca corte no meio de uma frase.`;
}
