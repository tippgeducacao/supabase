// 22/09/2026: voz é uma forma de entregar a fala já validada. O piloto precisa
// de opt-in E allowlist: cadastrar a credencial não liga áudio para a base inteira.
// deno-lint-ignore-file no-explicit-any
import { phoneVariants } from './conta.ts';
import { buscarLead } from './historico.ts';
import type { Msg } from './historico.ts';
import { pausaVigente } from './pausa.ts';
import { avaliarPoliticaVoz } from './politicaVoz.ts';
import { prepararVozElevenlabs, ErroVozElevenlabs, MODELO_ELEVENLABS_PADRAO, VOZ_PADRAO_ELEVENLABS } from './vozElevenlabs.ts';
import type { ConfiguracoesVozElevenlabs } from './vozElevenlabs.ts';
import { normalizarTextoParaVoz } from './textoParaVoz.ts';
import type { CtxConversa } from './tools.ts';

export type OpcoesVozSdr = {
  // O mesmo cliente Deno/esm.sh dos executores legados; não importar cliente web no backend.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  origem: 'followup' | 'conversa';
  // Provedor que GEROU a fala, já considerando eventual fallback do principal.
  provedorResposta: 'openai' | 'anthropic';
  historico: Msg[];
  etapaFollowup?: number;
  interacaoId?: string;
  iniciadaEm?: number;
  referenciaMensagemId?: string;
  interrompido?: () => Promise<boolean>;
};
type Telemetria = { registrar: (tipo: string, dados?: Record<string, unknown>, duracaoMs?: number, erro?: string) => void };
export type ResultadoVoz = 'texto' | 'texto_revalidar' | 'aceito' | 'cancelado' | 'desconhecido';
type ConfigVoz = { chaveApi: string; voiceId: string; modelo: string; voiceSettings?: ConfiguracoesVozElevenlabs };

export function configurarVoz(
  telefone: string,
  env: (nome: string) => string | undefined,
  provedorResposta?: string,
): ConfigVoz | null {
  // Piloto autorizado em 22/09/2026: somente o agente OpenAI. Omitir a origem
  // ou recuperar a rodada com Claude mantém texto, mesmo com telefone permitido.
  if (provedorResposta !== 'openai') return null;
  if (env('AGENTE_SDR_VOZ_ATIVA') !== 'true') return null;
  const variantes = new Set(phoneVariants(telefone));
  const permitidos = (env('AGENTE_SDR_VOZ_TELEFONES') ?? '').split(/[,;\s]+/).filter(Boolean);
  if (!permitidos.some((numero) => variantes.has(numero.replace(/\D/g, '')))) return null;
  const chaveApi = env('AGENTE_SDR_ELEVENLABS_KEY') || env('ELEVENLABS_API_KEY');
  if (!chaveApi) return null;
  const voiceId = env('AGENTE_SDR_ELEVENLABS_VOICE_ID') || VOZ_PADRAO_ELEVENLABS;
  const modelo = env('AGENTE_SDR_ELEVENLABS_MODEL') || MODELO_ELEVENLABS_PADRAO;
  // 22/09/2026: o clone profissional do piloto ficou artificial no V3. Perfil
  // conferido no painel que o usuário aprovou: Multilingual v2, mesmos ajustes.
  // Restringir ao par voz/modelo evita aplicar o perfil pessoal a outra voz.
  const voiceSettings = voiceId === 'kg0vrevk3kmdbBvFCQr0' && modelo === 'eleven_multilingual_v2'
    ? { stability: 0.69, similarity_boost: 1, style: 0.63, use_speaker_boost: true, speed: 0.97 }
    : undefined;
  return {
    chaveApi, voiceId, modelo, ...(voiceSettings ? { voiceSettings } : {}),
  };
}

