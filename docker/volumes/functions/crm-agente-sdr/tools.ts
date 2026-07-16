// Executores das tools do agente SDR — port fiel dos subfluxos do n8n:
//   consulta_disponibilidade  → GET  sdr-api/disponibilidade (limite 6) + formatação Brasília
//   confirmar_agendamento     → POST sdr-api/agendamentos → evento GCal c/ Meet → PATCH link_reuniao
//   verificar_compatibilidade → LLM (matriz cursos_pos_graduacao) + validador de código
//   consulta_objecoes         → Voyage (query) → match_ppg_voyage top-1
//   envia_informacoes         → POST sdr-api/envia-informacoes + contrato de retorno
//   pausa_ia                  → RPC crm_set_pausa_ia + followup_ativado=false
//   temporizador_proxima_turma→ RPC crm_agente_timer_proxima_turma (timer de recontato
//                               com a data REAL da próxima turma) + pausa da IA
//   consulta_pos_disponiveis  → catálogo de pós ativas (cursos) + troca do curso de
//                               interesse do lead (fn_sdr_api_resolver_pos_graduacao)
// Todo output inclui o id do tool_use (mesmo formato que o n8n devolvia ao Claude).

// deno-lint-ignore-file no-explicit-any
import { MATRIZ_SYSTEM, MATRIZ_USER_TEMPLATE } from './prompts.ts';
import { renderPrompt } from './contexto.ts';
import { atualizarLead, buscarLead } from './historico.ts';
import { chamarAnthropic } from './agente.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SDR_API_URL = (Deno.env.get('AGENTE_SDR_SDRAPI_URL') ?? `${SUPABASE_URL}/functions/v1/sdr-api`).replace(/\/$/, '');
const SDR_API_KEY = Deno.env.get('AGENTE_SDR_SDRAPI_KEY') ?? '';
const VOYAGE_KEY = Deno.env.get('AGENTE_SDR_VOYAGE_KEY') ?? Deno.env.get('VOYAGE_API_KEY') ?? '';
const MODELO_MATRIZ = Deno.env.get('AGENTE_SDR_MODEL_MATRIZ') ?? 'claude-sonnet-4-6';
// Integração (calendar_integrations) da conta Workspace com acesso às agendas dos
// monitores — equivalente à credencial "Workspace PPG" do n8n.
const GCAL_INTEGRATION_ID = Deno.env.get('AGENTE_SDR_GCAL_INTEGRATION_ID') ?? '';
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ?? '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') ?? '';

export type CtxConversa = {
  remotejid: string;
  telefone: string;            // só dígitos, sem @s.whatsapp.net
  waAccountId: string | null;
  leadId: string | null;
  oportunidadeId: string | null;
};

function sdrApi(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SDR_API_URL}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SDR_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

// Brasília = UTC-3 fixo (sem horário de verão desde 2019).
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

// Dia da semana computado em CÓDIGO e entregue pronto nas tools — o LLM erra conta de
// calendário (caso real: confirmou "Segunda, 07/07/2026" sendo terça). Nunca deixar o
// modelo derivar o dia da semana sozinho.
const DIA_SEMANA_BR = [
  'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sábado',
];

function toBrasilia(isoUtc: string) {
  const br = new Date(new Date(isoUtc).getTime() - BR_OFFSET_MS);
  const hh = pad(br.getUTCHours());
  const mm = pad(br.getUTCMinutes());
  return {
    data: `${br.getUTCFullYear()}-${pad(br.getUTCMonth() + 1)}-${pad(br.getUTCDate())}`,
    horario: `${hh}:${mm}`,
    display: mm === '00' ? `${hh}h` : `${hh}h${mm}`,
    diaSemana: DIA_SEMANA_BR[br.getUTCDay()],
  };
}

function toBrasiliaISO(isoUtc: string): string {
  const br = new Date(new Date(isoUtc).getTime() - BR_OFFSET_MS);
  return `${br.getUTCFullYear()}-${pad(br.getUTCMonth() + 1)}-${pad(br.getUTCDate())}` +
    `T${pad(br.getUTCHours())}:${pad(br.getUTCMinutes())}:${pad(br.getUTCSeconds())}-03:00`;
}

function formataBrasiliaDataHora(isoUtc: string): string {
  const br = new Date(new Date(isoUtc).getTime() - BR_OFFSET_MS);
  return `${DIA_SEMANA_BR[br.getUTCDay()]}, ${pad(br.getUTCDate())}/${pad(br.getUTCMonth() + 1)}/${br.getUTCFullYear()}` +
    ` às ${pad(br.getUTCHours())}:${pad(br.getUTCMinutes())}`;
}

