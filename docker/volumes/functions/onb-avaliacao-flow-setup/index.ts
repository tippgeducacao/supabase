// onb-avaliacao-flow-setup
//
// Função de ADMIN, invocada À MÃO (curl/Postman), uma vez, para criar e publicar na Meta o
// WhatsApp Flow da Avaliação D+15 do Onboarding ("Como foram os primeiros dias…", nota 1-5 +
// comentário). Não é chamada por nenhum gatilho automático — o token do Flow publicado
// (`flow_id`) é colado à mão no botão do template `int_aluno_15_avaliacao_v2` na hora de
// submeter na Meta Business Manager. Ver docs/CRM — Integração do Aluno.md.
//
// Por que existir como edge function, e não um script local: a credencial (waba_id +
// access_token da conta Suporte ao Aluno/3250) só existe no banco, em `crm_whatsapp_accounts`
// (não `wa_accounts` — essa é do Pedagógico; conferido em 30/09/2026), e a function já roda
// com a service_role pronta.
//
// FLUXO DE USO (nessa ordem, cada chamada é manual):
//   1. POST { action: "create" }               → cria o Flow na Meta como RASCUNHO (publish:
//      false). A resposta traz `id` e `validation_errors` — é aqui que qualquer erro de
//      estrutura do flow_json aparece, sem nenhum efeito colateral pro aluno (rascunho não é
//      enviável). Corrija o FLOW_JSON abaixo e rode de novo até `validation_errors` vir vazio.
//   2. POST { action: "publish", flow_id }      → publica o Flow já validado. Só depois disso
//      ele pode ser referenciado (por `flow_id`) no botão FLOW do template.
//   3. POST { action: "status", flow_id }       → consulta status/validation_errors a qualquer
//      momento (não muda nada).
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const META_API = 'https://graph.facebook.com/v21.0';

/** Mesma conta que dispara a régua de onboarding (onb-regua-dispatch/regras.ts). */
const CONTA_SUPORTE_3250 = 'b5987306-4f73-46fb-b90a-054ad800c9ab';

/**
 * Tela única: nota 1-5 (RadioButtonsGroup) + comentário opcional (TextArea) + botão que
 * conclui o Flow (Footer, ação "complete") devolvendo os dois valores pro webhook via
 * `nfm_reply.response_json`. Sem `data_api_version`/`endpoint_uri`: o Flow é ESTÁTICO (não
 * chama servidor nenhum no meio — só na conclusão, que já é o `nfm_reply` de sempre no
 * webhook do WhatsApp), então não precisa de nenhuma edge function nova como "endpoint" do
 * Flow. A personalização (nome/curso do aluno) já acontece no CORPO do template que antecede
 * o botão — a tela do Flow fica genérica de propósito.
 *
 * ⚠️ Estrutura pouco documentada, não testada ainda contra a Meta (ver ação "create" acima):
 * o aninhamento do Footer DENTRO de Form.children é o padrão mais comum visto em exemplos
 * oficiais, mas a confirmação real vem do `validation_errors` da criação como rascunho.
 */
const FLOW_JSON = {
  version: '7.0',
  routing_model: { AVALIACAO: [] as string[] },
  screens: [
    {
      id: 'AVALIACAO',
      title: 'Avaliação',
      terminal: true,
      success: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'avaliacao_form',
            children: [
              {
                type: 'RadioButtonsGroup',
                name: 'nota',
                label: 'De 1 a 5, qual nota você dá para os seus primeiros dias como aluno?',
                required: true,
                'data-source': [
                  { id: '1', title: '1 — muito ruim' },
                  { id: '2', title: '2 — ruim' },
                  { id: '3', title: '3 — regular' },
                  { id: '4', title: '4 — bom' },
                  { id: '5', title: '5 — ótimo' },
                ],
              },
              {
                type: 'TextArea',
                name: 'comentario',
                label: 'Comentário (opcional)',
                required: false,
                'max-length': 2000,
              },
              {
                type: 'Footer',
                label: 'Enviar avaliação',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    nota: '${form.nota}',
                    comentario: '${form.comentario}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'método não suportado' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { action, flow_id } = await req.json().catch(() => ({} as Record<string, unknown>));

    // ⚠️ CONTA_SUPORTE_3250 NÃO existe em `wa_accounts` (essa tabela é do Pedagógico —
    // `submit-meta-template` resolve por lá). A conta do Suporte ao Aluno mora em
    // `crm_whatsapp_accounts` — a MESMA tabela que `get_crm_wa_account()` usa, que é por onde
    // `crm-whatsapp-send`/`onb-regua-dispatch` já mandam o D+15 hoje. Conferido direto no banco
    // em 30/09/2026: id `b5987306-...` = "Grupo PPG Educação (3250)", waba_id 529589106913028.
    const { data: dona, error: donaErr } = await admin
      .from('crm_whatsapp_accounts')
      .select('id, waba_id, access_token, phone_number_id')
      .eq('id', CONTA_SUPORTE_3250)
      .eq('ativo', true)
      .maybeSingle();
    if (donaErr) throw donaErr;
    if (!dona?.waba_id || !dona?.access_token) {
      return json({ ok: false, error: 'Conta Suporte ao Aluno (3250) não encontrada/ativa/sem token em crm_whatsapp_accounts' }, 400);
    }
    const accessToken = dona.access_token as string;
    const wabaId = dona.waba_id as string;

    if (action === 'create') {
      const metaRes = await fetch(`${META_API}/${wabaId}/flows`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'onb_avaliacao_d15',
          categories: ['SURVEY'],
          flow_json: JSON.stringify(FLOW_JSON),
          publish: false,
        }),
      });
      const body = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok || body?.error) return json({ ok: false, error: body?.error ?? body }, 400);
      return json({ ok: true, id: body?.id, validation_errors: body?.validation_errors ?? [] });
    }

    if (action === 'publish') {
      if (!flow_id) return json({ ok: false, error: 'flow_id obrigatório' }, 400);
      const metaRes = await fetch(`${META_API}/${flow_id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok || body?.error) return json({ ok: false, error: body?.error ?? body }, 400);
      return json({ ok: true, published: body?.success === true });
    }

    if (action === 'status') {
      if (!flow_id) return json({ ok: false, error: 'flow_id obrigatório' }, 400);
      const metaRes = await fetch(
        `${META_API}/${flow_id}?fields=id,name,status,validation_errors,categories`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const body = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok || body?.error) return json({ ok: false, error: body?.error ?? body }, 400);
      return json({ ok: true, flow: body });
    }

    return json({ ok: false, error: "action deve ser 'create', 'publish' ou 'status'" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return json({ ok: false, error: msg }, 500);
  }
});
