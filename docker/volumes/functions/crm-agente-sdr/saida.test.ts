import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let saida: typeof import('./saida');
const transporte = vi.fn();
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
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
    expect(await saida.fracionarResposta(original)).toEqual(['claro, posso te ajudar.', 'qual curso vc quer conhecer?']);
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
