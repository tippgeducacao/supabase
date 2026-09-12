// A régua da integração inteira, com o transporte simulado: banco, Meta e as duas edges
// vizinhas são dublês. O que está sob teste é a decisão de mandar ou não mandar, que é a única
// coisa aqui que o aluno enxerga quando erra.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.49.4', () => ({ createClient: () => mocks }));

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://supabase.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'chave-do-container',
  ONB_REGUA_TOKEN: 'token-da-regua',
};

/** A chave que o BANCO conhece é outra, e é longa (JWT). Ver o comentário no index.ts. */
const CHAVE_DO_BANCO = 'jwt.de.servico.que.so.o.banco.conhece.0123456789';

const TELEFONE_DO_TESTE = '5546999321082';
const TELEFONE_DE_ALUNO = '5511988887777';
const CONTA_3250 = 'b5987306-4f73-46fb-b90a-054ad800c9ab';

let handler: (req: Request) => Promise<Response>;
let config: Record<string, unknown>;
let candidatos: Record<string, unknown>[];
let janelaOk: boolean;
let envioAnterior: Record<string, unknown> | null;
let respostaEnvio: Response;
let respostaCronograma: Response;
let reservaDaRodada: boolean;
let logs: string[];

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (chave: string) => ENV[chave] ?? '' },
    serve: (h: typeof handler) => { handler = h; },
  });
  vi.stubGlobal('fetch', mocks.fetch);
  await import('./index');
});
afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => {
  vi.resetAllMocks();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });

  janelaOk = true;
  reservaDaRodada = true;
  envioAnterior = null;
  config = {
    modo: 'producao',
    telefones_teste: ['+55 (46) 99932-1082'],
    pausado: false,
    wa_account_id: CONTA_3250,
    lote_max: 20,
  };
  candidatos = [{
    oportunidade_id: 'opo-1',
    via: 'posicao',
    lead_id: 'lead-1',
    nome: 'Maria',
    nome_completo: 'MARIA DA SILVA SOUZA',
    telefone: TELEFONE_DE_ALUNO,
    wa_account_id: CONTA_3250,
    etapa_id: 'etapa-9',
    etapa_nome: 'D+9 · DOCUMENTOS',
    ordem: 6,
    dia: 9,
    acao: 'enviar',
    motivo: null,
    template_nome: 'int_aluno_09_documentos',
    cabecalho: null,
    midia_url: null,
    variaveis: ['nome'],
    valores: ['Maria'],
    turma_id: 'turma-1',
    curso: 'Clínica Médica e Cirúrgica de Bovinos',
    marca: 'PPGVet Educação',
    aulas_futuras: 42,
    modo: 'producao',
  }];
  respostaEnvio = new Response(JSON.stringify({ success: true, wa_message_id: 'wamid.integracao' }));
  respostaCronograma = new Response(JSON.stringify({
    ok: true, url: 'https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/c/1.pdf',
    filename: 'Cronograma 02-26 #01.pdf', aulas_futuras: 42,
  }));

  mocks.from.mockImplementation((tabela: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      limit: () => q,
      maybeSingle: async () => ({
        data: tabela === 'onb_regua_config' ? config : tabela === 'onb_regua_envios' ? envioAnterior : null,
        error: null,
      }),
    };
    return q;
  });
  mocks.rpc.mockImplementation(async (nome: string, args?: Record<string, unknown>) => {
    if (nome === '_get_service_role_key') return { data: CHAVE_DO_BANCO, error: null };
    if (nome === 'onb_regua_janela_ok') return { data: janelaOk, error: null };
    if (nome === 'onb_regua_rodada_claim') return { data: reservaDaRodada, error: null };
    if (nome === 'onb_regua_rodada_liberar') return { data: null, error: null };
    if (nome === 'onb_regua_candidatos') return { data: candidatos, error: null };
    if (nome === 'onb_regua_registrar') {
      // Espelha o onb_regua_registrar de verdade: ele chama o onb_regua_mover, e o mover só
      // anda quando existe linha enviada/simulada. Passo pulado ou com erro fica onde está.
      const saiu = args?.p_status === 'enviado' || args?.p_status === 'simulado';
      return {
        data: {
          ok: true,
          envio_id: 'envio-1',
          mover: { movido: saiu, motivo: saiu ? 'tempo_cumprido' : 'aguardando_envio' },
        },
        error: null,
      };
    }
    if (nome === 'onb_regua_mover') return { data: { movido: true, motivo: 'passo_sem_modelo' }, error: null };
    return { data: null, error: null };
  });
  mocks.fetch.mockImplementation(async (url: string) => {
    if (String(url).includes('crm-whatsapp-templates')) {
      return new Response(JSON.stringify({
        templates: [
          { name: 'int_aluno_01_boasvindas_cronograma', status: 'APPROVED' },
          { name: 'int_aluno_09_documentos', status: 'APPROVED' },
          { name: 'int_aluno_02_plataforma_texto', status: 'PENDING' },
        ],
      }));
    }
    if (String(url).includes('generate-cronograma-aluno-pdf')) return respostaCronograma;
    if (String(url).includes('crm-whatsapp-send')) return respostaEnvio;
    return new Response('{}', { status: 404 });
  });
});

