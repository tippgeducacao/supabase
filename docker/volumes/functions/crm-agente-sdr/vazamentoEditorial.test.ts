import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOME_TOOL_RESPOSTA } from './canalResposta';
import type { Msg } from './historico';

// Texto recebido no incidente de 15/09/2026. A API usou a ferramenta final, mas
// colocou uma avaliação editorial dentro do campo que deveria ser fala ao cliente.
const EXPLICACAO = 'Correctly identifies that after pausing atendimento_incompativel, an unrelated automated message doesn’t require a new response, so remains silent.';
const INCIDENTE = '</antml>*\n\n###\n\n**Success**\n\n**Explanation:** ' + EXPLICACAO;
const SEM_TAG = '**Success**\n\n**Explanation:** ' + EXPLICACAO;

let saida: typeof import('./saida');
let chamarAgentePrincipal: typeof import('./agente').chamarAgentePrincipal;
let montarMensagensFollowup: typeof import('./followup').montarMensagensFollowup;
const transporte = vi.fn();
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => chave === 'AGENTE_SDR_MODEL' ? 'modelo-sintetico' : '' } });
  vi.stubGlobal('fetch', transporte);
  saida = await import('./saida');
  ({ chamarAgentePrincipal } = await import('./agente'));
  ({ montarMensagensFollowup } = await import('./followup'));
});
beforeEach(() => {
  transporte.mockReset();
  transporte.mockRejectedValue(new Error('Transporte não previsto pelo teste; nenhuma rede real é permitida.'));
});
afterAll(() => vi.unstubAllGlobals());

describe('relatório editorial em inglês dentro do canal público', () => {
  it.each([
    ['incidente integral', INCIDENTE],
    ['avaliação sem tag', SEM_TAG],
    ['avaliação sem Markdown', 'Success\nExplanation: ' + EXPLICACAO],
    ['avaliação impessoal sem cabeçalho', EXPLICACAO],
    ['fechamento antml órfão', '</antml>*'],
    ['fechamento antml órfão com fala residual', '</antml>*\nOlá, tudo bem?'],
    ['fragmento de parâmetro confirmado no banco', '</antml parameter>'],
    ['fragmento de parâmetro com parêntese confirmado no banco', '</antml (parameter>'],
  ])('invalida o texto inteiro: %s', (_cenario, texto) => {
    expect(saida.contemMeta(texto) || saida.contemRaciocinioVazado(texto)).toBe(true);
    expect(saida.humanizarTexto(texto)).toBe('');
  });

  it.each([
    'Seu agendamento foi confirmado com sucesso.',
    'Success é o nome da empresa onde você trabalha?',
    'O curso Customer Success faz parte da sua formação?',
    'Success is the name of your company, right?',
    'Explanation é o título do arquivo que você pediu.',
    'A explicação está no cronograma. Podemos continuar por aqui quando você puder.',
  ])('não usa palavra inglesa ou sucesso comum como motivo isolado de bloqueio: %s', (texto) => {
    expect(saida.contemMeta(texto)).toBe(false);
    expect(saida.contemRaciocinioVazado(texto)).toBe(false);
    expect(saida.humanizarTexto(texto)).toBe(texto);
  });

  it('a última barreira bloqueia antes do fracionador e do WhatsApp, inclusive com link crítico', async () => {
    const registrar = vi.fn();
    for (const texto of [INCIDENTE, SEM_TAG + '\nhttps://escoladeespecializacao.ppgvet.com.br']) {
      expect(await saida.fracionarResposta(texto)).toEqual([]);
      await saida.enviarResposta({ telefone: '5511999990001' } as never, texto, vi.fn(), { registrar });
    }
    expect(transporte).not.toHaveBeenCalled();
    expect(registrar).toHaveBeenCalledWith(expect.stringMatching(/meta_descartada|raciocinio_removido/), expect.objectContaining({ restou_vazio: true }));
  });
});

