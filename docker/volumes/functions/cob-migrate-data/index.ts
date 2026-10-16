// DESATIVADA em 16/10/2026 (contenção de segurança aprovada pelo usuário — docs/SECURITY.md,
// "Contenção de 16/10/2026"). Utilitário de migração avulso (Lovable, maio/2026) que rodava com
// a chave de serviço SEM conferir quem chamava: APAGAVA as tabelas cob_* e as recopiava de outro
// projeto. Hoje inerte só por acaso (a variável SOURCE_COBRANCA_SUPABASE_URL não existe no runtime
// e o módulo quebrava ao carregar); bastaria alguém definir a variável para virar um botão anônimo
// de apagar a cobrança. A pasta não pode simplesmente sumir: o deploy só troca as funções que
// existem no repositório. O código original está no histórico do git.
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