// Todos os reads são fechados em caso de erro. O piloto não transforma uma falha
// de leitura da pausa/janela em permissão de disparo; a próxima entrada retoma o fluxo.
export async function conferirEstadoVoz(
  ctx: CtxConversa,
  opcoes: OpcoesVozSdr,
  referenciaInbound?: string,
  agora = Date.now(),
): Promise<{ permitido: boolean; motivo: string; inbound?: string }> {
  if (!ctx.waAccountId || ctx.canal === 'webchat') return { permitido: false, motivo: 'conta_oficial_ausente' };
  if (opcoes.interrompido && await opcoes.interrompido()) return { permitido: false, motivo: 'conversa_interrompida' };
  const s = opcoes.supabase;
  const lead = await buscarLead(s, ctx.remotejid);
  if (!lead || lead.iniciar_atendimento !== true || pausaVigente(lead) || lead.nao_perturbe || lead.atendimento_finalizado || lead.agendado
    || (opcoes.origem === 'followup' && (lead.followup_ativado !== true || lead.modo_recontato))) {
    return { permitido: false, motivo: 'lead_indisponivel' };
  }
  const { data: bloqueio, error: erroBloqueio } = await s.rpc('crm_bloqueio_disparo', { p_telefone: ctx.telefone });
  if (erroBloqueio) throw new Error('voz_estado_indisponivel');
  if (bloqueio) return { permitido: false, motivo: 'disparo_bloqueado' };
  const { data: buffer, error: erroBuffer } = await s.from('crm_agente_sdr_buffer')
    .select('id').eq('remotejid', ctx.remotejid).limit(1);
  if (erroBuffer) throw new Error('voz_estado_indisponivel');
  if (buffer?.length) return { permitido: false, motivo: 'entrada_pendente' };

  const { data: entradas, error: erroEntrada } = await s.from('crm_whatsapp_messages')
    .select('id,wa_message_id,created_at').eq('wa_account_id', ctx.waAccountId)
    .in('telefone', phoneVariants(ctx.telefone)).eq('direcao', 'inbound')
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (erroEntrada) throw new Error('voz_estado_indisponivel');
  const entrada = entradas?.[0];
  const quando = Date.parse(entrada?.created_at ?? '');
  if (!Number.isFinite(quando) || quando > agora || agora - quando >= 24 * 3600_000) {
    return { permitido: false, motivo: 'janela_fechada' };
  }
  const inbound = String(entrada.id);
  // A referência pertence à entrada que gerou a resposta, ANTES do LLM. Uma
  // mídia nova pode já estar no CRM mas ainda não ter chegado ao buffer do SDR.
  if (opcoes.referenciaMensagemId ? entrada.wa_message_id !== opcoes.referenciaMensagemId
    : opcoes.iniciadaEm != null && quando > opcoes.iniciadaEm) {
    return { permitido: false, motivo: 'entrada_nova' };
  }
  if (referenciaInbound && referenciaInbound !== inbound) return { permitido: false, motivo: 'entrada_nova' };
  if (opcoes.iniciadaEm != null) {
    const { data: humanas, error } = await s.from('crm_whatsapp_messages')
      .select('id').eq('wa_account_id', ctx.waAccountId).in('telefone', phoneVariants(ctx.telefone))
      .eq('direcao', 'outbound').eq('metadata->>origem', 'humano').neq('status_entrega', 'failed')
      .gte('created_at', new Date(opcoes.iniciadaEm).toISOString()).limit(1);
    if (error) throw new Error('voz_estado_indisponivel');
    if (humanas?.length) return { permitido: false, motivo: 'humano_respondeu' };
  }
  return { permitido: true, motivo: 'estado_valido', inbound };
}

