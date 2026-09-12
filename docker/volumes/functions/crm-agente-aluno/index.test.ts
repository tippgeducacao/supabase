import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Banco e Anthropic falsos: o turno inteiro roda aqui, sem rede e sem WhatsApp.
// A conta vem da RPC onb_agente_conta; o banco falso devolve este marcador.
const CONTA = '<CONTA>';
const OP = '00000000-0000-4000-8000-000000000001';
const FONE = '554699112233';
/**
 * Uma QUARTA-FEIRA às 15:00 de Ampére (UTC-3), com o relógio congelado. Desde que o horário
 * passou a depender do dia da semana (sábado até meio-dia, domingo fechado), um teste que usasse
 * o relógio de verdade passaria de segunda a sexta e quebraria no fim de semana.
 */
const AGORA = new Date('2026-09-09T18:00:00Z');
/** O carimbo que a onb_agente_registrar_perfil devolve ao marcar a pergunta. */
const MARCADA_EM = '2026-09-09T18:03:00.000Z';

type Linha = Record<string, unknown>;
type Consulta = {
  tabela: string; op: string; filtros: [string, string, unknown][]; dados?: unknown;
  /** As colunas pedidas no select: é por elas que se sabe se a edge pediu o horário da semana. */
  colunas?: string;
};

const estado = vi.hoisted(() => ({
  consultas: [] as { tabela: string; op: string; filtros: [string, string, unknown][]; dados?: unknown }[],
  rpcs: [] as { nome: string; args: Record<string, unknown> }[],
  /** Tudo que bateu no banco, em ORDEM: é o que prova o que veio antes do quê. */
  ordem: [] as string[],
  anthropic: [] as Record<string, unknown>[],
  respostasModelo: [] as unknown[],
  origem: null as Record<string, unknown> | null,
  historico: [] as Record<string, unknown>[],
  saidas: [] as Record<string, unknown>[],
  aluno: null as Record<string, unknown> | null,
  contexto: null as Record<string, unknown> | null,
  config: null as Record<string, unknown> | null,
  /** A migration 20260912120000 ainda não aplicada: o select com as colunas novas falha. */
  configSemSemana: false,
  /** Inbound que chegou depois do que o turno leu (a busca da retomada). */
  novas: [] as Record<string, unknown>[],
  /** wa_message_id já marcados em onb_agente_processadas. */
  feitas: [] as string[],
  /** A marca `manha:disparada` que o tick das 8h grava antes de chamar. */
  marcaManha: null as Record<string, unknown> | null,
  /** Uma passagem de `onb_agente_transferencias` ainda sem `resolvida_em`. */
  transferenciaAberta: null as Record<string, unknown> | null,
  /** O trigger da fila cancelando a linha na entrada. */
  filaCancela: null as string | null,
  /** Ids das pendentes que esta resposta substituiu (o UPDATE ... returning id da fila). */
  filaCanceladas: [] as string[],
  /** Eventos `perfil:pergunta_marcada` que o desfazer encontra por fila_id. */
  marcasPergunta: [] as Record<string, unknown>[],
  tcc: null as Record<string, unknown> | null,
  /** Erro que a onb_agente_registrar_perfil devolve (null = gravou). */
  perfilErro: null as string | null,
  /** A RPC do perfil devolvendo NULO sem erro (oportunidade que o banco não acha). */
  perfilNulo: false,
}));

function responder(c: Consulta): { data: unknown; error: unknown } {
  const f = (col: string) => c.filtros.find(([k]) => k === col)?.[2];
  if (c.tabela === 'crm_whatsapp_messages') {
    if (f('wa_message_id')) return { data: estado.origem, error: null };
    if (f('direcao') === 'outbound') return { data: estado.saidas, error: null };
    if (f('direcao') === 'inbound') return { data: estado.novas, error: null }; // retomada
    return { data: estado.historico, error: null };
  }
  if (c.tabela === 'onb_agente_config') {
    // A migration do horário da semana pode não estar aplicada: aí o PostgREST recusa o select
    // com as colunas novas, e a edge tenta de novo sem elas (o teste da reserva usa isto).
    const pediuSemana = String((c as { colunas?: string }).colunas ?? '').includes('horario_fim_sabado');
    if (pediuSemana && estado.configSemSemana) {
      return { data: null, error: { message: 'column onb_agente_config.horario_fim_sabado does not exist' } };
    }
    return { data: estado.config, error: null };
  }
  if (c.tabela === 'onb_agente_eventos' && c.op === 'select') {
    return f('tipo') === 'perfil:pergunta_marcada'
      ? { data: estado.marcasPergunta, error: null }
      : { data: estado.marcaManha, error: null };
  }
  if (c.tabela === 'onb_agente_processadas') {
    if (c.op === 'insert') {
      const id = String((c.dados as Linha).wa_message_id);
      if (estado.feitas.includes(id)) return { data: null, error: { message: 'duplicate key' } };
      estado.feitas.push(id);
      return { data: null, error: null };
    }
    if (c.op === 'select') {
      const ids = (f('wa_message_id') as string[] | undefined) ?? [];
      return { data: estado.feitas.filter((id) => ids.includes(id)).map((id) => ({ wa_message_id: id })), error: null };
    }
  }
  if (c.tabela === 'crm_mensagens_agendadas' && c.op === 'insert') {
    return {
      data: estado.filaCancela
        ? { id: 'fila-nova', status: 'cancelado', erro_detalhe: estado.filaCancela }
        : { id: 'fila-nova', status: 'agendado', erro_detalhe: null },
      error: null,
    };
  }
  // O UPDATE que substitui a pendente devolve as linhas canceladas (returning id).
  if (c.tabela === 'crm_mensagens_agendadas' && c.op === 'update') {
    return { data: estado.filaCanceladas.map((id) => ({ id })), error: null };
  }
  // A passagem já aberta que a retomada fora da janela consulta antes de abrir outra.
  if (c.tabela === 'onb_agente_transferencias') return { data: estado.transferenciaAberta, error: null };
  if (c.tabela === 'ai_api_keys') return { data: { api_key: 'chave-do-banco' }, error: null };
  return { data: null, error: null };
}

