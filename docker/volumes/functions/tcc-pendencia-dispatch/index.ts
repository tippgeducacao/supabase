// tcc-pendencia-dispatch: manda ao aluno o modelo de UTILIDADE que cobra as pendências
// do TCC (notas, documentos ou os dois), pela linha do Suporte ao Aluno (3250).
//
// Quem chama é a RPC `gt_tcc_pendencia_mover`, por pg_net, DEPOIS do COMMIT do movimento
// do card — se a transação abortar, nada é enviado. O corpo é só { pendencia_id }.
//
// O que esta edge NÃO faz, de propósito:
//   · não abre o atendimento no SAC — isso já aconteceu na mesma transação do movimento
//     (`gt_tcc_pendencia_abrir_sac`), porque as RPCs do SAC exigem `auth.uid()` e aqui
//     não há usuário. Quando o envio falha, a Danieli já tem o card e fala com o aluno;
//   · não decide para quem vai: o lead é o que está vinculado ao card.
//
// ⚠️ Um 200 da Meta NÃO é entrega. A recusa (número banido, 131042 de cadastro fiscal)
// volta assíncrona pelo webhook de status. A prova de entrega é `status_entrega` em
// `crm_whatsapp_messages` virar `delivered` — ver docs/Logs do Sistema.md.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TIMEOUT_ENVIO_MS = 25_000;

