import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export class ErroAcessoResultados extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

/** `createClient` do supabase-js — recebido por parâmetro para este arquivo não ter import
 * remoto de valor (é o que deixa a regra ser testada no vitest, como `emailSendAuth.ts`). */
// deno-lint-ignore no-explicit-any
export type CriarClienteSupabase = (url: string, chave: string, opcoes: any) => SupabaseClient;

/**
 * Resultados de clima e DISC são só de quem é membro do espaço "💡 SETOR DO AMANHÃ" do
 * Gestor de Tarefas (decisão do Carlos, 23/09/2026 — hoje Rafael e Welinton).
 *
 * ⚠️ A regra mora NO BANCO, em `pode_ver_resultados_avaliacoes()`; aqui ela só é consultada,
 * com o token de quem chamou (a função usa `auth.uid()`), para não haver duas réguas.
 * ⚠️ Por que existe: o runtime self-hosted NÃO aplica verify_jwt por função (ver
 * `emailSendAuth.ts`). `clima-diagnostico` lia todas as respostas com a chave de serviço, e
 * `clima-feedback-individual`/`disc-feedback` gastavam os créditos de IA — as três atendiam
 * qualquer um. A chave pública (papel `anon`) não passa: o EXECUTE da função é só de
 * `authenticated`, então o `rpc` volta com erro e a resposta é recusada.
 *
 * Usada nas três: `clima-diagnostico`, `clima-feedback-individual`, `disc-feedback` — todas
 * chamadas só de dentro do painel de resultados, que só esses membros abrem.
 */
export async function exigirAcessoResultados(
  authorization: string | null,
  criarCliente: CriarClienteSupabase,
  ambiente: { url: string; chavePublica: string },
): Promise<void> {
  const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) throw new ErroAcessoResultados(401, "Entre no sistema para ver os resultados das avaliações.");

  const comoUsuario = criarCliente(ambiente.url, ambiente.chavePublica, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  try {
    // Token passado explícito: sem ele, `getUser()` depende de a versão do supabase-js ler o
    // Authorization "global" (as três funções usam versões diferentes: 2.49.1 e 2.49.4).
    const { data, error } = await comoUsuario.auth.getUser(token);
    if (error || !data?.user?.id || data.user.is_anonymous) {
      throw new ErroAcessoResultados(401, "Sessão inválida. Entre novamente para ver os resultados.");
    }
  } catch (e) {
    if (e instanceof ErroAcessoResultados) throw e;
    throw new ErroAcessoResultados(503, "Não foi possível verificar sua sessão. Tente novamente.");
  }

  let pode: unknown;
  try {
    const { data, error } = await comoUsuario.rpc("pode_ver_resultados_avaliacoes");
    if (error) throw error;
    pode = data;
  } catch {
    throw new ErroAcessoResultados(503, "Não foi possível verificar seu acesso. Tente novamente.");
  }
  if (pode !== true) {
    throw new ErroAcessoResultados(403, "Os resultados das avaliações ficam restritos ao Setor do Amanhã.");
  }
}

/** Resposta HTTP para o acesso recusado, com os mesmos cabeçalhos de CORS da função. */
export function respostaAcessoRecusado(e: ErroAcessoResultados, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: e.message }), {
    status: e.status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
