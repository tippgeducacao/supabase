import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const META_API = 'https://graph.facebook.com/v21.0';

const SAMPLES: Record<string, string> = {
  nome_professor: "João Silva",
  instituicao: "PPGVET Educação",
  pos_graduacao: "Avicultura Industrial",
  aula_titulo: "Manejo Sanitário",
  data: "15 de junho de 2026",
  horario: "19h às 22h",
  data_amanha: "16 de junho de 2026",
  data_conclusao: "15 de junho de 2026",
  data_aula: "15 de junho de 2026",
  valor: "1.500,00",
  // Lista enviada como string única (newlines preservados — Meta aceita \n no sample de BODY)
  lista_aulas: "• 15 de junho de 2026 — Pós em Reprodução Bovina\n• 22 de junho de 2026 — Pós em Bovinos de Leite\n• 06 de julho de 2026 — Pós em Bovinos de Leite",
};

const SAMPLES_URL: Record<string, string> = {
  "pos_graduacao.link_sala_meet_slug": "abc-defg-hij",
};

function fillUrlExample(url: string, urlVarsMapping: any): string | null {
  if (!url || !/\{\{\d+\}\}/.test(url)) return null;
  return url.replace(/\{\{(\d+)\}\}/g, (_m, n) => {
    const key = String(n);
    const varName = urlVarsMapping && typeof urlVarsMapping === 'object' && !Array.isArray(urlVarsMapping)
      ? String(urlVarsMapping[key] ?? '')
      : '';
    return SAMPLES_URL[varName] ?? SAMPLES[varName] ?? varName ?? `valor${key}`;
  });
}

function buildBodySamples(variaveis_mapping: any): string[] | null {
  if (!variaveis_mapping || typeof variaveis_mapping !== 'object' || Array.isArray(variaveis_mapping)) {
    return null;
  }

  const numericKeys = Object.keys(variaveis_mapping)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (numericKeys.length === 0) return null;

  const samples = numericKeys.map((key) => {
    const varName = String(variaveis_mapping[key] ?? '');
    return SAMPLES[varName] ?? varName ?? `Valor ${key}`;
  });

  return samples;
}

function buildComponents(t: any) {
  const components: any[] = [];

  if (t.header_tipo && t.header_tipo !== 'none') {
    const tipo = String(t.header_tipo).toUpperCase();
    if (tipo === 'TEXT') {
      components.push({ type: 'HEADER', format: 'TEXT', text: t.header_exemplo_url || '' });
    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(tipo)) {
      const comp: any = { type: 'HEADER', format: tipo };
      if (t.header_exemplo_url) {
        comp.example = { header_handle: [t.header_exemplo_url] };
      }
      components.push(comp);
    }
  }

  if (t.corpo) {
    const body: any = { type: 'BODY', text: t.corpo };
    const samples = buildBodySamples(t.variaveis_mapping);
    if (samples && samples.length > 0) {
      body.example = { body_text: [samples] };
    }
    components.push(body);
  }

  if (t.rodape) {
    components.push({ type: 'FOOTER', text: t.rodape });
  }

  if (Array.isArray(t.botoes) && t.botoes.length > 0) {
    const buttons = t.botoes.map((b: any) => {
      // Texto do botão: o editor salva quick-reply como { label, action };
      // CTA pode vir como { text/texto, url } ou { ..., phone_number }.
      const text = b.text ?? b.texto ?? b.label ?? b.titulo ?? '';
      const url = b.url ?? b.link;
      const phone = b.phone_number ?? b.telefone;
      // Tipo explícito (type/tipo) tem prioridade; senão infere pelo conteúdo
      // (URL/telefone) e, no caso padrão {label, action}, cai em QUICK_REPLY.
      let type = String(b.type ?? b.tipo ?? '').toUpperCase();
      if (!type) {
        if (url) type = 'URL';
        else if (phone) type = 'PHONE_NUMBER';
        else type = 'QUICK_REPLY';
      }
      const out: any = { type, text };
      if (type === 'URL' && url) {
        out.url = url;
        const filled = fillUrlExample(url, b.url_vars_mapping ?? b.variaveis_mapping);
        if (filled) out.example = [filled];
      }
      if (type === 'PHONE_NUMBER' && phone) {
        out.phone_number = phone;
      }
      return out;
    });
    components.push({ type: 'BUTTONS', buttons });
  }

  return components;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { template_id } = await req.json().catch(() => ({}));
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

    const { data: account, error: accErr } = await supabase.rpc('get_wa_account_pedagogico');
    if (accErr) throw accErr;

    const acct = Array.isArray(account) ? account[0] : account;
    const waba_id = acct?.waba_id;
    const access_token = acct?.access_token;
    if (!waba_id || !access_token) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Conta WhatsApp Pedagógico não configurada' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const components = buildComponents(template);

    const payload = {
      name: template.nome,
      language: template.idioma || 'pt_BR',
      category: String(template.categoria || 'utility').toUpperCase(),
      components,
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
      await supabase
        .from('ped_wa_templates')
        .update({
          status: 'erro_meta',
          erro_meta: metaBody,
        })
        .eq('id', template_id);

      return new Response(
        JSON.stringify({ ok: false, error: metaBody?.error || metaBody }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const meta_template_id = metaBody?.id ? String(metaBody.id) : null;

    const { error: upErr } = await supabase
      .from('ped_wa_templates')
      .update({
        status: 'pendente_meta',
        meta_template_id,
        meta_submitted_at: new Date().toISOString(),
        erro_meta: null,
      })
      .eq('id', template_id);

    if (upErr) throw upErr;

    return new Response(
      JSON.stringify({ ok: true, meta_template_id, nome: template.nome }),
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