async function chamar(corpo: Record<string, unknown> = {}, token = 'chave-do-container') {
  const res = await handler(new Request('https://supabase.invalid/onb-regua-dispatch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  }));
  return { status: res.status, corpo: await res.json() };
}

const chamadas = (alvo: string) => mocks.fetch.mock.calls.filter((c) => String(c[0]).includes(alvo));
const envios = () => chamadas('crm-whatsapp-send');
const corpoDoEnvio = () => JSON.parse(String(envios()[0][1].body));
const chamadasRpc = (nome: string) => mocks.rpc.mock.calls.filter((c) => c[0] === nome).map((c) => c[1]);
const registros = () => chamadasRpc('onb_regua_registrar');
const registro = () => registros().at(-1) as Record<string, unknown>;

describe('modo simulação', () => {
  it('da config: não manda nada pela rede e grava o payload inteiro', async () => {
    config.modo = 'simulacao';
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(0);
    expect(corpo).toMatchObject({ modo: 'simulacao', simulados: 1, enviados: 0 });
    expect(registro()).toMatchObject({ p_status: 'simulado', p_oportunidade_id: 'opo-1', p_etapa_id: 'etapa-9' });
    expect(registro().p_payload).toMatchObject({
      tipo: 'template',
      template_name: 'int_aluno_09_documentos',
      template_lang: 'pt_BR',
      telefone: TELEFONE_DE_ALUNO,
      template_components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }],
    });
  });

  it('pedida no corpo por cima da produção é ENSAIO: não envia e não grava', async () => {
    const { corpo } = await chamar({ modo: 'simulacao' });
    expect(corpo).toMatchObject({ modo: 'simulacao', ensaio: true });
    expect(envios()).toHaveLength(0);
    expect(registros()).toHaveLength(0);
    expect(chamadasRpc('onb_regua_mover')).toHaveLength(0);
    expect(corpo.resultados[0]).toMatchObject({ status: 'simulado' });
  });

  it('o corpo do POST não sobe o modo: curl não liga a produção', async () => {
    config.modo = 'teste';
    const { corpo } = await chamar({ modo: 'producao' });
    expect(corpo).toMatchObject({ modo: 'teste', modo_pedido: 'producao', modo_rebaixado: true });
  });

  it('ensaio em TESTE por cima da produção também não manda nada, nem para quem está na lista', async () => {
    // O furo que isto tranca: com a config em produção e { modo: 'teste' } no corpo, o candidato
    // que passa na lista de teste ia direto ao crm-whatsapp-send (o desvio de simulação não pega
    // o modo 'teste') e nenhuma linha era gravada, então o tick seguinte mandava tudo de novo.
    candidatos[0].telefone = TELEFONE_DO_TESTE;
    const { corpo } = await chamar({ modo: 'teste' });
    expect(corpo).toMatchObject({ modo: 'teste', ensaio: true, enviados: 0 });
    expect(envios()).toHaveLength(0);
    expect(registros()).toHaveLength(0);
    expect(chamadasRpc('onb_regua_mover')).toHaveLength(0);
    expect(corpo.resultados[0]).toMatchObject({ status: 'simulado', motivo: 'ensaio' });
  });

  it('ensaio não reserva a rodada, que é da régua de verdade', async () => {
    await chamar({ modo: 'simulacao' });
    expect(chamadasRpc('onb_regua_rodada_claim')).toHaveLength(0);
  });
});

