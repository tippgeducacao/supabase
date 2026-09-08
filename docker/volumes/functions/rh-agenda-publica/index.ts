import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

/**
 * A agenda de entrevistas, aberta ao CANDIDATO.
 *
 * O RH manda um link só; quem abre digita o WhatsApp, vê os horários que a casa liberou e
 * escolhe um. Existe porque o agendamento pela conversa do agente não escala: os
 * convocados do PS 01/2026 chegam todos no mesmo dia.
 *
 * Por que uma edge, e não RPC direto do navegador: `anon` não pode ter nada aqui. Uma RPC
 * aberta que aceita telefone e devolve nome vira um jeito de descobrir quem se candidatou,
 * digitando números. Aqui a página não fala com o banco em momento nenhum — fala com esta
 * função, que usa service_role e só devolve o primeiro nome de quem realmente tem card em
 * etapa liberada.
 *
 * Marcar é `rh_entrevista_marcar`, a MESMA do agente e do botão do card: a trava contra
 * dois candidatos no mesmo horário é o índice único de `rh_entrevistas`, e ler "está
 * livre?" antes de gravar não impede o INSERT concorrente — a agenda do comercial faz
 * isso e já colidiu três vezes em produção.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Modalidade = 'presencial' | 'online';

interface Horario {
  inicio: string;
  fim: string;
  rotulo: string;
  /** Da faixa liberada: 'ambos' é o único caso em que o candidato escolhe o formato. */
  modalidade: 'presencial' | 'online' | 'ambos';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Quantos dias de agenda a página mostra. Cobre a semana de entrevistas com folga. */