function construtor(tabela: string) {
  const c: Consulta = { tabela, op: 'select', filtros: [] };
  estado.consultas.push(c);
  const q: Record<string, unknown> = {};
  const encadeia = (nome: string, fn?: (...a: unknown[]) => void) => {
    q[nome] = (...a: unknown[]) => { fn?.(...a); return q; };
  };
  encadeia('select', (cols) => { if (typeof cols === 'string' && !c.colunas) c.colunas = cols; });
  encadeia('eq', (k, v) => c.filtros.push([String(k), 'eq', v]));
  encadeia('ilike', (k, v) => c.filtros.push([String(k), 'ilike', v]));
  encadeia('gt', (k, v) => c.filtros.push([String(k), 'gt', v]));
  encadeia('gte', (k, v) => c.filtros.push([String(k), 'gte', v]));
  encadeia('in', (k, v) => c.filtros.push([String(k), 'in', v]));
  encadeia('is', (k, v) => c.filtros.push([String(k), 'is', v]));
  encadeia('order');
  encadeia('limit');
  encadeia('insert', (d) => { c.op = 'insert'; c.dados = d; });
  encadeia('update', (d) => { c.op = 'update'; c.dados = d; });
  encadeia('delete', () => { c.op = 'delete'; });
  const registrar = () => { estado.ordem.push(`${c.op}:${c.tabela}`); return responder(c); };
  q.maybeSingle = async () => registrar();
  q.then = (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise.resolve(registrar()).then(ok, erro);
  return q;
}

vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({
  createClient: () => ({
    from: (tabela: string) => construtor(tabela),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      estado.rpcs.push({ nome, args });
      estado.ordem.push(`rpc:${nome}`);
      switch (nome) {
        case 'onb_agente_conta': return { data: '<CONTA>', error: null };
        case 'onb_agente_lock_claim': return { data: true, error: null };
        case 'onb_agente_aluno_por_telefone': return { data: estado.aluno ? [estado.aluno] : [], error: null };
        case 'onb_agente_contexto': return { data: estado.contexto, error: null };
        case 'onb_agente_registrar_transferencia': return { data: 'transf-nova', error: null };
        case 'onb_agente_proximas_aulas':
          return { data: [{ data: '2026-09-15', dow: 2, horario: '19:00 - 22:00', titulo: 'Pré-abertura \u2014 Boas-vindas' }], error: null };
        case 'onb_agente_tcc_status': return { data: estado.tcc ? [estado.tcc] : [], error: null };
        case 'onb_agente_registrar_perfil': {
          if (estado.perfilErro) return { data: null, error: { message: estado.perfilErro } };
          if (estado.perfilNulo) return { data: null, error: null };
          const qual = String(args.p_perguntou ?? '');
          return {
            data: {
              meta_pessoal_perguntas: qual === 'meta_pessoal' ? 1 : 0,
              meta_pessoal_perguntada_em: qual === 'meta_pessoal' ? MARCADA_EM : null,
              como_conheceu_perguntas: qual === 'como_conheceu' ? 1 : 0,
              como_conheceu_perguntada_em: qual === 'como_conheceu' ? MARCADA_EM : null,
            },
            error: null,
          };
        }
        case 'onb_agente_desmarcar_pergunta': return { data: true, error: null };
        default: return { data: true, error: null };
      }
    },
  }),
}));

let handler: (req: Request) => Promise<Response>;

/** O instante mais recente, no passado, em que Ampére marcava `hora`:00 (UTC-3 fixo). */
function ultimaVez(hora: number): string {
  const agora = new Date();
  const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), hora + 3, 0, 0));
  if (d.getTime() > agora.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
}

function mensagem(extra: Linha = {}): Linha {
  return {
    telefone: FONE, tipo: 'text', conteudo: 'onde fica o material?', metadata: {},
    created_at: ultimaVez(15), direcao: 'inbound', ...extra,
  };
}

async function chamar(payload: Linha = {}) {
  const corpo = { wa_account_id: CONTA, agente_ia_persona: 'aluno', direcao: 'inbound', from_me: false, id: 'wamid.TESTE', ...payload };
  const p = handler(new Request('https://edge.invalid/crm-agente-aluno', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  }));
  await vi.runAllTimersAsync();
  return await p;
}

const eventos = () => estado.consultas.filter((c) => c.tabela === 'onb_agente_eventos' && c.op === 'insert')
  .map((c) => (c.dados as Linha).tipo);
const fila = () => estado.consultas.filter((c) => c.tabela === 'crm_mensagens_agendadas' && c.op === 'insert')
  .map((c) => c.dados as Linha);

beforeAll(async () => {
  // O relógio também é falso: o horário do assistente depende do DIA da semana, e o teste não
  // pode passar na quarta e quebrar no domingo.
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  vi.setSystemTime(AGORA);
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => ({ SUPABASE_URL: 'https://supabase.invalid', AGENTE_ALUNO_ANTHROPIC_KEY: 'chave-teste' } as Record<string, string>)[k] },
    serve: (fn: typeof handler) => { handler = fn; },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) throw new Error(`rede não autorizada: ${url}`);
    estado.anthropic.push(JSON.parse(init.body));
    const r = estado.respostasModelo.shift() ?? { content: [{ type: 'text', text: 'ok' }] };
    return new Response(JSON.stringify(r), { status: 200 });
  }));
  await import('./index');
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.setSystemTime(AGORA); // cada turno avança o relógio falso alguns segundos
  estado.consultas = [];
  estado.rpcs = [];
  estado.ordem = [];
  estado.anthropic = [];
  estado.respostasModelo = [];
  estado.origem = mensagem();
  estado.historico = [
    mensagem(),
    { direcao: 'outbound', tipo: 'template', conteudo: 'Oi! Aqui é o vídeo do cronograma.', telefone: FONE, created_at: new Date(Date.parse(ultimaVez(15)) - 3_600_000).toISOString(), metadata: { origem: 'automacao' } },
  ];
  estado.saidas = [{ telefone: FONE, created_at: new Date(Date.parse(ultimaVez(15)) - 3_600_000).toISOString(), metadata: { origem: 'automacao' } }];
  estado.aluno = {
    oportunidade_id: OP, via: 'card', lead_id: 'lead-1', lead_nome: 'Ana Souza', etapa_id: 'e1',
    etapa_nome: 'D+3 · CRONOGRAMA', papel: 'conversa', entrou_na_etapa_em: ultimaVez(9), total_em_integracao: 1,
  };
  estado.contexto = {
    lead_nome: 'Ana Souza', marca: 'PPGVET Educação', pos_nome: 'Bovinos', pos_tcc: 'obrigatorio', turma_id: 'turma-1',
    turma_nome: '02/26 #01', dias_semana: [2], horario_inicio: '19:00:00', horario_fim: '22:00:00',
    grupo_url: 'https://chat.whatsapp.com/grupo-da-turma', no_grupo: null, transferencia_aberta: null,
  };
  estado.config = {
    modelo: 'claude-sonnet-5', horario_inicio: '08:00:00', horario_fim: '21:00:00',
    horario_fim_sabado: '12:00:00', atende_domingo: false, teste_telefones: [],
    liberado_para_todos: true,
    tcc_site_url: 'https://tcc.ppgeducacao.com.br', mentoria_tcc_quando: 'todo sábado, às 9h',
    mentoria_tcc_url: 'https://meet.google.com/cft-inax-tbw',
  };
  estado.configSemSemana = false;
  estado.novas = [];
  estado.feitas = [];
  estado.marcaManha = null;
  estado.transferenciaAberta = null;
  estado.filaCancela = null;
  estado.filaCanceladas = [];
  estado.marcasPergunta = [];
  estado.tcc = null;
  estado.perfilErro = null;
  estado.perfilNulo = false;
});

const C = { wa_account_id: CONTA };

