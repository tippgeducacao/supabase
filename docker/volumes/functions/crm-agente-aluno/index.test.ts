import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Banco e Anthropic falsos: o turno inteiro roda aqui, sem rede e sem WhatsApp.
// A conta vem da RPC onb_agente_conta; o banco falso devolve este marcador.
const CONTA = '<CONTA>';
const OP = '00000000-0000-4000-8000-000000000001';
const FONE = '554699112233';

type Linha = Record<string, unknown>;
type Consulta = { tabela: string; op: string; filtros: [string, string, unknown][]; dados?: unknown };

const estado = vi.hoisted(() => ({
  consultas: [] as { tabela: string; op: string; filtros: [string, string, unknown][]; dados?: unknown }[],
  rpcs: [] as { nome: string; args: Record<string, unknown> }[],
  anthropic: [] as Record<string, unknown>[],
  respostasModelo: [] as unknown[],
  origem: null as Record<string, unknown> | null,
  historico: [] as Record<string, unknown>[],
  saidas: [] as Record<string, unknown>[],
  aluno: null as Record<string, unknown> | null,
  contexto: null as Record<string, unknown> | null,
  config: null as Record<string, unknown> | null,
  /** Inbound que chegou depois do que o turno leu (a busca da retomada). */
  novas: [] as Record<string, unknown>[],
  /** wa_message_id já marcados em onb_agente_processadas. */
  feitas: [] as string[],
  /** A marca `manha:disparada` que o tick das 8h grava antes de chamar. */
  marcaManha: null as Record<string, unknown> | null,
  /** O trigger da fila cancelando a linha na entrada. */
  filaCancela: null as string | null,
  tcc: null as Record<string, unknown> | null,
}));

function responder(c: Consulta): { data: unknown; error: unknown } {
  const f = (col: string) => c.filtros.find(([k]) => k === col)?.[2];
  if (c.tabela === 'crm_whatsapp_messages') {
    if (f('wa_message_id')) return { data: estado.origem, error: null };
    if (f('direcao') === 'outbound') return { data: estado.saidas, error: null };
    if (f('direcao') === 'inbound') return { data: estado.novas, error: null }; // retomada
    return { data: estado.historico, error: null };
  }
  if (c.tabela === 'onb_agente_config') return { data: estado.config, error: null };
  if (c.tabela === 'onb_agente_eventos' && c.op === 'select') return { data: estado.marcaManha, error: null };
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
      data: estado.filaCancela ? { status: 'cancelado', erro_detalhe: estado.filaCancela } : { status: 'agendado', erro_detalhe: null },
      error: null,
    };
  }
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
  encadeia('select');
  encadeia('eq', (k, v) => c.filtros.push([String(k), 'eq', v]));
  encadeia('ilike', (k, v) => c.filtros.push([String(k), 'ilike', v]));
  encadeia('gt', (k, v) => c.filtros.push([String(k), 'gt', v]));
  encadeia('gte', (k, v) => c.filtros.push([String(k), 'gte', v]));
  encadeia('in', (k, v) => c.filtros.push([String(k), 'in', v]));
  encadeia('order');
  encadeia('limit');
  encadeia('insert', (d) => { c.op = 'insert'; c.dados = d; });
  encadeia('update', (d) => { c.op = 'update'; c.dados = d; });
  encadeia('delete', () => { c.op = 'delete'; });
  q.maybeSingle = async () => responder(c);
  q.then = (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise.resolve(responder(c)).then(ok, erro);
  return q;
}

vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({
  createClient: () => ({
    from: (tabela: string) => construtor(tabela),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      estado.rpcs.push({ nome, args });
      switch (nome) {
        case 'onb_agente_conta': return { data: '<CONTA>', error: null };
        case 'onb_agente_lock_claim': return { data: true, error: null };
        case 'onb_agente_aluno_por_telefone': return { data: estado.aluno ? [estado.aluno] : [], error: null };
        case 'onb_agente_contexto': return { data: estado.contexto, error: null };
        case 'onb_agente_registrar_transferencia': return { data: 'transf-nova', error: null };
        case 'onb_agente_proximas_aulas':
          return { data: [{ data: '2026-09-15', dow: 2, horario: '19:00 - 22:00', titulo: 'Pré-abertura \u2014 Boas-vindas' }], error: null };
        case 'onb_agente_tcc_status': return { data: estado.tcc ? [estado.tcc] : [], error: null };
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
  vi.useFakeTimers({ toFake: ['setTimeout'] });
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
  estado.consultas = [];
  estado.rpcs = [];
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
    modelo: 'claude-sonnet-5', horario_inicio: '08:00:00', horario_fim: '21:00:00', teste_telefones: [],
    liberado_para_todos: true,
    tcc_site_url: 'https://tcc.ppgeducacao.com.br', mentoria_tcc_quando: 'todo sábado, às 9h',
    mentoria_tcc_url: 'https://meet.google.com/cft-inax-tbw',
  };
  estado.novas = [];
  estado.feitas = [];
  estado.marcaManha = null;
  estado.filaCancela = null;
  estado.tcc = null;
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
    ]);
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
