// crm-whatsapp-webhook/carimbo.ts
// ----------------------------------------------------------------------------
// Carimbo de tempo de um inbound da Meta: a hora REAL em que o lead escreveu, não a
// hora em que o evento chegou aqui.
//
// A Meta reentrega webhook que falhou (401 por App Secret ausente, edge fora do ar,
// deploy) com backoff crescente — a fila drena HORAS ou DIAS depois. Gravar
// `created_at` = agora nessas reentregas fazia a janela de 24h (contada da hora em
// que o lead escreveu) parecer ABERTA quando a Meta já a considerava fechada: em
// 03/09/2026, 89 telefones da BM 02 nesse estado e 58 envios livres recusados com
// 131047 num só dia. Ver docs/CRM Comercial.md ("A reentrega da Meta mente a hora").
//
// Régua: atraso < REENTREGA_MIN_MS → chegada normal, mantém o carimbo de chegada
// (µs do servidor, ordem estável no chat); atraso ≥ REENTREGA_MIN_MS → reentrega, o
// carimbo é o `timestamp` da Meta (segundos, relógio dos servidores do WhatsApp).
// Sem timestamp confiável (ausente, inválido, no futuro) → chegada.
// Helper PURO (sem Deno) de propósito: roda no vitest do repo.

export const REENTREGA_MIN_MS = 60_000;

export interface CarimboInbound {
  /** ISO a gravar em `created_at`. */
  iso: string;
  /** true quando o carimbo veio do relógio da Meta (mensagem reentregue/atrasada). */
  reentrega: boolean;
  /** Atraso entre a escrita e a chegada, em segundos inteiros (0 sem timestamp). */
  atrasoS: number;
  /** ISO da chegada — vai para `metadata.chegou_em` na reentrega, para auditoria. */
  chegouEm: string;
}

export function carimboInbound(tsMeta: unknown, agoraMs: number): CarimboInbound {
  const chegouEm = new Date(agoraMs).toISOString();
  const seg = Number(tsMeta);
  if (!Number.isFinite(seg) || seg <= 0) {
    return { iso: chegouEm, reentrega: false, atrasoS: 0, chegouEm };
  }
  const atrasoMs = agoraMs - seg * 1000;
  if (atrasoMs < REENTREGA_MIN_MS) {
    return {
      iso: chegouEm,
      reentrega: false,
      atrasoS: Math.max(0, Math.floor(atrasoMs / 1000)),
      chegouEm,
    };
  }
  return {
    iso: new Date(seg * 1000).toISOString(),
    reentrega: true,
    atrasoS: Math.floor(atrasoMs / 1000),
    chegouEm,
  };
}
