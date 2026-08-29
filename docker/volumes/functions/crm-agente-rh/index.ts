commit 49d10628bcf818c54eeb2abc9f72f33fb9bd18f5
Author: tippgeducacao <tecnologia.inovacao@ppgeducacao.com.br>
Date:   Sat Aug 29 09:13:29 2026 -0300

    feat(rh): retomada de quem sumiu no meio da conversa
    
    O buraco entre as duas coisas que já existiam: a cadência de templates cuida de
    quem NUNCA respondeu, o agente cuida de quem está respondendo agora. Quem
    respondeu uma vez e parou não era de ninguém — ficava com a conversa pela
    metade e sumia.
    
    rh_followup_janela_tick(): enquanto a janela de 24h está aberta, retomar é de
    graça e sem template. Quem escreve é o próprio agente, com a conversa na mão
    ("faltou só me dizer a sua formação" resolve; "você está aí?" irrita), e ele
    pode responder PULAR quando não houver o que retomar.
    
    Travas, todas no SQL e não no prompt: janela aberta, a última mensagem tem que
    ser NOSSA (se ele respondeu, a bola é nossa e cutucar seria ofensivo), 90min de
    silêncio, 9h-19h de Brasília, no máximo 2 retomadas por janela. Cron criado
    DESLIGADO.
    
    Ensaio seco com os 2 candidatos reais: nenhum foi pego, porque nos dois casos
    a bola está com a gente — eles responderam e ninguém retornou desde ontem.
    
    Esconde também o checkbox "Ativar o agente de IA (João)" no funil de RH: ele
    chama crm_automacao_seed_ia, que cadastraria o candidato na base do SDR, ligaria
    o follow-up comercial em cima dele e gravaria a ÁREA como curso_interesse_original
    — justamente o dado que contamina a variável {{2}} dos templates de RH.
    
    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

diff --git a/src/components/crm-comercial/crm-v2/CrmV2AcaoCampos.tsx b/src/components/crm-comercial/crm-v2/CrmV2AcaoCampos.tsx
index 133a52112..e6d86ac59 100644
--- a/src/components/crm-comercial/crm-v2/CrmV2AcaoCampos.tsx
+++ b/src/components/crm-comercial/crm-v2/CrmV2AcaoCampos.tsx
@@ -210,6 +210,19 @@ interface CrmV2AcaoCamposProps {
   segmentos: Segmento[];
 }
 
+/**
+ * Funil de RH e Contratação. O checkbox "Ativar o agente de IA (João)" fica ESCONDIDO aqui.
+ *
+ * Ele chama `crm_automacao_seed_ia`, que cadastra a pessoa em `cliente_ppg_leads_sdr`, liga o
+ * atendimento do João e a esteira de follow-up COMERCIAL — em cima de um candidato a emprego.
+ * De quebra grava a ÁREA dele como `curso_interesse_original`, que é exatamente o dado que
+ * contamina a variável {{2}} dos templates de RH (7 dos 97 candidatos já têm isso).
+ *
+ * O agente de RH não se liga por automação: ele é ligado no NÚMERO (crm_whatsapp_accounts.
+ * agente_ia_ativo) e o webhook roteia por conta. Ver supabase/functions/crm-agente-rh.
+ */
+const FUNIL_RH_ID = "27ab7e60-7cbc-432a-b852-52597bf277b4";
+
 export function CrmV2AcaoCampos({
   acao,
   onChange,
@@ -270,20 +283,30 @@ export function CrmV2AcaoCampos({
               variaveis={acao.variaveis ?? []}
             />
           )}
-          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-violet-300 bg-violet-50 p-3 text-xs dark:border-violet-500/40 dark:bg-violet-500/10">
-            <input
-              type="checkbox"
-              className="mt-0.5 h-4 w-4 accent-violet-600"
-              checked={acao.ativarIaAposEnvio ?? false}
-              onChange={(event) => onChange({ ...acao, ativarIaAposEnvio: event.target.checked })}
-            />
-            <span>
-              <strong>Ativar o agente de IA (João) após enviar o template</strong>
-              <span className="mt-0.5 block text-[11px] text-muted-foreground">
-                A IA só é ativada depois que o WhatsApp aceitar o envio. Se o template falhar, o João não assume.
+          {funilAtualId === FUNIL_RH_ID ? (
+            <p className="rounded-lg border border-dashed p-3 text-[11px] text-muted-foreground">
+              Neste funil o agente é o <strong>de RH</strong>, e ele não se liga por automação:
+              é ligado no próprio <strong>número</strong> (CRM → WhatsApp → conta Administrativo PPG),
+              e responde sozinho quando o candidato escreve. O “ativar IA” do João fica escondido
+              aqui de propósito — ele cadastraria o candidato na base do SDR e ligaria o
+              follow-up comercial em cima de quem está se candidatando a uma vaga.
+            </p>
+          ) : (
+            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-violet-300 bg-violet-50 p-3 text-xs dark:border-violet-500/40 dark:bg-violet-500/10">
+              <input
+                type="checkbox"
+                className="mt-0.5 h-4 w-4 accent-violet-600"
+                checked={acao.ativarIaAposEnvio ?? false}
+                onChange={(event) => onChange({ ...acao, ativarIaAposEnvio: event.target.checked })}
+              />
+              <span>
+                <strong>Ativar o agente de IA (João) após enviar o template</strong>
+                <span className="mt-0.5 block text-[11px] text-muted-foreground">
+                  A IA só é ativada depois que o WhatsApp aceitar o envio. Se o template falhar, o João não assume.
+                </span>
               </span>
-            </span>
-          </label>
+            </label>
+          )}
         </div>
       );
     }
