import { describe, expect, it } from 'vitest';
import { idEventoB2B, type ReuniaoB2B } from './regras';
import {
  sincronizarReunioes, type ClienteGoogle, type Config, type Espelho,
  type EventoGoogle, type RepositorioSincronizacao, type ResultadoGoogle,
} from './sincronizacao';

const config: Config = {
  user_id: '00000000-0000-4000-8000-000000000001',
  integration_id: '00000000-0000-4000-8000-000000000002', ativo: true,
};
const reuniaoInicial: ReuniaoB2B = {
  id: '00000000-0000-4000-8000-000000000003', vendedor_id: config.user_id,
  data_agendamento: '2026-09-14T14:00:00Z', data_fim_agendamento: '2026-09-14T15:00:00Z',
  status: 'agendado', nome_empresa: 'Empresa de teste', produto_b2b: 'Formação',
  pos_graduacao_interesse: null, nome_decisor: null,
  link_reuniao: 'https://video.example/reuniao-manual', google_event_id: null,
  updated_at: '2026-09-12T14:00:00Z',
};
const copia = <T>(valor: T): T => structuredClone(valor);

class BancoMemoria implements RepositorioSincronizacao {
  reunioes = new Map([[reuniaoInicial.id, copia(reuniaoInicial)]]);
  espelhos = new Map<string, Espelho>();
  cache = new Set<string>();
  async listarReunioes(userId: string) {
    return copia([...this.reunioes.values()].filter(r => r.vendedor_id === userId));
  }
  async listarEspelhos(userId: string) {
    return copia([...this.espelhos.values()].filter(e => e.user_id === userId));
  }
  async buscarReuniao(id: string, userId: string) {
    const r = this.reunioes.get(id);
    return r?.vendedor_id === userId ? copia(r) : null;
  }
  async salvarEspelho(patch: Espelho) {
    const chave = `${patch.agendamento_id}:${patch.user_id}`;
    this.espelhos.set(chave, { ...this.espelhos.get(chave), ...copia(patch) });
  }
  async removerCache(integrationId: string, eventId: string) {
    this.cache.delete(`${integrationId}:${eventId}`);
  }
  async vincularReuniao(reuniao: ReuniaoB2B, patch: Record<string, unknown>) {
    const atual = this.reunioes.get(reuniao.id);
    // O adaptador de produção usa estes mesmos três predicados no UPDATE.
    if (!atual || atual.vendedor_id !== reuniao.vendedor_id || atual.updated_at !== reuniao.updated_at) return false;
    Object.assign(atual, copia(patch));
    return true;
  }
  get reuniao() { return this.reunioes.get(reuniaoInicial.id)!; }
  get espelho() { return this.espelhos.get(`${reuniaoInicial.id}:${config.user_id}`)!; }
}

type Chamada = { metodo: string; id: string; corpo?: EventoGoogle };
class GoogleMemoria {
  eventos = new Map<string, EventoGoogle>();
  chamadas: Chamada[] = [];
  getAusente = 0;
  timeoutAposCriar = false;
  antes?: (chamada: Chamada) => void;
  resposta(status: number, json: EventoGoogle = {}): ResultadoGoogle {
    return { status, ok: status >= 200 && status < 300, json: copia(json) };
  }
  cliente: ClienteGoogle = async (_cred, caminho, metodo = 'GET', body) => {
    const corpo = body ? copia(body as EventoGoogle) : undefined;
    const id = metodo === 'POST' ? corpo!.id! : decodeURIComponent(caminho.split('?')[0].slice(1));
    const chamada = { metodo, id, corpo };
    this.chamadas.push(chamada);
    this.antes?.(chamada);
    if (metodo === 'GET') {
      if (this.getAusente > 0) { this.getAusente--; return this.resposta(404); }
      return this.eventos.has(id) ? this.resposta(200, this.eventos.get(id)) : this.resposta(404);
    }
    if (metodo === 'DELETE') {
      if (!this.eventos.has(id)) return this.resposta(404);
      this.eventos.set(id, { ...this.eventos.get(id), status: 'cancelled' });
      return this.resposta(204);
    }
    if (metodo === 'POST' && this.eventos.has(id)) return this.resposta(409);
    if (metodo === 'PATCH' && !this.eventos.has(id)) return this.resposta(404);
    const evento: EventoGoogle = { status: 'confirmed', ...this.eventos.get(id), ...corpo, id };
    if (corpo?.conferenceData?.createRequest) {
      evento.conferenceData = { createRequest: {
        ...corpo.conferenceData.createRequest, status: { statusCode: 'pending' },
      } };
    }
    this.eventos.set(id, evento);
    if (metodo === 'POST' && this.timeoutAposCriar) {
      this.timeoutAposCriar = false;
      throw new Error('timeout após Google gravar o evento');
    }
    return this.resposta(metodo === 'POST' ? 201 : 200, evento);
  };
  porMetodo(metodo: string) { return this.chamadas.filter(c => c.metodo === metodo); }
}

