// Operação de teste autorizada por Gustavo: até sete envios imediatos só no seu
// telefone. Não chama a varredura global e não deixa a esteira automática ligada.
// deno-lint-ignore-file no-explicit-any
import { buscarLead, carregarHistorico, gravarMensagem, atualizarLead, MARCADOR_FOLLOWUP } from './historico.ts';
import { gerarFollowup } from './followup.ts';
import { enviarResposta } from './saida.ts';
import { configurarVoz, conferirEstadoVoz } from './envioVoz.ts';
import { selecionarProvedorDoLead } from './pilotoOpenai.ts';
import { carregarAulaParaFollowup, contextoAulaPiloto, INSTRUCAO_AULA_PILOTO } from './contextoAulaPiloto.ts';
import { carregarStatusMateriais } from './envioMateriais.ts';
import { contaDoLead } from './conta.ts';
import { criarTelemetria } from './eventos.ts';
import { registrarNaJornada } from './fichaAtendimento.ts';

const TELEFONE_TESTE = '5546988166051';
const MAXIMO_PASSOS = 7;
export function validarPedidoTesteFollowup(body: unknown): { telefone: string; testeId: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('pedido_invalido');
  const p = body as Record<string, unknown>;
  if (Object.keys(p).some(k => !['telefone', 'teste_id'].includes(k))) throw new Error('pedido_invalido');
  const telefone = typeof p.telefone === 'string' ? p.telefone.replace(/\D/g, '') : '';
  if (!['5546988166051', '46988166051', '554688166051', '4688166051'].includes(telefone)) throw new Error('fora_do_telefone_de_teste');
  if (typeof p.teste_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.teste_id)) throw new Error('teste_id_invalido');
  return { telefone: TELEFONE_TESTE, testeId: p.teste_id.toLowerCase() };
}

