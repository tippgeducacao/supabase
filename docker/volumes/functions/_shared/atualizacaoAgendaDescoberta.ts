/**
 * A descoberta renova metadados, mas não escolhe quais agendas sincronizar.
 * Em 12/09/2026, o default das sub-agendas apagava a seleção a cada sync/OAuth.
 * Defaults de seleção pertencem somente à inserção de uma integração nova.
 */
export function atualizacaoAgendaDescoberta(
  dados: Record<string, unknown>,
  preservarCredenciaisGmail = false,
): Record<string, unknown> {
  const atualizacao = { ...dados };
  delete atualizacao.selected;

  if (preservarCredenciaisGmail) {
    delete atualizacao.oauth_access_token;
    delete atualizacao.oauth_refresh_token;
    delete atualizacao.oauth_token_expires_at;
    // Os escopos descrevem o token preservado, não o grant recém-descoberto.
    delete atualizacao.scopes;
  }

  return atualizacao;
}
