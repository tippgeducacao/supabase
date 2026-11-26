// acesso: publico — página pública do embaixador (/e/<apelido>): só lê o que a própria página mostra (nome, título, frase, foto assinada por 1 h, lista de pós) e o cadastro exige Turnstile (fail-closed), freio por IP e página ativa; o lead segue pelo roteador dos sites com o secret lido da tabela.
//
// Edge Function: emb-pagina-publica — Programa de Embaixadores, etapa 3 (23/11/2026).
//   pagina    → dados da página + lista de pós (conta 1 visita quando `contar`).
//   cadastrar → manda o lead ao roteador dos sites como formulário da pós escolhida no site PPGVET
//               (cai na ficha form-pos-<sigla>: card, distribuição e mensagem de sempre; contato que já
//               existe mantém o dono) e grava o vínculo com o embaixador (vale o primeiro cadastro).
// Ver docs/Embaixadores.md.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { emailValido, normalizarWhatsapp } from "../_shared/embaixadorCadastro.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const APP = "https://sistemappgvet.ppgeducacao.site";
// O link assinado do Storage sai com o endereço INTERNO da edge (http://kong:8000), que o navegador do
// visitante não alcança. A assinatura não depende do host: troca-se a origem pela URL pública da API.
const API_PUBLICA = (Deno.env.get("SUPABASE_PUBLIC_URL") || Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site")
  .trim().replace(/\/+$/, "");
const linkPublico = (assinado: string, base = API_PUBLICA) => assinado.replace(/^https?:\/\/[^/]+/, base);
const CUPOM_PERCENTUAL = 80;
// Mesmo widget do Turnstile da agenda pública (mesmo domínio): src/lib/agendaLeadPublica.ts.
const CHAVE_TURNSTILE = "AGENDA_LEAD_TURNSTILE_SECRET";

const TEXTO_ACEITE =(nomeEmbaixador: string, tratamento: string | null) =>
  `Autorizo a PPGVET a falar comigo e ${tratamento === "embaixadora" ? "a embaixadora" : "o embaixador"} ${nomeEmbaixador} a acompanhar o meu atendimento. Política de privacidade: https://www.ppgeducacao.com.br/politica-de-privacidade`;

// ── Freio por IP (em memória, por worker) ─────────────────────────────────────────────────────────
const JANELA_MS = 10 * 60_000;
const baldes = {
  cadastrar: { max: 5, mapa: new Map<string, { n: number; ate: number }>() },
  ler: { max: 120, mapa: new Map<string, { n: number; ate: number }>() },
};
function dentroDoLimite(balde: keyof typeof baldes, ip: string): boolean {
  const { max, mapa } = baldes[balde];
  const agora = Date.now();
  if (mapa.size > 5000) for (const [k, v] of mapa) if (agora > v.ate) mapa.delete(k);
  const t = mapa.get(ip);
  if (!t || agora > t.ate) { mapa.set(ip, { n: 1, ate: agora + JANELA_MS }); return true; }
  t.n += 1;
  return t.n <= max;
}
const IP_PRIVADO_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;
function ipDe(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  let ip = cf ? cf.trim() : "";
  if (!ip) {
    const partes = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = partes.length - 1; i >= 0 && !ip; i--) if (!IP_PRIVADO_RE.test(partes[i])) ip = partes[i];
    if (!ip) ip = partes[partes.length - 1] ?? "";
  }
  return ip ? ip.slice(0, 45) : "desconhecido";
}

// ── Turnstile (fail-closed: sem segredo, sem token, recusado ou Cloudflare muda = não cadastra) ───
async function segredoTurnstile(admin: SupabaseClient): Promise<string> {
  try {
    const { data } = await admin.from("app_secrets").select("valor").eq("chave", CHAVE_TURNSTILE).maybeSingle();
    const v = String(data?.valor ?? "").trim();
    if (v) return v;
  } catch { /* cai no env */ }
  return (Deno.env.get(CHAVE_TURNSTILE) ?? "").trim();
}
async function turnstileOk(segredo: string, token: string, ip: string): Promise<boolean> {
  if (!segredo || !token) return false;
  try {
    const form = new URLSearchParams({ secret: segredo, response: token });
    if (ip && ip !== "desconhecido") form.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
      signal: AbortSignal.timeout(6000),
    });
    return (await res.json())?.success === true;
  } catch (e) {
    console.error(`[emb-pagina-publica] siteverify não respondeu: ${(e as Error).message}`);
    return false;
  }
}

