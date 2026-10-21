/**
 * Quem pode disparar a sincronização das agendas Google (21/10/2026).
 *
 * Até esta data a função não conferia nada: qualquer um, sem login, disparava a sincronização de
 * TODAS as contas conectadas — cota da API do Google e escrita em lote no banco, à vontade. Passam
 * três chamadores:
 *   - as edges irmãs (`b2b-calendar-sync`, `google-calendar-oauth`), com a chave de serviço do runtime;
 *   - o cron `google-calendar-sync-15min`, com o segredo do cofre no cabeçalho `x-calendar-cron` — o
 *     mesmo do `b2b-calendar-sync`, conferido no banco por `calendar_b2b_validar_cron`. O cron não
 *     manda a chave de serviço porque a que o banco guarda não é a mesma do runtime das edges;
 *   - usuário logado (o "Sincronizar" da tela de integrações), e só agenda por agenda: a rodada
 *     completa, sem `integration_id`, fica para o cron e as edges.
 */
export type Chamador = 'servico' | 'cron' | 'usuario';

export interface DepsPortao {
  chaveServico: string;
  cronValido(segredo: string): Promise<boolean>;
  usuarioValido(jwt: string): Promise<boolean>;
}

export async function quemChama(headers: Headers, deps: DepsPortao): Promise<Chamador | null> {
  const authorization = headers.get('Authorization') ?? '';
  if (deps.chaveServico && authorization === `Bearer ${deps.chaveServico}`) return 'servico';

  const segredo = headers.get('x-calendar-cron');
  if (segredo && (await deps.cronValido(segredo))) return 'cron';

  const jwt = authorization.replace(/^Bearer\s+/i, '').trim();
  if (jwt && (await deps.usuarioValido(jwt))) return 'usuario';

  return null;
}
