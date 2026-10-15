// Entrypoint Deno; o worker testável não conhece variáveis de ambiente nem tokens fora do Vault.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { createLogger } from '../_shared/logger.ts';
import { criarHandler, type Admin } from './worker.ts';

const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const supabaseUrl = Deno.env.get('SUPABASE_URL');

Deno.serve(criarHandler({
  serviceRole,
  supabaseUrl,
  baseUrl: Deno.env.get('APP_URL'),
  logger: createLogger('gt-notion-sync'),
  criarAdmin: () => createClient(supabaseUrl!, serviceRole!, {
    auth: { persistSession: false, autoRefreshToken: false },
    // SQL também tem timeout: indisponibilidade do banco não deixa o worker pendurado.
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }) },
  }) as unknown as Admin,
}));
