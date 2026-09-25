// Trava de consulta repetida na MESMA rodada — só no canário (ficha ligada).
//
// Duelo cego Luna × Sonnet 5 (25/09/2026): a Luna pediu a agenda de amanhã, recebeu horários de
// outro dia e repetiu a MESMA consulta, com os mesmos dados, até esgotar as voltas — e o lead ficou
// sem resposta (o limite de voltas só gera log). O Sonnet repetiu consulta em 9 dos 40 casos. Uma
// consulta sem efeito colateral devolve o mesmo resultado se os dados são os mesmos; a segunda
// chamada não executa: volta a ordem de responder com o que já tem.
//
// Só consultas. Qualquer outra tool (grava, envia, agenda) zera a memória: depois de um
// confirmar_agendamento recusado, reconsultar a agenda com os mesmos dados é legítimo.

const CONSULTAS = new Set([
  'consulta_disponibilidade', 'consulta_pos_disponiveis', 'consulta_objecoes', 'verificar_compatibilidade_curso',
]);

export const AVISO_CONSULTA_REPETIDA = 'Você já fez esta MESMA consulta, com os mesmos dados, nesta resposta: o resultado '
  + 'não muda e está logo acima. Não chame de novo. Responda ao lead agora com o que você tem; se o resultado não atende '
  + 'o que ele pediu, diga isso em poucas palavras e ofereça a alternativa que o resultado traz.';

function ordenado(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ordenado);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
      .map((k) => [k, ordenado((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export class MemoriaDeConsultas {
  private vistas = new Set<string>();

  /** true = esta chamada repete uma consulta idêntica desta rodada (não execute). */
  repetida(nome: string, input: unknown): boolean {
    if (!CONSULTAS.has(nome)) {
      this.vistas.clear();
      return false;
    }
    const assinatura = `${nome}:${JSON.stringify(ordenado(input ?? {}))}`;
    if (this.vistas.has(assinatura)) return true;
    this.vistas.add(assinatura);
    return false;
  }
}