// ── consulta_disponibilidade ────────────────────────────────────────────────
async function consultaDisponibilidade(input: any, toolUseId: string) {
  const qs = new URLSearchParams({ pos: input.curso_escolhido ?? '', limite: '6' });
  if (input.data_desejada) qs.set('data', input.data_desejada);
  if (input.periodo_desejado) qs.set('periodo', input.periodo_desejado);
  if (input.horario_inicio_desejado) qs.set('horario_inicio', input.horario_inicio_desejado);

  // Consulta com 1 retry. A sdr-api às vezes falha/cold-start; SEM distinguir erro de
  // agenda vazia, a ferramenta retornava [] e o agente dizia "sem horário" (mentira)
  // ao lead, mesmo com a agenda cheia. Agora: erro técnico ≠ ausência de horário.
  let res: Response | null = null;
  let resultado: any = {};
  let erroTecnico: string | null = null;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      res = await sdrApi(`disponibilidade?${qs.toString()}`);
      resultado = await res.json().catch(() => ({}));
      if (res.ok && resultado?.success !== false) { erroTecnico = null; break; }
      erroTecnico = `HTTP ${res.status}${resultado?.error ? ` — ${resultado.error}` : ''}`;
    } catch (e) {
      erroTecnico = (e as Error).message;
    }
    if (tentativa < 2) await new Promise((r) => setTimeout(r, 600));
  }

  // Falha técnica (≠ agenda vazia): NÃO dizer ao lead que não há horários. Instrui o
  // agente a tentar de novo / não inventar indisponibilidade.
  if (erroTecnico) {
    return {
      resultado: 'ERRO ao consultar a agenda (falha técnica, NÃO é falta de horário). ' +
        'NÃO diga ao lead que não há horários nem que a agenda fechou. Tente consultar de novo; ' +
        'se persistir, diga que vai confirmar com o time e já retorna.',
      erro: erroTecnico,
      slots_raw: [],
      id: toolUseId,
    };
  }

  const slots: any[] = resultado.data?.slots || resultado.slots || [];

  let conteudo: string;
  if (!slots.length) {
    conteudo = 'Nenhum horário disponível para o período solicitado.';
  } else {
    const formatted = slots.map((s) => {
      const brt = toBrasilia(s.inicio);
      return `- ${brt.display} de ${brt.diaSemana}, dia ${brt.data} (vendedor_id: ${s.vendedor_id}, nome: ${s.vendedor_nome})`;
    });
    conteudo = `Horários disponíveis (Brasília):\n${formatted.join('\n')}\n` +
      `(O dia da semana informado acima é o correto — use-o exatamente, não recalcule.)`;
  }

  return {
    resultado: conteudo,
    slots_raw: slots.map((s) => {
      const brt = toBrasilia(s.inicio);
      return { data: brt.data, dia_semana: brt.diaSemana, horario: brt.horario, vendedor_id: s.vendedor_id, vendedor_nome: s.vendedor_nome };
    }),
    id: toolUseId,
  };
}

// ── confirmar_agendamento (POST → GCal+Meet → PATCH link) ───────────────────
async function gcalToken(supabase: any): Promise<string> {
  if (!GCAL_INTEGRATION_ID) throw new Error('AGENTE_SDR_GCAL_INTEGRATION_ID não configurado');
  const { data: integ, error } = await supabase
    .from('calendar_integrations')
    .select('id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at, is_active')
    .eq('id', GCAL_INTEGRATION_ID)
    .maybeSingle();
  if (error || !integ) throw new Error('Integração Google do agente não encontrada');
  if (!integ.is_active) throw new Error('Integração Google do agente desativada');

  const expiraEm = integ.oauth_token_expires_at ? new Date(integ.oauth_token_expires_at).getTime() : 0;
  if (integ.oauth_access_token && expiraEm - Date.now() > 60_000) return integ.oauth_access_token;
  if (!integ.oauth_refresh_token) throw new Error('Integração Google sem refresh token');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: integ.oauth_refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`refresh do token Google falhou: ${JSON.stringify(json)}`);
  await supabase.from('calendar_integrations')
    .update({
      oauth_access_token: json.access_token,
      oauth_token_expires_at: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    })
    .eq('id', integ.id);
  return json.access_token;
}

async function criarEventoMeet(supabase: any, opts: {
  calendarId: string; startISO: string; endISO: string; summary: string; description: string;
}): Promise<{ hangoutLink: string | null; eventId: string }> {
  const token = await gcalToken(supabase);
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(opts.calendarId)}/events`);
  url.searchParams.set('conferenceDataVersion', '1');

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.startISO, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: opts.endISO, timeZone: 'America/Sao_Paulo' },
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
  });
  const gJson = await res.json();
  if (!res.ok) throw new Error(`Google Calendar falhou: ${JSON.stringify(gJson)}`);
  return { hangoutLink: gJson.hangoutLink ?? gJson.conferenceData?.entryPoints?.[0]?.uri ?? null, eventId: gJson.id };
}

// Move um evento existente (mesmo Meet/link) para um novo horário — usado ao remarcar.
async function moverEventoMeet(
  supabase: any,
  calendarId: string,
  eventId: string,
  startISO: string,
  endISO: string,
): Promise<void> {
  const token = await gcalToken(supabase);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: { dateTime: startISO, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: endISO, timeZone: 'America/Sao_Paulo' },
    }),
  });
  if (!res.ok) throw new Error(`Google Calendar (mover evento) falhou: ${await res.text()}`);
}

// Remove um evento do Google Calendar — usado ao remarcar quando NÃO dá pra mover
// (trocou de vendedor → o evento fica na agenda do vendedor anterior; sem isso vira
// fantasma). 404/410 = evento já não existe → idempotente, trata como sucesso.
async function deletarEventoMeet(supabase: any, calendarId: string, eventId: string): Promise<void> {
  const token = await gcalToken(supabase);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar (deletar evento) falhou: ${await res.text()}`);
  }
}

