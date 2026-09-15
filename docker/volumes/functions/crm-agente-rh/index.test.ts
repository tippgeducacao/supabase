import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercita a edge inteira sem banco, rede externa ou envio de mensagens reais.
type Registro = Record<string, unknown>;
const estado = vi.hoisted(() => ({
  respostas: [] as Registro[], chamadas: [] as Registro[], fila: [] as Registro[], eventos: [] as Registro[],
}));
const CONTA = 'conta-rh-teste';
const TELEFONE = '5546999990001';

vi.mock('https://esm.sh/@supabase/supabase-js@2.50.3', () => ({
  createClient: () => ({
    rpc: async (nome: string) => ({
      data: nome === 'rh_conta_meta' ? 'conta-rh-teste'
        : nome === 'rh_agente_card_por_telefone' ? [{ oportunidade_id: 'op-teste', lead_id: 'lead-teste', lead_nome: 'Pessoa', papel: 'coleta', etapa_nome: 'Contato 02' }]
        : true,
      error: null,
    }),
    from: (tabela: string) => {
      let op = 'select';
      let conteudo: Registro = {};
      const filtros: [string, unknown][] = [];
      const resultado = () => {
        if (op === 'insert') {
          if (tabela === 'rh_agente_eventos') estado.eventos.push(conteudo);
          if (tabela === 'crm_mensagens_agendadas') estado.fila.push(conteudo);
          return { data: null, error: null };
        }
        if (op !== 'select') return { data: null, error: null };
        if (tabela === 'crm_campos') return { data: { id: 'campo-area' }, error: null };
        if (tabela === 'crm_campo_valores') return { data: { id: 'origem-candidato' }, error: null };
        if (tabela === 'rh_entrevista_config') return { data: {}, error: null };
        if (tabela === 'crm_whatsapp_messages' && !filtros.some(([k, v]) => k === 'gt' || (k === 'direcao' && v === 'outbound'))) {
          return { data: [{ telefone: '5546999990001', direcao: 'inbound', conteudo: 'Conheço uma pessoa da equipe.', created_at: new Date().toISOString() }], error: null };
        }
        return { data: [], error: null };
      };
      const q: Registro = {};
      for (const metodo of ['select', 'eq', 'ilike', 'gt', 'gte', 'order', 'limit', 'or', 'in', 'update', 'insert', 'delete']) {
        q[metodo] = (...args: unknown[]) => {
          if (['insert', 'update', 'delete'].includes(metodo)) { op = metodo; conteudo = (args[0] ?? {}) as Registro; }
          if (metodo === 'eq') filtros.push([String(args[0]), args[1]]);
          if (metodo === 'gt') filtros.push(['gt', args[1]]);
          return q;
        };
      }
      q.maybeSingle = async () => resultado();
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resultado()).then(resolve);
      return q;
    },
  }),
}));

let handler: (req: Request) => Promise<Response>;
let limparResposta: (texto: string) => string;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => ({ SUPABASE_URL: 'https://supabase.invalid', AGENTE_RH_ANTHROPIC_KEY: 'chave-ficticia' } as Registro)[chave] },
    serve: (fn: typeof handler) => { handler = fn; },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('Rede bloqueada no teste');
    estado.chamadas.push(JSON.parse(init.body));
    return new Response(JSON.stringify(estado.respostas.shift() ?? { content: [] }));
  }));
  ({ limparResposta } = await import('./index'));
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => {
  estado.respostas = []; estado.chamadas = []; estado.fila = []; estado.eventos = [];
});

async function chamar() {
  const execucao = handler(new Request('https://edge.invalid/crm-agente-rh', {
    method: 'POST', body: JSON.stringify({ wa_account_id: CONTA, direcao: 'inbound', telefone: TELEFONE, id: 'wamid.teste', conteudo: 'Conheço uma pessoa da equipe.' }),
  }));
  await vi.runAllTimersAsync();
  return await execucao;
}
const consulta = (id = 'consulta-1') => ({ content: [
  { type: 'text', text: 'Preciso conferir o nome e decidir a próxima pergunta.' },
  { type: 'tool_use', id, name: 'conferir_colaborador', input: { nome: 'Pessoa sintética' } },
] });

describe('RH: bastidor não vira resposta reserva', () => {
  it('resposta vazia após ferramenta não recupera a análise anterior', async () => {
    estado.respostas = [consulta(), { content: [] }];
    expect((await chamar()).status).toBe(200);
    expect(estado.chamadas).toHaveLength(2);
    expect(estado.fila).toEqual([]);
    expect(estado.eventos).toContainEqual(expect.objectContaining({ tipo: 'erro', detalhe: expect.objectContaining({ motivo: 'resposta vazia' }) }));
  });

  it('resposta final legítima é a única que entra na fila', async () => {
    estado.respostas = [consulta(), { content: [{ type: 'text', text: 'Você poderia me enviar seu currículo?' }] }];
    await chamar();
    expect(estado.chamadas).toHaveLength(2);
    expect(estado.fila.map((m) => m.conteudo)).toEqual(['Você poderia me enviar seu currículo?']);
  });

  it('limite de ferramentas não manda texto intermediário', async () => {
    estado.respostas = Array.from({ length: 4 }, (_, i) => consulta(`consulta-${i}`));
    await chamar();
    expect(estado.chamadas).toHaveLength(4);
    expect(estado.fila).toEqual([]);
  });

  it.each(['thinking', 'thought', 'thoughts', 'scratchpad', 'reasoning', 'reflection', 'antml:thinking'])('remove bloco completo, truncado e fechamento órfão de %s', (tag) => {
    expect(limparResposta(`<${tag}>Preciso decidir.</${tag}>Pode enviar seu currículo!`)).toBe('Pode enviar seu currículo!');
    expect(limparResposta(`<${tag}>Preciso decidir.`)).toBe('');
    expect(limparResposta(`Pode enviar seu currículo! <${tag}>Preciso decidir.`)).toBe('Pode enviar seu currículo!');
    expect(limparResposta(`Preciso decidir.</${tag}>Pode enviar seu currículo!`)).toBe('Pode enviar seu currículo!');
  });
});