describe('modo teste', () => {
  beforeEach(() => { config.modo = 'teste'; });

  it('barra quem não está na lista e mascara o número no log', async () => {
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(0);
    expect(corpo).toMatchObject({ pulados: 1, enviados: 0 });
    expect(registro()).toMatchObject({ p_status: 'pulado', p_motivo: 'fora_do_teste' });
    expect(logs.join('\n')).toContain('5511*******77');
    expect(logs.join('\n')).not.toContain(TELEFONE_DE_ALUNO);
    expect(JSON.stringify(corpo)).not.toContain(TELEFONE_DE_ALUNO);
  });

  it('envia para quem está na lista', async () => {
    candidatos[0].telefone = TELEFONE_DO_TESTE;
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(1);
    expect(corpoDoEnvio()).toMatchObject({ telefone: TELEFONE_DO_TESTE, wa_account_id: CONTA_3250 });
    expect(corpo.enviados).toBe(1);
  });
});

describe('D+1, o passo do cronograma', () => {
  beforeEach(() => {
    candidatos[0] = {
      ...candidatos[0],
      etapa_id: 'etapa-0',
      etapa_nome: 'NOVO ALUNO',
      ordem: 0,
      dia: 1,
      template_nome: 'int_aluno_01_boasvindas_cronograma',
      cabecalho: 'documento',
      midia_url: null,
      variaveis: ['nome', 'curso'],
      valores: ['Maria', 'Clínica Médica e Cirúrgica de Bovinos'],
    };
  });

  it('com cronograma publicado, o PDF vai no cabeçalho', async () => {
    const { corpo } = await chamar();
    expect(chamadas('generate-cronograma-aluno-pdf')).toHaveLength(1);
    expect(JSON.parse(String(chamadas('generate-cronograma-aluno-pdf')[0][1].body)))
      .toEqual({ oportunidade_id: 'opo-1' });
    expect(corpoDoEnvio()).toMatchObject({
      header_media_format: 'DOCUMENT',
      header_media_url: 'https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/c/1.pdf',
      header_media_filename: 'Cronograma 02-26 #01.pdf',
    });
    expect(corpo.enviados).toBe(1);
  });

  it('turma sem cronograma publicado vira caminho B, sem envio', async () => {
    respostaCronograma = new Response(JSON.stringify({ ok: false, code: 'sem_cronograma' }), { status: 422 });
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(0);
    expect(corpo).toMatchObject({ pulados: 1, enviados: 0 });
    expect(registro()).toMatchObject({ p_status: 'pulado', p_motivo: 'sem_cronograma:sem_cronograma' });
  });

  it('cronograma sem aula daqui para a frente também é caminho B', async () => {
    respostaCronograma = new Response(JSON.stringify({ ok: true, url: 'https://x.invalid/a.pdf', aulas_futuras: 0 }));
    await chamar();
    expect(envios()).toHaveLength(0);
    expect(registro()).toMatchObject({ p_status: 'pulado', p_motivo: 'sem_cronograma:sem_aula_futura' });
  });

  it('o PDF só é gerado para quem passou nas outras travas', async () => {
    config.modo = 'teste';
    const { corpo } = await chamar();
    expect(chamadas('generate-cronograma-aluno-pdf')).toHaveLength(0);
    expect(corpo.pulados).toBe(1);
    expect(registro()).toMatchObject({ p_motivo: 'fora_do_teste' });
  });

  it('o alerta do banco (aluno sem turma) vira log sem ir até o PDF', async () => {
    candidatos[0].alerta = 'sem_turma';
    candidatos[0].turma_id = null;
    const { corpo } = await chamar();
    expect(chamadas('generate-cronograma-aluno-pdf')).toHaveLength(0);
    expect(envios()).toHaveLength(0);
    expect(corpo.pulados).toBe(1);
    expect(registro()).toMatchObject({ p_status: 'pulado', p_motivo: 'sem_turma' });
  });
});