describe('a avaliação antiga não é reintroduzida pelas esteiras de follow-up', () => {
  const humano = '[ATENDIMENTO_HUMANO] Monitora\n**Success**\n**Explanation:** Você nos encaminhou esse trecho do arquivo.';
  const cliente = 'Você enviou </antml parameter> na conversa.';

  it('projeção de follow-up remove relatório da IA e preserva autoria do cliente e do humano', () => {
    const historico: Msg[] = [
      { role: 'assistant', content: humano },
      { role: 'user', content: cliente },
      { role: 'assistant', content: INCIDENTE },
      { role: 'assistant', content: 'Posso esclarecer sua dúvida por aqui.' },
      { role: 'user', content: 'Já sou formada em Medicina Veterinária.' },
    ];
    const original = structuredClone(historico);
    const projetado = montarMensagensFollowup(historico, 2, 'ana', 'Sanidade Avícola');
    expect(JSON.stringify(projetado)).not.toContain(EXPLICACAO);
    expect(projetado).toContainEqual({ role: 'assistant', content: humano });
    expect(projetado).toContainEqual({ role: 'user', content: cliente });
    expect(projetado.some((m) => m.role === 'user' && String(m.content).includes('Já sou formada em Medicina Veterinária.'))).toBe(true);
    expect(projetado).toContainEqual({ role: 'assistant', content: 'Posso esclarecer sua dúvida por aqui.' });
    expect(historico).toEqual(original);
    expect(transporte).not.toHaveBeenCalled();
  });

});

function respostaModelo(mensagem: string, tokensEntrada = 10) {
  return new Response(JSON.stringify({
    model: 'modelo-sintetico', stop_reason: 'tool_use',
    usage: { input_tokens: tokensEntrada, output_tokens: 5 },
    content: [{ type: 'tool_use', id: 'canal-final', name: NOME_TOOL_RESPOSTA, input: { mensagem } }],
  }), { status: 200 });
}

function entradaAposRespostaAutomatica() {
  // Contexto sintético equivalente ao gatilho pet do incidente. As respostas da
  // API são controladas pelo teste: isto valida o contrato, não inteligência real.
  const messages: Msg[] = [
    { role: 'user', content: 'Minha formação não é compatível com essa pós.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'pausa-anterior', name: 'pausa_ia', input: { tipo: 'pausa', motivo: 'atendimento_incompativel' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pausa-anterior', content: JSON.stringify({ status: 'pausado', resultado: 'Atendimento em pausa.' }) }] },
    { role: 'assistant', content: 'Tudo bem, fico à disposição se precisar.' },
    { role: 'user', content: 'Mensagem automática: Olá, você falou com a Creche Pet Exemplo. Como podemos ajudar seu pet? Responderemos assim que possível.' },
  ];
  return { promptAgente: 'Preserve o atendimento pausado; a mensagem automática da creche não exige nova resposta.', contextoTemporal: '', tools: [], messages };
}

describe('recuperação única após o Claude colocar avaliação em responder_ao_cliente', () => {
  it('descarta avaliação e aceita silêncio explícito da única correção, sem repetir pausa', async () => {
    transporte.mockResolvedValueOnce(respostaModelo(INCIDENTE, 10))
      .mockResolvedValueOnce(respostaModelo('', 20));
    const entrada = entradaAposRespostaAutomatica();
    const original = structuredClone(entrada);
    const resposta = await chamarAgentePrincipal(entrada);
    expect(resposta).toMatchObject({ content: [], stop_reason: 'end_turn',
      canal_resposta: { motivo: 'silencio_explicito', motivo_correcao: 'bastidor_no_canal' },
      usage: { input_tokens: 30, output_tokens: 10 } });
    expect(transporte).toHaveBeenCalledTimes(2);
    expect(transporte.mock.calls.every(([url]) => url === 'https://api.anthropic.com/v1/messages')).toBe(true);
    const pedido = JSON.parse(String(transporte.mock.calls[1][1].body));
    expect(pedido.thinking).toEqual({ type: 'disabled' });
    expect(pedido.tools.map((t: { name: string }) => t.name)).toEqual([NOME_TOOL_RESPOSTA]);
    expect(pedido.tool_choice).toMatchObject({ type: 'tool', name: NOME_TOOL_RESPOSTA, disable_parallel_tool_use: true });
    expect(JSON.stringify(pedido.messages)).toContain('Creche Pet Exemplo');
    expect(JSON.stringify(pedido.messages)).not.toContain('Correctly identifies');
    expect(JSON.stringify(pedido)).not.toContain('</antml>');
    expect(entrada).toEqual(original);
  });

  it('reincidência editorial na correção permanece silêncio e não tenta uma terceira geração', async () => {
    transporte.mockResolvedValueOnce(respostaModelo(INCIDENTE))
      .mockResolvedValueOnce(respostaModelo(SEM_TAG));
    const resposta = await chamarAgentePrincipal(entradaAposRespostaAutomatica());
    expect(resposta.content).toEqual([]);
    expect(resposta.canal_resposta).toMatchObject({ motivo: 'bastidor_no_canal', motivo_correcao: 'bastidor_no_canal' });
    expect(transporte).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(resposta)).not.toContain('Correctly identifies');
    expect(JSON.stringify(resposta)).not.toContain('</antml>');
  });
});
