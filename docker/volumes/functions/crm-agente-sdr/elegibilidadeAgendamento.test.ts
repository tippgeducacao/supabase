import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtxConversa } from './tools.ts';

// Regressão adversarial do limite entre as tools (05/09/2026). Executores, leitura/escrita do lead e cálculo do prazo são reais.
// Só banco, HTTP e modelo são simulados. Interceptar o POST prova que a barreira
// TypeScript foi atravessada; não prova que a API/banco de produção criaria a reunião.
const fronteiras = vi.hoisted(() => ({ modelo: vi.fn(), fetch: vi.fn() }));
vi.mock('./agente.ts', () => ({ chamarAnthropic: fronteiras.modelo }));

const TELEFONE = '5500000000000';
const REMOTEJID = `${TELEFONE}@s.whatsapp.net`;
const API = 'https://sdr-api.invalid/functions/v1/sdr-api';
const LEAD_ID = '00000000-0000-4000-8000-000000000001';
const CURSO_ID = '00000000-0000-4000-8000-000000000002';
const VENDEDOR_ID = '00000000-0000-4000-8000-000000000003';
const PRIMEIRA_AVALIACAO_ID = '10000000-0000-4000-8000-000000000001';
const CONTEXTO: CtxConversa & { canal: 'webchat' } = {
  remotejid: REMOTEJID,
  telefone: TELEFONE,
  waAccountId: null,
  leadId: LEAD_ID,
  oportunidadeId: null,
  nome: 'Visitante Sintético',
  canal: 'webchat',
};

let executarTool: typeof import('./tools.ts').executarTool;
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => ({
    SUPABASE_URL: 'https://supabase.invalid',
    AGENTE_SDR_SDRAPI_URL: API,
    AGENTE_SDR_SDRAPI_KEY: 'chave-sintetica-sem-acesso',
  } as Record<string, string>)[chave] } });
  vi.stubGlobal('fetch', fronteiras.fetch);
  ({ executarTool } = await import('./tools.ts'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.resetAllMocks();
  // O contexto é mutável dentro da rodada real; estado de um cenário nunca pode
  // bloquear artificialmente o seguinte e fazê-lo passar sem consultar o banco.
  delete (CONTEXTO as CtxConversa & { ultimaElegibilidade?: unknown }).ultimaElegibilidade;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-05T15:00:00Z'));
  fronteiras.modelo.mockRejectedValue(new Error('Modelo não simulado neste cenário'));
  fronteiras.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== `${API}/agendamentos-agente` || init?.method !== 'POST') {
      throw new Error(`HTTP não previsto neste cenário: ${init?.method ?? 'GET'} ${url}`);
    }
    // A ferramenta REAL chegou à fronteira que cria reunião. Para aqui: não há
    // resposta de sucesso inventada nem tentativa de alcançar Google Calendar.
    return new Response(JSON.stringify({ error: 'POST interceptado pelo teste local' }), { status: 422 });
  });
});
afterEach(() => vi.useRealTimers());

