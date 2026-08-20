/**
 * Cifra da senha das caixas IMAP.
 *
 * Por que cifra própria, e não o Vault do Supabase: a root key do `pgsodium` não veio
 * na migração para o self-hosted (ver `20260525220000_fix_webhook_matricula_vault_decrypt_failure`)
 * — os helpers de vault devolvem NULL de propósito. Vault, aqui, é um cofre sem chave.
 *
 * Formato: `v1:<iv-base64>:<ciphertext-base64>`. O prefixo de versão é o que permite
 * rotacionar a `IMAP_ENC_KEY` depois sem invalidar o que já está gravado.
 *
 * A chave é SEMPRE injetada (nunca lida de env no meio do módulo) — mesma lição do
 * `emailProviders/ses.ts`: dependência de plataforma no topo do módulo mata o teste.
 */

const VERSAO = "v1";
const TAMANHO_CHAVE = 32; // AES-256
const TAMANHO_IV = 12; // recomendado para GCM

export class ErroCripto extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroCripto";
  }
}

function paraBase64(bytes: Uint8Array): string {
  let bruto = "";
  for (const b of bytes) bruto += String.fromCharCode(b);
  return btoa(bruto);
}

function deBase64(texto: string): Uint8Array {
  const bin = atob(texto);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Importa a chave mestra. Recebe base64 de 32 bytes. */
export async function importarChave(chaveBase64: string): Promise<CryptoKey> {
  let bruta: Uint8Array;
  try {
    bruta = deBase64(chaveBase64.trim());
  } catch {
    throw new ErroCripto("IMAP_ENC_KEY não é base64 válido.");
  }
  if (bruta.length !== TAMANHO_CHAVE) {
    throw new ErroCripto(
      `IMAP_ENC_KEY precisa ter ${TAMANHO_CHAVE} bytes depois do base64 (tem ${bruta.length}).`,
    );
  }
  return await crypto.subtle.importKey("raw", bruta, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Lê a chave do ambiente da edge. Fica isolada aqui para o resto do módulo
 * continuar puro (e testável no vitest, onde `Deno` não existe).
 */
export function lerChaveDoAmbiente(): string {
  const env = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno?.env;
  const valor = env?.get?.("IMAP_ENC_KEY");
  if (!valor) {
    throw new ErroCripto(
      "IMAP_ENC_KEY ausente no ambiente das edge functions — sem ela nenhuma caixa IMAP conecta.",
    );
  }
  return valor;
}

/** Atalho: importa a chave do ambiente. */
export async function chaveDoAmbiente(): Promise<CryptoKey> {
  return await importarChave(lerChaveDoAmbiente());
}

export async function cifrar(texto: string, chave: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(TAMANHO_IV));
  const cifrado = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    chave,
    new TextEncoder().encode(texto),
  );
  return `${VERSAO}:${paraBase64(iv)}:${paraBase64(new Uint8Array(cifrado))}`;
}

export async function decifrar(blob: string, chave: CryptoKey): Promise<string> {
  const partes = blob.split(":");
  if (partes.length !== 3) {
    throw new ErroCripto("Formato de senha cifrada inválido (esperado v1:iv:ct).");
  }
  const [versao, ivBase64, textoBase64] = partes;
  if (versao !== VERSAO) {
    throw new ErroCripto(`Versão de cifra desconhecida: "${versao}".`);
  }
  let aberto: ArrayBuffer;
  try {
    aberto = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: deBase64(ivBase64) },
      chave,
      deBase64(textoBase64),
    );
  } catch {
    // GCM falha na autenticação quando a chave está errada — não dá para
    // distinguir "chave trocada" de "dado corrompido", e o efeito é o mesmo.
    throw new ErroCripto(
      "Não foi possível decifrar a senha da caixa. A IMAP_ENC_KEY mudou desde o cadastro?",
    );
  }
  return new TextDecoder().decode(aberto);
}
