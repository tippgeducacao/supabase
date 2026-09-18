import { describe, expect, it } from 'vitest';
import {
  buscarLead,
  carregarHistorico,
  filtrarBastidorDoHistorico,
  INICIO_HISTORICO_HUMANO,
  jidsDoTelefone,
  limparParaRouter,
  MARCADOR_FOLLOWUP,
  sanitizarHistorico,
  type Msg,
} from './historico';

describe('bastidor editorial fora da memória do modelo', () => {
  const relatorio = '**Success**\n**Explanation:** Correctly identifies that the conversation should remain silent.';
  const vazamento = '</antml>*\n' + relatorio;

  it('remove a fala contaminada do principal e router, conservando as perguntas do cliente', () => {
    const origem: Msg[] = [
      { role: 'user', content: 'Recebi uma mensagem estranha.' },
      { role: 'assistant', content: vazamento },
      { role: 'user', content: 'Você pode explicar?' },
    ];
    const antes = structuredClone(origem);
    for (const replay of [filtrarBastidorDoHistorico(origem), sanitizarHistorico(origem), limparParaRouter(origem)]) {
      expect(JSON.stringify(replay)).not.toContain('Explanation');
      expect(JSON.stringify(replay)).toContain('Você pode explicar?');
    }
    expect(origem).toEqual(antes);
  });

  it('preserva a citação feita pelo cliente e pelo vendedor humano com suas autorias', () => {
    const origem: Msg[] = [
      { role: 'user', content: 'Você me enviou: ' + vazamento },
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Vou conferir o erro: ' + vazamento },
      { role: 'assistant', content: [{ type: 'text', text: '[ATENDIMENTO_HUMANO] Correção do atendimento.' }] },
    ];
    expect(filtrarBastidorDoHistorico(origem)).toEqual(origem);
  });

  it('reconhece avaliação dividida em blocos sem mexer no par de tools ou assinatura ativa', () => {
    const pensamento = { type: 'thinking', thinking: 'privado', signature: 'assinatura-imutavel' };
    const ferramenta = { type: 'tool_use', id: 'consulta-1', name: 'consulta_disponibilidade', input: {} };
    const retorno = { type: 'tool_result', tool_use_id: 'consulta-1', content: '15h disponível' };
    const origem: Msg[] = [
      { role: 'user', content: 'Pode verificar o horário?' },
      { role: 'assistant', content: [pensamento, { type: 'text', text: '**Success**' }, ferramenta,
        { type: 'text', text: '**Explanation:** The action was completed correctly.' }] },
      { role: 'user', content: [retorno] },
    ];
    expect(sanitizarHistorico(origem)).toEqual([
      origem[0], { role: 'assistant', content: [pensamento, ferramenta] }, origem[2],
    ]);
    expect(origem[1].content).toHaveLength(4);
  });

  it('não conserva pensamento sozinho da resposta textual rejeitada', () => {
    expect(filtrarBastidorDoHistorico([{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'privado', signature: 'assinatura' }, { type: 'text', text: vazamento },
    ] }])).toEqual([]);
  });

  it('retira avaliação repartida entre balões antes de os normalizadores reunirem as mensagens', () => {
    const origem: Msg[] = [
      { role: 'user', content: 'Olá' },
      { role: 'assistant', content: '**Success**' },
      { role: 'assistant', content: [{ type: 'text', text: '**Explanation:** The action was completed correctly.' }] },
      { role: 'user', content: 'Pode continuar?' },
    ];
    expect(filtrarBastidorDoHistorico(origem)).toEqual([origem[0], origem[3]]);
    for (const replay of [sanitizarHistorico(origem), limparParaRouter(origem)]) {
      expect(JSON.stringify(replay)).not.toMatch(/Success|Explanation/);
      expect(JSON.stringify(replay)).toContain('Pode continuar?');
    }
  });

  it('não reúne falas da IA através de uma intervenção humana ou fala do cliente', () => {
    for (const fronteira of [
      { role: 'assistant' as const, content: '[ATENDIMENTO_HUMANO] O tema do curso foi alterado.' },
      { role: 'user' as const, content: 'Agora quero falar de outro assunto.' },
    ]) {
      const origem: Msg[] = [
        { role: 'assistant', content: 'Success' }, fronteira,
        { role: 'assistant', content: 'Explanation: este é o título do documento pedido.' },
      ];
      expect(filtrarBastidorDoHistorico(origem)).toEqual(origem);
    }
  });
});