function bancoEmMemoria(formacao: string | null = null, erroCatalogo = false) {
  const lead: Record<string, unknown> = { remotejid: REMOTEJID, formacao_academica: formacao };
  const atualizacoes: Record<string, unknown>[] = [];
  const falhas = {
    catalogo: erroCatalogo, leitura: false, escrita: false,
    iniciar: false, finalizar: false, consultar: false,
    respostaConsulta: undefined as Record<string, unknown> | undefined,
    respostaFinalizacao: undefined as Record<string, unknown> | undefined,
  };
  let avaliacao: {
    id: string; curso: string; versao: string; decisao: string;
  } | null = null;
  let sequencia = 0;
  const banco = {
    rpc: vi.fn(async (nome: string, dados: Record<string, unknown>) => {
      if (nome === 'crm_agente_elegibilidade_iniciar') {
        if (falhas.iniciar || falhas.escrita) return { data: null, error: { message: 'Início indisponível no teste' } };
        expect(dados.p_telefone).toBe(TELEFONE);
        const informados = dados.p_dados as Record<string, unknown>;
        // O contrato SQL faz escrita da formação e invalidação no MESMO início.
        // Nunca derivar decisão de aprovação da mera presença do campo formação.
        avaliacao = {
          id: `10000000-0000-4000-8000-${String(++sequencia).padStart(12, '0')}`,
          curso: String(dados.p_curso), versao: String(dados.p_regra_versao), decisao: 'pendente',
        };
        if (informados.formacao_academica) lead.formacao_academica = informados.formacao_academica;
        return { data: { success: true, code: 'avaliacao_iniciada', avaliacao_id: avaliacao.id, curso_id: CURSO_ID, decisao: 'pendente' }, error: null };
      }
      if (nome === 'crm_agente_elegibilidade_finalizar') {
        if (falhas.finalizar) return { data: null, error: { message: 'Finalização indisponível no teste' } };
        if (falhas.respostaFinalizacao) return { data: falhas.respostaFinalizacao, error: null };
        if (!avaliacao || dados.p_avaliacao_id !== avaliacao.id) {
          return { data: { success: false, code: 'avaliacao_invalida' }, error: null };
        }
        if (dados.p_decisao === 'aprovado' && dados.p_curso_avaliado !== avaliacao.curso) {
          return { data: { success: false, code: 'curso_avaliado_divergente', decisao: 'pendente' }, error: null };
        }
        avaliacao.decisao = String(dados.p_decisao);
        return { data: { success: true, code: 'avaliacao_finalizada', avaliacao_id: avaliacao.id, curso_id: CURSO_ID, decisao: avaliacao.decisao }, error: null };
      }
      if (nome === 'crm_agente_elegibilidade_consultar') {
        if (falhas.consultar || falhas.leitura) return { data: null, error: { message: 'Consulta indisponível no teste' } };
        if (falhas.respostaConsulta) return { data: falhas.respostaConsulta, error: null };
        const corresponde = avaliacao && avaliacao.curso === dados.p_curso && avaliacao.versao === dados.p_regra_versao;
        return {
          data: corresponde
            ? { success: avaliacao!.decisao === 'aprovado', code: `elegibilidade_${avaliacao!.decisao}`, decisao: avaliacao!.decisao, avaliacao_id: avaliacao!.id, curso_id: CURSO_ID, regra_versao: avaliacao!.versao }
            : { success: false, code: 'elegibilidade_ausente', decisao: 'pendente' },
          error: null,
        };
      }
      throw new Error(`RPC não prevista: ${nome}`);
    }),
    from(tabela: string) {
      if (tabela === 'cliente_ppg_leads_sdr') {
        return {
          select: () => ({
            in: (campo: string, valores: string[]) => ({
              limit: async () => {
                expect(campo).toBe('remotejid');
                if (falhas.leitura) return { data: null, error: { message: 'Leitura indisponível no teste' } };
                return { data: valores.includes(REMOTEJID) ? [{ ...lead }] : [], error: null };
              },
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            in: async (campo: string, valores: string[]) => {
              expect(campo).toBe('remotejid');
              if (falhas.escrita) return { error: { message: 'Escrita indisponível no teste' } };
              if (valores.includes(REMOTEJID)) {
                atualizacoes.push({ ...patch });
                Object.assign(lead, patch);
              }
              return { error: null };
            },
          }),
        };
      }
      if (tabela === 'cursos_pos_graduacao') {
        return {
          select: () => ({ eq: () => ({ order: async () => ({
            data: falhas.catalogo ? null : [{
              pos_graduacao: 'Sanidade Avícola', pode_fazer: 'Medicina Veterinária',
              parcialmente_aceitas: '', status: 'ativo',
            }],
            error: falhas.catalogo ? { message: 'Catálogo indisponível no teste' } : null,
          }) }) }),
        };
      }
      throw new Error(`Tabela não prevista: ${tabela}`);
    },
  };
  return { banco, lead, atualizacoes, falhas };
}

function confirmar(
  banco: ReturnType<typeof bancoEmMemoria>['banco'], curso = 'Sanidade Avícola', contexto: CtxConversa = CONTEXTO,
) {
  return executarTool(banco, {
    id: 'confirmacao-sintetica', name: 'confirmar_agendamento', input: {
      curso_escolhido: curso, vendedor_id: VENDEDOR_ID,
      data_escolhida: '2026-09-07', horario_escolhido: '10:00',
    },
  }, contexto);
}

function verificar(
  banco: ReturnType<typeof bancoEmMemoria>['banco'], input: Record<string, unknown>,
  contexto: CtxConversa & { canal: 'webchat'; modoTeste?: boolean } = CONTEXTO,
) {
  return executarTool(banco, {
    id: 'verificacao-sintetica', name: 'verificar_compatibilidade_curso', input: {
      formacao_academica: 'Medicina Veterinária', curso_interesse: 'Sanidade Avícola', ...input,
    },
  }, contexto);
}

function exigirPostInterceptado(resultado: Record<string, unknown>) {
  expect(fronteiras.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fronteiras.fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`${API}/agendamentos-agente`);
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toMatchObject({
    lead_id: LEAD_ID,
    pos_graduacao_interesse: 'Sanidade Avícola',
    data_agendamento: '2026-09-07T10:00:00-03:00',
    elegibilidade_id: PRIMEIRA_AVALIACAO_ID,
    elegibilidade_versao: '2026-08-28:v1',
    telefone: TELEFONE,
  });
  expect(resultado.resultado).toContain('POST interceptado pelo teste local');
  expect(resultado.agendamento_id).toBeNull();
}

function exigirBloqueio(resultado: Record<string, unknown>) {
  expect(resultado.agendamento_id).toBeNull();
  expect(fronteiras.fetch).not.toHaveBeenCalled();
}

function aprovarMatriz(curso = 'Sanidade Avícola') {
  fronteiras.modelo.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({
    formacao_identificada: 'Medicina Veterinária', e_medico_veterinario: true,
    curso_solicitado: curso, pode_cursar: true, compativel: true,
    curso_exclusivo_veterinario: true, curso_alternativo_recomendado: false,
    curso_alternativo: null, mensagem_para_lead: 'Formação compatível.', output: 'APROVADO',
  }) }] });
}

