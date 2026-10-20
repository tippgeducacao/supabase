// ⚠️ APOSENTADA EM 20/10/2026 (varredura de 19/10). Buscava as faturas do EDUQ no n8n
// (auto.ppgeducacao.site/webhook/eduq-faturas-em-aberto e /eduq-faturas-liquidadas) e fazia
// upsert em eduq_faturas com a chave de serviço, sem conferir quem chamava.
//
// Por que virou lápide e não voltou a funcionar:
// - o n8n foi desligado (a VPS dele foi excluída em 14/10) e nada entra em eduq_faturas
//   desde 08/10;
// - o domínio auto.ppgeducacao.site passou a apontar para um servidor de OUTRA empresa
//   (certificado salesifiq.com). Se ela emitir um certificado válido para o nome, esta edge
//   gravaria no nosso banco o que ela devolvesse.
// Os crons que a chamavam (sync-eduq-faturas-30min e eduq-sync-incremental-daily) saíram na
// migration 20261020124953_varredura_crons_que_falhavam_sempre.sql.
//
// O arquivo FICA no repositório de propósito: a versão antiga só existia no servidor (o código
// saiu do repo em 22/05, commit 96879214b), e o deploy-edges.yml só troca as funções que
// existem aqui — sem esta pasta, a versão antiga continuaria no ar e chamável por qualquer um.
// O código original está no histórico do git (96879214b^).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  // Chamada residual aparece no log em vez de sumir calada.
  console.warn('[sync-eduq-faturas] chamada a edge aposentada', {
    method: req.method,
    ua: req.headers.get('user-agent'),
  });
  return new Response(
    JSON.stringify({ error: 'Função aposentada em 20/10/2026: a fonte (n8n) foi desligada.' }),
    { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
