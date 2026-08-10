import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': "authorization, x-client-info, apikey, content-type, cache-control, pragma, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { task_id, trigger_type, old_status_id, new_status_id, user_id, tag } = body;
    // Encadeamento de automações: quando uma ação muda o status/lista da tarefa, o
    // motor re-dispara a si mesmo com o evento status_changed para que as automações
    // de "chegou no status X" também rodem. _depth limita a recursão e evita loops
    // infinitos entre automações que se acionam em cadeia/ciclo.
    const depth = Number(body._depth) || 0;
    const MAX_CHAIN_DEPTH = 5;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Get task with context
    const { data: task, error: taskErr } = await supabase
      .from('gt_tasks')
      .select('*, gt_list_statuses!gt_tasks_status_id_fkey(name, slug)')
      .eq('id', task_id)
      .single();
    if (taskErr || !task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: corsHeaders });
    }
    // Status no início — comparamos no fim para detectar se alguma ação o mudou.
    const initialStatusId = task.status_id;

    // Get list info for department
    const { data: list } = await supabase.from('gt_task_lists').select('id, name, project_id').eq('id', task.list_id).single();
    let departmentId: string | null = null;
    if (list?.project_id) {
      const { data: proj } = await supabase.from('gt_projects').select('department_id').eq('id', list.project_id).single();
      departmentId = proj?.department_id || null;
    }

    // Find matching automations
    let query = supabase
      .from('gt_automations')
      .select('*')
      .eq('is_active', true);

    // Match on list or department
    if (departmentId) {
      query = query.or(`list_id.eq.${task.list_id},department_id.eq.${departmentId}`);
    } else {
      query = query.eq('list_id', task.list_id);
    }

    const { data: automations } = await query;
    if (!automations || automations.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const autoIds = automations.map(a => a.id);
    const [triggersRes, conditionsRes, actionsRes] = await Promise.all([
      supabase.from('gt_automation_triggers').select('*').in('automation_id', autoIds),
      supabase.from('gt_automation_conditions').select('*').in('automation_id', autoIds),
      supabase.from('gt_automation_actions').select('*').in('automation_id', autoIds).order('action_order'),
    ]);

    const triggers = triggersRes.data || [];
    const conditions = conditionsRes.data || [];
    const allActions = actionsRes.data || [];

    let processed = 0;

    for (const auto of automations) {
      const trigger = triggers.find(t => t.automation_id === auto.id);
      if (!trigger || trigger.trigger_type !== trigger_type) continue;

      // Check trigger specifics
      if (trigger_type === 'status_changed') {
        if (trigger.from_status_id && trigger.from_status_id !== old_status_id) continue;
        if (trigger.to_status_id && trigger.to_status_id !== new_status_id) continue;
      }
      if ((trigger_type === 'tag_added' || trigger_type === 'tag_removed') && trigger.target_tag && trigger.target_tag !== tag) continue;

      // Check conditions
      const autConditions = conditions.filter(c => c.automation_id === auto.id);
      let conditionsMet = true;
      for (const cond of autConditions) {
        const val = cond.value || '';
        switch (cond.condition_type) {
          case 'tag':
            const tags = task.tags || [];
            if (cond.operator === 'contains' && !tags.some((t: string) => t.includes(val))) conditionsMet = false;
            if (cond.operator === 'not_contains' && tags.some((t: string) => t.includes(val))) conditionsMet = false;
            if (cond.operator === 'equals' && !tags.includes(val)) conditionsMet = false;
            break;
          case 'priority':
            if (cond.operator === 'equals' && task.priority !== val) conditionsMet = false;
            if (cond.operator === 'not_equals' && task.priority === val) conditionsMet = false;
            break;
          case 'assignee':
            if (cond.operator === 'equals' && task.assignee_id !== val) conditionsMet = false;
            if (cond.operator === 'not_equals' && task.assignee_id === val) conditionsMet = false;
            break;
          case 'is_overdue':
            const overdue = task.due_date && new Date(task.due_date) < new Date() && !task.completed_at;
            if (cond.operator === 'equals' && !overdue) conditionsMet = false;
            if (cond.operator === 'not_equals' && overdue) conditionsMet = false;
            break;
          case 'custom_field': {
            const fieldId = cond.field_name;
            if (!fieldId) { conditionsMet = false; break; }
            // Carrega definição do campo + valor atual
            const { data: fieldDef } = await supabase
              .from('gt_custom_fields')
              .select('id, field_type')
              .eq('id', fieldId)
              .maybeSingle();
            const { data: cfv } = await supabase
              .from('gt_custom_field_values')
              .select('value_text, value_number, value_date, value_json')
              .eq('task_id', task_id)
              .eq('field_id', fieldId)
              .maybeSingle();
            let actual: any = null;
            if (cfv) {
              actual = cfv.value_text ?? cfv.value_number ?? cfv.value_date ?? cfv.value_json;
            }
            const actualStr = actual === null || actual === undefined ? '' : String(actual);
            if (cond.operator === 'is_empty' && actualStr !== '') conditionsMet = false;
            if (cond.operator === 'is_not_empty' && actualStr === '') conditionsMet = false;
            if (cond.operator === 'equals' && actualStr !== val) conditionsMet = false;
            if (cond.operator === 'not_equals' && actualStr === val) conditionsMet = false;
            if (cond.operator === 'contains' && !actualStr.includes(val)) conditionsMet = false;
            break;
          }
        }
        if (!conditionsMet) break;
      }
      if (!conditionsMet) continue;

      // Execute actions
      const autActions = allActions.filter(a => a.automation_id === auto.id).sort((a, b) => a.action_order - b.action_order);
      const executedActions: any[] = [];
      let notifiedThisAutomation = false;
      // Uma tarefa vive em UMA lista só. Se a automação tem vários "Mover para
      // outro espaço/lista", o 1º move a tarefa original e os demais recebem uma
      // CÓPIA — senão cada move sobrescreve o anterior e só o último destino fica.
      let moveToListCount = 0;

      for (const action of autActions) {
        const cfg = action.config || {};
        try {
          switch (action.action_type) {
            case 'change_status':
              await supabase.from('gt_tasks').update({ status_id: cfg.status_id }).eq('id', task_id);
              executedActions.push({ type: 'change_status', status: 'success' });
              break;
            case 'move_to_list': {
              if (!cfg.list_id) {
                executedActions.push({ type: 'move_to_list', status: 'failed', error: 'list_id ausente' });
                break;
              }
              moveToListCount++;
              // 2º destino em diante: copia a tarefa em vez de mover (uma tarefa
              // não pode estar em várias listas ao mesmo tempo).
              if (moveToListCount > 1) {
                const copy = await copyTaskToList(supabase, task, task_id, cfg.list_id, cfg.status_id);
                if (copy.ok) {
                  executedActions.push({ type: 'move_to_list', status: 'success', list_id: cfg.list_id, status_id: copy.status_id, copied: true, new_task_id: copy.id });
                } else {
                  executedActions.push({ type: 'move_to_list', status: 'failed', error: copy.error || 'cópia falhou', list_id: cfg.list_id });
                }
                break;
              }
              const update: any = { list_id: cfg.list_id };

              // Resolver status_id na nova lista (cada lista tem seus próprios status)
              let targetStatusId: string | null = cfg.status_id || null;
              if (targetStatusId) {
                // Garantir que o status pertence à lista de destino
                const { data: chk } = await supabase
                  .from('gt_list_statuses')
                  .select('id')
                  .eq('id', targetStatusId)
                  .eq('list_id', cfg.list_id)
                  .maybeSingle();
                if (!chk) targetStatusId = null;
              }
              let targetStatusIsDone = false;
              if (!targetStatusId) {
                const { data: firstStatus } = await supabase
                  .from('gt_list_statuses')
                  .select('id, is_done')
                  .eq('list_id', cfg.list_id)
                  .order('sort_order', { ascending: true })
                  .limit(1)
                  .maybeSingle();
                targetStatusId = firstStatus?.id || null;
                targetStatusIsDone = !!firstStatus?.is_done;
              } else {
                const { data: targetStatus } = await supabase
                  .from('gt_list_statuses')
                  .select('is_done')
                  .eq('id', targetStatusId)
                  .maybeSingle();
                targetStatusIsDone = !!targetStatus?.is_done;
              }
              if (targetStatusId) update.status_id = targetStatusId;
              if (!targetStatusIsDone) update.completed_at = null;

              const { error: moveErr } = await supabase.from('gt_tasks').update(update).eq('id', task_id);
              if (moveErr) {
                executedActions.push({ type: 'move_to_list', status: 'failed', error: moveErr.message });
              } else {
                // De ONDE a tarefa saiu — é o que permite desfazer o envio pela
                // tela (gt_automacao_desfazer_move). Sem isso a origem só pode
                // ser INFERIDA da automação, o que falha em automação de funil.
                // ⚠️ O status de volta é o ANTERIOR ao gatilho (old_status_id),
                // nunca o que disparou: voltar para o status disparador deixaria
                // a tarefa a um passo de ser reenviada.
                executedActions.push({
                  type: 'move_to_list', status: 'success',
                  list_id: cfg.list_id, status_id: targetStatusId,
                  from_list_id: task.list_id ?? null,
                  from_status_id: old_status_id ?? trigger?.from_status_id ?? null,
                });
              }
              break;
            }
            case 'change_assignee':
              await supabase.from('gt_tasks').update({ assignee_id: cfg.user_id }).eq('id', task_id);
              executedActions.push({ type: 'change_assignee', status: 'success' });
              break;
            case 'change_priority':
              await supabase.from('gt_tasks').update({ priority: cfg.priority }).eq('id', task_id);
              executedActions.push({ type: 'change_priority', status: 'success' });
              break;
            case 'change_due_date': {
              const triggerTs = new Date().toISOString();
              const offset = parseInt(cfg.offset_days) || 0;
              let newDueDate: string | null = null;
              const addDays = (iso: string, days: number) => {
                const d = new Date(iso);
                d.setDate(d.getDate() + days);
                return d.toISOString().slice(0, 10);
              };
              switch (cfg.mode) {
                case 'clear':
                  newDueDate = null;
                  break;
                case 'fixed':
                  newDueDate = cfg.date || null;
                  break;
                case 'trigger_date':
                  newDueDate = triggerTs.slice(0, 10);
                  break;
                case 'trigger_datetime':
                  newDueDate = triggerTs;
                  break;
                case 'from_field': {
                  const src = (task as any)?.[cfg.source_field];
                  const baseIso = src ? new Date(src).toISOString() : triggerTs;
                  newDueDate = addDays(baseIso, offset);
                  break;
                }
                case 'offset_from_trigger':
                case 'offset':
                default:
                  newDueDate = addDays(triggerTs, offset || 7);
              }
              await supabase.from('gt_tasks').update({ due_date: newDueDate }).eq('id', task_id);
              executedActions.push({ type: 'change_due_date', status: 'success' });
              break;
            }
            case 'add_tag': {
              const currentTags = task.tags || [];
              if (!currentTags.includes(cfg.tag)) {
                await supabase.from('gt_tasks').update({ tags: [...currentTags, cfg.tag] }).eq('id', task_id);
              }
              executedActions.push({ type: 'add_tag', status: 'success' });
              break;
            }
            case 'remove_tag': {
              const filteredTags = (task.tags || []).filter((t: string) => t !== cfg.tag);
              await supabase.from('gt_tasks').update({ tags: filteredTags }).eq('id', task_id);
              executedActions.push({ type: 'remove_tag', status: 'success' });
              break;
            }
            case 'add_comment': {
              const text = replaceVariables(cfg.content || '', task, { user_id, type: trigger_type });
              await supabase.from('gt_task_comments').insert({ task_id, user_id: null, content: text });
              executedActions.push({ type: 'add_comment', status: 'success' });
              break;
            }
            case 'send_notification': {
              const recipients = await resolveRecipients(supabase, cfg, task);
              const title = replaceVariables(cfg.title || auto.name || 'Automação executada', task, { user_id, type: trigger_type });
              const body = replaceVariables(cfg.message || '', task, { user_id, type: trigger_type });
              for (const rid of recipients) {
                await supabase.from('gt_notifications').insert({
                  user_id: rid,
                  type: 'automation',
                  title,
                  body,
                  link: `/?gt=task:${task_id}`,
                  reference_type: 'task',
                  reference_id: task_id,
                  actor_id: user_id || null,
                  category: 'primary',
                });
              }
              notifiedThisAutomation = true;
              executedActions.push({ type: 'send_notification', status: 'success', recipients: recipients.length });
              break;
            }
            case 'create_task': {
              await supabase.from('gt_tasks').insert({
                list_id: cfg.list_id || task.list_id,
                title: replaceVariables(cfg.title || 'Nova tarefa', task, { user_id, type: trigger_type }),
                assignee_id: cfg.assignee_id || null,
                priority: cfg.priority || 'normal',
                due_date: cfg.due_date_offset ? new Date(Date.now() + (cfg.due_date_offset) * 86400000).toISOString().slice(0, 10) : null,
                description: replaceVariables(cfg.description || '', task, { user_id, type: trigger_type }),
                created_by: null,
                reporter_id: task.reporter_id,
                source_task_id: task_id,
                tags: [],
                sort_order: 0,
              });
              executedActions.push({ type: 'create_task', status: 'success' });
              break;
            }
            case 'duplicate_task': {
              try {
                const targetListId = cfg.list_id || task.list_id;
                // Resolve status for target list
                let dupStatusId: string | null = cfg.status_id || null;
                if (dupStatusId) {
                  const { data: chk } = await supabase
                    .from('gt_list_statuses')
                    .select('id').eq('id', dupStatusId).eq('list_id', targetListId).maybeSingle();
                  if (!chk) dupStatusId = null;
                }
                if (!dupStatusId) {
                  const { data: firstStatus } = await supabase
                    .from('gt_list_statuses')
                    .select('id').eq('list_id', targetListId)
                    .order('sort_order', { ascending: true }).limit(1).maybeSingle();
                  dupStatusId = firstStatus?.id || null;
                }
                const suffix = cfg.title_suffix ?? ' (cópia)';
                const copyTags = cfg.copy_tags !== false;
                const copyAssignees = cfg.copy_assignees !== false;
                const copySubtasks = cfg.copy_subtasks === true;

                const { data: newTask, error: dupErr } = await supabase
                  .from('gt_tasks')
                  .insert({
                    list_id: targetListId,
                    status_id: dupStatusId,
                    title: `${task.title || 'Tarefa'}${suffix}`,
                    description: task.description || null,
                    priority: task.priority || 'normal',
                    due_date: task.due_date || null,
                    start_date: task.start_date || null,
                    tags: copyTags ? (task.tags || []) : [],
                    assignee_id: copyAssignees ? task.assignee_id : null,
                    reporter_id: task.reporter_id,
                    source_task_id: task_id,
                    created_by: null,
                    sort_order: 0,
                  })
                  .select('id')
                  .single();
                if (dupErr || !newTask) {
                  executedActions.push({ type: 'duplicate_task', status: 'failed', error: dupErr?.message || 'insert failed' });
                  break;
                }

                if (copyAssignees) {
                  const { data: assignees } = await supabase
                    .from('gt_task_assignees').select('user_id').eq('task_id', task_id);
                  const rows = (assignees || []).filter((a: any) => a.user_id).map((a: any) => ({ task_id: newTask.id, user_id: a.user_id }));
                  if (rows.length) await supabase.from('gt_task_assignees').insert(rows);
                }

                if (copySubtasks) {
                  const { data: subs } = await supabase
                    .from('gt_tasks').select('title, description, priority, tags, assignee_id, sort_order').eq('parent_task_id', task_id);
                  if (subs && subs.length) {
                    const subRows = subs.map((s: any) => ({
                      list_id: targetListId,
                      status_id: dupStatusId,
                      parent_task_id: newTask.id,
                      title: s.title,
                      description: s.description,
                      priority: s.priority || 'normal',
                      tags: s.tags || [],
                      assignee_id: copyAssignees ? s.assignee_id : null,
                      reporter_id: task.reporter_id,
                      sort_order: s.sort_order || 0,
                      created_by: null,
                    }));
                    await supabase.from('gt_tasks').insert(subRows);
                  }
                }

                executedActions.push({ type: 'duplicate_task', status: 'success', new_task_id: newTask.id, list_id: targetListId });
              } catch (e) {
                executedActions.push({ type: 'duplicate_task', status: 'failed', error: String(e) });
              }
              break;
            }
            case 'send_webhook': {
              const url = cfg.webhook_url;
              const method = cfg.webhook_method || 'POST';
              const body = replaceVariables(cfg.webhook_body || '{}', task, { user_id, type: trigger_type });
              try {
                const resp = await fetch(url, {
                  method,
                  headers: { 'Content-Type': 'application/json' },
                  body: method !== 'GET' ? body : undefined,
                });
                executedActions.push({ type: 'send_webhook', status: resp.ok ? 'success' : 'failed', http_status: resp.status });
              } catch (e) {
                executedActions.push({ type: 'send_webhook', status: 'failed', error: String(e) });
              }
              break;
            }
            case 'send_email': {
              try {
                if (!cfg.template_id) {
                  executedActions.push({ type: 'send_email', status: 'failed', error: 'template_id ausente' });
                  break;
                }
                // Nome do template para registro no histórico
                const { data: tpl } = await supabase
                  .from('email_templates')
                  .select('nome, remetente_id')
                  .eq('id', cfg.template_id)
                  .maybeSingle();
                const templateName = tpl?.nome || 'Template';
                const remetenteId = cfg.remetente_id || tpl?.remetente_id || null;

                // Resolver destinatário
                let recipientEmail: string | null = null;
                const source = cfg.recipient_source || 'custom_field';
                if (source === 'fixed') {
                  recipientEmail = cfg.recipient_email || null;
                } else if (source === 'custom_field' && cfg.recipient_field) {
                  const { data: cfv } = await supabase
                    .from('gt_custom_field_values')
                    .select('value_text')
                    .eq('task_id', task_id)
                    .eq('field_id', cfg.recipient_field)
                    .maybeSingle();
                  recipientEmail = cfv?.value_text || null;
                } else if (source === 'assignee') {
                  const targetUserId = task.assignee_id;
                  if (targetUserId) {
                    const { data: prof } = await supabase.from('profiles').select('email').eq('user_id', targetUserId).maybeSingle();
                    recipientEmail = prof?.email || null;
                  }
                } else if (source === 'reporter') {
                  if (task.reporter_id) {
                    const { data: prof } = await supabase.from('profiles').select('email').eq('user_id', task.reporter_id).maybeSingle();
                    recipientEmail = prof?.email || null;
                  }
                }

                if (!recipientEmail) {
                  executedActions.push({ type: 'send_email', status: 'failed', error: 'destinatário não resolvido', template_name: templateName, label: `email "${templateName}" não enviado (sem destinatário)` });
                  break;
                }

                // Chama email-send via fetch interno usando service role
                const sendRes = await fetch(`${supabaseUrl}/functions/v1/email-send`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serviceKey}`,
                  },
                  body: JSON.stringify({
                    template_id: cfg.template_id,
                    remetente_id: remetenteId,
                    destinatario_email: recipientEmail,
                    automacao_id: auto.id,
                    contexto_tipo: 'gt_task',
                    contexto_id: task_id,
                    idempotencia_key: `auto-${auto.id}-${task_id}-${cfg.template_id}`,
                    variaveis: {
                      'task.title': task.title || '',
                      'task.id': task.id || '',
                      'task.status': task.gt_list_statuses?.name || '',
                    },
                  }),
                });
                const sendData = await sendRes.json().catch(() => ({}));
                if (sendRes.ok) {
                  executedActions.push({
                    type: 'send_email',
                    status: 'success',
                    template_id: cfg.template_id,
                    template_name: templateName,
                    recipient: recipientEmail,
                    log_id: sendData?.log_id,
                    duplicado: sendData?.duplicado || false,
                    label: sendData?.duplicado
                      ? `email "${templateName}" já enviado (idempotência)`
                      : `email "${templateName}" enviado para ${recipientEmail}`,
                  });
                } else {
                  executedActions.push({
                    type: 'send_email',
                    status: 'failed',
                    template_name: templateName,
                    error: sendData?.error || `HTTP ${sendRes.status}`,
                    label: `falha ao enviar email "${templateName}"`,
                  });
                }
              } catch (e) {
                executedActions.push({ type: 'send_email', status: 'failed', error: String(e) });
              }
              break;
            }
          }
        } catch (e) {
          executedActions.push({ type: action.action_type, status: 'failed', error: String(e) });
        }
      }

      // Auto-notify all assignees if no explicit send_notification action ran
      if (!notifiedThisAutomation) {
        try {
          const recipientSet = new Set<string>(
            await resolveRecipients(supabase, { recipient: 'all_assignees' }, task)
          );

          // Build destination breadcrumb for any move_to_list actions
          let moveSummary = '';
          const moveActions = executedActions.filter((a: any) => a.type === 'move_to_list' && a.status === 'success');
          if (moveActions.length > 0) {
            // Always notify whoever triggered the move — they may not have access
            // to the destination space and otherwise the task appears to vanish.
            if (user_id) recipientSet.add(user_id);
            try {
              const destListId = moveActions[0].list_id;
              const { data: destList } = await supabase
                .from('gt_task_lists')
                .select('name, project_id')
                .eq('id', destListId)
                .maybeSingle();
              let projName = '';
              let deptName = '';
              if (destList?.project_id) {
                const { data: destProj } = await supabase
                  .from('gt_projects')
                  .select('name, department_id')
                  .eq('id', destList.project_id)
                  .maybeSingle();
                projName = destProj?.name || '';
                if (destProj?.department_id) {
                  const { data: destDept } = await supabase
                    .from('gt_departments')
                    .select('name')
                    .eq('id', destProj.department_id)
                    .maybeSingle();
                  deptName = destDept?.name || '';
                }
              }
              const breadcrumb = [deptName, projName, destList?.name].filter(Boolean).join(' › ');
              if (breadcrumb) moveSummary = ` Destino: ${breadcrumb}.`;
            } catch (e) {
              console.warn('move destination breadcrumb failed', e);
            }
          }

          const recipients = Array.from(recipientSet);
          const summary = executedActions
            .filter((a: any) => a.status === 'success')
            .map((a: any) => a.label || actionLabelPt(a.type))
            .filter(Boolean)
            .join(', ');
          for (const rid of recipients) {
            await supabase.from('gt_notifications').insert({
              user_id: rid,
              type: 'automation',
              title: auto.name || 'Automação executada',
              body: (summary
                ? `Automação executada na tarefa "${task.title}": ${summary}`
                : `Automação executada na tarefa "${task.title}"`) + moveSummary,
              link: `/?gt=task:${task_id}`,
              reference_type: 'task',
              reference_id: task_id,
              actor_id: user_id || null,
              category: 'primary',
            });
          }
          executedActions.push({ type: 'auto_notify_assignees', status: 'success', recipients: recipients.length });
        } catch (e) {
          console.error('auto_notify_assignees failed', e);
          executedActions.push({ type: 'auto_notify_assignees', status: 'failed', error: String(e) });
        }
      }


      // Log execution
      await supabase.from('gt_automation_logs').insert({
        automation_id: auto.id,
        task_id,
        actions_executed: executedActions,
        status: executedActions.every(a => a.status === 'success') ? 'success' : 'failed',
      });

      // Register in task activity feed so users see automation runs
      try {
        const summary = executedActions
          .filter((a: any) => a.status === 'success')
          .map((a: any) => a.label || actionLabelPt(a.type))
          .filter(Boolean)
          .join(', ');
        await supabase.from('gt_activity_log').insert({
          task_id,
          user_id: null,
          action: 'automation_executed',
          new_value: auto.name || 'Automação',
          metadata: {
            automation_id: auto.id,
            automation_name: auto.name,
            trigger_type,
            actions: executedActions,
            summary,
          },
        });
      } catch (e) {
        console.warn('activity log insert failed', e);
      }

      // Update counters
      await supabase.from('gt_automations').update({
        execution_count: (auto.execution_count || 0) + 1,
        last_executed_at: new Date().toISOString(),
      }).eq('id', auto.id);

      processed++;
    }

    // Encadeamento: se alguma ação mudou o status da tarefa (change_status ou
    // move_to_list — que escrevem direto no banco, sem passar pelo front), re-dispara
    // o motor com status_changed para que automações de chegada no novo status rodem.
    // Re-busca o status atual porque move_to_list resolve o status na lista de destino.
    if (processed > 0 && depth < MAX_CHAIN_DEPTH) {
      try {
        const { data: fresh } = await supabase
          .from('gt_tasks')
          .select('status_id')
          .eq('id', task_id)
          .maybeSingle();
        const newStatusId = fresh?.status_id || null;
        if (newStatusId && newStatusId !== initialStatusId) {
          await fetch(`${supabaseUrl}/functions/v1/automation-engine`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              task_id,
              trigger_type: 'status_changed',
              old_status_id: initialStatusId,
              new_status_id: newStatusId,
              user_id: user_id || null,
              _depth: depth + 1,
            }),
          });
        }
      } catch (e) {
        console.error('automation chain re-dispatch failed', e);
      }
    }

    return new Response(JSON.stringify({ processed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Automation engine error:', error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function replaceVariables(template: string, task: any, trigger: any): string {
  const statusName = task.gt_list_statuses?.name || '';
  return template
    .replace(/\{\{task\.id\}\}/g, task.id || '')
    .replace(/\{\{task\.title\}\}/g, task.title || '')
    .replace(/\{\{task\.description\}\}/g, task.description || '')
    .replace(/\{\{task\.status\}\}/g, statusName)
    .replace(/\{\{task\.priority\}\}/g, task.priority || '')
    .replace(/\{\{task\.due_date\}\}/g, task.due_date || '')
    .replace(/\{\{task\.start_date\}\}/g, task.start_date || '')
    .replace(/\{\{task\.tags\}\}/g, JSON.stringify(task.tags || []))
    .replace(/\{\{task\.url\}\}/g, `/app/task/${task.id}`)
    .replace(/\{\{trigger\.user\.name\}\}/g, trigger.user_name || '')
    .replace(/\{\{trigger\.user\.email\}\}/g, trigger.user_email || '')
    .replace(/\{\{trigger\.timestamp\}\}/g, new Date().toISOString())
    .replace(/\{\{trigger\.type\}\}/g, trigger.type || '')
    .replace(/\{\{task\.cf\.(\w+)\}\}/g, (_match: string, fieldSlug: string) => {
      const cfv = task.custom_field_values || {};
      return cfv[fieldSlug] || '';
    });
}

// Copia uma tarefa para outra lista, resolvendo o status de destino e
// replicando os responsáveis. Usado quando uma automação tem vários
// "Mover para outro espaço/lista" (o 1º move, os demais copiam).
async function copyTaskToList(
  supabase: any,
  task: any,
  sourceTaskId: string,
  targetListId: string,
  cfgStatusId?: string | null,
): Promise<{ ok: boolean; id?: string; status_id?: string | null; error?: string }> {
  try {
    // Resolver status_id válido na lista de destino (cada lista tem seus status)
    let statusId: string | null = cfgStatusId || null;
    if (statusId) {
      const { data: chk } = await supabase
        .from('gt_list_statuses')
        .select('id')
        .eq('id', statusId)
        .eq('list_id', targetListId)
        .maybeSingle();
      if (!chk) statusId = null;
    }
    if (!statusId) {
      const { data: firstStatus } = await supabase
        .from('gt_list_statuses')
        .select('id')
        .eq('list_id', targetListId)
        .order('sort_order', { ascending: true })
        .limit(1)
        .maybeSingle();
      statusId = firstStatus?.id || null;
    }

    const { data: newTask, error } = await supabase
      .from('gt_tasks')
      .insert({
        list_id: targetListId,
        status_id: statusId,
        title: task.title || 'Tarefa',
        description: task.description || null,
        priority: task.priority || 'normal',
        due_date: task.due_date || null,
        start_date: task.start_date || null,
        tags: task.tags || [],
        assignee_id: task.assignee_id,
        reporter_id: task.reporter_id,
        source_task_id: sourceTaskId,
        created_by: null,
        sort_order: 0,
      })
      .select('id')
      .single();
    if (error || !newTask) return { ok: false, error: error?.message || 'insert falhou' };

    // Replicar responsáveis (tabela N:N)
    const { data: assignees } = await supabase
      .from('gt_task_assignees')
      .select('user_id')
      .eq('task_id', sourceTaskId);
    const rows = (assignees || [])
      .filter((a: any) => a.user_id)
      .map((a: any) => ({ task_id: newTask.id, user_id: a.user_id }));
    if (rows.length) await supabase.from('gt_task_assignees').insert(rows);

    return { ok: true, id: newTask.id, status_id: statusId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function resolveRecipients(supabase: any, cfg: any, task: any): Promise<string[]> {
  const recipient = cfg?.recipient || 'all_assignees';
  const ids = new Set<string>();

  if (recipient === 'all_assignees' || recipient === 'assignee') {
    const { data: assignees } = await supabase
      .from('gt_task_assignees')
      .select('user_id')
      .eq('task_id', task.id);
    (assignees || []).forEach((a: any) => a.user_id && ids.add(a.user_id));
    if (task.assignee_id) ids.add(task.assignee_id);
    if (recipient === 'assignee' && ids.size > 1) {
      // keep just one for legacy semantics
      const first = Array.from(ids)[0];
      ids.clear(); ids.add(first);
    }
  } else if (recipient === 'reporter') {
    if (task.reporter_id) ids.add(task.reporter_id);
  } else if (recipient === 'watchers') {
    const { data: watchers } = await supabase
      .from('gt_task_watchers')
      .select('user_id')
      .eq('task_id', task.id);
    (watchers || []).forEach((w: any) => w.user_id && ids.add(w.user_id));
  } else if (recipient === 'specific_user' || cfg?.user_id) {
    if (cfg.user_id) ids.add(cfg.user_id);
  }

  return Array.from(ids);
}

function actionLabelPt(t: string): string {
  const map: Record<string, string> = {
    change_status: 'status alterado',
    move_to_list: 'movida de lista',
    change_assignee: 'responsável alterado',
    change_priority: 'prioridade alterada',
    change_due_date: 'data alterada',
    add_tag: 'tag adicionada',
    remove_tag: 'tag removida',
    add_comment: 'comentário adicionado',
    send_notification: 'notificação enviada',
    send_email: 'email enviado',
    create_task: 'nova tarefa criada',
    duplicate_task: 'tarefa duplicada',
    send_webhook: 'webhook disparado',
  };
  return map[t] || '';
}