// Supabase de mentira: guarda o filtro que recebeu e devolve as linhas combinadas.
function supabaseFake(linhas: Array<Record<string, unknown>>) {
  const visto: { coluna?: string; valores?: string[] } = {};
  const client = {
    from() { return client; },
    select() { return client; },
    in(coluna: string, valores: string[]) {
      visto.coluna = coluna;
      visto.valores = valores;
      return client;
    },
    limit() {
      const alvo = new Set(visto.valores ?? []);
      return Promise.resolve({
        data: linhas.filter((l) => alvo.has(String(l.remotejid))),
        error: null,
      });
    },
  };
  return { client, visto };
}

describe('jidsDoTelefone', () => {
  it('gera as duas variantes do 9º dígito a partir do telefone cru', () => {
    expect(jidsDoTelefone('46988166051')).toEqual([
      '5546988166051@s.whatsapp.net',
      '554688166051@s.whatsapp.net',
    ]);
  });

  it('aceita um jid completo como entrada', () => {
    expect(jidsDoTelefone('5546988166051@s.whatsapp.net')).toEqual([
      '5546988166051@s.whatsapp.net',
      '554688166051@s.whatsapp.net',
    ]);
  });
});

describe('buscarLead', () => {
  // O bug: o WEBCHAT monta o contexto com `remotejid = telefone` (cru). Com .eq() a
  // busca voltava null mesmo com o lead existindo, e os gates que dependem dele
  // (formação em confirmar_agendamento, aviso na consulta_disponibilidade) ficavam
  // fail-open no chat do site.
  it('acha o lead pelo telefone cru que o webchat usa como chave', async () => {
    const { client } = supabaseFake([
      { remotejid: '5546988166051@s.whatsapp.net', formacao_academica: 'Medicina Veterinária' },
    ]);
    const lead = await buscarLead(client, '46988166051');
    expect(lead?.formacao_academica).toBe('Medicina Veterinária');
  });

  it('acha o lead pela variante sem o 9º dígito', async () => {
    const { client } = supabaseFake([{ remotejid: '554688166051@s.whatsapp.net', nome: 'gustavo' }]);
    const lead = await buscarLead(client, '5546988166051@s.whatsapp.net');
    expect(lead?.nome).toBe('gustavo');
  });

  // 55 telefones da base têm as DUAS variantes como linhas separadas: maybeSingle()
  // estouraria, e pegar a primeira mudaria o lead do WhatsApp sem motivo.
  it('prefere o match exato quando as duas variantes existem', async () => {
    const { client } = supabaseFake([
      { remotejid: '554688166051@s.whatsapp.net', nome: 'linha antiga' },
      { remotejid: '5546988166051@s.whatsapp.net', nome: 'linha certa' },
    ]);
    const lead = await buscarLead(client, '5546988166051@s.whatsapp.net');
    expect(lead?.nome).toBe('linha certa');
  });

  it('devolve null quando não existe lead nenhum', async () => {
    const { client } = supabaseFake([]);
    expect(await buscarLead(client, '46988166051')).toBeNull();
  });
});

type LinhaHistorico = { id: number; remotejid: string; conversation_history: Msg | null };

function historicoPaginadoFake(linhas: LinhaHistorico[], falharNaPagina?: number) {
  const consultas: Array<{ colunaOrdem?: string; ascendente?: boolean; cursor?: number | string; remoto?: string; limite?: number }> = [];
  return {
    consultas,
    client: {
      from(tabela: string) {
        expect(tabela).toBe('cliente_ppg_mensagens_sdr');
        const consulta: typeof consultas[number] = {};
        const query = {
          select() { return query; },
          eq(coluna: string, remoto: string) {
            expect(coluna).toBe('remotejid');
            consulta.remoto = remoto;
            return query;
          },
          order(coluna: string, opcoes: { ascending: boolean }) {
            consulta.colunaOrdem = coluna;
            consulta.ascendente = opcoes.ascending;
            return query;
          },
          gt(coluna: string, cursor: number | string) {
            expect(coluna).toBe('id');
            consulta.cursor = cursor;
            return query;
          },
          async limit(limite: number) {
            consulta.limite = limite;
            consultas.push(consulta);
            const data = linhas
              .filter((l) => l.remotejid === consulta.remoto && l.id > Number(consulta.cursor ?? 0))
              .sort((a, b) => consulta.ascendente ? a.id - b.id : b.id - a.id)
              .slice(0, Math.min(limite, 1000));
            return { data, error: consultas.length === falharNaPagina ? { message: 'página indisponível' } : null };
          },
        };
        return query;
      },
    },
  };
}