interface Corpo {
  acao?: "pagina" | "cadastrar";
  apelido?: string;
  contar?: boolean;
  nome?: string;
  whatsapp?: string;
  email?: string;
  pos?: string;
  aceite?: boolean;
  utm?: Record<string, string>;
  referrer?: string;
  turnstile_token?: string;
}

interface Pagina {
  id: string; ativa: boolean; nome: string; tratamento: string | null; titulo: string | null;
  frase: string | null; foto_path: string | null; apelido: string;
}

const APELIDO_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const limpar = (s: unknown, max = 200) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  try {
    const corpo = (await req.json().catch(() => ({}))) as Corpo;
    const ip = ipDe(req);
    const apelido = String(corpo.apelido ?? "").trim().toLowerCase();
    if (!APELIDO_RE.test(apelido) || apelido.length > 60) return json({ error: "Página não encontrada." }, 404);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: pg } = await admin.rpc("emb_pagina_publica", { p_apelido: apelido });
    const pagina = pg as Pagina | null;
    if (!pagina) return json({ error: "Página não encontrada." }, 404);

    // ------------------------------------------------------------------------------------------------
    if (corpo.acao === "pagina") {
      if (!dentroDoLimite("ler", ip)) return json({ error: "Muitas tentativas. Aguarde alguns minutos." }, 429);
      if (!pagina.ativa) return json({ ok: true, ativa: false });
      if (corpo.contar) await admin.rpc("emb_pagina_visita", { p_emb: pagina.id });
      let fotoUrl: string | null = null;
      if (pagina.foto_path) {
        const { data } = await admin.storage.from("emb-fotos").createSignedUrl(pagina.foto_path, 3600);
        fotoUrl = data?.signedUrl ? linkPublico(data.signedUrl) : null;
      }
      const { data: pos } = await admin.rpc("emb_pos_da_pagina");
      return json({
        ok: true, ativa: true, nome: pagina.nome, tratamento: pagina.tratamento, titulo: pagina.titulo,
        frase: pagina.frase, foto_url: fotoUrl, cupom: CUPOM_PERCENTUAL, pos: pos ?? [],
        texto_aceite: TEXTO_ACEITE(pagina.nome.split(" ")[0], pagina.tratamento),
      });
    }

    // ------------------------------------------------------------------------------------------------
    if (corpo.acao === "cadastrar") {
      if (!dentroDoLimite("cadastrar", ip)) return json({ error: "Muitas tentativas. Aguarde alguns minutos." }, 429);
      if (!pagina.ativa) {
        return json({ error: "Esta página não está recebendo cadastros agora." }, 410);
      }
      if (!(await turnstileOk(await segredoTurnstile(admin), String(corpo.turnstile_token ?? ""), ip))) {
        return json({ error: "Não foi possível confirmar a verificação de segurança. Tente de novo." }, 403);
      }

      const nome = limpar(corpo.nome, 120);
      const email = limpar(corpo.email, 254).toLowerCase();
      const whatsapp = normalizarWhatsapp(String(corpo.whatsapp ?? ""));
      const sigla = limpar(corpo.pos, 20).toLowerCase();
      const erros: Record<string, string> = {};
      if (nome.length < 5 || !nome.includes(" ")) erros.nome = "Escreva o nome completo.";
      if (!whatsapp) erros.whatsapp = "WhatsApp com DDD.";
      if (!emailValido(email)) erros.email = "E-mail inválido.";
      const { data: listaPos } = await admin.rpc("emb_pos_da_pagina");
      const pos = ((listaPos ?? []) as Array<{ sigla: string; nome: string }>).find((p) => p.sigla === sigla);
      if (!pos) erros.pos = "Escolha a pós de interesse.";
      if (corpo.aceite !== true) erros.aceite = "Marque a autorização para continuar.";
      if (Object.keys(erros).length) return json({ error: "Confira os campos destacados.", erros }, 400);

      // Já estava no CRM? (mesma régua de pessoa do crm-lead-webhook)
      const { data: antes } = await admin.rpc("emb_lead_da_pessoa", { p_email: email, p_whatsapp: whatsapp });
      const jaExistia = !!antes;

      // O secret do roteador lido da tabela (trocar o secret na tela não quebra a página).
      const { data: roteador } = await admin.from("crm_webhook_integrations").select("secret, ativa")
        .eq("slug", "sites").maybeSingle();
      if (!roteador?.ativa || !roteador.secret) {
        console.error("[emb-pagina-publica] roteador dos sites indisponível");
        return json({ error: "Não foi possível enviar agora. Tente de novo em instantes." }, 503);
      }

      const utmEntrada = Object.fromEntries(Object.entries(corpo.utm ?? {})
        .filter(([k]) => /^(utm_(source|medium|campaign|content|term|id)|fbclid|gclid)$/.test(k))
        .map(([k, v]) => [k, limpar(v, 200)]));
      const captacaoId = crypto.randomUUID();
      const payload = {
        site: "ppgvet", formulario: "pos", pos: sigla, evento: "",
        nome, email, whatsapp,
        url: `${APP}/e/${apelido}`,
        referrer: limpar(corpo.referrer, 300) || undefined,
        utm_source: "embaixador",
        utm_medium: "pagina-embaixador",
        utm_campaign: apelido,
        utm_content: utmEntrada.utm_source || undefined,
        ip: ip !== "desconhecido" ? ip : undefined,
        id_envio: captacaoId,
        enviado_em: new Date().toISOString(),
        // Para quem ler o log/entrada: de onde veio e quem é o embaixador.
        origem: "pagina-embaixador",
        embaixador: apelido,
        embaixador_nome: pagina.nome,
        cupom_embaixador: `${CUPOM_PERCENTUAL}%`,
      };
      const resp = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/crm-lead-webhook?int=sites&secret=${encodeURIComponent(roteador.secret)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) },
      ).catch((e) => { console.error("[emb-pagina-publica] roteador", e); return null; });
      if (!resp || !resp.ok) {
        console.error("[emb-pagina-publica] roteador respondeu", resp?.status, resp ? await resp.text() : "");
        await admin.rpc("emb_captacao_registrar", {
          p_id: captacaoId, p_emb: pagina.id, p_lead: null, p_lead_ja_existia: jaExistia, p_pos: sigla,
          p_aceite_texto: TEXTO_ACEITE(pagina.nome.split(" ")[0], pagina.tratamento),
          p_nome: nome, p_whatsapp: whatsapp, p_email: email, p_utm: utmEntrada, p_ip: ip !== "desconhecido" ? ip : null,
          p_user_agent: req.headers.get("user-agent") ?? "",
        });
        return json({ error: "Não foi possível enviar agora. Tente de novo em instantes." }, 503);
      }

      const { data: depois } = await admin.rpc("emb_lead_da_pessoa", { p_email: email, p_whatsapp: whatsapp });
      const { data: resultado } = await admin.rpc("emb_captacao_registrar", {
        p_id: captacaoId, p_emb: pagina.id, p_lead: (depois as string | null) ?? null, p_lead_ja_existia: jaExistia, p_pos: sigla,
        p_aceite_texto: TEXTO_ACEITE(pagina.nome.split(" ")[0], pagina.tratamento),
        p_nome: nome, p_whatsapp: whatsapp, p_email: email, p_utm: utmEntrada, p_ip: ip !== "desconhecido" ? ip : null,
        p_user_agent: req.headers.get("user-agent") ?? "",
      });
      if (resultado === "erro") console.error("[emb-pagina-publica] lead não encontrado depois do roteador", captacaoId);
      // A resposta é a mesma em todos os casos: não revela se a pessoa já estava no CRM nem de quem é.
      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("[emb-pagina-publica]", e);
    return json({ error: "Erro inesperado. Tente de novo em instantes." }, 500);
  }
});
