import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { ocupadosNoGoogle, vagaOcupada, type Intervalo } from '../_shared/googleOcupados.ts';

/**
 * LINK DE PROSPECÇÃO DE PROFESSOR — o lado do professor, sem login.
 *
 * O SDR manda o link pessoal dele (`/agendar-professor/<token>`); o professor responde as
 * perguntas e escolhe uma vaga livre da agenda da secretaria. A reunião nasce em nome do
 * SDR dono do link — é dele o ponto quando a secretaria confirmar o comparecimento.
 *
 * Por que uma edge, e não RPC direto do navegador: `anon` não pode ter nada aqui. As RPCs
 * `reuniao_professor_publico_*` só executam como service_role; a página nunca fala com o
 * banco. TODA regra (token, vaga livre, perguntas obrigatórias, uma conversa por telefone,
 * lead + card no funil) está no banco — esta função só valida o formato, chama e cria o
 * evento no Google.
 *
 * O Google é SECUNDÁRIO de propósito (mesmo princípio de `rh-agenda-publica`): a reunião
 * já está gravada quando ele é chamado. Se falhar, o professor vê a confirmação sem o link
 * e a secretaria recria o evento salvando a reunião na agenda do sistema.
 *
 * CONFLITO COM A AGENDA GOOGLE DA SECRETARIA (08/10/2026): antes de oferecer e antes de
 * marcar, a vaga é conferida AO VIVO no Google (FreeBusy) — compromisso que a secretaria
 * pôs direto no Google tira a vaga. Se o Google não responde, o link NÃO oferece vaga
 * (`agenda_google`): marcar às cegas por cima de um compromisso dela é pior que esperar.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Freio de abuso para o MARCAR (por IP, em memória): o link é público e vai por WhatsApp.
// Carregar não conta — quem abre a página várias vezes não está fazendo nada de errado.
const tentativas = new Map<string, { n: number; ate: number }>();
const MAX_MARCAR = 8;
const JANELA_MS = 10 * 60_000;

function podeMarcar(ip: string): boolean {
  const agora = Date.now();
  const t = tentativas.get(ip);
  if (!t || agora > t.ate) {
    tentativas.set(ip, { n: 1, ate: agora + JANELA_MS });
    return true;
  }
  t.n += 1;
  return t.n <= MAX_MARCAR;
}

const TOKEN_OK = /^[A-Za-z0-9_-]{12,64}$/;

// IP do cliente SEM confiar no que o cliente manda (mesma régua do `crm-webchat`): o
// PRIMEIRO valor do x-forwarded-for é forjável; varre da direita (o que os NOSSOS proxies
// apuseram) e pega o primeiro IP público.
const IP_PRIVADO_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;
function ipDe(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const partes = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = partes.length - 1; i >= 0; i--) {
    if (!IP_PRIVADO_RE.test(partes[i])) return partes[i];
  }
  return partes[partes.length - 1] || 'desconhecido';
}

function texto(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

/** Só o formato: objeto { id: string | string[] }, com limites. O conteúdo o banco confere. */
function respostasLimpas(v: unknown): Record<string, string | string[]> {
  const saida: Record<string, string | string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return saida;
  for (const [id, valor] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
    if (!/^[a-z0-9_]{1,40}$/.test(id)) continue;
    if (Array.isArray(valor)) saida[id] = valor.slice(0, 40).map((x) => texto(x, 200));
    else if (valor != null) saida[id] = texto(valor, 2000);
  }
  return saida;
}

