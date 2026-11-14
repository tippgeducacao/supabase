// O motivo de uma mensagem "não suportada" — a parte pura (sem Deno, sem banco).
//
// A Cloud API entrega como `type: "unsupported"` tudo o que ela não repassa (enquete,
// ver-uma-vez, alguns formatos de arquivo…): chega o aviso, NÃO chega o conteúdo. Junto
// vem `errors[]` com o código e a explicação da Meta — e até 14/11/2026 a gente gravava
// só `[unsupported]` e jogava isso fora. Resultado: 161 mensagens em 30 dias (73 contatos)
// sem ninguém conseguir dizer ao atendente o que pedir de novo (caso Olavo, 13/11/2026:
// 9 arquivos num envio só, 6 chegaram como documento e 3 como "não suportada").
//
// Guardamos também o objeto CRU: a Meta acrescenta campos a esse payload sem aviso, e o
// que não for gravado na chegada não existe mais depois (o conteúdo é irrecuperável).

export interface MetaErroInbound {
  code: number | null;
  title: string | null;
  message: string | null;
  details: string | null;
}

export interface DetalheNaoSuportada {
  erros: MetaErroInbound[];
  /** `unsupported.type`, quando a Meta diz qual era o tipo original. */
  tipo_informado: string | null;
  /** A mensagem como a Meta mandou; ausente se passar de `TETO_BRUTO` caracteres. */
  bruto?: Record<string, unknown>;
}

/** Teto do objeto cru na metadata — o payload real tem ~400 caracteres. */
export const TETO_BRUTO = 4000;

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * null = mensagem comum (nada a guardar). Devolve o detalhe quando o tipo é
 * `unsupported` OU quando a Meta mandou `errors[]` numa mensagem recebida.
 */
export function detalheNaoSuportada(msg: unknown): DetalheNaoSuportada | null {
  if (!ehObjeto(msg)) return null;
  const lista = Array.isArray(msg.errors) ? msg.errors.filter(ehObjeto) : [];
  if (msg.type !== "unsupported" && lista.length === 0) return null;

  const erros: MetaErroInbound[] = lista.map((e) => {
    const dados = ehObjeto(e.error_data) ? e.error_data : {};
    const code = Number(e.code);
    return {
      code: Number.isFinite(code) ? code : null,
      title: texto(e.title),
      message: texto(e.message),
      details: texto(dados.details),
    };
  });

  const detalhe: DetalheNaoSuportada = {
    erros,
    tipo_informado: ehObjeto(msg.unsupported) ? texto(msg.unsupported.type) : null,
  };
  try {
    if (JSON.stringify(msg).length <= TETO_BRUTO) detalhe.bruto = msg;
  } catch {
    // objeto não serializável: fica sem o cru, o resumo acima já foi extraído
  }
  return detalhe;
}