describe('nunca duas vezes o mesmo passo', () => {
  it('passo que já tem envio gravado não sai de novo nem gera registro', async () => {
    envioAnterior = { id: 'envio-antigo' };
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(0);
    expect(registros()).toHaveLength(0);
    expect(corpo).toMatchObject({ ja_enviados: 1, processados: 1 });
  });

  it('banco indisponível para conferir não vira envio otimista', async () => {
    mocks.from.mockImplementation((tabela: string) => {
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q, in: () => q, limit: () => q,
        maybeSingle: async () => tabela === 'onb_regua_config'
          ? { data: config, error: null }
          : { data: null, error: { message: 'indisponível' } },
      };
      return q;
    });
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(0);
    expect(corpo.ja_enviados).toBe(1);
  });

  it('o mesmo par oportunidade/etapa repetido na rodada sai uma vez só', async () => {
    candidatos = [candidatos[0], { ...candidatos[0] }];
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(1);
    expect(corpo.processados).toBe(1);
  });

  it('rodada anterior ainda em andamento não abre uma segunda', async () => {
    // A conferência de envios da segunda rodada acontece antes de a primeira gravar: sem a
    // reserva, as duas mandam o mesmo passo e a unique só percebe depois de entregue.
    reservaDaRodada = false;
    const { corpo } = await chamar();
    expect(corpo).toMatchObject({ parado: 'rodada_em_andamento', processados: 0 });
    expect(chamadasRpc('onb_regua_candidatos')).toHaveLength(0);
    expect(envios()).toHaveLength(0);
  });

  it('a reserva é devolvida no fim da rodada', async () => {
    await chamar();
    expect(chamadasRpc('onb_regua_rodada_liberar')).toHaveLength(1);
  });
});

describe('quando o envio não acontece', () => {
  it('erro da Meta vira erro registrado e a etapa NÃO anda', async () => {
    respostaEnvio = new Response(JSON.stringify({ error: 'Message undeliverable (131026)' }), { status: 422 });
    const { corpo } = await chamar();
    expect(corpo).toMatchObject({ erros: 1, enviados: 0, movidos: 0 });
    expect(registro()).toMatchObject({ p_status: 'erro', p_motivo: 'Message undeliverable (131026)' });
    expect(chamadasRpc('onb_regua_mover')).toHaveLength(0);
  });

  it('resposta 200 sem confirmação também é erro, não sucesso', async () => {
    respostaEnvio = new Response('{}', { status: 200 });
    const { corpo } = await chamar();
    expect(corpo.erros).toBe(1);
    expect(registro()).toMatchObject({ p_status: 'erro' });
  });

  it('timeout no envio não vira sucesso', async () => {
    const listagem = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('crm-whatsapp-templates')) return listagem(url, init);
      throw new Error('Timeout simulado');
    });
    const { corpo } = await chamar();
    expect(corpo.erros).toBe(1);
    expect(registro()).toMatchObject({ p_status: 'erro', p_motivo: 'Timeout simulado' });
  });

  it('recusa da Meta por frequência adia o passo, não o transforma em erro', async () => {
    // A crm-whatsapp-send NÃO devolve `skipped`: a trava de "1 template por 24 h" foi removida de
    // lá a pedido do diretor. O que chega de verdade é o código de pacing da Meta.
    respostaEnvio = new Response(
      JSON.stringify({ error: '(#131049) This message was not delivered to maintain healthy ecosystem engagement' }),
      { status: 400 },
    );
    const { corpo } = await chamar();
    expect(corpo).toMatchObject({ pulados: 1, erros: 0, movidos: 0 });
    expect(String(registro().p_motivo)).toContain('frequencia_meta');
  });

  it('modelo ainda não aprovado na Meta não é disparado', async () => {
    candidatos[0].template_nome = 'int_aluno_02_plataforma_texto';
    await chamar();
    expect(envios()).toHaveLength(0);
    expect(registro()).toMatchObject({ p_status: 'pulado', p_motivo: 'modelo_nao_aprovado' });
  });
});

