/**
 * Arquivo do cabeçalho escolhido na ação "Template WhatsApp" do funil (28/11/2026).
 *
 * A linha da fila chega com `contexto_campanha.header_media_url`. A fila é gravável por quem
 * usa o CRM, então o que está nela NÃO é prova de que veio do motor: o despachante só repassa o
 * arquivo quando ele é um PDF do acervo PÚBLICO de ementas (bucket `ementas`) — a mesma régua
 * do gatilho `trg_crm_cadencia_email_fila` (função `crm_cadencia_email__arquivo_permitido`).
 * Endereço de fora, de outro bucket ou assinado não passa: o envio segue sem cabeçalho próprio
 * (vale a mídia fixa do modelo) e nunca usa a chave de serviço para abrir arquivo privado.
 */
export const BASE_PUBLICA_PADRAO = "https://api.ppgeducacao.site";
const NOME_DO_PDF = /^[A-Za-z0-9._-]{1,150}\.pdf$/;

export function arquivoDoEnvioPermitido(url: unknown, basesPublicas: Array<string | null | undefined> = [BASE_PUBLICA_PADRAO]): string | null {
  if (typeof url !== "string") return null;
  const endereco = url.trim();
  for (const base of [...basesPublicas, BASE_PUBLICA_PADRAO]) {
    const raiz = String(base ?? "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(raiz)) continue;
    const prefixo = `${raiz}/storage/v1/object/public/ementas/`;
    if (!endereco.startsWith(prefixo)) continue;
    const arquivo = endereco.slice(prefixo.length);
    if (NOME_DO_PDF.test(arquivo) && !arquivo.includes("..")) return endereco;
  }
  return null;
}

/** Nome que o lead vê no cartão do PDF: sem caractere de controle nem barra, até 120 caracteres. */
export function nomeDoArquivoDoEnvio(nome: unknown): string | undefined {
  if (typeof nome !== "string") return undefined;
  const limpo = [...nome].filter((letra) => {
    const codigo = letra.charCodeAt(0);
    return codigo > 31 && codigo !== 127 && letra !== "/" && letra !== "\\";
  }).join("").trim().slice(0, 120);
  return limpo || undefined;
}
