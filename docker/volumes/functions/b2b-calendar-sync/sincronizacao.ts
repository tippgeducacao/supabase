import { corpoEventoB2B, hashConteudoB2B, idEventoB2B, reuniaoCancelada, type ReuniaoB2B } from './regras.ts';

export type Config = { user_id: string; integration_id: string; ativo: boolean };
export type Espelho = {
  agendamento_id: string; user_id: string; integration_id: string; external_event_id: string;
  geracao: number; estado: string; hash_conteudo?: string | null;
  sincronizado_em?: string; erro?: string | null;
};
export type CredencialGoogle = { accessToken: string; calendarId: string };
export type EventoGoogle = {
  id?: string; status?: string; hangoutLink?: string;
  extendedProperties?: { private?: { ppg_agendamento_id?: string; ppg_responsavel_id?: string } };
  conferenceData?: {
    createRequest?: { requestId?: string; status?: { statusCode?: string } };
    entryPoints?: Array<{ entryPointType: string; uri?: string }>;
  };
  [campo: string]: unknown;
};
export type ResultadoGoogle = { ok: boolean; status: number; json: EventoGoogle };
export type ClienteGoogle = (cred: CredencialGoogle, path: string, method?: string, body?: unknown) => Promise<ResultadoGoogle>;
export interface RepositorioSincronizacao {
  listarReunioes(userId: string): Promise<ReuniaoB2B[]>;
  listarEspelhos(userId: string): Promise<Espelho[]>;
  buscarReuniao(id: string, userId: string): Promise<ReuniaoB2B | null>;
  salvarEspelho(patch: Espelho): Promise<void>;
  removerCache(integrationId: string, eventId: string): Promise<void>;
  vincularReuniao(reuniao: ReuniaoB2B, patch: Record<string, unknown>): Promise<boolean>;
}
export type DependenciasSincronizacao = {
  repositorio: RepositorioSincronizacao;
  google: ClienteGoogle;
  agora?: () => number;
};

