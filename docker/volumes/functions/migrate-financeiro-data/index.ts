// DESATIVADA em 16/10/2026 (contenção de segurança aprovada pelo usuário — docs/SECURITY.md,
// "Contenção de 16/10/2026"). Utilitário de migração avulso (Lovable, abril/2026) que rodava com
// a chave de serviço SEM conferir quem chamava e inseria dados financeiros a partir do projeto
// antigo (iogotqysdouakzthmdqt). Hoje inerte só por acaso (o host não resolve mais). A pasta não
// pode simplesmente sumir: o deploy só troca as funções que existem no repositório. O código
// original está no histórico do git.
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
