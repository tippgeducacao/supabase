// DESATIVADA em 16/10/2026 (contenção de segurança aprovada pelo usuário — docs/SECURITY.md,
// "Contenção de 16/10/2026"). Era um utilitário de migração avulso (Lovable, abril/2026) que
// rodava com a chave de serviço SEM conferir quem chamava: um POST anônimo com
// {"step":"cleanup"} apagava TODOS os fin_lancamento_rateios e todos os fin_lancamentos de
// despesa. A pasta não pode simplesmente sumir: o deploy-edges.yml só troca as funções que
// existem no repositório e o espelho não tem --delete — a versão antiga continuaria no ar.
// O código original está no histórico do git (antes de 16/10/2026).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return new Response(JSON.stringify({ error: 'Função desativada: utilitário de migração antigo.' }), {
    status: 410,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
