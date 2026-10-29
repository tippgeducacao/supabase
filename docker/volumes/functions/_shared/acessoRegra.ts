// Regra PURA da conferência de acesso das edges (sem rede, testável no vitest).
// A porta de entrada que as edges importam é ./acesso.ts — ver o porquê lá.

export type Chamador =
  | { tipo: "servico" }
  | { tipo: "segredo" }
  | { tipo: "usuario"; usuarioId: string; token: string };

export interface OpcoesAcesso {
  /** Aceita a chave de serviço exata (cron, outra edge). */
  servico?: boolean;
  /** Aceita colaborador logado. */
  usuario?: boolean;
  /** RPC sem argumentos, chamada COM O TOKEN DO USUÁRIO, que precisa devolver true (ex.: "is_financial_user"). */
  rpcPermissao?: string;
  /** Segredo próprio num cabeçalho (comparação em tempo constante). Valor vazio = desligado. */
  segredo?: { cabecalho: string; valor: string | null | undefined };
}

export class AcessoNegado extends Error {
  constructor(public status: 401 | 403 | 503, mensagem: string) {
    super(mensagem);
  }
}

export interface DependenciasAcesso {
  chaveServico: string;
  chaveAnon: string;
  /** Usuário dono do token, ou null se o token não é de sessão válida. Lança se não deu para conferir. */
  usuarioDoToken: (token: string) => Promise<{ id: string; anonimo: boolean } | null>;
  /** Resultado da RPC chamada como o usuário: true/false, ou null se falhou. */
  rpcComoUsuario: (token: string, rpc: string) => Promise<boolean | null>;
}

/** Comparação que não vaza, pelo tempo de resposta, quanto do valor estava certo. */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let dif = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) dif |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return dif === 0;
}

export function tokenDoCabecalho(authorization: string | null): string | null {
  const m = (authorization ?? "").match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Decide quem está chamando. Devolve o chamador ou lança AcessoNegado:
 * 401 sem credencial válida, 403 logado sem permissão, 503 quando não deu para conferir.
 */
export async function decidirAcesso(
  cabecalhos: { authorization: string | null; get: (nome: string) => string | null },
  opcoes: OpcoesAcesso,
  deps: DependenciasAcesso,
): Promise<Chamador> {
  if (opcoes.segredo?.valor) {
    const recebido = cabecalhos.get(opcoes.segredo.cabecalho) ?? "";
    if (iguaisEmTempoConstante(recebido, opcoes.segredo.valor)) return { tipo: "segredo" };
  }

  const token = tokenDoCabecalho(cabecalhos.authorization);
  if (!token) throw new AcessoNegado(401, "Credencial ausente.");

  if (opcoes.servico && deps.chaveServico && iguaisEmTempoConstante(token, deps.chaveServico)) {
    return { tipo: "servico" };
  }
  if (!opcoes.usuario) throw new AcessoNegado(401, "Acesso restrito ao sistema.");
  if (deps.chaveAnon && iguaisEmTempoConstante(token, deps.chaveAnon)) {
    throw new AcessoNegado(401, "Login necessário.");
  }

  let usuario: { id: string; anonimo: boolean } | null;
  try {
    usuario = await deps.usuarioDoToken(token);
  } catch {
    throw new AcessoNegado(503, "Não foi possível conferir a sessão.");
  }
  if (!usuario?.id || usuario.anonimo) throw new AcessoNegado(401, "Sessão inválida. Entre novamente.");

  if (opcoes.rpcPermissao) {
    let pode: boolean | null;
    try {
      pode = await deps.rpcComoUsuario(token, opcoes.rpcPermissao);
    } catch {
      pode = null;
    }
    if (pode === null) throw new AcessoNegado(503, "Não foi possível conferir a permissão.");
    if (pode !== true) throw new AcessoNegado(403, "Você não tem permissão para esta ação.");
  }

  return { tipo: "usuario", usuarioId: usuario.id, token };
}
