// A autorização segue a sessão real e a regra de dono/gestão no banco.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { criarHandlerControleCampanha } from "./handler.ts";
const url = Deno.env.get("SUPABASE_URL")!;
const apikey = Deno.env.get("SUPABASE_ANON_KEY")!;
Deno.serve(criarHandlerControleCampanha({ url, apikey,
  criarCliente: auth => createClient(url, apikey, { global: { headers: { Authorization: auth } } }),
}));