const DIAS_NA_TELA = 21;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const acao = String(body?.acao ?? 'carregar');
    const whatsapp = String(body?.whatsapp ?? '');
    const digitos = whatsapp.replace(/\D/g, '');

    if (digitos.length < 10) {
      return json({ ok: false, motivo: 'telefone_curto' });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: achado, error: erroCandidato } = await admin.rpc('rh_agenda_publica_candidato', {
      p_whatsapp: digitos,
    });
    if (erroCandidato) throw erroCandidato;

    const candidato = Array.isArray(achado) ? achado[0] : achado;
    // Mesma resposta para "número não existe" e "existe mas não foi convocado": a diferença
    // entre as duas contaria, a quem tentasse, quem passou de etapa.
    if (!candidato?.oportunidade_id) {
      return json({ ok: false, motivo: 'nao_encontrado' });
    }

    const { data: livresRaw, error: erroHorarios } = await admin.rpc('rh_entrevista_horarios_livres', {
      p_qtd: 500,
      p_dias: DIAS_NA_TELA,
    });
    if (erroHorarios) throw erroHorarios;
    const livres = (livresRaw ?? []) as Horario[];

    const jaMarcada = candidato.entrevista_inicio
      ? {
          inicio: candidato.entrevista_inicio,
          fim: candidato.entrevista_fim,
          modalidade: candidato.entrevista_modalidade ?? 'presencial',
          link: candidato.entrevista_link ?? null,
        }
      : null;

    if (acao === 'carregar') {
      return json({
        ok: true,
        primeiro_nome: candidato.primeiro_nome,
        horarios: livres,
        entrevista: jaMarcada,
      });
    }

    if (acao !== 'marcar') return json({ ok: false, motivo: 'acao_invalida' }, 400);

    // ── Marcar ────────────────────────────────────────────────────────────────

    const inicio = String(body?.inicio ?? '');
    const slot = livres.find((h) => h.inicio === inicio);
    if (!slot) {
      // Some da lista quem foi pego enquanto a página estava aberta. É o caso comum quando
      // a turma toda recebe o link na mesma hora.
      return json({ ok: false, motivo: 'horario_indisponivel' });
    }

    // O formato é da FAIXA, não do candidato: às 19:00 pode não haver ninguém na sala em
    // Ampére. Ele só escolhe quando a casa abriu o horário para os dois.
    const pedida = body?.modalidade === 'online' ? 'online' : 'presencial';
    const modalidade: Modalidade =
      slot.modalidade === 'ambos' ? pedida : (slot.modalidade as Modalidade);

    const { data: marcado, error: erroMarcar } = await admin.rpc('rh_entrevista_marcar', {
      p_oportunidade_id: candidato.oportunidade_id,
      p_inicio: inicio,
      p_por: 'candidato',
      p_forcar: false,
      p_modalidade: modalidade,
      p_link: null,
    });
    if (erroMarcar) throw erroMarcar;

    const r = Array.isArray(marcado) ? marcado[0] : marcado;
    if (!r?.ok) {
      return json({ ok: false, motivo: r?.motivo ?? 'falhou' });
    }

    // Etapa de agendamento manda o card para Entrevista Agendada, igual ao agente. Sem
    // isso, quem agendasse a partir de "Agendar 03" continuaria lá e a esteira de 24h o
    // empurraria para DESQUALIFICADOS no dia seguinte ao de ter escolhido o horário.
    // As duas etapas dos monitores não têm papel: o card fica na coluna da trilha dele.
    if (candidato.papel_etapa === 'agendar') {
      const { error: erroMover } = await admin.rpc('rh_entrevista_mover_para_agendada', {
        p_oportunidade_id: candidato.oportunidade_id,
      });
      if (erroMover) console.error('[rh-agenda-publica] card não moveu de etapa', erroMover);
    }

    // ── Evento na agenda do Google, e a sala quando é online ──────────────────
    //
    // Secundário de propósito: a entrevista já está travada no banco, que é a fonte da
    // verdade. Se o Google falhar, o candidato não pode ver um erro depois de ter
    // conseguido o horário.
    let link: string | null = null;
    try {
      const { data: integracao } = await admin.rpc('rh_entrevista_agenda_integracao');
      const { data: cfg } = await admin
        .from('rh_entrevista_config')
        .select('local, link_online_padrao')
        .eq('id', true)
        .maybeSingle();

      // Sala fixa da casa. Vazia de propósito: sala reaproveitada por dois candidatos no
      // mesmo dia é gente entrando na entrevista do outro.
      const salaFixa = String(cfg?.link_online_padrao ?? '').trim() || null;
      const online = modalidade === 'online';
      const pedirMeet = online && !salaFixa;
      link = online ? salaFixa : null;

      if (integracao) {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/google-calendar-create-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
          body: JSON.stringify({
            integration_id: integracao,
            title: `Entrevista: ${candidato.nome}`,
            description:
              `Candidato: ${candidato.nome}\n` +
              `Área: ${candidato.area}\n` +
              `WhatsApp: ${candidato.telefone ?? 'não informado'}\n\n` +
              `Modalidade: ${online ? 'online' : 'presencial'}\n` +
              `Horário escolhido pelo próprio candidato, na página de agendamento.`,
            location: online
              ? (salaFixa ?? 'Online, link a definir')
              : (cfg?.local ?? 'PPG Educação, Ampére/PR'),
            starts_at: r.inicio,
            ends_at: r.fim,
            create_meet: pedirMeet,
            reminders: [
              { method: 'popup', minutes: 60 },
              { method: 'popup', minutes: 10 },
            ],
          }),
        });

        if (pedirMeet) {
          const j = await res.json().catch(() => null);
          const meet = typeof j?.meetLink === 'string' ? j.meetLink.trim() : '';
          if (meet) {
            // Sem gravar aqui, o lembrete de 24h sai dizendo que o link vem depois e a sala
            // fica só dentro do Google.
            await admin.rpc('rh_entrevista_definir_modalidade', {
              p_oportunidade_id: candidato.oportunidade_id,
              p_modalidade: 'online',
              p_link: meet,
            });
            link = meet;
          }
        }
      }
    } catch (e) {
      console.error('[rh-agenda-publica] evento no Google falhou', e);
    }

    return json({
      ok: true,
      primeiro_nome: candidato.primeiro_nome,
      entrevista: { inicio: r.inicio, fim: r.fim, rotulo: r.rotulo, modalidade, link },
    });
  } catch (e) {
    console.error('[rh-agenda-publica]', e);
    return json({ ok: false, motivo: 'falhou' }, 500);
  }
});