export async function tentarEnviarVoz(opts: {
  ctx: CtxConversa;
  texto: string;
  opcoes: OpcoesVozSdr;
  renovarLock: () => Promise<void>;
  tel?: Telemetria;
  sendUrl: string;
  serviceRole: string;
  env?: (nome: string) => string | undefined;
  fetchImpl?: typeof fetch;
  cadenciaAtingida?: boolean;
}): Promise<ResultadoVoz> {
  const { ctx, texto, opcoes, tel } = opts;
  const config = configurarVoz(ctx.telefone, opts.env ?? ((nome) => Deno.env.get(nome)), opcoes.provedorResposta);
  if (!config || !ctx.waAccountId || ctx.canal === 'webchat') return 'texto';
  const politica = avaliarPoliticaVoz({
    habilitada: true, origem: opcoes.origem, texto, historico: opcoes.historico,
    cadenciaAtingida: opts.cadenciaAtingida === true,
  });
  if (!politica.permitido) {
    tel?.registrar('voz_mantida_texto', { motivo: politica.motivo });
    return 'texto';
  }
  let referencia: string | undefined;
  try {
    const estado = await conferirEstadoVoz(ctx, opcoes);
    if (!estado.permitido) {
      tel?.registrar('voz_cancelada', { motivo: estado.motivo });
      return 'cancelado';
    }
    referencia = estado.inbound;
    // A frequência é controlada por origem no banco: conversa 3–5, follow-up 2. O antigo
    // teto de um áudio diário impediria o intervalo pedido pelo usuário.
    const { data: ultimas, error: erroUltima } = await opcoes.supabase.from('crm_whatsapp_messages')
      .select('tipo,wa_message_id').eq('wa_account_id', ctx.waAccountId).in('telefone', phoneVariants(ctx.telefone))
      .eq('direcao', 'outbound').neq('status_entrega', 'failed')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
    if (erroUltima) throw new Error('voz_estado_indisponivel');
    if (ultimas?.[0]?.tipo === 'audio') {
      const anterior = ultimas[0].wa_message_id;
      if (opcoes.origem !== 'conversa' || typeof anterior !== 'string' || !anterior) return 'texto';
      // 22/09/2026: o dono do piloto pediu ouvir a voz nova na próxima resposta.
      // Operação explícita, auditada e válida por 2h, presa ao último wamid:
      // qualquer novo envio invalida a exceção, sem relaxar a cadência da base.
      const { data: testes, error: erroTeste } = await opcoes.supabase.from('crm_agente_sdr_eventos')
        .select('id').eq('remotejid', ctx.remotejid).eq('tipo', 'voz_teste_proxima_resposta')
        .eq('dados->>wa_account_id', ctx.waAccountId).eq('dados->>apos_wa_message_id', anterior)
        .eq('dados->>voz', config.voiceId)
        .gte('criado_em', new Date(Date.now() - 2 * 3600_000).toISOString()).limit(1);
      if (erroTeste || !testes?.length) return 'texto';
      tel?.registrar('voz_teste_autorizado', { solicitacao_id: testes[0].id });
    }
  } catch {
    tel?.registrar('voz_cancelada', { motivo: 'estado_indisponivel' });
    return 'cancelado';
  }

  let audio: Awaited<ReturnType<typeof prepararVozElevenlabs>> | undefined;
  let textoFalado = texto;
  try {
    await opts.renovarLock();
    textoFalado = normalizarTextoParaVoz(texto);
    if (!/[\p{L}\p{N}]/u.test(textoFalado)) throw new ErroVozElevenlabs('TEXTO_INVALIDO');
    // O helper valida o limite depois da expansão e usa o texto realmente falado
    // no hash: um áudio antigo soletrando "vc" não pode satisfazer esse cache.
    audio = await prepararVozElevenlabs({ texto: textoFalado, ...config, storage: opcoes.supabase.storage });
    tel?.registrar('voz_preparada', {
      voz: config.voiceId, modelo: config.modelo, caracteres: audio.caracteres, cache: audio.cacheHit,
      texto_normalizado: textoFalado !== texto,
    });
  } catch (erro) {
    // Síntese ainda não enviou nada ao destinatário. O texto aprovado é seguro
    // como fallback, mas somente depois de reler o estado abaixo.
    // Só o enum local entra no log: nunca Error.message, body, URL ou chave.
    tel?.registrar('voz_fallback_texto', { motivo: 'preparo_falhou',
      codigo: erro instanceof ErroVozElevenlabs ? erro.codigo : 'ERRO_NAO_CLASSIFICADO' });
  }
  try {
    const estado = await conferirEstadoVoz(ctx, opcoes, referencia);
    if (!estado.permitido) {
      tel?.registrar('voz_cancelada', { motivo: estado.motivo });
      return 'cancelado';
    }
    await opts.renovarLock();
  } catch {
    tel?.registrar('voz_cancelada', { motivo: 'estado_indisponivel' });
    return 'cancelado';
  }
  if (!audio) return 'texto_revalidar';

  const controller = new AbortController();
  const prazo = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.sendUrl, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${opts.serviceRole}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telefone: ctx.telefone, tipo: 'audio', origem: 'ia', conteudo: textoFalado, anexo_url: audio.url,
        mime_type: audio.mimeType, filename: audio.filename, wa_account_id: ctx.waAccountId,
        lead_id: ctx.leadId, oportunidade_id: ctx.oportunidadeId,
      }),
    });
    const retorno = await res.json().catch(() => null);
    if (res.ok && retorno?.success === true && typeof retorno.wa_message_id === 'string' && retorno.wa_message_id) {
      tel?.registrar('audio_enviado', { ok: true, wa_message_id: retorno.wa_message_id, voz: config.voiceId, origem: opcoes.origem });
      // Compatibilidade com o contador de partes aceitas do follow-up. A fala
      // permanece no histórico existente; este evento associa texto e áudio.
      tel?.registrar('chunk_enviado', { ok: true, status: res.status, canal: 'audio', wa_message_id: retorno.wa_message_id, texto: textoFalado });
      return 'aceito';
    }
    // Sem comprovação de aceite/falha anterior ao despacho, nunca mandar texto
    // automaticamente: um timeout/502 pode esconder um áudio que já saiu.
    tel?.registrar('voz_envio_desconhecido', { status: res.status });
    return 'desconhecido';
  } catch {
    tel?.registrar('voz_envio_desconhecido', { motivo: 'transporte_interrompido' });
    return 'desconhecido';
  } finally {
    clearTimeout(prazo);
  }
}