describe('carregarHistorico paginado', () => {
  const remoto = '5546999990000@s.whatsapp.net';

  function criarLinhas(quantidade: number): LinhaHistorico[] {
    return Array.from({ length: quantidade }, (_, i) => ({
      id: (i + 1) * 3,
      remotejid: remoto,
      conversation_history: { role: i % 2 === 0 ? 'user' : 'assistant', content: `turno ${i + 1}` },
    }));
  }

  it('lê mais de 1.000 linhas em ordem de id, inclusive o par de tools entre páginas', async () => {
    const linhas = criarLinhas(1003);
    linhas[999].conversation_history = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'envio-grade', name: 'enviar_informacoes', input: {} }],
    };
    linhas[1000].conversation_history = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'envio-grade', content: 'documento enviado' }],
    };
    linhas[1001].conversation_history = { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Vendedora: expliquei o cronograma.' };
    const outroContato: LinhaHistorico = { id: 2, remotejid: 'outro', conversation_history: { role: 'user', content: 'outra conversa' } };
    const { client, consultas } = historicoPaginadoFake([outroContato, ...linhas].reverse());

    const historico = await carregarHistorico(client, remoto);
    expect(historico).toEqual(linhas.map((l) => l.conversation_history));
    expect(consultas).toEqual([
      { colunaOrdem: 'id', ascendente: true, remoto, limite: 1000 },
      { colunaOrdem: 'id', ascendente: true, remoto, limite: 1000, cursor: 3000 },
    ]);
    const replay = sanitizarHistorico(historico);
    expect(replay[999]).toEqual(linhas[999].conversation_history);
    expect(replay[1000]).toEqual(linhas[1000].conversation_history);
    expect(replay[1001]).toEqual(linhas[1001].conversation_history);
  });

  it('não entrega memória parcial quando a segunda página falha, mesmo trazendo data', async () => {
    const { client, consultas } = historicoPaginadoFake(criarLinhas(1002), 2);
    await expect(carregarHistorico(client, remoto)).rejects.toThrow('carregarHistorico: página indisponível');
    expect(consultas).toHaveLength(2);
  });

  it('não encerra a paginação porque registros sem turno válido foram filtrados', async () => {
    const linhas = criarLinhas(1001);
    linhas[0].conversation_history = null;
    const { client } = historicoPaginadoFake(linhas);
    const historico = await carregarHistorico(client, remoto);
    expect(historico).toHaveLength(1000);
    expect(historico.at(-1)).toEqual(linhas[1000].conversation_history);
  });

  it('encerra no fim de uma página cheia sem duplicar os turnos', async () => {
    const { client, consultas } = historicoPaginadoFake(criarLinhas(1000));
    expect(await carregarHistorico(client, remoto)).toHaveLength(1000);
    expect(consultas).toHaveLength(2);
  });

  it('filtra só a projeção do banco sem alterar os registros de auditoria', async () => {
    const linhas = criarLinhas(3);
    linhas[1].conversation_history = { role: 'assistant', content: '</antml parameter>' };
    const antes = structuredClone(linhas);
    const { client } = historicoPaginadoFake(linhas);
    expect(await carregarHistorico(client, remoto)).toEqual([linhas[0].conversation_history, linhas[2].conversation_history]);
    expect(linhas).toEqual(antes);
  });
});

