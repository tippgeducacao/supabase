import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

/**
 * A agenda de entrevistas, aberta ao CANDIDATO.
 *
 * Três links, a mesma edge (13/11/2026):
 *  - CAMPANHA (`/processo-seletivo/campanha/<código>`, corpo com `campanha`): um só, gerado
 *    quando a campanha é publicada. Mostra os horários livres da campanha sem pedir nada; a
 *    pessoa diz nome e WhatsApp só ao confirmar. Pedido do Rafael: "um link somente com os
 *    horários disponíveis e boa, sem regras e complicações".
 *  - PESSOAL e ANTIGO, abaixo.
 *
 * Desde 13/11/2026 o link é PESSOAL (`/processo-seletivo/agendar/<token>`), igual ao da
 * renegociação da cobrança: quem abre já vê o primeiro nome e os horários dele, sem digitar
 * nada. O corpo traz `token`; o dono é `rh_agenda_publica_por_token`. Pedido do Rafael:
 * "retire essa trava de ter que colocar o nome, não precisa disso".
 *
 * O link antigo, um só para todo mundo, continua respondendo para quem já o recebeu: sem
 * `token`, quem abre digita o NOME COMPLETO, vê os horários que a casa liberou e escolhe um.
 *
 * Existe porque o agendamento pela conversa do agente não escala: os convocados do PS 01/2026
 * chegam todos no mesmo dia.
 *
 * Era por telefone até 10/09 e travava gente demais — número trocado, dois chips, inscrição
 * feita com o telefone de outra pessoa. O nome é o que o candidato lê no PDF do resultado.
 *
 * Por que uma edge, e não RPC direto do navegador: `anon` não pode ter nada aqui. Uma RPC
 * aberta que aceita telefone e devolve nome vira um jeito de descobrir quem se candidatou,
 * digitando números. Aqui a página não fala com o banco em momento nenhum — fala com esta
 * função, que usa service_role e só devolve o primeiro nome de quem realmente tem card aberto
 * no funil de RH.
 *
 * Quem agenda (desde 11/09/2026): TODO card aberto do funil, menos as etapas de
 * `rh_agenda_publica_fora` (desqualificados, contratados, admissão, menor de idade, monitores
 * não convocados). E cada um vê a SUA agenda, que quem decide é o banco
 * (`rh_entrevista_horarios_do_candidato`): o monitor convocado vê a rodada do PS 01/2026; o
 * candidato comum vê as faixas padrão, nos próximos 3 dias com horário, nunca nos dias da
 * rodada — aqueles horários foram abertos só para os monitores.
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

/**
 * Quantos dias o candidato comum vê: os próximos 3 que TÊM horário livre (decisão do Rafael,
 * 11/09). Dia sem vaga não conta, senão quem abrisse o link numa segunda da rodada não veria
 * nada. Três semanas na tela eram 129 horários, e ninguém escolhia.
 */
const DIAS_COM_HORARIO = 3;

