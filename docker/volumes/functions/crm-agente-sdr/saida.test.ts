import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let saida: typeof import('./saida');
const transporte = vi.fn();
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => undefined } });
  vi.stubGlobal('fetch', transporte);
  saida = await import('./saida');
});
beforeEach(() => { transporte.mockReset(); });
afterAll(() => vi.unstubAllGlobals());

const analiseDoIncidente = 'O lead pediu pra retirar o cadastro. Já foi feita a pergunta de retenção antes '
  + '("hoje você teria interesse em uma pós-graduação? posso manter seu cadastro ou prefere que retiro do sistema?") '
  + 'e ele confirmou o "retirar". Isso conta como retenção explícita e reiteração do não. '
  + 'Vou encerrar com respeito e mandar o presente da biblioteca.';

describe('barreira de bastidor na saída', () => {
  it('descarta a análise inteira do incidente, inclusive as citações com interrogação', () => {
    expect(saida.contemMeta(analiseDoIncidente)).toBe(true);
    expect(saida.humanizarTexto(analiseDoIncidente)).toBe('');
    expect(saida.humanizarTexto(analiseDoIncidente + '\ntranquilo, fico à disposição.')).toBe('');
  });

  it.each([
    'Já é a segunda vez que ela diz que não tem interesse, preciso fazer a pergunta de retenção explícita antes de pausar.\nsem problema, não quero te incomodar.',
    'Precisa fazer a pergunta de retenção antes de pausar por opt-out.',
    'Não é retenção ainda registrada no histórico, então preciso perguntar antes de pausar.',
    'Preciso perguntar.',
    'I need to follow the instructions. tudo bem?',
  ])('bloqueia família de análise sem tags: %s', (texto) => {
    expect(saida.humanizarTexto(texto)).toBe('');
  });

  it.each([
    'sem problema, não quero te incomodar à toa. vc não tem interesse mesmo, ou prefere que eu te chame quando abrir a próxima turma?',
    'não receberá mais nenhuma mensagem nossa.',
    'posso te chamar quando abrir a próxima turma, sem mensagens no meio tempo?',
    'fico te aguardando.',
    'o monitor já está te aguardando.',
    '**14h, 14h30 ou 15h**',
    'vou confirmar com o time e já te retorno.',
    'ela já te passa tudo na hora.',
    'a retenção de alunos é um tema desse material.',
  ])('preserva a fala legítima: %s', (texto) => {
    expect(saida.humanizarTexto(texto)).toBe(texto);
  });

  it.each(['thinking', 'reasoning', 'analysis', 'antml:thinking', 'scratchpad'])('protege tags %s, inclusive truncadas', (tag) => {
    expect(saida.humanizarTexto(`<${tag}>análise privada</${tag}>olá.`)).toBe('olá.');
    expect(saida.humanizarTexto(`<${tag}>análise truncada`)).toBe('');
    expect(saida.humanizarTexto(`<${tag} atributo="incompleto`)).toBe('');
    expect(saida.humanizarTexto(`análise órfã</${tag}>olá.`)).toBe('olá.');
  });

  it('não fraciona nem envia bastidor, mesmo com link crítico anexado', async () => {
    const texto = analiseDoIncidente + '\nhttps://escoladeespecializacao.ppgvet.com.br';
    const registrar = vi.fn();
    await saida.enviarResposta({ telefone: '5511999990001' } as never, texto, vi.fn(), { registrar });
    expect(transporte).not.toHaveBeenCalled();
    expect(registrar).toHaveBeenCalledWith('meta_descartada', expect.objectContaining({ restou_vazio: true }));
    expect(await saida.fracionarResposta(texto)).toEqual([]);
  });
});