function ambiente() {
  const banco = new BancoMemoria();
  const google = new GoogleMemoria();
  const rodar = () => sincronizarReunioes(config, { accessToken: 'simulado', calendarId: 'agenda@example.test' }, {
    repositorio: banco, google: google.cliente,
  });
  return { banco, google, rodar };
}

describe('sincronização B2B com banco e Google simulados', () => {
  it('cria uma única cópia com link manual e não solicita Meet nem convidados', async () => {
    const { banco, google, rodar } = ambiente();
    expect(await rodar()).toBe(1);
    expect(await rodar()).toBe(0);
    expect(google.porMetodo('POST')).toHaveLength(1);
    expect(google.porMetodo('PATCH')).toHaveLength(0);
    expect(google.porMetodo('POST')[0].corpo).toMatchObject({ location: reuniaoInicial.link_reuniao });
    expect(google.porMetodo('POST')[0].corpo).not.toHaveProperty('conferenceData');
    expect(google.porMetodo('POST')[0].corpo).not.toHaveProperty('attendees');
    expect(banco.reuniao.google_event_id).toBe(banco.espelho.external_event_id);
    expect(banco.espelho.estado).toBe('sincronizado');
  });

  it('recupera timeout após POST e conflito 409 usando o mesmo ID e o conteúdo atual', async () => {
    const { banco, google, rodar } = ambiente();
    google.timeoutAposCriar = true;
    await expect(rodar()).rejects.toThrow('timeout');
    const id = banco.espelho.external_event_id;
    expect(banco.espelho.estado).toBe('pendente');
    banco.reuniao.nome_empresa = 'Nome corrigido durante a repetição';
    banco.reuniao.updated_at = '2026-09-12T14:01:00Z';
    google.getAusente = 1; // GET ainda não vê o POST que já foi confirmado no servidor.
    await rodar();
    expect(google.eventos.size).toBe(1);
    expect(google.porMetodo('POST').map(c => c.id)).toEqual([id, id]);
    expect(google.porMetodo('PATCH')).toHaveLength(1);
    expect(google.eventos.get(id)?.summary).toContain('Nome corrigido');
    expect(banco.espelho.estado).toBe('sincronizado');
  });

  it('aguarda Meet pendente e consulta o mesmo evento sem gerar outra conferência', async () => {
    const { banco, google, rodar } = ambiente();
    banco.reuniao.link_reuniao = null;
    await rodar();
    const id = banco.espelho.external_event_id;
    expect(banco.espelho.estado).toBe('pendente');
    expect(banco.reuniao.link_reuniao).toBeNull();
    const evento = google.eventos.get(id)!;
    evento.hangoutLink = 'https://meet.google.com/aaa-bbbb-ccc';
    evento.conferenceData!.createRequest!.status = { statusCode: 'success' };
    await rodar();
    expect(google.porMetodo('POST')).toHaveLength(1);
    expect(google.chamadas.filter(c => c.corpo?.conferenceData?.createRequest)).toHaveLength(1);
    expect(banco.reuniao.link_reuniao).toBe(evento.hangoutLink);
    expect(banco.espelho.external_event_id).toBe(id);
    expect(banco.espelho.estado).toBe('sincronizado');
  });

  it.each(['cancelamento', 'reatribuição', 'exclusão'])('remove somente o evento gerido após %s', async (acao) => {
    const { banco, google, rodar } = ambiente();
    await rodar();
    const id = banco.espelho.external_event_id;
    banco.cache.add(`${config.integration_id}:${id}`);
    google.eventos.set('evento-pessoal', { id: 'evento-pessoal', summary: 'Compromisso privado' });
    if (acao === 'cancelamento') banco.reuniao.status = 'cancelado';
    if (acao === 'reatribuição') banco.reuniao.vendedor_id = 'outro-responsavel';
    if (acao === 'exclusão') banco.reunioes.clear();
    await rodar();
    expect(google.porMetodo('DELETE').map(c => c.id)).toEqual([id]);
    expect(google.eventos.get('evento-pessoal')).toEqual({ id: 'evento-pessoal', summary: 'Compromisso privado' });
    expect(banco.espelho.estado).toBe('cancelado');
    expect(banco.cache.size).toBe(0);
    await rodar();
    expect(google.porMetodo('DELETE')).toHaveLength(1);
  });

  it.each(['ppg_agendamento_id', 'ppg_responsavel_id'] as const)('recusa apagar quando a marca %s diverge', async (marca) => {
    const { banco, google, rodar } = ambiente();
    await rodar();
    google.eventos.get(banco.espelho.external_event_id)!.extendedProperties!.private![marca] = 'outro';
    banco.reuniao.status = 'cancelado';
    await expect(rodar()).rejects.toThrow('não pertence');
    expect(google.porMetodo('DELETE')).toHaveLength(0);
  });

  it.each(['sistema', 'google'])('usa nova geração ao restaurar evento cancelado no %s', async (origem) => {
    const { banco, google, rodar } = ambiente();
    await rodar();
    const anterior = banco.espelho.external_event_id;
    if (origem === 'sistema') {
      banco.reuniao.status = 'cancelado';
      await rodar();
      banco.reuniao.status = 'agendado';
    } else {
      google.eventos.get(anterior)!.status = 'cancelled';
      banco.reuniao.nome_empresa = 'Empresa com reunião remarcada';
      await rodar();
      expect(banco.espelho.estado).toBe('cancelado');
    }
    await rodar();
    expect(banco.espelho.external_event_id).toBe(idEventoB2B(reuniaoInicial.id, config.user_id, 1));
    expect(banco.espelho.external_event_id).not.toBe(anterior);
    expect(banco.espelho.estado).toBe('sincronizado');
  });

  it('não escreve no Google se a reunião muda durante o GET de conferência', async () => {
    const { banco, google, rodar } = ambiente();
    google.antes = chamada => {
      if (chamada.metodo === 'GET') banco.reuniao.updated_at = '2026-09-12T14:02:00Z';
    };
    expect(await rodar()).toBe(0);
    expect(google.porMetodo('POST')).toHaveLength(0);
    expect(google.porMetodo('PATCH')).toHaveLength(0);
    expect(banco.espelho.estado).toBe('pendente');
  });

  it('não finaliza o espelho quando o CAS perde para edição posterior à escrita Google', async () => {
    const { banco, google, rodar } = ambiente();
    google.antes = chamada => {
      if (chamada.metodo === 'POST') {
        banco.reuniao.updated_at = '2026-09-12T14:02:00Z';
        banco.reuniao.link_reuniao = 'https://video.example/link-novo';
      }
    };
    expect(await rodar()).toBe(0);
    expect(banco.reuniao.google_event_id).toBeNull();
    expect(banco.reuniao.link_reuniao).toBe('https://video.example/link-novo');
    expect(banco.espelho.estado).toBe('pendente');
    google.antes = undefined;
    await rodar();
    expect(google.porMetodo('POST')).toHaveLength(1);
    expect(google.porMetodo('PATCH')).toHaveLength(1);
    expect(google.eventos.get(banco.espelho.external_event_id)?.location).toBe('https://video.example/link-novo');
    expect(banco.espelho.estado).toBe('sincronizado');
  });

  it('não duplica nem adota evento legado sem as marcas do sistema', async () => {
    const { banco, google, rodar } = ambiente();
    banco.reuniao.google_event_id = 'evento-legado';
    google.eventos.set('evento-legado', { id: 'evento-legado', summary: 'Evento sem marca' });
    await expect(rodar()).rejects.toThrow('outro evento');
    expect(google.porMetodo('POST')).toHaveLength(0);
    expect(google.porMetodo('PATCH')).toHaveLength(0);
  });

  it('recusa confirmação 409 com a mesma reunião, mas outro responsável', async () => {
    const { banco, google, rodar } = ambiente();
    const id = idEventoB2B(reuniaoInicial.id, config.user_id);
    google.eventos.set(id, { id, extendedProperties: { private: {
      ppg_agendamento_id: reuniaoInicial.id, ppg_responsavel_id: 'outro-responsavel',
    } } });
    google.getAusente = 1;
    await expect(rodar()).rejects.toThrow('não confirmou');
    expect(google.porMetodo('PATCH')).toHaveLength(0);
    expect(banco.reuniao.google_event_id).toBeNull();
    expect(banco.espelho.estado).toBe('pendente');
  });

  it('não remove reunião restaurada durante o GET que antecede o DELETE', async () => {
    const { banco, google, rodar } = ambiente();
    await rodar();
    banco.reuniao.status = 'cancelado';
    google.antes = chamada => {
      if (chamada.metodo === 'GET') {
        banco.reuniao.status = 'agendado';
        banco.reuniao.updated_at = '2026-09-12T14:02:00Z';
      }
    };
    await rodar();
    expect(google.porMetodo('DELETE')).toHaveLength(0);
    expect(banco.espelho.estado).toBe('sincronizado');
  });
});