describe('crm-agente-aluno: gates antes do modelo', () => {
  it('outra conta ou outra persona nem entram', async () => {
    expect(await (await chamar({ wa_account_id: 'outra' })).json()).toEqual({ ok: true, pulado: 'numero' });
    expect(await (await chamar({ ...C, agente_ia_persona: 'qualificador' })).json()).toEqual({ ok: true, pulado: 'numero' });
    expect(estado.anthropic).toHaveLength(0);
  });

  it('mensagem que o banco não conhece nesta conta é ignorada (endpoint público)', async () => {
    estado.origem = null;
    await chamar(C);
    expect(estado.anthropic).toHaveLength(0);
    expect(eventos()).toEqual([]);
  });

  it('uma PESSOA falou por último: cala', async () => {
    estado.saidas = [{ telefone: FONE, created_at: ultimaVez(15), metadata: { origem: 'humano', enviado_por_nome: 'Suporte' } }];
    await chamar(C);
    expect(eventos()).toContain('pulado:humano_no_comando');
    expect(estado.anthropic).toHaveLength(0);
    expect(fila()).toHaveLength(0);
  });

  it('fora do horário: registra o adiamento e não chama o modelo nem enfileira', async () => {
    estado.origem = mensagem({ created_at: ultimaVez(23) });
    await chamar(C);
    expect(eventos()).toContain('adiado:fora_do_horario');
    expect(estado.anthropic).toHaveLength(0);
    expect(fila()).toHaveLength(0);
  });

  it('etapa sem papel (saída do funil): cala', async () => {
    estado.aluno = { ...estado.aluno, papel: null, etapa_nome: 'INTEGRADO' };
    await chamar(C);
    expect(eventos()).toContain('pulado:etapa');
    expect(estado.anthropic).toHaveLength(0);
  });

  it('allowlist de teste preenchida sem o número: cala', async () => {
    estado.config = { ...estado.config, teste_telefones: ['46 99999-0000'] };
    await chamar(C);
    expect(eventos()).toContain('pulado:fora_da_allowlist');
    expect(estado.anthropic).toHaveLength(0);
  });

  it('passagem aberta de antes: cala até alguém da equipe responder', async () => {
    estado.contexto = { ...estado.contexto, transferencia_aberta: { id: 'transf-velha', assunto: 'financeiro' } };
    await chamar(C);
    expect(eventos()).toContain('pulado:transferencia_aberta');
    expect(estado.anthropic).toHaveLength(0);
  });

  it('reação não acorda o modelo', async () => {
    estado.origem = mensagem({ tipo: 'reaction', conteudo: '[reacao]👍' });
    await chamar(C);
    expect(eventos()).toContain('pulado:reacao');
    expect(estado.anthropic).toHaveLength(0);
  });
});

describe('crm-agente-aluno: o horário da semana', () => {
  /**
   * Põe o relógio falso e a conversa inteira num instante. O gate do horário olha o dia da
   * semana da mensagem, e a janela das 24h olha a idade dela: os dois precisam do mesmo instante.
   */
  const em = (utc: string) => {
    const quando = new Date(utc);
    vi.setSystemTime(quando);
    const iso = quando.toISOString();
    estado.origem = mensagem({ created_at: iso });
    estado.historico = [mensagem({ created_at: iso })];
    estado.saidas = [{
      telefone: FONE, created_at: new Date(quando.getTime() - 3_600_000).toISOString(),
      metadata: { origem: 'automacao' },
    }];
  };

  it('sábado de manhã responde', async () => {
    em('2026-09-12T14:00:00Z'); // sábado, 11:00 em Ampére
    await chamar(C);
    expect(eventos()).toContain('respondido');
    expect(fila()).toHaveLength(1);
  });

  it('sábado depois do meio-dia fica para a segunda', async () => {
    em('2026-09-12T15:30:00Z'); // sábado, 12:30 em Ampére
    await chamar(C);
    expect(eventos()).toContain('adiado:fora_do_horario');
    expect(estado.anthropic).toHaveLength(0);
    expect(fila()).toHaveLength(0);
  });

  it('domingo é fechado o dia inteiro, e só abre por configuração', async () => {
    em('2026-09-13T13:00:00Z'); // domingo, 10:00 em Ampére
    await chamar(C);
    expect(eventos()).toContain('adiado:fora_do_horario');
    expect(fila()).toHaveLength(0);

    estado.consultas = [];
    estado.config = { ...estado.config, atende_domingo: true };
    em('2026-09-13T13:00:00Z');
    await chamar({ ...C, id: 'wamid.DOMINGO' });
    expect(eventos()).toContain('respondido');
  });

  /**
   * A edge sobe sozinha no push e a migration do horário da semana é aplicada à mão. Enquanto ela
   * não for aplicada, o `onb_agente_manha_tick` vivo é o de 12 h, que não conhece dia da semana:
   * adiar o sábado à tarde ali seria adiar para uma retomada que NUNCA chega (segunda de manhã
   * está a 41 h do adiamento). Então, sem as colunas, vale a janela única de antes, todo dia, e o
   * aluno é respondido na hora, como era. A ausência das colunas é o sinal de que o tick é o
   * antigo: as duas coisas nascem da mesma migration.
   */
  it('config sem as colunas da semana (migration ainda não aplicada): volta à janela única, sem adiar o fim de semana', async () => {
    estado.configSemSemana = true;
    em('2026-09-12T15:30:00Z'); // sábado, 12:30 em Ampére
    await chamar(C);
    const daConfig = estado.consultas.filter((c) => c.tabela === 'onb_agente_config');
    expect(daConfig).toHaveLength(2); // a tentativa com as colunas novas e a leitura antiga
    expect(String(daConfig[1].colunas)).not.toContain('horario_fim_sabado');
    expect(eventos()).not.toContain('adiado:fora_do_horario');
    expect(eventos()).toContain('respondido');

    // E o domingo também: sem as colunas, ninguém retomaria a mensagem na segunda.
    estado.consultas = [];
    em('2026-09-13T13:00:00Z'); // domingo, 10:00 em Ampére
    await chamar({ ...C, id: 'wamid.DOMINGO-VELHO' });
    expect(eventos()).toContain('respondido');
  });
});

/**
 * O fim de semana criou um par novo: a edge adia o que chega sábado à tarde, e o tick da manhã vai
 * buscar até 48 h atrás para retomar na segunda. Só que a janela das 24 h da edge não conhece
 * exceção, e a Meta também não deixa responder texto livre depois dela. Como o tick grava
 * `manha:disparada` ANTES de chamar, nenhuma rodada seguinte busca essa pessoa de novo: sair
 * calado aqui é a mensagem do aluno morrer sem ninguém saber. Então vira passagem para a equipe.
 */