const ROTULO: Record<string, string> = {
  notas: 'notas pendentes',
  documentos: 'documentos pendentes',
  notas_documentos: 'notas e documentos pendentes',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Primeiro nome, com maiúscula. Vazio vira "Olá" utilizável pelo modelo. */
function primeiroNome(nome?: string | null): string {
  const p = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  if (!p) return 'tudo bem';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * A Meta REJEITA parâmetro de corpo com quebra de linha, tab ou 4+ espaços seguidos
 * (o texto some inteiro, em silêncio). A secretaria digita a lista livremente, então a
 * limpeza acontece aqui — e quebra de linha vira " · ", que é como a lista fica legível
 * numa linha só.
 */
function sanitizarParametro(s: string): string {
  return String(s ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean)
    .join(' · ')
    .replace(/[\t]+/g, ' ')
    .replace(/\s{4,}/g, '   ')
    .trim();
}

async function comentar(admin: ReturnType<typeof createClient>, taskId: string, texto: string) {
  try {
    await admin.from('gt_task_comments').insert({ task_id: taskId, user_id: null, content: texto });
  } catch (e) {
    console.error('[tcc-pendencia] comentário falhou:', String(e));
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  let pendenciaId = '';

  try {
    const body = await req.json().catch(() => ({}));
    pendenciaId = String(body?.pendencia_id ?? '').trim();
    if (!pendenciaId) return json({ error: 'pendencia_id é obrigatório' }, 400);

    const { data: pend, error: pendErr } = await admin
      .from('gt_tcc_pendencias')
      .select('id, task_id, status_id, tipo, pendencias, lead_id, situacao')
      .eq('id', pendenciaId)
      .maybeSingle();
    if (pendErr) return json({ error: `falha ao ler a pendência: ${pendErr.message}` }, 500);
    if (!pend) return json({ error: 'pendência não encontrada' }, 404);

    // Reentrada (retry do pg_net, chamada manual): já enviado não manda de novo.
    if (pend.situacao === 'enviado') {
      return json({ ok: true, ja_enviado: true, pendencia_id: pendenciaId });
    }

    const [{ data: modelo }, { data: lead }] = await Promise.all([
      admin.from('gt_tcc_pendencia_modelos')
        .select('tipo, template_name, template_lang, wa_account_id, ativo')
        .eq('tipo', pend.tipo).maybeSingle(),
      admin.from('leads').select('id, nome, whatsapp').eq('id', pend.lead_id).maybeSingle(),
    ]);

    const falhar = async (erro: string) => {
      await admin.from('gt_tcc_pendencias')
        .update({ situacao: 'falhou', erro, processado_em: new Date().toISOString() })
        .eq('id', pendenciaId);
      await comentar(
        admin,
        pend.task_id,
        `❌ A cobrança de ${ROTULO[pend.tipo] ?? pend.tipo} NÃO foi enviada pelo WhatsApp: ${erro}\n\n` +
          'O atendimento no SAC (Suporte ao Aluno · Danieli) já está aberto — dá para falar com o aluno por lá.',
      );
      return json({ ok: false, erro }, 200);
    };

    if (!modelo?.ativo) return await falhar('a cobrança automática desta coluna está desligada');
    if (!String(modelo.template_name ?? '').trim()) {
      return await falhar('o modelo de WhatsApp desta coluna ainda não foi configurado');
    }
    if (!lead) return await falhar('o contato vinculado ao card não existe mais');
    if (!String(lead.whatsapp ?? '').trim()) {
      return await falhar('o contato vinculado não tem WhatsApp cadastrado');
    }

    const pendenciasTexto = sanitizarParametro(pend.pendencias);
    if (!pendenciasTexto) {
      return await falhar('o texto do que está faltando ficou vazio depois da limpeza');
    }

    // Avisa (sem barrar): o espelho `wa_templates` atrasa em relação à Meta, então um
    // modelo aprovado há minutos ainda aparece como pendente aqui. Quem decide é a Meta.
    try {
      const { data: espelho } = await admin.from('wa_templates')
        .select('status, quality_score')
        .eq('template_name', modelo.template_name)
        .maybeSingle();
      if (espelho && espelho.status !== 'APPROVED') {
        console.warn(`[tcc-pendencia] ${modelo.template_name} está ${espelho.status} no espelho wa_templates`);
      }
    } catch { /* espelho indisponível não impede o envio */ }

    const payload = {
      wa_account_id: modelo.wa_account_id,
      telefone: lead.whatsapp,
      tipo: 'template',
      template_name: modelo.template_name,
      template_lang: modelo.template_lang || 'pt_BR',
      template_components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: primeiroNome(lead.nome) },
          { type: 'text', text: pendenciasTexto },
        ],
      }],
      lead_id: lead.id,
      origem: 'automacao',
    };

    let resp: Record<string, unknown> = {};
    let httpStatus = 0;
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_ENVIO_MS),
      });
      httpStatus = r.status;
      resp = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (e) {
      return await falhar(`o envio não completou (${String(e)})`);
    }

    if (httpStatus >= 400 || resp?.error || resp?.success !== true) {
      return await falhar(String(resp?.error ?? `falha no envio (status ${httpStatus})`));
    }

    const waMessageId = typeof resp?.wa_message_id === 'string' ? resp.wa_message_id : null;
    await admin.from('gt_tcc_pendencias').update({
      situacao: 'enviado',
      erro: null,
      wa_message_id: waMessageId,
      processado_em: new Date().toISOString(),
    }).eq('id', pendenciaId);

    await comentar(
      admin,
      pend.task_id,
      `📲 Cobrança de ${ROTULO[pend.tipo] ?? pend.tipo} enviada para *${lead.nome ?? 'o aluno'}* ` +
        `pelo WhatsApp do Suporte (3250).\n\nO que foi pedido: ${pendenciasTexto}\n\n` +
        'O atendimento está aberto no SAC → Suporte ao Aluno, coluna da Danieli.',
    );

    return json({ ok: true, pendencia_id: pendenciaId, wa_message_id: waMessageId });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    console.error('[tcc-pendencia] erro:', erro);
    if (pendenciaId) {
      try {
        await admin.from('gt_tcc_pendencias')
          .update({ situacao: 'falhou', erro, processado_em: new Date().toISOString() })
          .eq('id', pendenciaId);
      } catch { /* já estamos no catch de cima */ }
    }
    return json({ error: erro }, 500);
  }
});