export async function executarTesteFollowup(supabase: any, body: unknown) {
  const { telefone, testeId } = validarPedidoTesteFollowup(body);
  const remotejid = telefone + '@s.whatsapp.net';
  const { data: lock, error: erroLock } = await supabase.rpc('crm_agente_sdr_lock_claim', { p_remotejid: remotejid, p_ttl_segundos: 240 });
  if (erroLock || lock !== true) throw new Error('conversa_em_processamento');
  let restaurar = false;
  const resultados: Record<string, unknown>[] = [];
  const auditar = async (tipo: string, dados: Record<string, unknown>) => {
    const { error } = await supabase.from('crm_agente_sdr_eventos').insert({
      remotejid, rodada_id: testeId, tipo, dados: { teste_id: testeId, ...dados },
    });
    if (error) throw new Error('auditoria_do_teste_indisponivel');
  };
  try {
    const { data: anterior, error: erroAnterior } = await supabase.from('crm_agente_sdr_eventos')
      .select('id').eq('remotejid', remotejid).eq('tipo', 'followup_teste_inicio').eq('rodada_id', testeId).limit(1);
    if (erroAnterior) throw new Error('auditoria_do_teste_indisponivel');
    if (anterior?.length) return { ok: true, ja_executado: true, teste_id: testeId };
    const lead = await buscarLead(supabase, remotejid);
    if (!lead || lead.followup_ativado !== false || lead.iniciar_atendimento !== true || lead.pausa_ia
      || lead.nao_perturbe || lead.agendado || lead.atendimento_finalizado || lead.modo_recontato) throw new Error('lead_indisponivel_para_teste');
    const provedor = await selecionarProvedorDoLead(supabase, telefone);
    if (provedor?.nome !== 'openai' || !configurarVoz(telefone, n => Deno.env.get(n), 'openai')) throw new Error('piloto_openai_voz_indisponivel');
    const conta = await contaDoLead(supabase, telefone, { direcao: 'inbound' });
    if (!conta) throw new Error('conta_inbound_ausente');
    const aula = lead.contexto_campanha?.persona === 'aula' ? await carregarAulaParaFollowup(supabase, lead) : null;
    if (lead.contexto_campanha?.persona === 'aula' && !aula) throw new Error('aula_sem_contexto');
    const ctx = { remotejid, telefone, waAccountId: conta, leadId: null, oportunidadeId: null };
    const iniciadaEm = Date.now();
    const renovar = async () => {
      const { error } = await supabase.rpc('crm_agente_sdr_lock_renovar', { p_remotejid: remotejid, p_ttl_segundos: 240 });
      if (error) throw new Error('lock_indisponivel');
    };
    const interrompido = async () => {
      const atual = await buscarLead(supabase, remotejid);
      if (!atual || atual.followup_ativado !== true || atual.timestamp_mensagem !== lead.timestamp_mensagem
        || atual.pausa_ia || atual.nao_perturbe || atual.agendado || atual.atendimento_finalizado
        || atual.iniciar_atendimento !== true || atual.modo_recontato) return true;
      const { data, error } = await supabase.from('crm_agente_sdr_buffer').select('id').eq('remotejid', remotejid).limit(1);
      return Boolean(error || data?.length);
    };
    await auditar('followup_teste_inicio', { quantidade_maxima: MAXIMO_PASSOS, followup_original: false, conta });
    restaurar = true;
    await atualizarLead(supabase, remotejid, { followup_ativado: true });
    for (let passo = 1; passo <= MAXIMO_PASSOS; passo++) {
      const history = await carregarHistorico(supabase, remotejid);
      const tel = criarTelemetria(supabase, remotejid);
      const voz = { supabase, origem: 'followup' as const, provedorResposta: 'openai' as const,
        historico: history, iniciadaEm, interacaoId: tel.rodadaId, interrompido };
      const estado = await conferirEstadoVoz(ctx, voz);
      if (!estado.permitido) { resultados.push({ passo, estado: 'cancelado', motivo: estado.motivo }); break; }
      await renovar();
      const atual = await buscarLead(supabase, remotejid);
      const contexto = '\n\nDADOS JÁ COLETADOS (não perguntar de novo): ' + JSON.stringify(atual.jornada?.coleta ?? {})
        + (aula ? '\n\n' + INSTRUCAO_AULA_PILOTO + contextoAulaPiloto(aula) : '');
      const materiais = await carregarStatusMateriais(supabase, { telefone, waAccountId: conta });
      const gerada = await gerarFollowup(supabase, aula ? { ...atual, curso_interesse_original: aula.curso_nome ?? '' } : atual,
        passo, tel, history, materiais, { provedor, contexto });
      if (gerada.provedorResposta !== 'openai') throw new Error('geracao_fora_do_openai');
      if (!gerada.message) { resultados.push({ passo, estado: 'silencio', motivo: gerada.final_answer }); break; }
      if (await interrompido()) { resultados.push({ passo, estado: 'cancelado', motivo: 'nova_entrada' }); break; }
      await gravarMensagem(supabase, remotejid, { role: 'user', content: MARCADOR_FOLLOWUP });
      const envioInterrompido = async () => {
        try { return !(await conferirEstadoVoz(ctx, voz)).permitido; } catch { return true; }
      };
      const envio = await enviarResposta(ctx, gerada.message, renovar, tel, envioInterrompido, voz, 'codigo');
      const registro = { passo, rodada_id: tel.rodadaId, estado: envio.estado, canal: envio.canal, aceitos: envio.aceitos, texto: gerada.message };
      resultados.push(registro);
      await auditar('followup_teste_passo', registro);
      if (!envio.aceitos) break; // Transporte incerto nunca é repetido automaticamente.
      await gravarMensagem(supabase, remotejid, { role: 'assistant', content: [{ type: 'text', text: gerada.message }] });
      if (gerada.perguntaCarreira) {
        const pergunta = gerada.perguntaCarreira;
        await registrarNaJornada(supabase, telefone, j => ({ ...j, followup_carreira: [
          ...(j.followup_carreira ?? []).filter(p => p.escopo !== pergunta.escopo || p.pergunta_id !== pergunta.pergunta_id),
          { ...pergunta, enviado_em: new Date().toISOString() },
        ] }));
      }
    }
    await auditar('followup_teste_concluido', { resultados });
    return { ok: true, teste_id: testeId, resultados };
  } finally {
    try {
      if (restaurar) await atualizarLead(supabase, remotejid, { followup_ativado: false });
    } finally {
      await supabase.from('crm_agente_sdr_lock').delete().eq('remotejid', remotejid);
    }
  }
}
