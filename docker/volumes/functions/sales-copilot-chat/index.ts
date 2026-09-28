// sales-copilot-chat — APOSENTADA em 28/09/2026. A Mimosa de Vendas agora é `mimosa-vendas`.
//
// Por que não foi só apagada: o deploy das edges não remove do servidor a função que
// some do repositório — ela continuaria no ar. E esta estava ABERTA: não exigia login,
// usava a chave da Anthropic do sistema e aceitava um `context` livre do cliente. Além
// disso, as RPCs de curso que ela chamava com a service role voltavam vazias
// (`auth.uid()` nulo), então os "dados ao vivo" dela nunca chegaram ao modelo.
//
// Aba antiga aberta no navegador chama este endereço até recarregar: o 410 com
// mensagem clara é o que faz a pessoa recarregar e cair na Mimosa nova.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(
    JSON.stringify({ error: "A Mimosa foi atualizada. Recarregue a página (F5) para usar a versão nova." }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
