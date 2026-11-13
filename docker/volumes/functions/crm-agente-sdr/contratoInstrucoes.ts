// Auditoria estrutural, não interpretação de linguagem natural. A revisão de decisões
// continua sendo humana e por ensaios: ausência de aviso não prova ausência de ambiguidades.
export function conferirContratoInstrucoes(textos: readonly string[], ferramentas: readonly { name: string }[], nomesConhecidos: readonly string[]) {
  const texto = textos.join('\n\n');
  const oferecidas = new Set(ferramentas.map(t => t.name));
  const ferramentasDuplicadas = [...oferecidas].filter(n => ferramentas.filter(t => t.name === n).length > 1);
  const referenciasAusentes = [...new Set(nomesConhecidos)].filter(n => new RegExp(`\\b${n}\\b`).test(texto) && !oferecidas.has(n));
  const contagem = new Map<string, number>();
  for (const p of texto.split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p.length >= 120)) {
    contagem.set(p, (contagem.get(p) ?? 0) + 1);
  }
  const paragrafosDuplicados = [...contagem].filter(([, n]) => n > 1).map(([texto, ocorrencias]) => ({ texto, ocorrencias }));
  return { referenciasAusentes, ferramentasDuplicadas, paragrafosDuplicados };
}