describe('envio que dá certo', () => {
  it('registra o id da Meta e deixa o banco mover a etapa', async () => {
    const { corpo } = await chamar();
    expect(corpoDoEnvio()).toMatchObject({
      tipo: 'template',
      template_name: 'int_aluno_09_documentos',
      oportunidade_id: 'opo-1',
      lead_id: 'lead-1',
      origem: 'automacao',
    });
    expect(registro()).toMatchObject({
      p_status: 'enviado',
      p_wa_message_id: 'wamid.integracao',
      p_telefone: TELEFONE_DE_ALUNO,
      p_template_nome: 'int_aluno_09_documentos',
    });
    expect(corpo).toMatchObject({ enviados: 1, processados: 1, movidos: 1 });
    expect(JSON.stringify(corpo)).not.toContain(TELEFONE_DE_ALUNO);
  });
});

describe('passo que só anda', () => {
  it('acao mover chama o onb_regua_mover e não manda mensagem nenhuma', async () => {
    candidatos[0].acao = 'mover';
    candidatos[0].motivo = 'passo_sem_modelo';
    const { corpo } = await chamar();
    expect(envios()).toHaveLength(0);
    expect(registros()).toHaveLength(0);
    expect(chamadasRpc('onb_regua_mover')).toEqual([{ p_oportunidade_id: 'opo-1' }]);
    expect(corpo).toMatchObject({ movidos: 1, enviados: 0 });
  });

  it('mover que não moveu aparece com o motivo do banco', async () => {
    candidatos[0].acao = 'mover';
    mocks.rpc.mockImplementation(async (nome: string) => {
      if (nome === '_get_service_role_key') return { data: CHAVE_DO_BANCO, error: null };
      if (nome === 'onb_regua_janela_ok') return { data: true, error: null };
      if (nome === 'onb_regua_rodada_claim') return { data: true, error: null };
      if (nome === 'onb_regua_candidatos') return { data: candidatos, error: null };
      if (nome === 'onb_regua_mover') return { data: { movido: false, motivo: 'ainda_no_prazo' }, error: null };
      return { data: null, error: null };
    });
    const { corpo } = await chamar();
    expect(corpo.movidos).toBe(0);
    expect(corpo.resultados[0]).toMatchObject({ status: 'movido', motivo: 'ainda_no_prazo' });
  });
});

describe('freios da rodada inteira', () => {
  it('pausado não processa ninguém', async () => {
    config.pausado = true;
    const { corpo } = await chamar();
    expect(corpo).toMatchObject({ parado: 'pausado', processados: 0 });
    expect(chamadasRpc('onb_regua_candidatos')).toHaveLength(0);
  });

  it('fora da janela de horário (quem decide é o banco) não processa ninguém', async () => {
    janelaOk = false;
    const { corpo } = await chamar();
    expect(corpo).toMatchObject({ parado: 'fora_da_janela', processados: 0 });
    expect(envios()).toHaveLength(0);
  });

  it('sem limite no corpo, a RPC recebe null e o lote_max da config manda', async () => {
    await chamar();
    expect(chamadasRpc('onb_regua_candidatos')).toEqual([{ p_limite: null }]);
  });

  it('limite do corpo chega na RPC de candidatos', async () => {
    await chamar({ limite: 3 });
    expect(chamadasRpc('onb_regua_candidatos')).toEqual([{ p_limite: 3 }]);
  });
});

describe('quem pode chamar', () => {
  it('sem token, 401', async () => {
    const res = await handler(new Request('https://supabase.invalid/onb-regua-dispatch', { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(chamadasRpc('onb_regua_candidatos')).toHaveLength(0);
  });

  it('token errado, 401', async () => {
    const { status } = await chamar({}, 'token-chutado');
    expect(status).toBe(401);
  });

  it('token próprio da régua serve para o POST manual', async () => {
    const { status } = await chamar({}, 'token-da-regua');
    expect(status).toBe(200);
  });

  it('a chave de serviço do BANCO serve, que é a que o cron manda por pg_net', async () => {
    const { status } = await chamar({}, CHAVE_DO_BANCO);
    expect(status).toBe(200);
  });

  it('GET não roda a régua', async () => {
    const res = await handler(new Request('https://supabase.invalid/onb-regua-dispatch', {
      method: 'GET', headers: { Authorization: 'Bearer chave-do-container' },
    }));
    expect(res.status).toBe(405);
  });
});