/** "2026-11-13", no fuso de Brasília: é a data que a campanha usa. */
function hojeEmSaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const acao = String(body?.acao ?? 'carregar');
    const campanha = String(body?.campanha ?? '').trim().toLowerCase();
    const token = String(body?.token ?? '').trim().toLowerCase();
    const nome = String(body?.nome ?? '').trim();

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    let candidato: any = null;
    // No link da campanha os horários são os da campanha e a pessoa só diz quem é ao
    // confirmar; nos outros dois, os horários são a agenda DO candidato.
    let livres: Horario[] = [];
    let forcar = false;

    if (campanha) {
      // ── Link da campanha (13/11/2026): um só, abre direto nos horários livres ──
      // Pedido do Rafael: "um link somente com os horários disponíveis e boa, sem regras".
      if (!/^[0-9a-f]{12}$/.test(campanha)) return json({ ok: false, motivo: 'campanha_encerrada' });

      const { data: cfg, error: erroCfg } = await admin
        .from('rh_entrevista_config')
        .select('campanha_codigo, agenda_publica_ate')
        .eq('id', true)
        .maybeSingle();
      if (erroCfg) throw erroCfg;
      if (
        !cfg ||
        cfg.campanha_codigo !== campanha ||
        !cfg.agenda_publica_ate ||
        String(cfg.agenda_publica_ate) < hojeEmSaoPaulo()
      ) {
        return json({ ok: false, motivo: 'campanha_encerrada' });
      }

      const { data: daCampanha, error: erroCampanha } = await admin.rpc('rh_entrevista_horarios_da_rodada');
      if (erroCampanha) throw erroCampanha;
      livres = (daCampanha ?? []) as Horario[];

      if (acao === 'carregar') return json({ ok: true, horarios: livres });
      if (acao !== 'marcar') return json({ ok: false, motivo: 'acao_invalida' }, 400);

      // Quem é, só agora: o WhatsApp (o número que recebeu a mensagem) e, se o número não
      // achar ninguém, o nome. Qualquer card aberto do funil de RH: sem lista de fora.
      const whatsapp = String(body?.whatsapp ?? '').replace(/\D/g, '');
      if (!nome || whatsapp.length < 10) return json({ ok: false, motivo: 'contato_incompleto' });

      const { data: achado, error: erroContato } = await admin.rpc('rh_agenda_publica_por_contato', {
        p_whatsapp: whatsapp,
        p_nome: nome,
      });
      if (erroContato) throw erroContato;
      candidato = Array.isArray(achado) ? achado[0] : achado;
      if ((candidato?.achados ?? 0) > 1) return json({ ok: false, motivo: 'contato_ambiguo' });
      if (!candidato?.oportunidade_id) return json({ ok: false, motivo: 'contato_nao_encontrado' });

      // O horário vale para quem tem o link, seja qual for a etapa do card. Forçar só pula a
      // conferência da agenda DO candidato: o horário é conferido abaixo contra os livres da
      // campanha, e o índice único de rh_entrevistas continua impedindo dois no mesmo horário.
      forcar = true;
    } else if (token) {
      // ── Link pessoal ──────────────────────────────────────────────────────────
      if (!/^[0-9a-f]{32}$/.test(token)) return json({ ok: false, motivo: 'link_invalido' });

      const { data: achado, error: erroCandidato } = await admin.rpc('rh_agenda_publica_por_token', {
        p_token: token,
      });
      if (erroCandidato) throw erroCandidato;
      candidato = Array.isArray(achado) ? achado[0] : achado;

      // Mesma resposta para "link que não existe" e "pessoa que saiu do processo"
      // (desqualificada, contratada, monitor não convocado fora de campanha).
      if (!candidato?.oportunidade_id) return json({ ok: false, motivo: 'link_invalido' });
    } else {
      // ── Link antigo, por nome ─────────────────────────────────────────────────
      // Nome e sobrenome, no mínimo: com uma palavra só, meia dúzia de "Maria" casaria com a
      // primeira que aparecesse na lista.
      if (nome.replace(/\s+/g, ' ').split(' ').filter(Boolean).length < 2) {
        return json({ ok: false, motivo: 'nome_incompleto' });
      }

      const { data: achado, error: erroCandidato } = await admin.rpc('rh_agenda_publica_por_nome', {
        p_nome: nome,
      });
      if (erroCandidato) throw erroCandidato;
      candidato = Array.isArray(achado) ? achado[0] : achado;

      // Homônimo não vira chute: marcar a entrevista no card errado é pior que não marcar.
      if ((candidato?.achados ?? 0) > 1) {
        return json({ ok: false, motivo: 'ambiguo' });
      }
      // Mesma resposta para "não existe" e "existe mas está fora" (desqualificado, contratado,
      // monitor não convocado): a diferença entre as duas contaria, a quem tentasse, quem saiu
      // do processo.
      if (!candidato?.oportunidade_id) {
        return json({ ok: false, motivo: 'nao_encontrado' });
      }
    }

    if (!campanha) {
      // A agenda DESTE candidato: rodada para o monitor convocado, faixas padrão para os demais.
      // A regra mora no banco, que é o mesmo lugar onde `rh_entrevista_marcar` a confere.
      const { data: livresRaw, error: erroHorarios } = await admin.rpc('rh_entrevista_horarios_do_candidato', {
        p_oportunidade_id: candidato.oportunidade_id,
        p_dias_com_horario: DIAS_COM_HORARIO,
      });
      if (erroHorarios) throw erroHorarios;
      livres = (livresRaw ?? []) as Horario[];

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
    }

    // ── Marcar ────────────────────────────────────────────────────────────────

    const inicio = String(body?.inicio ?? '');
    const slot = livres.find((h) => h.inicio === inicio);
    if (!slot) {
      // Some da lista quem foi pego enquanto a página estava aberta, e o que não é da agenda
      // desta pessoa. É o caso comum quando a turma toda recebe o link na mesma hora.
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
      p_forcar: forcar,
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

        // Lida SEMPRE: é dela que sai o id do evento. Sem ele anotado na entrevista, a trava
        // "tendo evento, não crie outro" nunca dispara e trocar para online duplica o evento.
        const j = await res.json().catch(() => null);
        const idEvento = typeof j?.event?.id === 'string' ? j.event.id : '';
        if (idEvento) {
          await admin.rpc('rh_entrevista_anotar_evento', {
            p_oportunidade_id: candidato.oportunidade_id,
            p_google_event_id: idEvento,
          });
        }

        if (pedirMeet) {
          // A sala vem em `event.meetLink`. Até 11/09/2026 lia-se `meetLink` na raiz, onde a
          // resposta nunca teve nada: sete candidatos agendaram e nenhum recebeu a sala.
          const bruto = j?.event?.meetLink ?? j?.meetLink;
          const meet = typeof bruto === 'string' ? bruto.trim() : '';
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
