// Quem pode disparar o e-mail do funil do TCC (14/10/2026).
//
// Até aqui a função não conferia nada: com a chave pública do site (que está no bundle)
// e o id de uma tarefa, qualquer um mandava HTML livre pelo remetente do TCC para
// qualquer endereço (corpo_html_override + destinatarios_override). Agora só passam:
//  · o gatilho do banco (fire_funil_email_on_task_status): segredo do Vault no cabeçalho
//    x-funil-email-secret, conferido por funil_email_validar_gatilho. Comparar o Bearer
//    com a SUPABASE_SERVICE_ROLE_KEY do runtime NÃO serve para ele: a chave que o banco
//    manda é outra string (sonda de 14/10 no email-send voltou 401; mesmo caso do
//    pod-gravacao-lembretes, dfc076976). Foi o que segurou a checagem simples;
//  · chamada interna com a chave de serviço do próprio runtime;
//  · colaborador logado com perfil ATIVO (aba Comunicação da tarefa). 76 dos 138 perfis
//    são de ex-colaboradores — sessão viva de quem saiu não manda e-mail.
// O resto volta 401/403 antes de ler tarefa, modelo ou destinatário.

export type Acesso =
  | { tipo: 'gatilho' | 'interno' }
  | { tipo: 'usuario'; usuarioId: string; nome: string | null }

export class ErroAcesso extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem)
  }
}

export interface DepsAcesso {
  chaveServico?: string
  validarGatilho: (segredo: string) => Promise<boolean>
  /** id do usuário dono do token, ou null se o token não é de um usuário válido. */
  usuarioDoToken: (token: string) => Promise<string | null>
  perfil: (id: string) => Promise<{ ativo: boolean | null; name: string | null } | null>
}

export async function autorizarDispatch(req: Request, deps: DepsAcesso): Promise<Acesso> {
  const segredo = req.headers.get('x-funil-email-secret')
  if (segredo) {
    if (await deps.validarGatilho(segredo)) return { tipo: 'gatilho' }
    throw new ErroAcesso(401, 'Credencial do gatilho inválida.')
  }

  const token = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) throw new ErroAcesso(401, 'Entre no sistema para enviar e-mails.')
  if (deps.chaveServico && token === deps.chaveServico) return { tipo: 'interno' }

  const usuarioId = await deps.usuarioDoToken(token)
  if (!usuarioId) throw new ErroAcesso(401, 'Sessão inválida. Entre novamente para enviar e-mails.')
  const perfil = await deps.perfil(usuarioId)
  if (perfil?.ativo !== true) throw new ErroAcesso(403, 'Seu usuário não está ativo para enviar e-mails.')
  return { tipo: 'usuario', usuarioId, nome: perfil.name }
}
