// Erro de TOKEN da agenda: o que só se resolve reconectando a conta no Google.
//
// 20/10/2026: quando o Google devolvia `invalid_grant`, o `google-calendar-sync` só punha o erro
// na resposta do cron — `calendar_integrations.calendar_token_error` (criada em 26/05 para isso)
// seguia NULL e ninguém era levado a reconectar. A agenda global "Aberturas e Módulos Práticos"
// ficou congelada desde 16/10 assim, junto com duas pessoais sem sync desde 22/05.
//
// Vocabulário IGUAL ao das caixas de e-mail (`email_caixas_conectadas.last_sync_error`, que o
// banner "Reconectar Gmail" do Inbox já lê, e `_shared/gmail.ts`):
//   • `token_revoked`      — o Google derrubou o grant (`invalid_grant`) ou não há refresh token;
//   • `scope_insuficiente` — o token renova, mas não tem escopo de Calendar (403
//                            ACCESS_TOKEN_SCOPE_INSUFFICIENT na leitura dos eventos).
// Falha TRANSITÓRIA (rede, 5xx, 429) não é erro de token: devolve null e o valor gravado fica
// como está — senão um soluço do Google mandaria todo mundo reconectar à toa.
// ⚠️ `invalid_client`/`unauthorized_client` ficam de fora de propósito: são da credencial do
// NOSSO app (GOOGLE_CALENDAR_CLIENT_*), valem para todas as contas e reconectar não resolve.

export type ErroDeTokenAgenda = 'token_revoked' | 'scope_insuficiente';

const ESCOPO_INSUFICIENTE = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i;

/** Classifica o erro que `syncIntegration` lançou. null = não é problema de token. */
export function erroDeTokenDaAgenda(erro: unknown): ErroDeTokenAgenda | null {
  const msg = erro instanceof Error ? erro.message : String(erro ?? '');
  if (msg === 'no_refresh_token') return 'token_revoked';
  if (msg.startsWith('refresh_failed:') && msg.includes('"invalid_grant"')) return 'token_revoked';
  if (msg.startsWith('events_fetch_failed:') && ESCOPO_INSUFICIENTE.test(msg)) return 'scope_insuficiente';
  return null;
}