describe('crm-agente-aluno: a retomada que chega depois das 24 h', () => {
  /** Segunda-feira 8h05 de Ampére, retomando o que ele escreveu sábado às 13h (43 h antes). */
  const segundaDeManha = () => {
    vi.setSystemTime(new Date('2026-09-14T11:05:00Z'));
    const sabado = '2026-09-12T16:00:00Z';
    estado.historico = [mensagem({ created_at: sabado })];
    estado.saidas = [{
      telefone: FONE, created_at: '2026-09-11T14:00:00Z', metadata: { origem: 'automacao' },
    }];
    estado.marcaManha = { telefone: FONE };
  };

  it('passa para a equipe em vez de calar, e não chama o modelo', async () => {
    segundaDeManha();
    await chamar({ ...C, id: 'manha-fim-de-semana', motivo: 'manha', telefone: FONE });
    const transf = estado.rpcs.find((r) => r.nome === 'onb_agente_registrar_transferencia');
    expect(transf?.args).toMatchObject({ p_assunto: 'outro' });
    expect(String(transf?.args.p_motivo)).toContain('24 horas');
    expect(eventos()).toContain('pulado:janela');
    expect(estado.anthropic).toHaveLength(0);
    expect(fila()).toHaveLength(0);
  });

  it('não incomoda quem já está com a conversa: passagem aberta ou pessoa no comando', async () => {
    segundaDeManha();
    estado.transferenciaAberta = { id: 'transf-velha' };
    await chamar({ ...C, id: 'manha-com-passagem', motivo: 'manha', telefone: FONE });
    expect(estado.rpcs.map((r) => r.nome)).not.toContain('onb_agente_registrar_transferencia');
    expect(eventos()).toContain('pulado:janela');

    estado.consultas = [];
    estado.rpcs = [];
    segundaDeManha();
    // O histórico chega do banco da mais nova para a mais velha: a pessoa falou depois dele.
    estado.historico = [
      { direcao: 'outbound', tipo: 'text', conteudo: 'Oi, eu respondo', telefone: FONE, created_at: '2026-09-12T17:00:00Z', metadata: { origem: 'humano' } },
      mensagem({ created_at: '2026-09-12T16:00:00Z' }),
    ];
    await chamar({ ...C, id: 'manha-com-humano', motivo: 'manha', telefone: FONE });
    expect(estado.rpcs.map((r) => r.nome)).not.toContain('onb_agente_registrar_transferencia');
  });

  it('quem escreveu dentro das 24 h segue respondido normalmente', async () => {
    vi.setSystemTime(new Date('2026-09-14T11:05:00Z'));
    const ontemANoite = '2026-09-14T01:00:00Z'; // domingo 22h em Ampére, 10 h antes
    estado.historico = [mensagem({ created_at: ontemANoite })];
    estado.saidas = [{ telefone: FONE, created_at: '2026-09-13T14:00:00Z', metadata: { origem: 'automacao' } }];
    estado.marcaManha = { telefone: FONE };
    await chamar({ ...C, id: 'manha-dentro-da-janela', motivo: 'manha', telefone: FONE });
    expect(eventos()).not.toContain('pulado:janela');
    expect(eventos()).toContain('respondido');
  });
});

