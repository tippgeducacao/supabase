/**
 * Assinatura Svix usada pelo Resend. O corpo precisa chegar intacto ao HMAC:
 * parsear e serializar JSON antes da verificação mudaria os bytes assinados.
 *
 * WebCrypto mantém a mesma implementação no Deno da VPS e nos testes Node, sem
 * dependência remota no caminho de recebimento dos eventos de supressão.
 * Protocolo: https://docs.svix.com/receiving/verifying-payloads/how-manual
 */
const TOLERANCIA_SEGUNDOS = 300;

function decodificarBase64(valor: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(valor), (c) => c.charCodeAt(0));
}

export async function assinaturaResendValida(
  corpo: string,
  headers: Headers,
  segredo: string,
  agoraMs = Date.now(),
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const assinaturas = headers.get("svix-signature");
  if (!id || id.length > 255 || !timestamp || !/^\d+$/.test(timestamp) || !assinaturas) return false;
  const segundos = Number(timestamp);
  if (!Number.isSafeInteger(segundos) || Math.abs(agoraMs / 1000 - segundos) > TOLERANCIA_SEGUNDOS) return false;
  if (!segredo.startsWith("whsec_") || assinaturas.length > 4096) return false;

  try {
    const chave = await crypto.subtle.importKey(
      "raw", decodificarBase64(segredo.slice(6)),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const conteudo = new TextEncoder().encode(`${id}.${timestamp}.${corpo}`);
    // Na rotação de chaves podem chegar várias assinaturas. A comparação dos bytes
    // fica no WebCrypto, evitando uma comparação de strings dependente do prefixo.
    for (const parte of assinaturas.split(/\s+/)) {
      const [versao, valor] = parte.split(",");
      if (versao !== "v1" || !valor) continue;
      try {
        if (await crypto.subtle.verify("HMAC", chave, decodificarBase64(valor), conteudo)) return true;
      } catch {
        // Uma assinatura malformada não invalida a outra chave durante rotação.
      }
    }
  } catch {
    return false;
  }
  return false;
}
