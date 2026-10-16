// Quem disparou o motor DE VERDADE (16/10/2026).
//
// O runtime self-hosted não aplica verify_jwt e o corpo da chamada é livre: qualquer um
// manda o user_id que quiser. O motor segue aceitando chamada sem credencial (os
// chamadores são a tela, o widget de Mac e o próprio motor), mas o que ele ESCREVE EM
// NOME DE ALGUÉM — a mensagem do "Adicionar comentário" no chat da tarefa — sai do token,
// nunca do corpo:
//  · chamada interna (o próprio motor re-disparando com a chave de serviço do runtime) →
//    o user_id que ele repassou, já conferido na chamada de origem;
//  · colaborador logado com perfil ATIVO (tela, widget) → o id do token. Sessão viva de
//    ex-colaborador não assina mensagem (mesma régua do funil-email-dispatch/acesso.ts);
//  · o resto (sem token, chave pública do site, sessão inválida, perfil inativo) → ninguém.

export type Ator =
  | { tipo: 'interno'; usuarioId: string | null }
  | { tipo: 'usuario'; usuarioId: string }
  | { tipo: 'ninguem' }

export interface DepsAtor {
  chaveServico?: string
  /** id do usuário dono do token, ou null se o token não é de um usuário válido. */
  usuarioDoToken: (token: string) => Promise<string | null>
  perfilAtivo: (id: string) => Promise<boolean>
}

export async function resolverAtor(req: Request, corpoUserId: unknown, deps: DepsAtor): Promise<Ator> {
  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) return { tipo: 'ninguem' }
  if (deps.chaveServico && token === deps.chaveServico) {
    return { tipo: 'interno', usuarioId: typeof corpoUserId === 'string' && corpoUserId ? corpoUserId : null }
  }
  try {
    const usuarioId = await deps.usuarioDoToken(token)
    if (!usuarioId) return { tipo: 'ninguem' }
    return (await deps.perfilAtivo(usuarioId)) ? { tipo: 'usuario', usuarioId } : { tipo: 'ninguem' }
  } catch {
    // Auth fora do ar não vira autor: na dúvida, ninguém.
    return { tipo: 'ninguem' }
  }
}

/** O id que pode assinar (e ser repassado no encadeamento), ou null. */
export const autorDoAtor = (a: Ator): string | null => (a.tipo === 'ninguem' ? null : a.usuarioId)