describe('elegibilidade comprovada antes de confirmar_agendamento', () => {
  it('controle negativo: sem formação, recusa antes de qualquer HTTP', async () => {
    const { banco } = bancoEmMemoria();
    const resposta = await confirmar(banco);
    expect(resposta.resultado).toContain('RECUSADO');
    expect(resposta.agendamento_id).toBeNull();
    expect(fronteiras.fetch).not.toHaveBeenCalled();
    expect(fronteiras.modelo).not.toHaveBeenCalled();
  });

  it('controle positivo: checagem aprovada alcança POST de criação', async () => {
    const { banco, lead } = bancoEmMemoria();
    aprovarMatriz();
    const checagem = await verificar(banco, { contexto_qualificacao: 'normal' });
    expect(checagem.output).toBe('APROVADO');
    expect(lead.formacao_academica).toBe('Medicina Veterinária');
    expect(fronteiras.modelo).toHaveBeenCalledTimes(1);
    exigirPostInterceptado(await confirmar(banco));
  });

  it('formação preenchida sem aprovação não basta para alcançar POST', async () => {
    const { banco } = bancoEmMemoria('Medicina Veterinária');
    exigirBloqueio(await confirmar(banco));
  });

  it('estudante que conclui em janeiro de 2027 e passa na matriz pode agendar', async () => {
    const { banco } = bancoEmMemoria();
    aprovarMatriz();
    const checagem = await verificar(banco, {
      contexto_qualificacao: 'estudante_apto',
      conclusao_graduacao_bruta: 'concluo em janeiro de 2027',
      conclusao_graduacao: '01/2027',
    });
    expect(checagem.output).toBe('APROVADO');
    exigirPostInterceptado(await confirmar(banco));
  });

  it('posição no curso ambígua pede data e impede agendamento', async () => {
    const { banco } = bancoEmMemoria();
    const checagem = await verificar(banco, {
      contexto_qualificacao: 'estudante_apto',
      conclusao_graduacao_bruta: 'estou no 2 semestre',
    });
    expect(checagem.output).toBe('PRECISA_DATA_CONCLUSAO');
    expect(fronteiras.modelo).not.toHaveBeenCalled();
    exigirBloqueio(await confirmar(banco));
  });

  it('aprovação de um curso não autoriza confirmar outro curso', async () => {
    const { banco } = bancoEmMemoria();
    aprovarMatriz();
    expect((await verificar(banco, { contexto_qualificacao: 'normal' })).output).toBe('APROVADO');
    exigirBloqueio(await confirmar(banco, 'Cannabis Medicinal'));
  });

  it('matriz que aprova um curso diferente do solicitado não produz autorização', async () => {
    const { banco } = bancoEmMemoria();
    aprovarMatriz('Cannabis Medicinal');
    const checagem = await verificar(banco, { contexto_qualificacao: 'normal' });
    expect(checagem.output).toBe('FALHA_TECNICA');
    exigirBloqueio(await confirmar(banco));
  });

  it.each(['estudante_fora_do_prazo', 'estudante_apto'])(
    'bloqueia POST depois de prazo reprovado pelo código (enum %s)',
    async (contexto_qualificacao) => {
      const { banco, lead, atualizacoes } = bancoEmMemoria();
      const checagem = await verificar(banco, {
        contexto_qualificacao,
        conclusao_graduacao_bruta: 'concluo em dezembro de 2028',
        conclusao_graduacao: '12/2028',
      });
      // Até o enum equivocado "apto" é corrigido pelo prazo REAL, sem chamar LLM.
      expect(checagem.output).toBe('REPROVADO_PRAZO');
      expect(checagem.pode_cursar).toBe(false);
      expect(checagem.instrucao).toContain('NÃO agende reunião');
      expect(fronteiras.modelo).not.toHaveBeenCalled();
      expect(fronteiras.fetch).not.toHaveBeenCalled();
      expect(atualizacoes).not.toContainEqual({ formacao_academica: 'Medicina Veterinária' });
      expect(banco.rpc).toHaveBeenCalledWith('crm_agente_elegibilidade_iniciar', expect.objectContaining({
        p_dados: expect.objectContaining({ formacao_academica: 'Medicina Veterinária' }),
      }));
      expect(lead.formacao_academica).toBe('Medicina Veterinária');
      exigirBloqueio(await confirmar(banco));
    },
  );

  it('bloqueia POST depois de falha técnica da matriz com formação existente', async () => {
    const { banco } = bancoEmMemoria('Medicina Veterinária', true);
    const checagem = await verificar(banco, { contexto_qualificacao: 'normal' });
    expect(checagem.output).toBe('FALHA_TECNICA');
    expect(checagem.compativel).toBeNull();
    expect(checagem.pode_cursar).toBeNull();
    expect(checagem.instrucao).toContain('É PROIBIDO tratar o lead como apto');
    expect(fronteiras.modelo).not.toHaveBeenCalled();
    exigirBloqueio(await confirmar(banco));
  });

  it('aprovação anterior deixa de valer depois de nova checagem com falha técnica', async () => {
    const { banco, falhas } = bancoEmMemoria();
    aprovarMatriz();
    expect((await verificar(banco, { contexto_qualificacao: 'normal' })).output).toBe('APROVADO');
    falhas.catalogo = true;
    const segunda = await verificar(banco, { contexto_qualificacao: 'normal' });
    expect(segunda.output).toBe('FALHA_TECNICA');
    exigirBloqueio(await confirmar(banco));
  });

  it('erro ao ler a evidência persistida não autoriza criação por falta de confirmação', async () => {
    const { banco, falhas } = bancoEmMemoria();
    aprovarMatriz();
    expect((await verificar(banco, { contexto_qualificacao: 'normal' })).output).toBe('APROVADO');
    falhas.leitura = true;
    exigirBloqueio(await confirmar(banco));
  });

  it('erro ao persistir formação não pode produzir aprovação utilizável', async () => {
    const { banco, falhas } = bancoEmMemoria('Medicina Veterinária');
    falhas.escrita = true;
    aprovarMatriz();
    const checagem = await verificar(banco, { contexto_qualificacao: 'normal' });
    expect(checagem.output).toBe('FALHA_TECNICA');
    exigirBloqueio(await confirmar(banco));
  });

  it('falha da RPC de início impede classificação e gravação de aprovação', async () => {
    const { banco, falhas } = bancoEmMemoria('Medicina Veterinária');
    falhas.iniciar = true;
    const checagem = await verificar(banco, { contexto_qualificacao: 'normal' });
    expect(checagem.output).toBe('FALHA_TECNICA');
    expect(fronteiras.modelo).not.toHaveBeenCalled();
    expect(banco.rpc.mock.calls.some(([nome]) => nome === 'crm_agente_elegibilidade_finalizar')).toBe(false);
    exigirBloqueio(await confirmar(banco));
  });

  it('aprovação da matriz com erro ao finalizar não vale como aprovação persistida', async () => {
    const { banco, falhas } = bancoEmMemoria();
    falhas.finalizar = true;
    aprovarMatriz();
    const checagem = await verificar(banco, { contexto_qualificacao: 'normal' });
    expect(fronteiras.modelo).toHaveBeenCalledTimes(1);
    expect(checagem.output).toBe('FALHA_TECNICA');
    exigirBloqueio(await confirmar(banco));
  });

  it('falha ao iniciar nova checagem bloqueia a rodada mesmo existindo aprovação anterior', async () => {
    const { banco, falhas } = bancoEmMemoria();
    aprovarMatriz();
    expect((await verificar(banco, { contexto_qualificacao: 'normal' })).output).toBe('APROVADO');
    falhas.iniciar = true;
    expect((await verificar(banco, { contexto_qualificacao: 'normal' })).output).toBe('FALHA_TECNICA');
    // O banco não conseguiu revogar. O mesmo contexto precisa conservar a recusa
    // local e não tentar usar a autorização que existia antes da nova análise.
    expect(fronteiras.modelo).toHaveBeenCalledTimes(1);
    exigirBloqueio(await confirmar(banco));
    expect(banco.rpc.mock.calls.some(([nome]) => nome === 'crm_agente_elegibilidade_consultar')).toBe(false);
  });

  it.each([
    { success: true },
    { success: 'true', decisao: 'aprovado' },
  ])('finalização insuficiente não é autorização: %j', async (resposta) => {
    const { banco, falhas } = bancoEmMemoria();
    falhas.respostaFinalizacao = resposta;
    aprovarMatriz();
    expect((await verificar(banco, { contexto_qualificacao: 'normal' })).output).toBe('FALHA_TECNICA');
    exigirBloqueio(await confirmar(banco));
  });

  it('erro na consulta de aprovação existente impede POST', async () => {
    const { banco, falhas } = bancoEmMemoria();
    aprovarMatriz();
    expect((await verificar(banco, { contexto_qualificacao: 'normal' })).output).toBe('APROVADO');
    falhas.consultar = true;
    exigirBloqueio(await confirmar(banco));
  });

  it.each([
    { success: false, decisao: 'aprovado', avaliacao_id: LEAD_ID },
    { success: 'true', decisao: 'aprovado', avaliacao_id: LEAD_ID },
    { success: true, decisao: 'pendente', avaliacao_id: LEAD_ID },
    { success: true, decisao: 'reprovado', avaliacao_id: LEAD_ID },
    { success: true, decisao: 'aprovado', avaliacao_id: '' },
    { success: true, decisao: 'aprovado', avaliacao_id: 'token-invalido' },
    { success: true, decisao: 'aprovado', avaliacao_id: LEAD_ID, regra_versao: 'regra-antiga' },
  ])('nega resposta insuficiente de aprovação: %j', async (resposta) => {
    const { banco, falhas } = bancoEmMemoria('Medicina Veterinária');
    falhas.respostaConsulta = { regra_versao: '2026-08-28:v1', curso_id: CURSO_ID, ...resposta };
    exigirBloqueio(await confirmar(banco));
  });

  it('reprovação continua impedindo POST numa nova rodada sem memória local', async () => {
    const { banco } = bancoEmMemoria();
    expect((await verificar(banco, {
      contexto_qualificacao: 'estudante_fora_do_prazo',
      conclusao_graduacao_bruta: 'dezembro de 2028', conclusao_graduacao: '12/2028',
    })).output).toBe('REPROVADO_PRAZO');
    const novaRodada = { ...CONTEXTO };
    delete (novaRodada as CtxConversa & { ultimaElegibilidade?: unknown }).ultimaElegibilidade;
    exigirBloqueio(await confirmar(banco, 'Sanidade Avícola', novaRodada));
    expect(banco.rpc).toHaveBeenCalledWith('crm_agente_elegibilidade_consultar', expect.objectContaining({
      p_telefone: TELEFONE, p_curso: 'Sanidade Avícola',
    }));
  });

  it('modo de teste classifica com lógica real sem RPC ou escrita no lead de produção', async () => {
    const { banco, lead, atualizacoes } = bancoEmMemoria('Formação anterior preservada');
    aprovarMatriz();
    const checagem = await verificar(banco, { contexto_qualificacao: 'normal' }, { ...CONTEXTO, modoTeste: true });
    expect(checagem.output).toBe('APROVADO');
    expect(fronteiras.modelo).toHaveBeenCalledTimes(1);
    expect(banco.rpc).not.toHaveBeenCalled();
    expect(atualizacoes).toEqual([]);
    expect(lead.formacao_academica).toBe('Formação anterior preservada');
    exigirBloqueio(await confirmar(banco));
  });

  it('aprovação simulada autoriza apenas confirmação simulada do mesmo curso', async () => {
    const { banco } = bancoEmMemoria();
    const contextoTeste = { ...CONTEXTO, modoTeste: true };
    aprovarMatriz();
    expect((await verificar(banco, { contexto_qualificacao: 'normal' }, contextoTeste)).output).toBe('APROVADO');
    const simulado = await confirmar(banco, 'Sanidade Avícola', contextoTeste);
    expect(simulado.simulado).toBe(true);
    expect(simulado.agendamento_id).toBeNull();
    expect(fronteiras.fetch).not.toHaveBeenCalled();
    expect(banco.rpc).not.toHaveBeenCalled();
    exigirBloqueio(await confirmar(banco, 'Cannabis Medicinal', contextoTeste));
  });
});
