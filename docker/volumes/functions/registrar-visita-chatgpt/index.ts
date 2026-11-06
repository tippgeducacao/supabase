// acesso: publico — contador anônimo de visitas do site (o aviso sai do navegador de quem clicou no link do ChatGPT): só aceita páginas dos domínios da PPG, só SOMA 1 num contador agregado por dia/página/tipo (não grava IP, cookie, nome nem a URL completa), descarta robôs e limita a taxa por IP; não lê nada do banco
//
// registrar-visita-chatgpt — conta as VISITAS que chegam ao site pelo ChatGPT (a resposta que cita a PPG e o anúncio
// do ChatGPT Ads). Pedido do Marketing em 06/11/2026: "cada pesquisa feita no ChatGPT que entregar o link da PPGVET
// [...] para termos uma noção de quantos são". Quem só VÊ o link não deixa rastro (a OpenAI não informa); quem CLICA
// chega com `utm_source=chatgpt.com` — que o próprio ChatGPT acrescenta — ou, no anúncio, `utm_source=openai`.
//
//   POST (corpo texto/JSON) { u: "<location.href>", r: "<document.referrer>" }
//   → 204 sempre que o pedido é bem formado (conte ou não: quem está de fora não deve conseguir sondar o que é aceito)
//   → 400 corpo torto · 405 método · 413 corpo grande · 429 passou do limite de taxa · 503 falha ao gravar
//
// QUEM CHAMA: o trecho de JavaScript colocado nas páginas (GTM `GTM-5MTCBPTF` no GreatPages e, à mão, nas páginas sem
// GTM) manda `navigator.sendBeacon(url, new Blob([json], {type:"text/plain"}))`. Texto puro de propósito: é uma
// requisição "simples" do navegador, sem pré-voo de CORS, e a página nunca espera a resposta.
//
// ⚠️ O QUE ESTA PORTA PÚBLICA PODE FAZER: somar 1 num contador. A régua que decide se conta (domínio da PPG, marca do
// ChatGPT, anúncio × resposta, caminho normalizado) está em `_shared/visitaChatgpt.ts` (testada); o teto de linhas
// por dia mora na função do banco `site_visita_chatgpt_registrar`. O contador pode ser inflado por quem quiser
// chamar daqui — é indicador de tendência, não prova contábil. Nada é lido, nada é devolvido.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";
import {
  MAX_BYTES_DO_PEDIDO,
  chaveDoCliente,
  classificarVisita,
  criarLimitador,
  ehRobo,
} from "../_shared/visitaChatgpt.ts";

const cabecalhos = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};
const resposta = (status: number) => new Response(null, { status, headers: cabecalhos });

// 30 avisos por minuto por IP, em memória (some quando o isolate reinicia; nada é gravado)
const podePassar = criarLimitador({ max: 30, janelaMs: 60_000 });

let banco: ReturnType<typeof createClient> | null = null;
function bancoDeServico() {
  banco ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return banco;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return resposta(204);
  if (req.method !== "POST") return resposta(405);

  // robô não conta (e não gasta o limite de ninguém)
  if (ehRobo(req.headers.get("user-agent"))) return resposta(204);
  if (!podePassar(chaveDoCliente(req.headers))) return resposta(429);

  let corpo: unknown;
  try {
    const texto = await req.text();
    if (texto.length > MAX_BYTES_DO_PEDIDO) return resposta(413);
    corpo = JSON.parse(texto);
  } catch {
    return resposta(400);
  }

  const visita = classificarVisita((corpo ?? {}) as { u?: unknown; r?: unknown });
  // não é visita do ChatGPT a uma página da PPG: ignora calado
  if (!visita) return resposta(204);

  try {
    const { error } = await bancoDeServico().rpc("site_visita_chatgpt_registrar", {
      p_host: visita.host,
      p_pagina: visita.pagina,
      p_tipo: visita.tipo,
      p_via: visita.via,
    });
    if (error) throw error;
    return resposta(204);
  } catch (e) {
    // Sem detalhe para quem está de fora; o motivo fica no log da edge.
    console.error("registrar-visita-chatgpt:", e instanceof Error ? e.message : JSON.stringify(e));
    return resposta(503);
  }
});