describe('memória humana no replay e no router', () => {
  it('preserva texto, documento e áudio pendente do vendedor como assistant ao fundir turnos', () => {
    const humanos: Msg[] = [
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Vendedora: você concluiu Medicina Veterinária?' },
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Documento enviado: cronograma.pdf' },
      { role: 'assistant', content: [{ type: 'text', text: '[ATENDIMENTO_HUMANO] Áudio enviado; transcrição pendente.' }] },
    ];
    const resposta: Msg = { role: 'user', content: 'Ainda estou cursando.' };
    const brutas = [...humanos, resposta];
    const copia = structuredClone(brutas);
    const replay = sanitizarHistorico(brutas);
    expect(replay[0]).toEqual({
      role: 'assistant',
      content: humanos.map((m) => Array.isArray(m.content) ? m.content[0] : { type: 'text', text: m.content }),
    });
    expect(replay[1]).toEqual(resposta);
    expect(brutas).toEqual(copia);

    const router = limparParaRouter(brutas);
    expect(router[0]).toEqual({ role: 'user', content: INICIO_HISTORICO_HUMANO });
    expect(router[1].role).toBe('assistant');
    expect(router[1].content).toContain('você concluiu Medicina Veterinária?');
    expect(router[1].content).toContain('cronograma.pdf');
    expect(router[1].content).toContain('transcrição pendente');
    expect(router[2]).toEqual(resposta);
  });

  it('mantém a memória quando só há envios humanos, sem inventar resposta do lead', () => {
    const mensagem: Msg = { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Vendedor: te enviei a grade.' };
    expect(limparParaRouter([mensagem])).toEqual([
      { role: 'user', content: INICIO_HISTORICO_HUMANO },
      mensagem,
      { role: 'user', content: MARCADOR_FOLLOWUP },
    ]);
  });

  it('conserva a transcrição pronta no mesmo turno carregado, sem inventar outro áudio', async () => {
    const mensagem: Msg = { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Áudio da vendedora, transcrição: as aulas ficam gravadas.' };
    const { client } = historicoPaginadoFake([{ id: 42, remotejid: 'remoto', conversation_history: mensagem }]);
    const replay = sanitizarHistorico(await carregarHistorico(client, 'remoto'));
    expect(replay).toEqual([mensagem]);
  });
});

describe('como o histórico termina (pedido nunca pode acabar num turno do assistant)', () => {
  it('termina na fala do lead ou num tool_result: segue sem mexer', async () => {
    const { avaliarFimDoHistorico, comEntradaPendente } = await import('./historico');
    const normal = [{ role: 'assistant' as const, content: 'oi' }, { role: 'user' as const, content: 'quero saber' }];
    expect(avaliarFimDoHistorico(normal)).toBe('ok');
    expect(avaliarFimDoHistorico([])).toBe('ok');
    expect(avaliarFimDoHistorico([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }])).toBe('ok');
    expect(comEntradaPendente(normal, 'quero saber')).toEqual(normal);
  });

  it('última fala é de um vendedor: humano_respondeu (em string ou em bloco de texto)', async () => {
    const { avaliarFimDoHistorico } = await import('./historico');
    expect(avaliarFimDoHistorico([{ role: 'user', content: 'caro' }, { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Suéli · beleza' }])).toBe('humano_respondeu');
    expect(avaliarFimDoHistorico([{ role: 'user', content: 'caro' }, { role: 'assistant', content: [{ type: 'text', text: '  [ATENDIMENTO_HUMANO] Welinton · oi' }] }])).toBe('humano_respondeu');
  });

  it('última fala é da IA: a mensagem do lote volta como último turno, sem mutar a entrada', async () => {
    const { avaliarFimDoHistorico, comEntradaPendente, MARCADOR_ENTRADA_PENDENTE } = await import('./historico');
    const historico = [{ role: 'user' as const, content: 'Sim' }, { role: 'assistant' as const, content: [{ type: 'text', text: 'qual pós?' }] }];
    const copia = structuredClone(historico);
    expect(avaliarFimDoHistorico(historico)).toBe('entrada_antes_da_ultima_fala');
    const saida = comEntradaPendente(historico, '  Sim  ');
    expect(saida).toHaveLength(3);
    expect(saida[2].role).toBe('user');
    expect(String(saida[2].content).startsWith(MARCADOR_ENTRADA_PENDENTE)).toBe(true);
    expect(String(saida[2].content).endsWith('\nSim')).toBe(true);
    expect(avaliarFimDoHistorico(saida)).toBe('ok');
    expect(historico).toEqual(copia);
  });

  it('lote sem texto não inventa turno; citar o marcador humano no meio da fala da IA não conta como vendedor', async () => {
    const { avaliarFimDoHistorico, comEntradaPendente } = await import('./historico');
    const fimIa = [{ role: 'user' as const, content: 'oi' }, { role: 'assistant' as const, content: 'olá' }];
    expect(comEntradaPendente(fimIa, '   ')).toEqual(fimIa);
    expect(avaliarFimDoHistorico([{ role: 'assistant', content: 'como o [ATENDIMENTO_HUMANO] disse' }])).toBe('entrada_antes_da_ultima_fala');
  });
});