// Fluxo compartilhado pelo worker e pelos testes; nenhum token/cliente é global.
export async function sincronizarReunioes(
  config: Config,
  cred: CredencialGoogle,
  { repositorio, google, agora = Date.now }: DependenciasSincronizacao,
) {
  const limite = agora() + 120_000; // reserva tempo para importar o Google e soltar a lease
  const [reunioes, espelhos] = await Promise.all([
    repositorio.listarReunioes(config.user_id),
    repositorio.listarEspelhos(config.user_id),
  ]);
  const porId = new Map(reunioes.map(r => [r.id, r]));
  let alterados = 0;
  // Reatribuir ou excluir no sistema retira somente o espelho controlado por esta integração.
  for (const espelho of espelhos) {
    if (agora() > limite) break;
    const snapshot = porId.get(espelho.agendamento_id);
    if (snapshot && !reuniaoCancelada(snapshot.status)) continue;
    // O agendamento pode ser reatribuído/cancelado enquanto o worker está no Google.
    const reuniao = await repositorio.buscarReuniao(espelho.agendamento_id, config.user_id);
    if (reuniao && !reuniaoCancelada(reuniao.status)) continue;
    if (espelho.estado === 'cancelado') continue;
    if (espelho.integration_id !== config.integration_id) throw new Error('A agenda de destino mudou; o vínculo anterior precisa ser conferido.');
    const original = await google(cred, `/${encodeURIComponent(espelho.external_event_id)}`);
    if (original.ok && original.json.status !== 'cancelled' && (original.json.extendedProperties?.private?.ppg_agendamento_id !== espelho.agendamento_id ||
        original.json.extendedProperties?.private?.ppg_responsavel_id !== config.user_id)) {
      throw new Error('O evento Google não pertence a esta reunião; nenhuma remoção realizada.');
    }
    if (!original.ok && ![404, 410].includes(original.status)) throw new Error('Não foi possível conferir o evento antes de remover.');
    // O GET remoto também pode demorar: uma restauração ocorrida nesse intervalo
    // deve impedir o DELETE que estava preparado pelo snapshot cancelado.
    const antesDaRemocao = await repositorio.buscarReuniao(espelho.agendamento_id, config.user_id);
    if (antesDaRemocao && !reuniaoCancelada(antesDaRemocao.status)) continue;
    const res = original.ok && original.json.status !== 'cancelled'
      ? await google(cred, `/${encodeURIComponent(espelho.external_event_id)}?sendUpdates=none`, 'DELETE')
      : { ok: true, status: 204 };
    if (!res.ok && ![404, 410].includes(res.status)) throw new Error('Google não confirmou a remoção da reunião cancelada.');
    await repositorio.salvarEspelho({ ...espelho, estado: 'cancelado', hash_conteudo: null, sincronizado_em: new Date().toISOString(), erro: null });
    await repositorio.removerCache(config.integration_id, espelho.external_event_id);
    alterados++;
  }
  for (const snapshot of reunioes) {
    if (agora() > limite) break;
    const anterior = espelhos.find(e => e.agendamento_id === snapshot.id);
    if (reuniaoCancelada(snapshot.status)) continue;
    if (anterior?.estado === 'sincronizado' && anterior.hash_conteudo === await hashConteudoB2B(corpoEventoB2B(snapshot))) continue;
    const reuniao = await repositorio.buscarReuniao(snapshot.id, config.user_id);
    if (!reuniao) continue;
    if (reuniaoCancelada(reuniao.status)) continue;
    if (anterior && anterior.integration_id !== config.integration_id) throw new Error('A agenda de destino mudou; confira o vínculo anterior.');
    const geracao = anterior?.estado === 'cancelado' ? anterior.geracao + 1 : anterior?.geracao || 0;
    const eventId = anterior && anterior.estado !== 'cancelado'
      ? anterior.external_event_id : (!anterior && reuniao.google_event_id) || idEventoB2B(reuniao.id, config.user_id, geracao);
    const corpo = corpoEventoB2B(reuniao);
    const hash = await hashConteudoB2B(corpo);
    if (anterior?.estado === 'sincronizado' && anterior.hash_conteudo === hash) continue;
    const espelho = { agendamento_id: reuniao.id, user_id: config.user_id,
      integration_id: config.integration_id, external_event_id: eventId, geracao, estado: 'pendente' };
    await repositorio.salvarEspelho(espelho);
    const existente = await google(cred, `/${encodeURIComponent(eventId)}`);
    if (!existente.ok && ![404, 410].includes(existente.status)) throw new Error('Não foi possível conferir a reunião no Google.');
    if (existente.json.status === 'cancelled' || existente.status === 410) {
      // O Google retém IDs excluídos. Uma restauração ganha uma nova geração.
      await repositorio.salvarEspelho({ ...espelho, estado: 'cancelado', hash_conteudo: null });
      continue;
    }
    if (existente.ok && (existente.json.extendedProperties?.private?.ppg_agendamento_id !== reuniao.id ||
        existente.json.extendedProperties?.private?.ppg_responsavel_id !== config.user_id)) {
      throw new Error('O identificador Google já pertence a outro evento; nenhuma alteração realizada.');
    }
    const comMeet = !reuniao.link_reuniao && !existente.json.hangoutLink && !existente.json.conferenceData?.createRequest;
    const payload = { ...corpo, ...(comMeet ? { conferenceData: {
      createRequest: { requestId: eventId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
    } } : {}) };
    const aindaAtual = await repositorio.buscarReuniao(reuniao.id, config.user_id);
    if (!aindaAtual || aindaAtual.updated_at !== reuniao.updated_at || reuniaoCancelada(aindaAtual.status)) continue;
    let res = existente.ok
      ? await google(cred, `/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`, 'PATCH', payload)
      : await google(cred, '?conferenceDataVersion=1&sendUpdates=none', 'POST', { id: eventId, ...payload });
    // Timeout/repetição: o ID é determinístico, e só adotamos evento com a nossa marca.
    if (res.status === 409) {
      res = await google(cred, `/${encodeURIComponent(eventId)}`);
      if (res.ok && res.json.extendedProperties?.private?.ppg_agendamento_id === reuniao.id &&
          res.json.extendedProperties?.private?.ppg_responsavel_id === config.user_id) {
        res = await google(cred, `/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=none`, 'PATCH', corpo);
      }
    }
    if (!res.ok || res.json.extendedProperties?.private?.ppg_agendamento_id !== reuniao.id ||
        res.json.extendedProperties?.private?.ppg_responsavel_id !== config.user_id) {
      throw new Error('Google não confirmou a sincronização da reunião. Ela permanece cadastrada no sistema.');
    }
    const meet = res.json.hangoutLink || res.json.conferenceData?.entryPoints?.find((x: { entryPointType: string }) => x.entryPointType === 'video')?.uri;
    const patch: Record<string, unknown> = { google_event_id: eventId };
    if (!reuniao.link_reuniao && meet) patch.link_reuniao = meet;
    if (!await repositorio.vincularReuniao(reuniao, patch)) continue;
    // A geração do Meet é assíncrona. Sem link, o próximo tick consulta o MESMO evento.
    await repositorio.salvarEspelho({ ...espelho, estado: !reuniao.link_reuniao && !meet ? 'pendente' : 'sincronizado',
      hash_conteudo: hash, sincronizado_em: new Date().toISOString(), erro: null });
    alterados++;
  }
  return alterados;
}