describe('crm-agente-aluno: o turno', () => {
  it('responde pela fila, como assistente, sem criado_por, pela conta do aluno', async () => {
    estado.respostasModelo = [{ content: [{ type: 'text', text: 'Fica na plataforma \u2014 no **material didático do curso**.' }] }];
    await chamar(C);
    const [linha] = fila();
    expect(linha).toMatchObject({ criado_por_nome: 'Assistente pedagógico', wa_account_id: '<CONTA>', tipo_mensagem: 'texto', status: 'agendado', oportunidade_id: OP });
    expect(linha).not.toHaveProperty('criado_por');
    // Saneado na saída: sem travessão e com o negrito do WhatsApp.
    expect(linha.conteudo).toBe('Fica na plataforma, no *material didático do curso*.');
    expect(eventos()).toContain('respondido');
  });

  it('system em dois blocos, cache só no prompt fixo, primeira mensagem do usuário', async () => {
    await chamar(C);
    const [corpo] = estado.anthropic as { system: Linha[]; messages: Linha[]; tools: Linha[]; thinking: Linha; model: string }[];
    expect(corpo.model).toBe('claude-sonnet-5');
    expect(corpo.thinking).toEqual({ type: 'disabled' });
    expect(corpo.system).toHaveLength(2);
    expect(corpo.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(corpo.system[1].cache_control).toBeUndefined();
    expect(String(corpo.system[1].text)).toContain('CONTEXTO DESTE ALUNO');
    expect(corpo.messages[0].role).toBe('user');
    expect(corpo.messages[corpo.messages.length - 1].role).toBe('user');
    expect(corpo.tools.map((t) => t.name)).toEqual([
      'nao_responder', 'passar_para_atendente', 'consultar_proximas_aulas',
      'registrar_grupo_da_turma', 'registrar_preferencia_ligacao', 'consultar_tcc',
      'registrar_perfil_do_aluno',
    ]);
  });

  it('a ferramenta do perfil não tem campo de sexo, e as listas são fechadas', async () => {
    await chamar(C);
    const [corpo] = estado.anthropic as { tools: { name: string; input_schema: { properties: Record<string, Linha> } }[] }[];
    const perfil = corpo.tools.find((t) => t.name === 'registrar_perfil_do_aluno')!;
    expect(Object.keys(perfil.input_schema.properties).sort()).toEqual(
      ['acabei_de_perguntar', 'como_conheceu', 'como_conheceu_detalhe', 'meta_pessoal', 'meta_pessoal_categoria'],
    );
    expect(JSON.stringify(perfil)).not.toMatch(/sexo/i);
    expect(perfil.input_schema.properties.acabei_de_perguntar.enum).toEqual(['meta_pessoal', 'como_conheceu']);
    expect(perfil.input_schema.properties.como_conheceu.enum).toEqual(
      ['redes_sociais', 'indicacao', 'google_site', 'curso_evento_ppg', 'youtube', 'outro'],
    );
  });

  it('botão "Não estou": grava o grupo e o link vai mesmo se o modelo esquecer', async () => {
    estado.origem = mensagem({
      tipo: 'button', conteudo: 'Não estou',
      metadata: { interactive_reply: { tipo: 'template_button', id: 'Não estou', title: 'Não estou' } },
    });
    estado.respostasModelo = [{ content: [{ type: 'text', text: 'Te mando o link agora!' }] }];
    await chamar(C);
    expect(estado.rpcs).toContainEqual({ nome: 'onb_agente_registrar_grupo', args: { p_oportunidade_id: OP, p_no_grupo: false } });
    const [linha] = fila();
    expect(String(linha.conteudo)).toContain('https://chat.whatsapp.com/grupo-da-turma');
  });

  it('botão "Não estou" fora do horário: grava mesmo assim, e deixa a resposta para as 8h', async () => {
    estado.origem = mensagem({
      tipo: 'button', conteudo: 'Não estou', created_at: ultimaVez(23),
      metadata: { interactive_reply: { tipo: 'template_button', id: 'ONB_GRUPO_NAO', title: 'Não estou' } },
    });
    await chamar(C);
    expect(estado.rpcs.map((r) => r.nome)).toContain('onb_agente_registrar_grupo');
    expect(eventos()).toContain('adiado:fora_do_horario');
    expect(fila()).toHaveLength(0);
  });

  it('passar_para_atendente: registra a passagem e manda só a frase curta', async () => {
    estado.origem = mensagem({ conteudo: 'meu boleto veio com valor errado' });
    estado.respostasModelo = [
      { content: [{ type: 'tool_use', id: 't1', name: 'passar_para_atendente', input: { assunto: 'financeiro', motivo: 'boleto com valor errado' } }] },
      { content: [{ type: 'text', text: 'Deixa eu confirmar isso certinho aqui e já te retorno.' }] },
    ];
    await chamar(C);
    const transf = estado.rpcs.find((r) => r.nome === 'onb_agente_registrar_transferencia');
    expect(transf?.args).toMatchObject({ p_oportunidade_id: OP, p_assunto: 'financeiro', p_wa_account_id: '<CONTA>' });
    expect(eventos()).toContain('transferido:financeiro');
    expect(fila()[0].conteudo).toBe('Deixa eu confirmar isso certinho aqui e já te retorno.');
    // No histórico da 2ª chamada entra só o bloco de ferramenta, nunca o texto que veio junto.
    const segunda = estado.anthropic[1] as { messages: { role: string; content: unknown }[] };
    const doAssistente = segunda.messages[segunda.messages.length - 2];
    expect(doAssistente.role).toBe('assistant');
    expect((doAssistente.content as Linha[]).every((b) => b.type === 'tool_use')).toBe(true);
  });

  it('nao_responder: silêncio, nada na fila', async () => {
    estado.origem = mensagem({ conteudo: 'obrigado!' });
    estado.respostasModelo = [{ content: [{ type: 'tool_use', id: 't1', name: 'nao_responder', input: { motivo: 'agradecimento' } }] }];
    await chamar(C);
    expect(eventos()).toContain('silencio');
    expect(fila()).toHaveLength(0);
  });

  it('consultar_proximas_aulas devolve a linha saneada ao modelo', async () => {
    estado.respostasModelo = [
      { content: [{ type: 'tool_use', id: 't1', name: 'consultar_proximas_aulas', input: { quantidade: 1 } }] },
      { content: [{ type: 'text', text: 'A próxima é terça, 15/09, das 19:00 às 22:00.' }] },
    ];
    await chamar(C);
    expect(estado.rpcs).toContainEqual({ nome: 'onb_agente_proximas_aulas', args: { p_turma_id: 'turma-1', p_qtd: 1 } });
    const segunda = estado.anthropic[1] as { messages: { content: Linha[] }[] };
    const resultado = segunda.messages[segunda.messages.length - 1].content[0];
    expect(resultado.content).toBe('terça-feira, 15/09/2026, das 19:00 às 22:00: Pré-abertura, Boas-vindas');
  });

  it('turma desconhecida: a consulta de aulas manda passar, sem chamar a RPC', async () => {
    estado.contexto = { ...estado.contexto, turma_id: null, turma_nome: null };
    estado.respostasModelo = [
      { content: [{ type: 'tool_use', id: 't1', name: 'consultar_proximas_aulas', input: {} }] },
      { content: [{ type: 'text', text: 'Deixa eu confirmar sua turma e já te retorno.' }] },
    ];
    await chamar(C);
    expect(estado.rpcs.map((r) => r.nome)).not.toContain('onb_agente_proximas_aulas');
  });

  it('lista de teste vazia sem liberado_para_todos: cala (produção é decisão explícita)', async () => {
    estado.config = { ...estado.config, teste_telefones: [], liberado_para_todos: false };
    await chamar(C);
    expect(eventos()).toContain('pulado:nao_liberado');
    expect(estado.anthropic).toHaveLength(0);
    expect(fila()).toHaveLength(0);
  });

  it('o que uma PESSOA da equipe escreveu não chega ao modelo, só o aviso de que respondeu', async () => {
    const antes = (h: number) => new Date(Date.parse(ultimaVez(15)) - h * 3_600_000).toISOString();
    estado.origem = mensagem({ conteudo: 'se eu pagar dia 15 tem juros? me manda de novo' });
    estado.historico = [
      mensagem({ conteudo: 'se eu pagar dia 15 tem juros? me manda de novo' }),
      { direcao: 'outbound', tipo: 'template', conteudo: 'Reta final da integração!', telefone: FONE, created_at: antes(1), metadata: { origem: 'automacao' } },
      { direcao: 'outbound', tipo: 'text', conteudo: 'Sua parcela é R$ 389,90, vence 10/10: https://boleto.exemplo/abc', telefone: FONE, created_at: antes(30), metadata: { origem: 'humano' } },
    ];
    await chamar(C);
    const enviado = JSON.stringify((estado.anthropic[0] as { messages: unknown }).messages);
    expect(enviado).not.toContain('389');
    expect(enviado).not.toContain('boleto.exemplo');
    expect(enviado).toContain('(aqui um atendente da equipe respondeu ao aluno)');
    expect(enviado).toContain('Reta final da integração!');
  });

  it('fila que cancela a resposta na entrada vira erro:fila_bloqueou, não respondido', async () => {
    estado.filaCancela = 'bloqueado: lead arquivado (não recebe disparo)';
    await chamar(C);
    expect(fila()).toHaveLength(1);
    expect(eventos()).toContain('erro:fila_bloqueou');
    expect(eventos()).not.toContain('respondido');
  });

  it('consultar_tcc com o de-para indisponível manda passar, e não diz que não achou', async () => {
    estado.tcc = { encontrados: null, rotulo: null, transferir: true };
    estado.respostasModelo = [
      { content: [{ type: 'tool_use', id: 't1', name: 'consultar_tcc', input: {} }] },
      { content: [{ type: 'text', text: 'Deixa eu confirmar isso certinho aqui e já te retorno.' }] },
    ];
    await chamar(C);
    const segunda = estado.anthropic[1] as { messages: { content: Linha[] }[] };
    const resultado = String(segunda.messages[segunda.messages.length - 1].content[0].content);
    expect(resultado).toContain('precisa de uma pessoa da equipe');
    expect(resultado).not.toContain('Não achei');
  });

  it('"Não estou" sem link e depois "parem de me mandar": uma passagem por assunto', async () => {
    estado.contexto = { ...estado.contexto, grupo_url: null };
    estado.origem = mensagem({
      tipo: 'button', conteudo: 'Não estou',
      metadata: { interactive_reply: { tipo: 'template_button', id: 'ONB_GRUPO_NAO', title: 'Não estou' } },
    });
    estado.respostasModelo = [
      { content: [{ type: 'tool_use', id: 't1', name: 'passar_para_atendente', input: { assunto: 'nao_quer_mensagens', motivo: 'parem de me mandar mensagem' } }] },
      { content: [{ type: 'text', text: 'Entendi, vou ajustar isso por aqui.' }] },
    ];
    await chamar(C);
    const assuntos = estado.rpcs.filter((r) => r.nome === 'onb_agente_registrar_transferencia').map((r) => r.args.p_assunto);
    expect(assuntos).toEqual(['grupo_sem_link', 'nao_quer_mensagens']);
    // O resultado da ferramenta não promete que as mensagens param (nenhuma automação lê a pausa).
    const segunda = estado.anthropic[1] as { messages: { content: Linha[] }[] };
    expect(String(segunda.messages[segunda.messages.length - 1].content[0].content)).not.toMatch(/mensagens autom.ticas param/);
  });

  it('botão de ligação de madrugada: grava sem abrir passagem, e às 8h abre e pergunta', async () => {
    const botao = mensagem({
      tipo: 'button', conteudo: 'Fim da tarde', created_at: ultimaVez(23),
      metadata: { interactive_reply: { tipo: 'template_button', id: 'ONB_LIGAR_TARDE', title: 'Fim da tarde' } },
    });
    estado.origem = botao;
    await chamar(C);
    expect(estado.rpcs.map((r) => r.nome)).toContain('onb_agente_registrar_ligacao');
    expect(estado.rpcs.map((r) => r.nome)).not.toContain('onb_agente_registrar_transferencia');
    expect(eventos()).toContain('adiado:fora_do_horario');

    // 8h: o tick grava a marca e chama de novo, sem wamid do aluno.
    estado.consultas = [];
    estado.rpcs = [];
    const convite = new Date(Date.parse(ultimaVez(23)) - 3_600_000).toISOString();
    estado.historico = [botao, { direcao: 'outbound', tipo: 'template', conteudo: 'Podemos te ligar?', telefone: FONE, created_at: convite, metadata: { origem: 'automacao' } }];
    estado.saidas = [{ telefone: FONE, created_at: convite, metadata: { origem: 'automacao' } }];
    estado.marcaManha = { telefone: FONE };
    estado.respostasModelo = [{ content: [{ type: 'text', text: 'Combinado! Prefere ligação ou videochamada?' }] }];
    await chamar({ ...C, id: 'manha-teste-1', motivo: 'manha', telefone: FONE });
    const transf = estado.rpcs.find((r) => r.nome === 'onb_agente_registrar_transferencia');
    expect(transf?.args).toMatchObject({ p_assunto: 'ligacao' });
    expect(eventos()).not.toContain('pulado:transferencia_aberta');
    expect(eventos()).toContain('respondido');
    expect(String(fila()[0].conteudo)).toContain('videochamada');
  });
});

describe('crm-agente-aluno: o perfil do aluno (a meta e como conheceu)', () => {
  const ontem = () => new Date(Date.now() - 36 * 3_600_000).toISOString();
  /** O perfil como o contexto devolve depois da 20260911235100. */
  const perfil = (extra: Linha = {}) => ({
    meta_pessoal_respondida: false, meta_pessoal_perguntas: 0, meta_pessoal_perguntada_em: null,
    como_conheceu_respondido: false, como_conheceu_perguntas: 0, como_conheceu_perguntada_em: null,
    ...extra,
  });
  const ferramenta = (id: string, input: Linha) => ({ type: 'tool_use', id, name: 'registrar_perfil_do_aluno', input });
  const doPerfil = () => estado.rpcs.filter((r) => r.nome === 'onb_agente_registrar_perfil');
  /** Os tool_result que a edge devolveu ao modelo na rodada seguinte. */
  const resultados = (rodada = 1) => {
    const corpo = estado.anthropic[rodada] as { messages: { content: Linha[] }[] };
    return corpo.messages[corpo.messages.length - 1].content;
  };

  beforeEach(() => {
    estado.contexto = { ...estado.contexto, ...perfil() };
  });

  it('a resposta dele: chama a RPC com a oportunidade, as palavras dele e a categoria', async () => {
    estado.origem = mensagem({ conteudo: 'quero abrir minha própria clínica' });
    estado.respostasModelo = [
      { content: [ferramenta('t1', { meta_pessoal: 'quero abrir minha própria clínica', meta_pessoal_categoria: 'empreender' })] },
      { content: [{ type: 'text', text: 'Que bacana, Ana. A pós vai te dar base pra isso.' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toEqual([{
      nome: 'onb_agente_registrar_perfil',
      args: {
        p_oportunidade_id: OP, p_meta_pessoal: 'quero abrir minha própria clínica', p_meta_categoria: 'empreender',
        p_como_conheceu: null, p_como_detalhe: null, p_perguntou: null,
      },
    }]);
    expect(eventos()).toContain('perfil:registrado');
    expect(String(resultados()[0].content)).toContain('Registrado');
    expect(fila()).toHaveLength(1);
  });

  it('como conheceu, com o detalhe', async () => {
    estado.origem = mensagem({ conteudo: 'foi a colega Júlia que me falou de vocês' });
    estado.respostasModelo = [
      { content: [ferramenta('t1', { como_conheceu: 'indicacao', como_conheceu_detalhe: 'a colega Júlia' })] },
      { content: [{ type: 'text', text: 'Que bom que ela te indicou!' }] },
    ];
    await chamar(C);
    expect(doPerfil()[0].args).toMatchObject({ p_oportunidade_id: OP, p_como_conheceu: 'indicacao', p_como_detalhe: 'a colega Júlia', p_perguntou: null });
  });

  it('o que ele não disse não é gravado: o texto livre tem de estar na mensagem dele', async () => {
    estado.origem = mensagem({ conteudo: 'oi, tudo bem?' });
    estado.respostasModelo = [
      { content: [ferramenta('t1', { meta_pessoal: 'quer crescer na carreira', meta_pessoal_categoria: 'crescer_na_carreira' })] },
      { content: [{ type: 'text', text: 'Tudo ótimo!' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(0);
    const [r] = resultados();
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain('copiado da mensagem dele');
    expect(eventos()).toContain('perfil:recusado');
  });

  /**
   * O modelo não lê a mensagem crua: `sanearParaModelo` troca "5–10" por "5 a 10" e o travessão
   * por vírgula antes. Conferindo só contra a crua, o aluno que escreve com meia-risca tem a meta
   * recusada por "não ser dele", justamente quando o modelo copiou certinho o que leu, e as
   * rodadas seguintes se gastam tentando de novo.
   */
  it('a meta copiada do texto que o modelo LEU é aceita, mesmo saneada', async () => {
    estado.origem = mensagem({ conteudo: 'minha meta é sair de 5–10 mil por mês' });
    estado.historico = [estado.origem as Linha];
    estado.respostasModelo = [
      { content: [ferramenta('t1', { meta_pessoal: 'sair de 5 a 10 mil por mês', meta_pessoal_categoria: 'aumentar_renda' })] },
      { content: [{ type: 'text', text: 'Anotado, Ana.' }] },
    ];
    await chamar(C);
    expect(doPerfil()[0].args).toMatchObject({ p_meta_pessoal: 'sair de 5 a 10 mil por mês', p_meta_categoria: 'aumentar_renda' });
    expect(eventos()).not.toContain('perfil:recusado');
  });

  it('acabei_de_perguntar: a pergunta só conta DEPOIS de a resposta entrar na fila', async () => {
    estado.respostasModelo = [
      { content: [{ type: 'text', text: 'Fica na plataforma. E me conta: qual é a sua maior meta com essa pós?' }, ferramenta('t1', { acabei_de_perguntar: 'meta_pessoal' })] },
      { content: [{ type: 'text', text: 'Fica na plataforma. E me conta: qual é a sua maior meta com essa pós?' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(1);
    expect(doPerfil()[0].args).toMatchObject({ p_oportunidade_id: OP, p_perguntou: 'meta_pessoal', p_meta_pessoal: null, p_como_conheceu: null });
    // a resposta com a pergunta entrou na fila ANTES de a pergunta ser contada
    expect(estado.ordem.indexOf('insert:crm_mensagens_agendadas'))
      .toBeLessThan(estado.ordem.indexOf('rpc:onb_agente_registrar_perfil'));
    expect(String(resultados()[0].content)).toContain('Anotado');
    expect(String(fila()[0].conteudo)).toContain('maior meta');
    const marca = estado.consultas.find((c) => c.tabela === 'onb_agente_eventos' && c.op === 'insert'
      && (c.dados as Linha).tipo === 'perfil:pergunta_marcada');
    expect((marca?.dados as Linha).detalhe).toMatchObject({ pergunta: 'meta_pessoal', fila_id: 'fila-nova', marcada_em: MARCADA_EM, erro: null });
  });

  it('turno que acaba sem enviar nada: a pergunta não conta', async () => {
    // o modelo faz a pergunta, e em seguida decide ficar quieto: nada foi para o aluno
    estado.respostasModelo = [
      { content: [ferramenta('t1', { acabei_de_perguntar: 'meta_pessoal' })] },
      { content: [{ type: 'tool_use', id: 't2', name: 'nao_responder', input: { motivo: 'ele só agradeceu' } }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(0);
    expect(fila()).toHaveLength(0);
    expect(eventos()).toContain('silencio');
    expect(eventos()).not.toContain('perfil:pergunta_marcada');
  });

  it('fila que cancela a resposta na entrada: a pergunta também não conta', async () => {
    estado.filaCancela = 'Telefone arquivado.';
    estado.respostasModelo = [
      { content: [ferramenta('t1', { acabei_de_perguntar: 'meta_pessoal' })] },
      { content: [{ type: 'text', text: 'E me conta: qual é a sua maior meta com essa pós?' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(0);
    expect(eventos()).toContain('erro:fila_bloqueou');
  });

  it('a resposta pendente foi substituída: a pergunta que ia nela deixa de contar', async () => {
    estado.filaCanceladas = ['fila-velha'];
    estado.marcasPergunta = [{
      detalhe: { pergunta: 'meta_pessoal', fila_id: 'fila-velha', marcada_em: MARCADA_EM, antes: null },
    }];
    estado.respostasModelo = [{ content: [{ type: 'text', text: 'Fica na plataforma.' }] }];
    await chamar(C);
    expect(estado.rpcs.filter((r) => r.nome === 'onb_agente_desmarcar_pergunta')).toEqual([{
      nome: 'onb_agente_desmarcar_pergunta',
      args: { p_oportunidade_id: OP, p_pergunta: 'meta_pessoal', p_marcada_em: MARCADA_EM, p_anterior: null },
    }]);
    expect(eventos()).toContain('perfil:pergunta_desfeita');
  });

  it('categoria fora da lista: recusada, sem RPC, e o modelo é avisado com a lista', async () => {
    estado.respostasModelo = [
      { content: [ferramenta('t1', { meta_pessoal: 'ficar rico', meta_pessoal_categoria: 'ficar_rico' })] },
      { content: [{ type: 'text', text: 'Entendi!' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(0);
    const [r] = resultados();
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain('crescer_na_carreira');
    expect(eventos()).toContain('perfil:recusado');
  });

  it('nunca envia sexo, nem se o modelo inventar de mandar', async () => {
    estado.origem = mensagem({ conteudo: 'vi vocês no Instagram' });
    estado.respostasModelo = [
      { content: [ferramenta('t1', { como_conheceu: 'redes_sociais', como_conheceu_detalhe: 'Instagram', sexo: 'F' })] },
      { content: [{ type: 'text', text: 'Legal!' }] },
    ];
    await chamar(C);
    const [{ args }] = doPerfil();
    expect(Object.keys(args).filter((k) => /sexo/i.test(k))).toEqual([]);
    expect(Object.values(args)).not.toContain('F');
  });

  it('o contexto leva a linha do perfil e nunca o sexo, nem se o banco mandar', async () => {
    estado.contexto = { ...estado.contexto, sexo: 'F', sexo_origem: 'nome', sexo_confianca: 0.98 };
    await chamar(C);
    const [corpo] = estado.anthropic as { system: Linha[] }[];
    const ctx = String(corpo.system[1].text);
    expect(ctx).toContain('- Perfil do aluno: meta pessoal com a pós ainda não respondida, nunca perguntada');
    expect(ctx).toContain('você pode perguntar a meta pessoal dele com a pós.');
    expect(ctx).not.toMatch(/sexo|feminin|masculin/i);
  });

  it('pergunta já feita hoje: não marca de novo e manda tirar a pergunta da mensagem', async () => {
    estado.contexto = { ...estado.contexto, ...perfil({ meta_pessoal_perguntas: 1, meta_pessoal_perguntada_em: new Date().toISOString() }) };
    estado.respostasModelo = [
      { content: [ferramenta('t1', { acabei_de_perguntar: 'meta_pessoal' })] },
      { content: [{ type: 'text', text: 'Fica na plataforma.' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(0);
    expect(String(resultados()[0].content)).toContain('Hoje você já fez uma pergunta do perfil');
    expect(eventos()).toContain('perfil:recusado');
  });

  it('como conheceu antes da meta: vetada, a meta vem primeiro', async () => {
    estado.respostasModelo = [
      { content: [ferramenta('t1', { acabei_de_perguntar: 'como_conheceu' })] },
      { content: [{ type: 'text', text: 'Fica na plataforma.' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(0);
    expect(String(resultados()[0].content)).toContain('a meta pessoal dele com a pós');
  });

  it('as duas perguntas no mesmo turno: só a primeira fica marcada', async () => {
    estado.contexto = { ...estado.contexto, ...perfil({ meta_pessoal_perguntas: 1, meta_pessoal_perguntada_em: ontem() }) };
    estado.respostasModelo = [
      { content: [ferramenta('t1', { acabei_de_perguntar: 'meta_pessoal' }), ferramenta('t2', { acabei_de_perguntar: 'como_conheceu' })] },
      { content: [{ type: 'text', text: 'Me conta: qual é a sua maior meta com essa pós?' }] },
    ];
    await chamar(C);
    expect(doPerfil().map((r) => r.args.p_perguntou)).toEqual(['meta_pessoal']);
    expect(String(resultados()[1].content)).toContain('Nunca as duas');
  });

  it('passou para a equipe no mesmo turno: a pergunta não vai, mas a resposta dele fica', async () => {
    estado.origem = mensagem({ conteudo: 'ninguém me respondeu ainda. achei vocês no google' });
    estado.respostasModelo = [
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'passar_para_atendente', input: { assunto: 'reclamacao', motivo: 'ninguém respondeu' } },
          ferramenta('t2', { como_conheceu: 'google_site' }),
          ferramenta('t3', { acabei_de_perguntar: 'meta_pessoal' }),
        ],
      },
      { content: [{ type: 'text', text: 'Deixa eu confirmar isso certinho aqui e já te retorno.' }] },
    ];
    await chamar(C);
    expect(doPerfil()).toHaveLength(1);
    expect(doPerfil()[0].args).toMatchObject({ p_como_conheceu: 'google_site', p_perguntou: null });
    expect(String(resultados()[2].content)).toContain('passada para a equipe');
  });

  it('a RPC falhou ao contar a pergunta: a resposta já saiu, e fica o rastro', async () => {
    estado.perfilErro = 'function onb_agente_registrar_perfil does not exist';
    estado.respostasModelo = [
      { content: [ferramenta('t1', { acabei_de_perguntar: 'meta_pessoal' })] },
      { content: [{ type: 'text', text: 'E me conta: qual é a sua maior meta com essa pós?' }] },
    ];
    await chamar(C);
    expect(fila()).toHaveLength(1);
    const marca = estado.consultas.find((c) => c.tabela === 'onb_agente_eventos' && c.op === 'insert'
      && (c.dados as Linha).tipo === 'perfil:pergunta_marcada');
    expect(((marca?.dados as Linha).detalhe as Linha).erro).toContain('does not exist');
  });

  it('a RPC devolveu nulo sem erro (oportunidade não encontrada): também é falha', async () => {
    estado.perfilNulo = true;
    estado.origem = mensagem({ conteudo: 'quero passar em concurso' });
    estado.respostasModelo = [
      { content: [ferramenta('t1', { meta_pessoal: 'passar em concurso', meta_pessoal_categoria: 'concurso' })] },
      { content: [{ type: 'text', text: 'Boa!' }] },
    ];
    await chamar(C);
    expect(String(resultados()[0].content)).toContain('Não deu para registrar agora');
    const registro = estado.consultas.find((c) => c.tabela === 'onb_agente_eventos' && c.op === 'insert' && (c.dados as Linha).tipo === 'perfil:registrado');
    expect(((registro?.dados as Linha).detalhe as Linha).erro).toContain('oportunidade não encontrada');
  });

  it('contexto sem os campos do perfil (migration ainda não aplicada): não pergunta', async () => {
    const semPerfil = { ...estado.contexto };
    for (const k of Object.keys(perfil())) delete semPerfil[k];
    estado.contexto = semPerfil;
    estado.respostasModelo = [
      { content: [ferramenta('t1', { acabei_de_perguntar: 'meta_pessoal' })] },
      { content: [{ type: 'text', text: 'Fica na plataforma.' }] },
    ];
    await chamar(C);
    const [corpo] = estado.anthropic as { system: Linha[] }[];
    expect(String(corpo.system[1].text)).toContain('Perfil do aluno: não disponível agora');
    expect(doPerfil()).toHaveLength(0);
  });

  it('sem a oportunidade do aluno: nem chega ao modelo, nem à RPC do perfil', async () => {
    estado.aluno = { ...estado.aluno, oportunidade_id: null };
    await chamar(C);
    expect(eventos()).toContain('pulado:sem_card');
    expect(estado.anthropic).toHaveLength(0);
    expect(doPerfil()).toHaveLength(0);
  });
});

/**
 * ÁUDIO (12/09/2026). Quem transcreve é a fila do banco (`onb_agente_audio_fila`, migration
 * 20260912160000); a edge só espera o texto aparecer na `metadata` da mensagem. O banco falso
 * devolve `estado.origem` na consulta por wa_message_id, que é exatamente o que a espera lê.
 */
describe('crm-agente-aluno: áudio do aluno', () => {
  const audio = (metadata: Linha = {}) =>
    mensagem({ tipo: 'audio', conteudo: '[áudio]', metadata });
  const renovacoes = () => estado.rpcs.filter((r) => r.nome === 'onb_agente_lock_renovar').length;

  it('com a transcrição pronta, o modelo recebe o que ele FALOU e não espera nada', async () => {
    estado.origem = audio({ audio_transcricao: 'Oi, queria saber quando começa a minha turma.' });
    estado.historico = [estado.origem];
    await chamar(C);
    const enviado = JSON.stringify((estado.anthropic[0] as { messages: unknown }).messages);
    expect(enviado).toContain('Oi, queria saber quando começa a minha turma.');
    expect(enviado).toContain('esta é a transcrição do que ele falou');
    expect(enviado).not.toContain('não consegue ouvir');
    expect(eventos()).toContain('audio:transcrito');
    expect(renovacoes()).toBe(0);
  });

  it('sem transcrição no prazo, espera, avisa e mantém o caminho antigo', async () => {
    estado.origem = audio();
    estado.historico = [estado.origem];
    await chamar(C);
    const enviado = JSON.stringify((estado.anthropic[0] as { messages: unknown }).messages);
    expect(enviado).toContain('(ele mandou um áudio, que você não consegue ouvir)');
    expect(eventos()).toContain('audio:sem_transcricao');
    // Esperou de verdade, renovando a trava a cada volta: sem isso a espera comeria a trava.
    expect(renovacoes()).toBeGreaterThan(0);
  });

  it('áudio de quem o assistente não atende não segura turno nenhum', async () => {
    // Fora do horário a mensagem é adiada ANTES da espera: a transcrição do áudio de madrugada
    // continua acontecendo na fila, mas o turno não fica parado esperando por ela.
    estado.origem = audio();
    estado.origem = { ...estado.origem, created_at: ultimaVez(23) };
    await chamar(C);
    expect(eventos()).toContain('adiado:fora_do_horario');
    expect(eventos()).not.toContain('audio:sem_transcricao');
    expect(renovacoes()).toBe(0);
  });
});

describe('crm-agente-aluno: o que chegou no meio do turno', () => {
  const b = { wa_message_id: 'wamid.B', telefone: FONE, created_at: new Date().toISOString() };

  it('turno que termina em nao_responder ainda vai buscar a mensagem que bateu no lock', async () => {
    estado.origem = mensagem({ conteudo: 'obrigado!' });
    estado.novas = [b];
    estado.respostasModelo = [
      { content: [{ type: 'tool_use', id: 't1', name: 'nao_responder', input: { motivo: 'agradecimento' } }] },
      { content: [{ type: 'text', text: 'A próxima é terça, 15/09, das 19:00 às 22:00.' }] },
    ];
    await chamar(C);
    expect(eventos()).toContain('silencio');
    expect(eventos()).toContain('retomando:chegou_no_meio');
    expect(eventos()).toContain('respondido');
    expect(fila()).toHaveLength(1);
  });

  it('turno barrado por uma porta também passa pela retomada', async () => {
    estado.aluno = { ...estado.aluno, papel: null, etapa_nome: 'INTEGRADO' };
    estado.novas = [b];
    await chamar(C);
    expect(eventos().filter((t) => t === 'retomando:chegou_no_meio')).toHaveLength(1);
  });

  it('figurinha já marcada no meio não esconde a pergunta que veio depois dela', async () => {
    estado.novas = [{ ...b, wa_message_id: 'wamid.FIGURINHA' }, b];
    estado.feitas = ['wamid.FIGURINHA'];
    estado.respostasModelo = [
      { content: [{ type: 'text', text: 'Fica na plataforma.' }] },
      { content: [{ type: 'text', text: 'A próxima é terça.' }] },
    ];
    await chamar(C);
    const retomadas = estado.consultas
      .filter((c) => c.tabela === 'onb_agente_eventos' && c.op === 'insert' && (c.dados as Linha).tipo === 'retomando:chegou_no_meio')
      .map((c) => ((c.dados as Linha).detalhe as Linha).msgId);
    expect(retomadas).toEqual(['wamid.B']);
  });
});
