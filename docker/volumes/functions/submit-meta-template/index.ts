import { createClient } from 'npm:@supabase/supabase-js@2';
import { META_API, buildComponents } from '../_shared/pedWaTemplateMeta.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // `wa_account_id` (opcional) submete numa WABA ESPECÍFICA — é o que a migração de
    // número usa para recriar a régua no número novo sem tocar no que ainda está no ar.
    const { template_id, wa_account_id } = await req.json().catch(() => ({}));
    if (!template_id) {
      return new Response(JSON.stringify({ ok: false, error: 'template_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: template, error: tErr } = await supabase
      .from('ped_wa_templates')
      .select('*')
      .eq('id', template_id)
      .maybeSingle();

    if (tErr) throw tErr;
    if (!template) {
      return new Response(JSON.stringify({ ok: false, error: 'Template não encontrado' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // WABA onde o template será CRIADO: a conta pedida no corpo, senão a conta dona
    // (ped_wa_templates.wa_account_id), senão a pedagógica padrão. Submeter na WABA errada
    // é o mecanismo de RECORRÊNCIA do bug do (#132001): o modelo passa a existir numa conta
    // e o envio o procura na outra. Ex.: reenviar `podcast_agenda_1` para aprovação criaria
    // uma cópia na WABA pedagógica, enquanto o envio (que resolve pela coluna) continuaria
    // apontando para a do podcast.
    let acct: { id?: string; waba_id?: string; access_token?: string } | null = null;
    const contaPedida = wa_account_id ?? template.wa_account_id;
    if (contaPedida) {
      // Token efetivo pela RPC quando a conta pedida é a EM PRODUÇÃO (ela resolve o token
      // pela conta do CRM); fora disso, lê a linha direto.
      const { data: dona } = await supabase
        .from('wa_accounts').select('id, waba_id, access_token, phone_number_id')
        .eq('id', contaPedida).eq('is_active', true).maybeSingle();
      if (dona?.waba_id) {
        let token = dona.access_token;
        // O token de system user é rotacionado na tela do CRM; quando o mesmo número existe
        // lá, ele é a fonte. Sem isto, migrar por uma linha de `wa_accounts` recém-criada
        // usaria uma cópia que envelhece.
        const { data: crmConta } = await supabase
          .from('crm_whatsapp_accounts').select('access_token')
          .eq('phone_number_id', dona.phone_number_id).eq('ativo', true).maybeSingle();
        if (crmConta?.access_token) token = crmConta.access_token;
        if (token) acct = { id: dona.id, waba_id: dona.waba_id, access_token: token };
      }
    }
    if (!acct) {
      const { data: account, error: accErr } = await supabase.rpc('get_wa_account_pedagogico');
      if (accErr) throw accErr;
      acct = Array.isArray(account) ? account[0] : account;
    }
    const waba_id = acct?.waba_id;
    const access_token = acct?.access_token;
    const contaId = acct?.id ?? null;
    if (!waba_id || !access_token) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Conta WhatsApp Pedagógico não configurada' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // A conta EM PRODUÇÃO (a que a régua usa hoje) é a única cujo resultado pode mexer na
    // linha principal de `ped_wa_templates`. Submeter numa WABA de migração só grava o
    // rastro em `ped_wa_template_contas` — senão a régua no ar cairia para "pendente_meta"
    // e o dispatcher (que filtra status='aprovado') pararia de achar o template.
    const { data: prodRow } = await supabase.rpc('get_wa_account_pedagogico');
    const prod = Array.isArray(prodRow) ? prodRow[0] : prodRow;
    const ehContaEmProducao = !contaId || contaId === prod?.id || waba_id === prod?.waba_id;

    const payload = {
      name: template.nome,
      language: template.idioma || 'pt_BR',
      category: String(template.categoria || 'utility').toUpperCase(),
      components: buildComponents(template),
    };

    const metaRes = await fetch(`${META_API}/${waba_id}/message_templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const metaBody = await metaRes.json().catch(() => ({}));

    if (!metaRes.ok || metaBody?.error) {
      if (ehContaEmProducao) {
        await supabase.from('ped_wa_templates')
          .update({ status: 'erro_meta', erro_meta: metaBody })
          .eq('id', template_id);
      }
      if (contaId) {
        await supabase.from('ped_wa_template_contas').upsert({
          template_id, wa_account_id: contaId, status: 'erro_meta', erro_meta: metaBody,
        }, { onConflict: 'template_id,wa_account_id' });
      }

      return new Response(
        JSON.stringify({ ok: false, error: metaBody?.error || metaBody }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const meta_template_id = metaBody?.id ? String(metaBody.id) : null;
    const agora = new Date().toISOString();

    if (ehContaEmProducao) {
      const { error: upErr } = await supabase
        .from('ped_wa_templates')
        .update({
          status: 'pendente_meta',
          meta_template_id,
          meta_submitted_at: agora,
          erro_meta: null,
        })
        .eq('id', template_id);
      if (upErr) throw upErr;
    }

    if (contaId) {
      await supabase.from('ped_wa_template_contas').upsert({
        template_id,
        wa_account_id: contaId,
        meta_template_id,
        status: 'pendente_meta',
        meta_submitted_at: agora,
        meta_rejected_at: null,
        meta_rejection_reason: null,
        erro_meta: null,
      }, { onConflict: 'template_id,wa_account_id' });
    }

    return new Response(
      JSON.stringify({ ok: true, meta_template_id, nome: template.nome, waba_id, em_producao: ehContaEmProducao }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
