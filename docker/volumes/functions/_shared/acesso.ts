// Conferência de acesso das edge functions — PORTA ÚNICA (29/10/2026).
//
// Por que existe: o runtime aceita qualquer JWT bem assinado, e a chave anon (pública, está
// no código do site) é um JWT bem assinado. "Exige token" NÃO é "exige login". A validação de
// 28-29/10 achou 74 edges que rodavam com a service_role e não conferiam quem chamava: envio
// de WhatsApp, escrita no Financeiro, IA paga, tudo sem login.
//
// Regra (checada no deploy por scripts/check-edges-acesso.mjs): toda edge chama
// `exigirAcesso` antes de qualquer leitura, escrita ou chamada externa, OU declara no topo
//   // acesso: publico — <motivo>
// quando é pública de propósito (webhook com assinatura conferida, callback de OAuth,
// formulário por token de uso único). Ver docs/SECURITY.md → "Edge functions: quem chama".
//
// Quem pode chamar, em ordem de preferência:
//   usuario  — colaborador logado (token de sessão), opcionalmente com uma RPC de permissão
//   servico  — a chave de serviço EXATA (cron via pg_net, outra edge)
//   segredo  — cabeçalho próprio com valor de env/app_secrets (automação externa sem a chave)
// Nunca: confiar em cabeçalho sem segredo (`x-trigger: cron`), ler o papel do JWT sem conferir
// a assinatura, ou aceitar "Bearer qualquer-coisa".
//
// Uso:
//   import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
//   try { await exigirAcesso(req, { usuario: true, servico: true }); }
//   catch (e) { return respostaAcessoNegado(e, corsHeaders); }
//
// ⚠️ Sem import por URL (esm.sh) de propósito: fala com o GoTrue e o PostgREST por fetch, para
// que os testes (vitest) das edges que importam esta porta continuem carregando.

import { AcessoNegado, decidirAcesso, type Chamador, type OpcoesAcesso } from "./acessoRegra.ts";

export { AcessoNegado, iguaisEmTempoConstante, tokenDoCabecalho } from "./acessoRegra.ts";
export type { Chamador, OpcoesAcesso } from "./acessoRegra.ts";

export function exigirAcesso(req: Request, opcoes: OpcoesAcesso): Promise<Chamador> {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const chaveServico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const chaveAnon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const apikey = chaveAnon || chaveServico;
  return decidirAcesso(
    { authorization: req.headers.get("Authorization"), get: (n) => req.headers.get(n) },
    opcoes,
    {
      chaveServico,
      chaveAnon,
      usuarioDoToken: async (token) => {
        const r = await fetch(`${url}/auth/v1/user`, {
          headers: { apikey, Authorization: `Bearer ${token}` },
        });
        // 4xx do GoTrue = token ruim (sessão inválida/expirada); o resto = não deu para conferir.
        if (r.status >= 400 && r.status < 500) return null;
        if (!r.ok) throw new Error(`GoTrue ${r.status}`);
        const u = (await r.json()) as { id?: string; is_anonymous?: boolean };
        return u?.id ? { id: u.id, anonimo: !!u.is_anonymous } : null;
      },
      rpcComoUsuario: async (token, rpc) => {
        const r = await fetch(`${url}/rest/v1/rpc/${encodeURIComponent(rpc)}`, {
          method: "POST",
          headers: { apikey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
        });
        if (!r.ok) return null;
        return (await r.json()) === true;
      },
    },
  );
}

/** Resposta JSON padrão para AcessoNegado; relança qualquer outro erro. */
export function respostaAcessoNegado(e: unknown, cors: Record<string, string> = {}): Response {
  if (!(e instanceof AcessoNegado)) throw e;
  return new Response(JSON.stringify({ error: e.message }), {
    status: e.status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