describe('fracionador só pode extrair texto aprovado', () => {
  function devolver(chunks: string[]) {
    transporte.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      chunks: chunks.map((message, i) => ({ message, sequence_number: i + 1 })),
    }) } }] })));
  }
  const original = 'claro, posso te ajudar.\nqual curso vc quer conhecer?';
  it('aceita divisão fiel, tolerando somente espaços e quebras de linha', async () => {
    devolver(['claro, posso te ajudar.', 'qual curso vc quer conhecer?']);
    // balão curto não fica sozinho: a reação vai junto da pergunta que ela introduz
    expect(await saida.fracionarResposta(original)).toEqual(['claro, posso te ajudar. qual curso vc quer conhecer?']);
  });
  it('junta balões curtos ao vizinho, preserva os longos e nunca mistura mídia', () => {
    expect(saida.juntarBaloesCurtos(['tranquilo, à noite fica melhor.', 'qual é a sua graduação?'])).toEqual(['tranquilo, à noite fica melhor. qual é a sua graduação?']);
    const lista = 'para a conversa com o monitor sobre a pós, tenho hoje às 19h, 19h30 ou 20h, no horário de brasília.';
    expect(saida.juntarBaloesCurtos([lista, 'qual fica melhor?'])).toEqual([`${lista} qual fica melhor?`]);
    const a = 'estamos no fechamento do primeiro lote promocional da pós, e eu gostaria de te apresentar a condição e tirar suas dúvidas.';
    const b = 'pra te passar isso direitinho, preciso marcar uma conversa rápida no meet com um monitor especialista.';
    expect(saida.juntarBaloesCurtos([a, b, 'hoje fica melhor de manhã ou à tarde?'])).toEqual([a, `${b} hoje fica melhor de manhã ou à tarde?`]);
    expect(saida.juntarBaloesCurtos(['olha só', '<video>https://x/y.mp4</video>', 'gostou?'])).toEqual(['olha só', '<video>https://x/y.mp4</video>', 'gostou?']);
  });
  it.each([
    ['Analisando o histórico.', 'claro, posso te ajudar.', 'qual curso vc quer conhecer?'],
    ['claro, posso te ajudar.'],
    ['qual curso vc quer conhecer?', 'claro, posso te ajudar.'],
    ['claro, posso te ajudar.', 'claro, posso te ajudar.', 'qual curso vc quer conhecer?'],
    ['claro, já confirmei sua matrícula.', 'qual curso vc quer conhecer?'],
  ])('ignora invenção, omissão, duplicação ou reordenação: %j', async (...chunks) => {
    devolver(chunks);
    expect(await saida.fracionarResposta(original)).toEqual([original]);
  });
  it('falha de rede preserva apenas a entrada aprovada', async () => {
    transporte.mockRejectedValue(new Error('rede indisponível'));
    expect(await saida.fracionarResposta(original)).toEqual([original]);
  });
  it('mensagem com link crítico continua inteira e não chama outro modelo', async () => {
    const texto = 'seu acesso: https://escoladeespecializacao.ppgvet.com.br';
    expect(await saida.fracionarResposta(texto)).toEqual([texto]);
    expect(transporte).not.toHaveBeenCalled();
  });
});

describe('fracionamento determinístico no pipeline de saída', () => {
  it('divide o texto aprovado sem chamar API', async () => {
    const texto = 'primeira ideia.\n\nsegunda ideia.';
    expect(await saida.fracionarResposta(texto, 'codigo')).toEqual(['primeira ideia.', 'segunda ideia.']);
    expect(transporte).not.toHaveBeenCalled();
  });

  it('mantém as barreiras de bastidor antes de dividir em código', async () => {
    expect(await saida.fracionarResposta(analiseDoIncidente, 'codigo')).toEqual([]);
    expect(transporte).not.toHaveBeenCalled();
  });

  it('envia pelo transporte existente, sem chamar o fracionador LLM', async () => {
    transporte.mockResolvedValue(new Response('{}', { status: 200 }));
    const registrar = vi.fn();
    const resultado = await saida.enviarResposta({ telefone: '5511999990001' } as never,
      'claro, vc já trabalha nessa área?', vi.fn(), { registrar }, undefined, undefined, 'codigo');
    expect(resultado).toEqual({ aceitos: 1, canal: 'texto', estado: 'aceito' });
    expect(transporte).toHaveBeenCalledTimes(1);
    expect(transporte.mock.calls[0][0]).toContain('crm-whatsapp-send');
    expect(JSON.parse(transporte.mock.calls[0][1].body).conteudo).toBe('claro, vc já trabalha nessa área?');
    expect(registrar).toHaveBeenCalledWith('resposta_chunks', expect.objectContaining({ metodo: 'codigo', total: 1 }));
  });

  it('honra pausa antes do primeiro envio, mesmo sem a chamada de chunking', async () => {
    const resultado = await saida.enviarResposta({ telefone: '5511999990001' } as never,
      'claro, vc já trabalha nessa área?', vi.fn(), undefined, async () => true, undefined, 'codigo');
    expect(resultado).toEqual({ aceitos: 0, canal: 'texto', estado: 'cancelado' });
    expect(transporte).not.toHaveBeenCalled();
  });
});

describe('nome do curso na fala (21/09/2026)', () => {
  it('"pós em MBA" vira só MBA, com o artigo ajustado', () => {
    expect(saida.corrigirNomeDeCurso('o valor integral da pós em MBA GESTÃO DA PECUÁRIA LEITERA é X')).toBe('o valor integral do MBA GESTÃO DA PECUÁRIA LEITEIRA é X');
    expect(saida.corrigirNomeDeCurso('vc tem interesse na pós em MBA gestão?')).toBe('vc tem interesse no MBA gestão?');
    expect(saida.corrigirNomeDeCurso('a pós em MBA crédito rural é online')).toBe('o MBA crédito rural é online');
    expect(saida.corrigirNomeDeCurso('pós-graduação em MBA crédito rural')).toBe('MBA crédito rural');
  });
  it('corrige a grafia do catálogo só na fala, e não toca em quem não tem o erro', () => {
    expect(saida.humanizarTexto('o MBA em gestão da pecuária leitera tem aulas ao vivo')).toBe('o MBA em gestão da pecuária leiteira tem aulas ao vivo');
    expect(saida.corrigirNomeDeCurso('pós em clínica de bovinos leiteiros')).toBe('pós em clínica de bovinos leiteiros');
  });
});