function horaBR(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const acao = String(body?.acao ?? 'carregar');
    const token = String(body?.token ?? '');
    if (!TOKEN_OK.test(token)) return json({ ok: false, motivo: 'link_invalido' });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Vagas que o banco oferece, já sem as que batem com compromisso no Google da secretaria.
    async function carregarConferido(): Promise<any> {
      const { data, error } = await admin.rpc('reuniao_professor_publico_carregar', { p_token: token });
      if (error) throw error;
      if (!data?.ok) return data;
      const vagas = (data.vagas ?? []) as Intervalo[];
      if (vagas.length === 0) return data;
      const { data: cfg } = await admin
        .from('reuniao_professor_config').select('calendar_integration_id').eq('id', true).maybeSingle();
      const google = await ocupadosNoGoogle(admin, cfg?.calendar_integration_id ?? null, vagas[0].inicio, vagas[vagas.length - 1].fim);
      if (!google.ok) {
        console.error('[professor-agenda-publica] agenda Google da secretaria indisponível:', google.erro);
        return { ok: false, motivo: 'agenda_google' };
      }
      return { ...data, vagas: vagas.filter((v) => !vagaOcupada(v, google.ocupados)) };
    }

    if (acao === 'carregar') {
      return json(await carregarConferido());
    }

    if (acao !== 'marcar') return json({ ok: false, motivo: 'acao_invalida' }, 400);

    if (!podeMarcar(ipDe(req))) return json({ ok: false, motivo: 'muitas_tentativas' });

    const inicio = String(body?.inicio ?? '');
    if (Number.isNaN(Date.parse(inicio))) return json({ ok: false, motivo: 'horario_indisponivel' });

    // Confere de novo, AGORA, no banco e no Google: entre abrir a página e confirmar, a
    // secretaria pode ter posto um compromisso nesse horário.
    const conferido = await carregarConferido();
    if (!conferido?.ok) return json(conferido);
    const aindaLivre = (conferido.vagas as Intervalo[]).some((v) => Date.parse(v.inicio) === Date.parse(inicio));
    if (!aindaLivre) return json({ ok: false, motivo: 'horario_indisponivel' });

    const { data: r, error } = await admin.rpc('reuniao_professor_publico_marcar', {
      p_token: token,
      p_nome: texto(body?.nome, 120),
      p_telefone: texto(body?.telefone, 25),
      p_email: texto(body?.email, 160),
      p_respostas: respostasLimpas(body?.respostas),
      p_inicio: inicio,
    });
    if (error) throw error;
    if (!r?.ok) return json({ ok: false, motivo: r?.motivo ?? 'falhou' });

    // ── Evento com Meet na agenda Google da secretaria (melhor-esforço) ─────────
    let link: string | null = null;
    let conviteEmail = false;
    if (r.integration_id) {
      try {
        const email = texto(body?.email, 160);
        const respostas = (r.respostas ?? []) as Array<{ pergunta: string; resposta: string }>;
        const descricao = [
          `Professor(a): ${texto(body?.nome, 120)}`,
          `WhatsApp: ${texto(body?.telefone, 25)}`,
          `E-mail: ${email}`,
          '',
          ...respostas.map((x) => `${x.pergunta}\n→ ${x.resposta}`),
          '',
          `Convite enviado por ${r.sdr_nome ?? 'SDR'} (link de prospecção). Horário escolhido pelo próprio professor.`,
        ].join('\n');

        const res = await fetch(`${SUPABASE_URL}/functions/v1/google-calendar-create-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
          body: JSON.stringify({
            integration_id: r.integration_id,
            title: `Reunião com professor — ${texto(body?.nome, 120)}`,
            description: descricao,
            starts_at: r.inicio,
            ends_at: r.fim,
            attendees: email ? [email] : [],
            create_meet: true,
            reminders: [
              { method: 'popup', minutes: 30 },
              { method: 'email', minutes: 60 * 24 },
            ],
          }),
        });
        const j = await res.json().catch(() => null);
        if (j?.success) {
          const bruto = j?.event?.meetLink;
          link = typeof bruto === 'string' && bruto.trim() ? bruto.trim() : null;
          conviteEmail = !!email;
          const { error: erroAnotar } = await admin
            .from('reunioes_professor')
            .update({ link, google_event_cache_id: j?.event?.cache_id ?? null })
            .eq('id', r.reuniao_id);
          if (erroAnotar) console.error('[professor-agenda-publica] Meet não anotado na reunião', erroAnotar);
        } else {
          console.error('[professor-agenda-publica] Google recusou o evento', j?.error);
        }
      } catch (e) {
        console.error('[professor-agenda-publica] evento no Google falhou', e);
      }
    }

    console.log(`[professor-agenda-publica] reunião ${r.reuniao_id} marcada para ${horaBR(r.inicio)} (link de ${r.sdr_nome})`);
    return json({
      ok: true,
      reuniao: { inicio: r.inicio, fim: r.fim, link, convite_email: conviteEmail },
    });
  } catch (e) {
    console.error('[professor-agenda-publica]', e);
    return json({ ok: false, motivo: 'falhou' }, 500);
  }
});