async function confirmarAgendamento(supabase: any, input: any, ctx: CtxConversa, toolUseId: string) {
  try {
    const post = await sdrApi('agendamentos', {
      method: 'POST',
      body: JSON.stringify({
        lead: { whatsapp: ctx.telefone },
        pos_graduacao_interesse: input.curso_escolhido,
        vendedor_id: input.vendedor_id,
        data_agendamento: `${input.data_escolhida}T${input.horario_escolhido}:00-03:00`,
      }),
    });
    const resp = await post.json().catch(() => ({}));
    if (!post.ok || resp.error || !resp.data) {
      throw new Error(typeof resp.error === 'string' ? resp.error : `HTTP ${post.status} ao agendar`);
    }
    const ag = resp.data;

    const calendarId = ag.vendedor?.id_calendar;
    if (!calendarId) {
      // Vendedor sem agenda vinculada — falha visível em vez de evento na agenda errada.
      throw new Error(`Vendedor ${ag.vendedor?.name ?? ag.vendedor_id} sem id_calendar cadastrado`);
    }

    const startUtc = ag.data_agendamento;
    const endUtc = ag.data_fim_agendamento ?? new Date(new Date(startUtc).getTime() + 30 * 60 * 1000).toISOString();
    const evento = await criarEventoMeet(supabase, {
      calendarId,
      startISO: toBrasiliaISO(startUtc),
      endISO: toBrasiliaISO(endUtc),
      summary: `Reunião PPG — ${ag.lead?.nome ?? 'Lead'}`,
      description:
        `Agendamento: ${ag.id}\n` +
        `Curso: ${ag.pos_graduacao_interesse ?? '-'}\n` +
        `Lead: ${ag.lead?.nome ?? '-'} (${ag.lead?.whatsapp ?? '-'})\n` +
        `Vendedor: ${ag.vendedor?.name ?? '-'}\n` +
        `Link: ${ag.link_reuniao ?? '-'}`,
    });

    if (evento.hangoutLink) {
      await sdrApi(`agendamentos/${ag.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ link_reuniao: evento.hangoutLink }),
      });
    }
    // Guarda o id do evento do GCal pra poder MOVER (não recriar) ao remarcar.
    try {
      await supabase.from('agendamentos').update({ google_event_id: evento.eventId }).eq('id', ag.id);
    } catch (e) {
      console.log(`[crm-agente-sdr] salvar google_event_id falhou (segue): ${(e as Error).message}`);
    }

    const vendedor = ag.vendedor?.name || ag.vendedor_id || 'monitor';
    return {
      resultado: `Agendamento confirmado. id: ${ag.id}, data: ${formataBrasiliaDataHora(ag.data_agendamento)}, monitor: ${vendedor}, link: ${evento.hangoutLink ?? ag.link_reuniao ?? ''}`,
      agendamento_id: ag.id,
      id: toolUseId,
    };
  } catch (e) {
    return { resultado: `Erro ao agendar: ${(e as Error).message}`, agendamento_id: null, id: toolUseId };
  }
}

// ── remarcar_agendamento (atualiza o agendamento EXISTENTE do lead → novo horário vale) ──
// Acha o agendamento ativo do lead, faz PATCH (fn_sdr_api_reagendar) com a nova data e
// MOVE o evento do Google Calendar pro novo horário (mesmo link). NÃO cria agendamento novo.
async function remarcarAgendamento(supabase: any, input: any, ctx: CtxConversa, toolUseId: string) {
  try {
    // 1) acha o agendamento ATIVO (status=agendado) do lead — o mais próximo no futuro.
    const get = await sdrApi(`agendamentos?telefone=${encodeURIComponent(ctx.telefone)}&status=agendado&limit=50`);
    const getResp = await get.json().catch(() => ({}));
    const lista: any[] = Array.isArray(getResp.data) ? getResp.data : [];
    const agora = Date.now();
    const alvo = lista
      .filter((a) => a.data_agendamento && new Date(a.data_agendamento).getTime() > agora - 3_600_000)
      .sort((a, b) => new Date(a.data_agendamento).getTime() - new Date(b.data_agendamento).getTime())[0] ?? lista[0];
    if (!alvo) {
      return { resultado: 'Nenhum agendamento ativo encontrado para este lead. Se ele quer marcar do zero, use consulta_disponibilidade + confirmar_agendamento.', id: toolUseId };
    }

    const vendedorNovo = input.vendedor_id ?? alvo.vendedor_id;
    const startBR = `${input.data_escolhida}T${input.horario_escolhido}:00-03:00`;
    const startMs = new Date(startBR).getTime();
    if (!Number.isFinite(startMs)) {
      return { resultado: 'data/horário inválido pra remarcar (use data_escolhida YYYY-MM-DD e horario_escolhido HH:mm).', id: toolUseId };
    }
    const endIsoUtc = new Date(startMs + 30 * 60 * 1000).toISOString();

    // 2) PATCH no MESMO agendamento (reagenda) — novo horário passa a valer na base.
    const patch = await sdrApi(`agendamentos/${alvo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data_agendamento: startBR,
        vendedor_id: input.vendedor_id ?? undefined,
        observacoes: 'Remarcado pela IA a pedido do lead.',
      }),
    });
    const patchResp = await patch.json().catch(() => ({}));
    if (!patch.ok || patchResp.success === false || patchResp.error) {
      const err = patchResp.error || `HTTP ${patch.status}`;
      return { resultado: `Não consegui remarcar (${err}). Rode consulta_disponibilidade pro novo horário e ofereça um slot livre antes de remarcar.`, id: toolUseId };
    }
    const agNovo = patchResp.agendamento ?? {};
    let link = agNovo.link_reuniao ?? alvo.link_reuniao ?? '';

    // 3) move (ou cria) o evento no Google Calendar pro novo horário.
    try {
      const mesmoVendedor = String(vendedorNovo) === String(alvo.vendedor_id);
      let calendarId = mesmoVendedor ? alvo.vendedor?.id_calendar : null;
      if (!calendarId) {
        const { data: prof } = await supabase.from('profiles').select('id_calendar').eq('id', vendedorNovo).maybeSingle();
        calendarId = prof?.id_calendar ?? null;
      }
      const startISO = toBrasiliaISO(new Date(startMs).toISOString());
      const endISO = toBrasiliaISO(endIsoUtc);
      const eventId = agNovo.google_event_id ?? null;
      if (eventId && mesmoVendedor && calendarId) {
        await moverEventoMeet(supabase, calendarId, eventId, startISO, endISO);
      } else if (calendarId) {
        // sem event_id (agendamento antigo) ou trocou de vendedor → cria evento novo
        const evento = await criarEventoMeet(supabase, {
          calendarId, startISO, endISO,
          summary: `Reunião PPG — remarcada`,
          description: `Agendamento: ${alvo.id} (remarcado pela IA)\nLink: ${link || '-'}`,
        });
        link = evento.hangoutLink ?? link;
        await supabase.from('agendamentos').update({ link_reuniao: link, google_event_id: evento.eventId }).eq('id', alvo.id);
        // Apaga o evento ANTIGO da agenda do vendedor anterior (senão fica fantasma no
        // horário velho). Só quando há id antigo e ele não é o evento que acabamos de criar.
        const oldEventId = alvo.google_event_id ?? eventId;
        const oldCalendarId = alvo.vendedor?.id_calendar;
        if (oldEventId && oldCalendarId && oldEventId !== evento.eventId) {
          try {
            await deletarEventoMeet(supabase, oldCalendarId, oldEventId);
          } catch (e) {
            console.error(`[crm-agente-sdr] remarcar: evento antigo não removido (segue): ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      console.error(`[crm-agente-sdr] remarcar: GCal não atualizado (segue): ${(e as Error).message}`);
    }

    // Nome do monitor computado aqui — sem ele no retorno, o modelo reaproveita o nome
    // antigo (caso real: slot da Letícia Tamara confirmado como "Leticia Carolina").
    let vendedorNome = '';
    try {
      const { data: prof } = await supabase.from('profiles').select('name').eq('id', vendedorNovo).maybeSingle();
      vendedorNome = prof?.name ?? '';
    } catch { /* segue sem o nome */ }
    return {
      resultado: `Reunião remarcada. Novo horário: ${formataBrasiliaDataHora(startBR)}. ` +
        `Monitor: ${vendedorNome || vendedorNovo}. Link: ${link || '(o mesmo de antes)'}. ` +
        `Confirme o novo horário, o monitor e o link pro lead (use exatamente estes dados).`,
      agendamento_id: alvo.id,
      id: toolUseId,
    };
  } catch (e) {
    return { resultado: `Erro ao remarcar: ${(e as Error).message}`, id: toolUseId };
  }
}

// ── verificar_compatibilidade_curso (LLM + validador) ───────────────────────
const CURSOS_OFICIAIS = [
  'Sanidade Avícola', 'MBA Postura Comercial', 'Reprodução, Nutrição e Gestão de Bovinos',
  'Reprodução de Bovinos', 'Nutrição e Gestão de Bovinos', 'Produção, Nutrição e Gestão de Bovinos',
  'Produção de Suínos', 'Clínica Médica e Cirúrgica de Bovinos', 'Clínica Médica de Bovinos',
  'Saúde Única e Zoonoses', 'Qualidade e Segurança de POA', 'Comportamento e BEA Animais Produção',
  'Comportamento e BEA Animais Companhia', 'Cooperativismo e Crédito Rural', 'Cannabis Medicinal',
  'Gestão e Produção Avicola', 'Fitoterapia', 'MBA em Liderança e Gestão de Fazendas',
  'MBA em Liderança e Inteligência Artificial no Agronegócio', 'MBA em Liderança e Extensão Rural na Agroindústria',
];
const CURSOS_EXCLUSIVOS = [
  'Sanidade Avícola', 'Reprodução, Nutrição e Gestão de Bovinos', 'Reprodução de Bovinos',
  'Clínica Médica e Cirúrgica de Bovinos', 'Clínica Médica de Bovinos',
];
const ALTERNATIVAS: Record<string, string> = {
  'Sanidade Avícola': 'Gestão e Produção Avicola',
  'Reprodução, Nutrição e Gestão de Bovinos': 'Produção, Nutrição e Gestão de Bovinos',
  'Reprodução de Bovinos': 'Produção, Nutrição e Gestão de Bovinos',
  'Clínica Médica e Cirúrgica de Bovinos': 'Produção, Nutrição e Gestão de Bovinos',
  'Clínica Médica de Bovinos': 'Produção, Nutrição e Gestão de Bovinos',
};

// Port do code node "Saida Estruturada" (validação + correções de lógica).
function validarMatriz(resultado: any): any {
  const obrigatorios = [
    'formacao_identificada', 'e_medico_veterinario', 'curso_solicitado', 'pode_cursar',
    'curso_alternativo_recomendado', 'mensagem_para_lead', 'compativel', 'output',
  ];
  for (const campo of obrigatorios) {
    if (resultado[campo] === undefined) throw new Error(`Campo obrigatório ausente: ${campo}`);
  }
  for (const campo of ['e_medico_veterinario', 'pode_cursar', 'compativel', 'curso_alternativo_recomendado']) {
    if (typeof resultado[campo] !== 'boolean') throw new Error(`${campo} deve ser boolean`);
  }

  const ehExclusivo = CURSOS_EXCLUSIVOS.includes(resultado.curso_solicitado);
  if (ehExclusivo !== resultado.curso_exclusivo_veterinario) resultado.curso_exclusivo_veterinario = ehExclusivo;

  if (!resultado.e_medico_veterinario && ehExclusivo && resultado.pode_cursar === true) {
    resultado.pode_cursar = false;
    resultado.compativel = false;
    const alternativa = ALTERNATIVAS[resultado.curso_solicitado];
    if (alternativa) {
      resultado.curso_alternativo = alternativa;
      resultado.curso_alternativo_recomendado = true;
    }
  }
  if (resultado.e_medico_veterinario && ehExclusivo && resultado.pode_cursar === false) {
    resultado.pode_cursar = true;
    resultado.compativel = true;
    resultado.curso_alternativo = null;
    resultado.curso_alternativo_recomendado = false;
  }
  if (resultado.compativel !== resultado.pode_cursar) resultado.compativel = resultado.pode_cursar;

  const deveSerTrue = resultado.pode_cursar === false && resultado.curso_alternativo != null;
  if (resultado.curso_alternativo_recomendado !== deveSerTrue) resultado.curso_alternativo_recomendado = deveSerTrue;

  if (resultado.pode_cursar && resultado.output !== 'APROVADO') resultado.output = 'APROVADO';

  if (resultado.curso_alternativo_recomendado === true) {
    if (resultado.curso_alternativo == null) throw new Error('Inconsistência: marcou alternativa mas não forneceu curso');
    if (resultado.pode_cursar === true) throw new Error('Inconsistência: marcou alternativa mas aprovou curso original');
  }
  return resultado;
}

async function verificarCompatibilidade(supabase: any, input: any, ctx: CtxConversa, toolUseId: string) {
  // Side effect do subfluxo: grava objetivos/área no lead (não bloqueante).
  const patch: Record<string, unknown> = {};
  if (input.objetivos_profissionais) patch.objetivos_profissionais = input.objetivos_profissionais;
  if (input.area_trabalho) patch.situacao_trabalho_atual = input.area_trabalho;
  if (Object.keys(patch).length) {
    try { await atualizarLead(supabase, ctx.remotejid, patch); } catch (e) {
      console.log(`[crm-agente-sdr] update lead na matriz falhou (segue): ${(e as Error).message}`);
    }
  }

  // Guarda determinística de PRAZO (2026-07-16, caso Jaqueline): estudante que só
  // conclui a graduação FORA da janela de elegibilidade (90 dias) não pode ser
  // agendado. A matriz avalia só a ÁREA — com contexto 'normal' ela aprovava o
  // estudante fora do prazo e o veredito "APROVADO" atropelava a regra do prompt.
  // O enum novo dá ao modelo um jeito de expressar o caso, e a reprovação sai
  // daqui (código), não da obediência ao prompt. A matriz nem roda.
  if (input.contexto_qualificacao === 'estudante_fora_do_prazo') {
    return {
      id: toolUseId,
      output: 'REPROVADO_PRAZO',
      compativel: false,
      pode_cursar: false,
      curso_solicitado: input.curso_interesse ?? null,
      curso_alternativo: null,
      curso_alternativo_recomendado: false,
      formacao_identificada: input.formacao_academica ?? null,
      motivo_alteracao: 'Lead ainda cursando a graduação, com conclusão prevista fora do prazo de elegibilidade (90 dias).',
      mensagem_para_lead: null,
      instrucao: 'NÃO agende reunião, NÃO diga que a formação atende e NÃO empurre a decisão pro monitor. ' +
        'Encerre com respeito e, na MESMA resposta, chame pausa_ia com motivo ' +
        '"Lead conclui a graduação fora do prazo de 90 dias". ' +
        'Nunca mencione "90 dias", "prazo" ou "elegibilidade" ao lead.',
    };
  }

  const { data: cursos, error } = await supabase
    .from('cursos_pos_graduacao')
    .select('pos_graduacao, pode_fazer, parcialmente_aceitas, status')
    .eq('status', 'ativo');
  if (error) throw new Error(`cursos_pos_graduacao: ${error.message}`);

  // No n8n a tabela chegava ao agente via tool getAll; aqui vai injetada no system.
  const system = `${MATRIZ_SYSTEM}\n\n---\n\n## TABELA cursos_pos_graduacao (status = 'ativo') — FONTE DA VERDADE\n\n${JSON.stringify(cursos, null, 1)}`;
  const user = renderPrompt(MATRIZ_USER_TEMPLATE, {
    formacao_academica: input.formacao_academica ?? '',
    curso_interesse: input.curso_interesse ?? '',
  });

  const resp = await chamarAnthropic({
    model: MODELO_MATRIZ,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const texto = (resp.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  const semMarkdown = texto.includes('```') ? texto.replace(/```json\n?/g, '').replace(/```\n?/g, '') : texto;

  let parsed: any;
  try { parsed = JSON.parse(semMarkdown.trim()); } catch (e) {
    throw new Error(`IA da matriz não retornou JSON válido: ${(e as Error).message}`);
  }
  return { ...validarMatriz(parsed), id: toolUseId };
}

// ── consulta_objecoes (Voyage + match_ppg_voyage top-1) ─────────────────────
async function consultaObjecoes(supabase: any, input: any, toolUseId: string) {
  const vRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: [input.mensagem_lead],
      model: 'voyage-4-large',
      input_type: 'query',
      output_dimension: 1024,
    }),
  });
  if (!vRes.ok) throw new Error(`Voyage HTTP ${vRes.status}: ${await vRes.text()}`);
  const vJson = await vRes.json();
  const embedding = vJson.data?.[0]?.embedding;
  if (!embedding) throw new Error('Voyage não retornou embedding');

  const { data, error } = await supabase.rpc('match_ppg_voyage', {
    query_embedding: `[${embedding.join(',')}]`,
    match_count: 1,
    filter: {},
  });
  if (error) throw new Error(`match_ppg_voyage: ${error.message}`);

  // top-1 sempre — retriever burro (idem n8n).
  const resposta = data?.[0]?.metadata?.resposta;
  return { resposta_objecao: resposta || 'CONFIANCA_BAIXA', id: toolUseId };
}

// ── envia_informacoes (sdr-api + contrato de retorno) ───────────────────────
// Curso da OPORTUNIDADE do lead — fallback quando a tool não passa `curso_escolhido`
// OU a sdr-api não acha a pós (pos_nao_encontrada). Limpa prefixo de landing e símbolos.
async function cursoDaOportunidade(supabase: any, ctx: CtxConversa): Promise<string> {
  try {
    let titulo: string | null = null;
    if (ctx.oportunidadeId) {
      const { data } = await supabase.from('crm_oportunidades').select('titulo').eq('id', ctx.oportunidadeId).maybeSingle();
      titulo = (data as any)?.titulo ?? null;
    }
    if (!titulo && ctx.leadId) {
      const { data } = await supabase.from('crm_oportunidades').select('titulo')
        .eq('lead_id', ctx.leadId).order('criada_em', { ascending: false }).limit(1).maybeSingle();
      titulo = (data as any)?.titulo ?? null;
    }
    if (!titulo) return '';
    return String(titulo).replace(/^lead great pages\s+/i, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  } catch { return ''; }
}

async function enviaInformacoes(supabase: any, input: any, ctx: CtxConversa, toolUseId: string) {
  const conteudo = input.conteudo || 'cronograma';
  const enviarCronograma = conteudo === 'cronograma' || conteudo === 'cronograma_e_valor';
  const incluirValor = conteudo === 'valor' || conteudo === 'cronograma_e_valor';
  const sair = (texto: string) => ({ resultado: texto, id: toolUseId });

  const cursoOp = await cursoDaOportunidade(supabase, ctx);
  const pos = String(input.curso_escolhido ?? '').trim() || cursoOp;
  if (!pos) {
    return sair('Erro: curso_escolhido não informado e sem curso na oportunidade. Diga ao lead que vai enviar em seguida e conduza a conversa normalmente.');
  }

  const chamar = async (p: string) => {
    const r = await sdrApi('envia-informacoes', {
      method: 'POST',
      // wa_account_id = conta da CONVERSA (ctx): sem ela o crm-whatsapp-send cai na
      // primeira conta ativa (João) e o cronograma de lead atendido em OUTRO número
      // sai fora da janela de 24h → falha assíncrona 131047 (a IA acha que enviou).
      body: JSON.stringify({
        whatsapp: ctx.telefone, pos: p, conteudo,
        wa_account_id: ctx.waAccountId,
        lead_id: ctx.leadId,
        oportunidade_id: ctx.oportunidadeId,
      }),
    });
    let b: any;
    try { b = await r.json(); } catch { b = { raw: await r.text().catch(() => '') }; }
    return { res: r, body: b, d: b?.data ?? b ?? {} };
  };

  let { res, body, d } = await chamar(pos);
  // Fallback: pós não encontrada → tenta com o curso da oportunidade (se for diferente).
  if ((res.status < 200 || res.status >= 300) && (d.code === 'pos_nao_encontrada' || body?.code === 'pos_nao_encontrada')
      && cursoOp && cursoOp.toLowerCase() !== pos.toLowerCase()) {
    ({ res, body, d } = await chamar(cursoOp));
  }

  if (res.status < 200 || res.status >= 300) {
    const msg = d.error || body?.error || `HTTP ${res.status} no envia-informacoes`;
    const code = d.code || body?.code || '';
    if (code === 'cronograma_nao_cadastrado') {
      return sair('Cronograma ainda não cadastrado para este curso. Diga ao lead que vai mandar o material em seguida e conduza a conversa normalmente.');
    }
    if (code === 'valor_nao_cadastrado') {
      return sair('Valor não cadastrado para este curso. Diga que essa informação é passada na reunião e reconduza pro agendamento.');
    }
    if (code === 'cronograma_ja_enviado') {
      return sair('O cronograma já foi enviado anteriormente nesta conversa. NÃO reenvie nem chame a função de novo. Diga que o material já está com ele e siga a conversa.');
    }
    return sair(`Erro ao enviar informações (${msg}${code ? ' / ' + code : ''}). Diga ao lead que vai enviar em seguida e siga a conversa.`);
  }

  const partes: string[] = [];
  if (enviarCronograma) {
    partes.push(d.cronograma_enviado
      ? 'Cronograma enviado com sucesso no WhatsApp do lead. Confirme em uma linha que enviou e reconduza a conversa pro agendamento.'
      : 'Cronograma não pôde ser enviado. Diga que vai mandar em seguida e siga a conversa.');
  }
  if (incluirValor) {
    if (d.valor_integral) {
      partes.push(`Valor integral da pós: ${d.valor_integral}, sem nenhuma condição aplicada. Informe exatamente este valor e lembre que a condição especial liberada hoje, com valor mais em conta e parcelamento mais leve, é apresentada na conversa com o monitor.`);
    } else {
      partes.push('Valor não cadastrado. Diga que essa informação é passada na reunião.');
    }
    const valorMatricula = d.valor_matricula || null;
    const linkMatricula = d.link_matricula || null;
    if (valorMatricula || linkMatricula) {
      const matriculaTxt = [valorMatricula, linkMatricula].filter(Boolean).join(' ');
      partes.push(`Matrícula (valor e link pra garantir a vaga direto no valor integral): ${matriculaTxt}. Ofereça pra quem preferir fechar agora, deixando claro que pelo link é o valor integral, sem condição. NUNCA diga ou insinue que o valor da matrícula pode ser reduzido ou negociado.`);
    }
  }
  return sair(partes.join(' '));
}

// ── pausa_ia ────────────────────────────────────────────────────────────────
async function pausaIa(supabase: any, input: any, ctx: CtxConversa, toolUseId: string) {
  const { error } = await supabase.rpc('crm_set_pausa_ia', {
    p_telefone: ctx.telefone,
    p_pausa: true,
    p_motivo: input.motivo ?? null,
  });
  if (error) throw new Error(`crm_set_pausa_ia: ${error.message}`);
  // n8n também desligava o follow-up automático ao pausar.
  try { await atualizarLead(supabase, ctx.remotejid, { followup_ativado: false }); } catch { /* não bloqueia */ }
  return { mensagem: 'Atendimento em Pausa', status: 'pausado', id: toolUseId };
}

// ── temporizador_proxima_turma ──────────────────────────────────────────────
// Lead pediu pra ser chamado quando abrir a PRÓXIMA TURMA: agenda o Temporizador de
// Recontato com a data real da próxima turma (ped_turmas, via RPC worker
// crm_agente_timer_proxima_turma — service-role-only, timer POR TELEFONE) e pausa a IA.
// Anti-SPAM: lead com timer ativo fica fora de todo disparo em massa até o timer vencer.
async function temporizadorProximaTurma(supabase: any, input: any, ctx: CtxConversa, toolUseId: string) {
  const sair = (texto: string) => ({ resultado: texto, id: toolUseId });

  // Curso: o que a IA passou > o que o agente aprendeu do lead > título da oportunidade.
  let curso = String(input.curso ?? '').trim();
  if (!curso) {
    try {
      const lead = await buscarLead(supabase, ctx.remotejid);
      curso = String(lead?.curso_interesse_original ?? '').trim();
    } catch { /* segue pros fallbacks */ }
  }
  if (!curso) curso = await cursoDaOportunidade(supabase, ctx);

  const { data, error } = await supabase.rpc('crm_agente_timer_proxima_turma', {
    p_telefone: ctx.telefone,
    p_curso: curso || null,
    p_motivo: input.motivo ?? null,
  });
  if (error) throw new Error(`crm_agente_timer_proxima_turma: ${error.message}`);

  // Pausa a IA (mesmo efeito do pausa_ia) — o ciclo do timer devolve o lead ao time.
  const { error: ePausa } = await supabase.rpc('crm_set_pausa_ia', {
    p_telefone: ctx.telefone,
    p_pausa: true,
    p_motivo: input.motivo ?? 'Lead pediu recontato na próxima turma',
  });
  if (ePausa) console.error(`[crm-agente-sdr] pausa pós-timer falhou: ${ePausa.message}`);
  try { await atualizarLead(supabase, ctx.remotejid, { followup_ativado: false }); } catch { /* não bloqueia */ }

  const d = (data ?? {}) as Record<string, any>;
  if (d.ok === false) {
    return sair(`Não consegui agendar o temporizador (${d.erro ?? 'erro desconhecido'}), mas a IA foi pausada. Despeça-se com cordialidade dizendo que vai chamá-lo quando abrir a próxima turma.`);
  }
  if (d.turma_inicio) {
    return sair(`Recontato agendado no temporizador: a próxima turma de ${d.curso_casado} está prevista pra começar em ${d.turma_inicio}, e o time vai chamar o lead por volta de ${d.recontato_em}. Confirme pro lead que vai chamá-lo quando abrir a próxima turma — pode citar o MÊS de forma aproximada, sem prometer dia exato — e despeça-se. A IA já foi pausada; não chame pausa_ia.`);
  }
  return sair(`Recontato agendado no temporizador (este curso ainda não tem turma futura cadastrada; o time vai retomar o lead em ${d.recontato_em}). Confirme pro lead que vai chamá-lo quando abrir a próxima turma, sem citar data, e despeça-se. A IA já foi pausada; não chame pausa_ia.`);
}

// ── consulta_pos_disponiveis ─────────────────────────────────────────────────
// Catálogo de pós ativas (tabela cursos) + troca do curso de interesse do lead.
// `trocar_para` resolve o nome oficial via fn_sdr_api_resolver_pos_graduacao (o
// MESMO resolver do envia_informacoes/disponibilidade → o nome devolvido funciona
// nas outras tools) e MATERIALIZA em cliente_ppg_leads_sdr.curso_interesse_original
// (prompts e esteiras de follow-up passam a usar o curso novo sozinhos).
async function consultaPosDisponiveis(supabase: any, input: any, ctx: CtxConversa, toolUseId: string) {
  const sair = (texto: string) => ({ resultado: texto, id: toolUseId });

  const { data: cursos, error } = await supabase
    .from('cursos')
    .select('nome')
    .eq('ativo', true)
    .eq('modalidade', 'Pós-Graduação')
    .order('nome');
  if (error) return sair(`Erro ao listar as pós (${error.message}). Tente de novo; se persistir, siga a conversa sem citar o erro.`);
  const lista = ((cursos ?? []) as { nome: string }[]).map((c) => `- ${c.nome}`).join('\n');

  const alvo = String(input?.trocar_para ?? '').trim();
  if (!alvo) {
    return sair(
      `Pós-graduações ATIVAS da PPG:\n${lista}\n` +
      `Ao falar com o lead, cite só as relevantes pro contexto (máx. 3-4) e NUNCA use os prefixos "PÓS |"/"MBA |" — fale o nome natural.`,
    );
  }

  const { data: resolved, error: eR } = await supabase.rpc('fn_sdr_api_resolver_pos_graduacao', { p_valor: alvo });
  const cursoId = (resolved as any)?.id ?? null;
  const nomeOficial = String((resolved as any)?.nome ?? '').trim();
  if (eR || !cursoId) {
    return sair(
      `Não achei uma pós correspondente a "${alvo}". Catálogo ativo:\n${lista}\n` +
      `Confirme com o lead qual dessas ele quer (cite as 2-3 mais próximas, sem os prefixos) e chame de novo com o nome escolhido.`,
    );
  }

  // Nome natural pra conversa/registro (sem "PÓS |"; "MBA |" vira "MBA ").
  const nomeConversa = nomeOficial.replace(/^p[oó]s\s*\|\s*/i, '').replace(/^mba\s*\|\s*/i, 'MBA ').trim();
  try {
    await atualizarLead(supabase, ctx.remotejid, { curso_interesse_original: nomeConversa });
  } catch (e) {
    console.error(`[crm-agente-sdr] consulta_pos: atualizar interesse falhou (segue): ${(e as Error).message}`);
  }
  return sair(
    `Interesse do lead ATUALIZADO para: ${nomeConversa} (nome oficial: ${nomeOficial}). ` +
    `Daqui em diante use "${nomeConversa}" como curso_escolhido em TODAS as chamadas (consulta_disponibilidade, envia_informacoes, verificar_compatibilidade_curso). ` +
    `Pode enviar o cronograma/valor dessa pós normalmente se o lead pedir. Confirme a troca pro lead de forma natural e siga o fluxo.`,
  );
}

// ── dispatcher ──────────────────────────────────────────────────────────────
export async function executarTool(
  supabase: any,
  toolUse: { id: string; name: string; input: any },
  ctx: CtxConversa,
): Promise<Record<string, unknown>> {
  const { id, name, input } = toolUse;
  try {
    switch (name) {
      case 'consulta_disponibilidade': return await consultaDisponibilidade(input, id);
      case 'confirmar_agendamento': return await confirmarAgendamento(supabase, input, ctx, id);
      case 'remarcar_agendamento': return await remarcarAgendamento(supabase, input, ctx, id);
      case 'verificar_compatibilidade_curso': return await verificarCompatibilidade(supabase, input, ctx, id);
      case 'consulta_objecoes': return await consultaObjecoes(supabase, input, id);
      case 'envia_informacoes': return await enviaInformacoes(supabase, input, ctx, id);
      case 'pausa_ia': return await pausaIa(supabase, input, ctx, id);
      case 'temporizador_proxima_turma': return await temporizadorProximaTurma(supabase, input, ctx, id);
      case 'consulta_pos_disponiveis': return await consultaPosDisponiveis(supabase, input, ctx, id);
      default: return { resultado: `Tool desconhecida: ${name}`, id };
    }
  } catch (e) {
    // Erro vira tool_result legível — o agente contorna na conversa em vez de travar.
    console.error(`[crm-agente-sdr] tool ${name} falhou:`, e);
    return { resultado: `Erro ao executar ${name}: ${(e as Error).message}. Conduza a conversa normalmente sem citar o erro.`, id };
  }
}

// tool_results no formato que o Claude espera (content = JSON do output, idem n8n).
export function montarToolResults(outputs: Record<string, unknown>[]): any[] {
  return outputs.map((output) => ({
    type: 'tool_result',
    tool_use_id: output.id,
    content: JSON.stringify(output),
  }));
}
