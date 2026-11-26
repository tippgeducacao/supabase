// acesso: publico — desativada: responde 410 sem ler o pedido nem tocar em dado
// DESATIVADA em 25/11/2026 (correção de segurança aprovada pelo usuário — docs/SECURITY.md,
// "Edges mortas desativadas em 25/11/2026"). Motivo: utilitário de correção de rateios do financeiro (apagava rateios no modo limpeza), sem chamador.
// A pasta não pode sumir: o deploy só troca as funções que existem no repositório (não
// desinstala), e a versão antiga continuaria no ar. O código original está no histórico do git.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return new Response(JSON.stringify({ error: 'Função desativada.' }), {
    status: 410,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
