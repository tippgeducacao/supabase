/**
 * Links de abertura/descadastro podem usar o domínio de envio sem trocar a URL
 * do Supabase usada por Auth, Storage e consultas internas. O domínio dedicado
 * precisa encaminhar as rotas públicas de e-mail antes de ativar a variável.
 */
export function urlPublicaEmail(lerEnv: (chave: string) => string | undefined): string {
  for (const chave of ["EMAIL_PUBLIC_URL", "SUPABASE_PUBLIC_URL", "PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) {
    const valor = lerEnv(chave)?.trim();
    if (valor) return valor.replace(/\/+$/, "");
  }
  throw new Error("URL pública de e-mail não configurada.");
}