diff --git a/supabase/functions/crm-agente-rh/index.ts b/supabase/functions/crm-agente-rh/index.ts
index 0a7ee4c24..2a221e258 100644
--- a/supabase/functions/crm-agente-rh/index.ts
+++ b/supabase/functions/crm-agente-rh/index.ts
@@ -182,9 +182,12 @@ async function processar(payload: any) {
   });
   if (!pegou) { await evento('pulado:lock', { telefone }); return; }
 
+  const ehFollowup = payload?.motivo === 'followup';
+
   try {
     // Buffer: dá tempo de a pessoa terminar de escrever antes de responder.
-    await dormir(BUFFER_MS);
+    // Na cutucada não existe ninguém digitando do outro lado, então não espera.
+    if (!ehFollowup) await dormir(BUFFER_MS);
 
     // ── Lead, card e etapa, em três consultas simples ────────────────────
     // Sem embed do PostgREST de propósito: join por nome de relacionamento quebra calado
@@ -274,7 +277,15 @@ async function processar(payload: any) {
       `\n\nCONTEXTO DESTE CANDIDATO (não repita de volta para ele, use para conversar):\n` +
       `- Nome no cadastro: ${lead.nome ?? 'não informado'}\n` +
       `- Área que ele escolheu na página: ${card.titulo ?? 'não informada'}\n` +
-      `- Etapa atual: ${etapa}`;
+      `- Etapa atual: ${etapa}` +
+      (ehFollowup
+        ? `\n\nATENÇÃO: esta mensagem é uma RETOMADA, não uma resposta. A pessoa parou de ` +
+          `responder no meio da conversa e ninguém escreveu nada novo. Mande UMA mensagem ` +
+          `curta, leve e sem cobrança, retomando exatamente de onde parou — cite o que ` +
+          `faltava, se faltava algo. Nada de "você está aí?" nem de repetir o que já foi dito. ` +
+          `Se a conversa já tinha terminado bem, com tudo coletado, responda apenas a palavra ` +
+          `PULAR e mais nada.`
+        : '');
 
     let resposta = '';
     let dadosGravados: string[] = [];
@@ -313,13 +324,19 @@ async function processar(payload: any) {
     }
 
     resposta = limparResposta(resposta);
+    // Saída de emergência da cutucada: se o próprio modelo achar que não há o que retomar,
+    // é melhor o silêncio do que uma mensagem sem motivo.
+    if (ehFollowup && /^pular\.?$/i.test(resposta.trim())) {
+      await evento('followup_dispensado', { telefone, lead_id: leadId, oportunidade_id: card.id });
+      return;
+    }
     if (!resposta) {
       await evento('erro', { telefone, lead_id: leadId, oportunidade_id: card.id, motivo: 'resposta vazia' });
       return;
     }
 
     await enviar(telefone, resposta, leadId, card.id);
-    await evento('respondido', {
+    await evento(ehFollowup ? 'followup_enviado' : 'respondido', {
       telefone, lead_id: leadId, oportunidade_id: card.id, etapa,
       campos: dadosGravados, rodadas: rodada, tamanho: resposta.length,
     });
diff --git a/supabase/migrations/20260829120000_rh_followup_janela_aberta.sql b/supabase/migrations/20260829120000_rh_followup_janela_aberta.sql
new file mode 100644
index 000000000..07dc85976
--- /dev/null
+++ b/supabase/migrations/20260829120000_rh_followup_janela_aberta.sql
@@ -0,0 +1,103 @@
+-- Esteira de follow-up da JANELA ABERTA: o candidato começou a conversar e sumiu no meio.
+--
+-- É o buraco entre as duas coisas que já existem. A cadência de templates cuida de quem
+-- NUNCA respondeu; o agente cuida de quem está respondendo AGORA. Quem respondeu uma vez e
+-- parou não é atendido por nenhum dos dois: fica com a conversa pela metade e some.
+--
+-- Enquanto a janela de 24h está aberta, retomar é de graça e sem template (texto livre).
+-- Depois que ela fecha, este mecanismo se cala — quem cobra a partir daí é a cadência.
+--
+-- Quem escreve a mensagem é o próprio agente, com a conversa na mão, e não um texto fixo:
+-- "faltou só me dizer a sua formação" resolve; "você está aí?" irrita.
+--
+-- As travas, todas aqui e não no agente:
+--   • janela aberta (última entrada do candidato há menos de 24h);
+--   • a última mensagem é NOSSA (se ele respondeu, não há o que retomar);
+--   • silêncio de pelo menos 90 minutos;
+--   • horário comercial de Brasília (9h às 19h) — ninguém é cutucado de madrugada;
+--   • no máximo 2 retomadas por janela, contadas desde a última entrada dele;
+--   • só nas etapas da esteira e na Triagem.
+
+create or replace function public.rh_followup_janela_tick()
+returns jsonb
+language plpgsql
+security definer
+set search_path to 'public'
+as $fn$
+declare
+  c_funil   constant uuid := '27ab7e60-7cbc-432a-b852-52597bf277b4';
+  c_conta   constant uuid := '31d9a4ff-9606-4018-a2fb-ffb0155e099b';
+  c_silencio_min constant int := 90;
+  c_max_retomadas constant int := 2;
+  c_etapas  constant text[] := array[
+    'Inscrição Recebida','Contato 02','Contato 03','Contato 04',
+    'Contato 05','Contato 06','Contato 07','Triagem Candidato'
+  ];
+  v_base text;
+  v_hora int;
+  v_alvo record;
+  v_n int := 0;
+begin
+  v_hora := extract(hour from (now() at time zone 'America/Sao_Paulo'))::int;
+  if v_hora < 9 or v_hora >= 19 then
+    return jsonb_build_object('pulado','fora_do_horario','hora',v_hora);
+  end if;
+
+  select decrypted_secret into v_base from vault.decrypted_secrets where name = 'edge_base_url' limit 1;
+  v_base := coalesce(v_base, 'https://api.ppgeducacao.site/functions/v1');
+
+  for v_alvo in
+    with conversa as (
+      select o.id as op_id, o.lead_id, l.whatsapp,
+             right(regexp_replace(l.whatsapp,'\D','','g'),8) as fone8,
+             max(m.created_at) filter (where m.direcao='inbound')  as ultima_dele,
+             max(m.created_at) filter (where m.direcao='outbound') as ultima_nossa
+        from crm_oportunidades o
+        join crm_funis_etapas e on e.id = o.etapa_id
+        join leads l on l.id = o.lead_id
+        join crm_whatsapp_messages m
+          on m.wa_account_id = c_conta
+         and right(regexp_replace(m.telefone,'\D','','g'),8)
+           = right(regexp_replace(l.whatsapp,'\D','','g'),8)
+       where o.funil_id = c_funil
+         and o.status = 'aberta'
+         and coalesce(o.arquivada,false) = false
+         and e.nome = any(c_etapas)
+       group by o.id, o.lead_id, l.whatsapp
+    )
+    select c.* from conversa c
+     where c.ultima_dele is not null                                   -- já conversou alguma vez
+       and c.ultima_dele > now() - interval '24 hours'                 -- janela ABERTA
+       and c.ultima_nossa is not null
+       and c.ultima_nossa > c.ultima_dele                              -- a bola está com ele
+       and c.ultima_nossa < now() - make_interval(mins => c_silencio_min)
+       and (select count(*) from rh_agente_eventos ev
+             where ev.oportunidade_id = c.op_id
+               and ev.tipo in ('followup_enviado','followup_dispensado')
+               and ev.criada_em > c.ultima_dele) < c_max_retomadas
+  loop
+    perform net.http_post(
+      url := v_base || '/crm-agente-rh',
+      headers := '{"Content-Type":"application/json"}'::jsonb,
+      body := jsonb_build_object(
+        'wa_account_id', c_conta,
+        'direcao', 'inbound',
+        'from_me', false,
+        'motivo', 'followup',
+        'id', 'followup-' || v_alvo.op_id::text || '-' || extract(epoch from now())::bigint::text,
+        'telefone', v_alvo.whatsapp,
+        'conteudo', ''
+      )
+    );
+    v_n := v_n + 1;
+  end loop;
+
+  return jsonb_build_object('retomadas_disparadas', v_n, 'em', now());
+end
+$fn$;
+
+revoke all on function public.rh_followup_janela_tick() from public, anon;
+grant execute on function public.rh_followup_janela_tick() to service_role;
+
+comment on function public.rh_followup_janela_tick() is
+  'Retoma a conversa de quem respondeu e sumiu, enquanto a janela de 24h está aberta. Máx. 2 por janela, 9h-19h BRT, silêncio de 90min. O texto é do agente, não fixo.';
