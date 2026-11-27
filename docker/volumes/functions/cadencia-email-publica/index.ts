// acesso: publico — página /meu-atendimento/<token> do lead (link pessoal dos e-mails da cadência por pós), sem login; a credencial é o token de 122 hex assinado pelo banco (HMAC por lead + e-mail + card + opção), o formato é conferido antes de qualquer consulta, há freio por IP e toda regra mora em RPCs só de service_role
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { acaoValida, deveAcordarDespachante, respostaDaPagina, TOKEN_OK } from './regras.ts';

/**
 * CADÊNCIA POR PÓS, E-MAILS v2 — o lado do LEAD (27/11/2026, especificação do Rafael).
 *
 * No e-mail de cada toque, "Ver o cronograma completo" e cada opção de resposta são links
 * PESSOAIS. A página só fala com esta edge, em duas chamadas:
 *
 *   abrir     → o que a tela mostra (primeiro nome, 4 últimos dígitos, a pós, a opção escolhida).
 *               NÃO tem efeito nenhum.
 *   registrar → grava o clique e avisa o motor do CRM V2. O que sai no WhatsApp (modelo, número,
 *               texto) é AUTOMAÇÃO DO FUNIL, com os gatilhos "O lead responder a um e-mail da
 *               cadência" e "O lead pedir o cronograma pelo e-mail" — nada é enviado daqui.
 *
 * Por que duas chamadas: o verificador de links dos provedores de e-mail abre o endereço
 * sozinho (o do Hotmail abriu 1 minuto depois da entrega, no teste de 27/11). A página só
 * chama `registrar` depois de carregar num navegador de verdade, com a aba visível.
 *
 * Travas (no banco, `crm_cadencia_email_publica_registrar`): 1 envio por lead × pós (cronograma)
 * ou por lead × e-mail (resposta) a cada 24 h; clique repetido só mostra a confirmação.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── Freio por IP (em memória, por worker) ───────────────────────────────────────────────
// ABRIR é leitura (60 a cada 10 min); REGISTRAR é o que pode virar WhatsApp (12 a cada 10 min).
const JANELA_MS = 10 * 60_000;
const baldes = {
  abrir: { max: 60, mapa: new Map<string, { n: number; ate: number }>() },
  registrar: { max: 12, mapa: new Map<string, { n: number; ate: number }>() },
};

function dentroDoLimite(balde: keyof typeof baldes, ip: string): boolean {
  const { max, mapa } = baldes[balde];
  const agora = Date.now();
  if (mapa.size > 5000) for (const [k, v] of mapa) if (agora > v.ate) mapa.delete(k);
  // Enxurrada de IPs diferentes: o mapa não pode crescer sem fim nem ser varrido a cada pedido.
  // Zerar afrouxa o freio por IP por um instante; as travas que valem estão no banco.
  if (mapa.size > 10000) mapa.clear();
  const t = mapa.get(ip);
  if (!t || agora > t.ate) {
    mapa.set(ip, { n: 1, ate: agora + JANELA_MS });
    return true;
  }
  t.n += 1;
  return t.n <= max;
}

// IP do cliente sem confiar no que o cliente manda (a mesma régua da agenda pública).
const IP_PRIVADO_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;
function ipDe(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  let ip = cf ? cf.trim() : '';
  if (!ip) {
    const partes = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = partes.length - 1; i >= 0 && !ip; i--) {
      if (!IP_PRIVADO_RE.test(partes[i])) ip = partes[i];
    }
    if (!ip) ip = partes[partes.length - 1] ?? '';
  }
  if (!ip) return 'desconhecido';
  if (ip.includes(':')) {
    const grupos = ip.toLowerCase().split('::')[0].split(':').filter(Boolean).slice(0, 4);
    return `${grupos.join(':')}::/64`;
  }
  return ip.slice(0, 45);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, motivo: 'pedido_invalido' }, 405);

  try {
    // O pedido da página tem ~170 bytes; corpo grande não é da página.
    if (Number(req.headers.get('content-length') ?? '0') > 4096) return json({ ok: false, motivo: 'pedido_invalido' }, 413);
    const body = await req.json().catch(() => ({}));
    const acao = body?.acao;
    const token = String(body?.token ?? '').trim().toLowerCase();
    // O formato é conferido ANTES de criar o cliente do banco; a assinatura, só o banco confere.
    if (!acaoValida(acao)) return json({ ok: false, motivo: 'pedido_invalido' }, 400);
    if (!TOKEN_OK.test(token)) return json({ ok: false, motivo: 'link_invalido' });

    const ip = ipDe(req);
    if (!dentroDoLimite(acao, ip)) return json({ ok: false, motivo: 'muitas_tentativas' });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    if (acao === 'abrir') {
      const { data, error } = await admin.rpc('crm_cadencia_email_publica_abrir', { p_token: token });
      if (error) throw error;
      return json(respostaDaPagina(data));
    }

    // ── Registrar ────────────────────────────────────────────────────────────────────────
    const { data, error } = await admin.rpc('crm_cadencia_email_publica_registrar', { p_token: token, p_ip: ip });
    if (error) throw error;
    const r = (data && typeof data === 'object' ? data : {}) as { ok?: unknown; enviou?: unknown; repetido?: unknown; motivo?: unknown };
    if (r.ok !== true) return json({ ok: false, motivo: typeof r.motivo === 'string' ? r.motivo : 'link_invalido' });

    // A mensagem já está na fila do WhatsApp (posta pela automação do funil). O cron a despacha
    // em até 1 minuto; com a fila curta, acorda o despachante agora para o lead receber na hora.
    if (r.enviou === true && r.repetido !== true) {
      try {
        const { count } = await admin.from('crm_mensagens_agendadas')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'agendado').lte('enviar_em', new Date().toISOString());
        if (deveAcordarDespachante(r, count ?? null)) {
          await fetch(`${SUPABASE_URL}/functions/v1/crm-agendadas-dispatch`, {
            method: 'POST', signal: AbortSignal.timeout(20_000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
            body: '{}',
          }).then((resposta) => resposta.body?.cancel()).catch(() => {});
        }
      } catch {
        /* o cron de 1 minuto cobre */
      }
    }
    return json({ ok: true, enviou: r.enviou === true, repetido: r.repetido === true });
  } catch (e) {
    console.error('[cadencia-email-publica]', e instanceof Error ? e.message : e);
    return json({ ok: false, motivo: 'falhou' }, 500);
  }
});
