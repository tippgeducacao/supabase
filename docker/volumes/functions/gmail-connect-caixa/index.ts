// OAuth continua sendo a autorização prévia; o cadastro apenas vincula a caixa
// autorizada ao responsável e, quando escolhido, à pasta da equipe.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { criarHandlerConectarCaixa } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(criarHandlerConectarCaixa({
  admin: createClient(SUPABASE_URL, SERVICE_ROLE),
  autenticar: async (authorization) => {
    const cliente = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error } = await cliente.auth.getUser();
    return error ? null : user;
  },
  iniciarSync: (caixaId) => {
    fetch(`${SUPABASE_URL}/functions/v1/gmail-sync-inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ caixa_id: caixaId, initial: true }),
    }).catch(() => console.error('Falha ao iniciar sincronização da caixa.'));
  },
}));
