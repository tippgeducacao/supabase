// Retribuir o cumprimento do lead — garantia em código, só no canário (26/09/2026).
//
// Pedido do Gustavo: "garanta que a Luna sempre responda a uma saudação". No duelo de 25/09 a lead
// escreveu "Bom dia hoje pela manhã as 09" e a Luna respondeu só "vc já é formado em Medicina
// Veterinária?". A regra 0 da voz (vozDoJoao.ts) pede para responder ao cumprimento, mas o modelo
// nem sempre segue. Duas camadas: o alerta no bloco da ficha (o modelo retribui com as palavras dele)
// e, se ainda assim a fala sair sem cumprimento, o código põe o cumprimento na frente antes do envio.

export type SaudacaoDoLead = {
  /** Cumprimento a devolver, no mesmo período que o lead usou. */
  cumprimento: 'bom dia' | 'boa tarde' | 'boa noite' | 'oi' | null;
  /** O lead perguntou como o João está ("tudo bem?", "como vai?"). */
  perguntouComoEsta: boolean;
};

const normalizar = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Lê o cumprimento só no começo da fala (primeiros 80 caracteres), sem a citação do WhatsApp. */
export function saudacaoDoLead(fala: string | null | undefined): SaudacaoDoLead {
  const t = normalizar(String(fala ?? '').replace(/^\[Em resposta à mensagem: "[\s\S]*?"\]\s*/, '')).trim().slice(0, 80);
  // Letra repetida é comum ("bom diaa", "boa tardee"): conta como o mesmo cumprimento.
  const periodo = t.match(/\b(?:bom\s*dia+|boa\s*tarde+|boa\s*noite+)\b/)?.[0];
  const oi = /^(?:oi+|ola+|opa|e ai)\b/.test(t);
  const perguntouComoEsta = /\b(?:tudo bem|tudo bom|tudo certo|tudo joia|como vai|como (?:vc|voce) (?:esta|ta))\b\s*\?/.test(t)
    || /\b(?:tudo bem|tudo bom)\s*$/.test(t);
  return {
    cumprimento: periodo
      ? (periodo.includes('dia') ? 'bom dia' : periodo.includes('tard') ? 'boa tarde' : 'boa noite')
      : oi ? 'oi' : null,
    perguntouComoEsta,
  };
}

/** Linha para o bloco da ficha: o modelo retribui com as palavras dele. */
export function alertaSaudacao(fala: string | null | undefined): string | null {
  const s = saudacaoDoLead(fala);
  if (!s.cumprimento && !s.perguntouComoEsta) return null;
  const partes = [
    s.cumprimento ? `cumprimentou ("${s.cumprimento}")` : null,
    s.perguntouComoEsta ? 'perguntou como você está' : null,
  ].filter(Boolean).join(' e ');
  return `[CUMPRIMENTO] O lead ${partes}. Comece a resposta retribuindo, em poucas palavras`
    + `${s.cumprimento ? ` ("${s.cumprimento}")` : ''}${s.perguntouComoEsta ? ' e dizendo que está tudo bem' : ''}, e só depois siga.`;
}

/**
 * Garante que a fala retribua o cumprimento. Só mexe no COMEÇO: se os primeiros 80 caracteres já
 * cumprimentam (qualquer cumprimento) e já respondem ao "tudo bem?", devolve o texto intacto.
 */
export function garantirSaudacao(texto: string, fala: string | null | undefined): { texto: string; acrescentou: string | null } {
  const s = saudacaoDoLead(fala);
  if (!texto.trim() || (!s.cumprimento && !s.perguntouComoEsta)) return { texto, acrescentou: null };
  const inicio = normalizar(texto).trimStart().slice(0, 80);
  const jaCumprimentou = /\b(?:bom dia|boa tarde|boa noite|oi+|ola|opa)\b/.test(inicio);
  const jaRespondeu = /\btudo (?:bem|bom|certo|otimo|tranquilo|joia)\b|\b(?:to|tô|estou) bem\b/.test(inicio);
  const partes = [
    s.cumprimento && !jaCumprimentou ? s.cumprimento : null,
    s.perguntouComoEsta && !jaRespondeu ? 'tudo bem sim' : null,
  ].filter(Boolean);
  if (!partes.length) return { texto, acrescentou: null };
  const prefixo = partes.join(', ');
  return { texto: `${prefixo}. ${texto.trimStart()}`, acrescentou: prefixo };
}
