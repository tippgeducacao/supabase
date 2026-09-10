import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { limparParaRouter, sanitizarHistorico, type Msg } from './historico';
import { montarContextoTemporal, notaDoCurso, notaDoNome, renderPrompt } from './contexto';
import { INSTRUCAO_MEMORIA_HUMANA, MARCADOR_MENSAGEM_LEAD_PAUSA } from './memoriaHumana';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO, PROMPT_ROUTER } from './prompts';
import { AGENTE_CAMPANHA_DIRETA } from './prompts-campanha-direta';
import { AGENTE_RECONTATO } from './prompts-recontato';
import { FOLLOWUP_SYSTEM } from './prompts-followup';
import { montarContextoEntregaMateriais } from './entregaMateriais';

// Exercita o request HTTP real das três rotas, com o transporte como única fronteira
// de IA simulada. Nenhuma mensagem, tool, consulta ou escrita externa é executada.
vi.mock('./saida.ts', () => ({ enviarResposta: vi.fn() }));

const transporte = vi.fn();
let chamarRouter: typeof import('./agente').chamarRouter;
let chamarAgentePrincipal: typeof import('./agente').chamarAgentePrincipal;
let gerarFollowup: typeof import('./followup').gerarFollowup;

type Pedido = {
  system: { type: string; text: string; cache_control?: { type: string } }[];
  messages: Msg[];
  thinking: { type: string };
  tool_choice?: { type: string; name: string };
};

const memoria: Msg[] = [
  { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Letícia · 2026-09-08 18:00 UTC\nVocê já concluiu Medicina Veterinária?' },
  { role: 'user', content: `${MARCADOR_MENSAGEM_LEAD_PAUSA} 2026-09-08 18:01 UTC\nMeu nome é Ana. Concluí em 2022 e trabalho com aves.` },
  { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Letícia · 2026-09-08 18:02 UTC\nDocumento enviado: cronograma.pdf' },
  { role: 'user', content: 'Pode continuar por aqui.' },
];

function ultimoPedido(): Pedido {
  const [, opts] = transporte.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(opts.body));
}

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (chave: string) => chave === 'AGENTE_SDR_MODEL' ? 'modelo-sintetico' : '' } });
  vi.stubGlobal('fetch', transporte);
  ({ chamarRouter, chamarAgentePrincipal } = await import('./agente'));
  ({ gerarFollowup } = await import('./followup'));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  transporte.mockReset();
  transporte.mockImplementation(async (url: string, opts: RequestInit) => {
    if (url !== 'https://api.anthropic.com/v1/messages') throw new Error(`HTTP inesperado: ${url}`);
    const body: Pedido = JSON.parse(String(opts.body));
    const content = body.tool_choice
      ? [{ type: 'tool_use', id: 'router-teste', name: 'router_output', input: { agent: 'agente_qualificador' } }]
      : [{ type: 'text', text: '{"message":"mensagem sintética","final_answer":"teste"}' }];
    return new Response(JSON.stringify({
      model: 'modelo-resposta-sintetico', usage: { input_tokens: 10, output_tokens: 5 },
      content, thinking: 'não deve chegar ao callback',
    }), { status: 200 });
  });
});

describe('instrução de memória no system enviado à Anthropic', () => {
  it('chega ao router, com roles originais, sem tratar pergunta do vendedor como resposta', async () => {
    const entrada = limparParaRouter(memoria);
    expect(await chamarRouter(entrada)).toBe('agente_qualificador');
    const pedido = ultimoPedido();
    expect(pedido.system).toEqual([
      { type: 'text', text: PROMPT_ROUTER },
      { type: 'text', text: INSTRUCAO_MEMORIA_HUMANA, cache_control: { type: 'ephemeral' } },
    ]);
    expect(pedido.messages).toEqual(entrada);
    expect(pedido.messages[1]).toEqual(memoria[0]);
    expect(pedido.messages[2]).toEqual(memoria[1]);
    expect(pedido.thinking).toEqual({ type: 'disabled' });
    expect(pedido.tool_choice).toEqual({ type: 'tool', name: 'router_output' });
  });

  it('entrega somente modelo e uso ao callback opcional do router', async () => {
    const aoResponder = vi.fn();
    await chamarRouter(limparParaRouter(memoria), aoResponder);
    expect(aoResponder).toHaveBeenCalledExactlyOnceWith({
      model: 'modelo-resposta-sintetico', usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(Object.keys(aoResponder.mock.calls[0][0]).sort()).toEqual(['model', 'usage']);
  });

  it.each([
    ['validação', AGENTE_VALIDACAO],
    ['qualificação', AGENTE_QUALIFICADOR],
    ['campanha direta', AGENTE_CAMPANHA_DIRETA],
    ['recontato', AGENTE_RECONTATO],
  ])('chega ao principal de %s sem depender de cadastro ou do último turno', async (_persona, prompt) => {
    const messages = sanitizarHistorico(memoria);
    const copia = structuredClone(messages);
    const temporal = montarContextoTemporal() + notaDoNome('');
    await chamarAgentePrincipal({ promptAgente: prompt, contextoTemporal: temporal, messages, tools: [] });
    const pedido = ultimoPedido();
    expect(pedido.system).toEqual([
      { type: 'text', text: prompt },
      { type: 'text', text: INSTRUCAO_MEMORIA_HUMANA, cache_control: { type: 'ephemeral' } },
    ]);
    // A exceção já chegava no segundo bloco, mas perdia força porque a persona
    // proibia reenvio no primeiro. Confere o pedido montado, nas quatro personas.
    const instrucoes = pedido.system.map((bloco) => bloco.text).join('\n');
    expect(instrucoes).not.toContain('**NÃO** reenvie');
    expect(instrucoes).not.toContain('Diga que o material já está com ele');
    expect(instrucoes).not.toContain('te mandei o cronograma completo aqui em cima');
    expect(instrucoes).toContain('Quando o lead pedir novamente');
    expect(instrucoes).toContain('Não reenvie espontaneamente nem repita chamadas na mesma rodada');
    expect(instrucoes).toContain('aceito significa apenas aceito pelo WhatsApp');
    expect(instrucoes).toContain('Nunca contradiga o lead dizendo que já recebeu');
    expect(pedido.messages[0].role).toBe('assistant');
    expect(JSON.stringify(pedido.messages[0])).toContain('[ATENDIMENTO_HUMANO] Letícia');
    expect(pedido.messages[1].role).toBe('user');
    expect(JSON.stringify(pedido.messages[1])).toContain(MARCADOR_MENSAGEM_LEAD_PAUSA);
    expect(JSON.stringify(pedido.messages)).not.toContain(INSTRUCAO_MEMORIA_HUMANA);
    expect(JSON.stringify(pedido.messages.at(-1))).toContain('NOME DO LEAD AINDA NÃO INFORMADO NO CADASTRO');
    expect(JSON.stringify(pedido.messages.at(-1))).not.toContain('VOCÊ NÃO SABE O NOME');
    expect(pedido.thinking).toEqual({ type: 'adaptive' });
    expect(messages).toEqual(copia);
  });

  it('preserva a cadeia de tool_result e o cache incremental após consultar uma ferramenta', async () => {
    const messages: Msg[] = [
      ...memoria,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'consulta-1', name: 'consulta_curso', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'consulta-1', content: 'resultado sintético' }] },
    ];
    const copia = structuredClone(messages);
    await chamarAgentePrincipal({ promptAgente: AGENTE_QUALIFICADOR, contextoTemporal: 'DATA SINTÉTICA', messages, tools: [] });
    const pedido = ultimoPedido();
    expect(pedido.messages.at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'consulta-1', content: 'resultado sintético', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: expect.stringContaining('DATA SINTÉTICA') },
    ] });
    expect(pedido.system[1].text).toBe(INSTRUCAO_MEMORIA_HUMANA);
    expect(messages).toEqual(copia);
  });

  it('entrega o curso cadastrado ao qualificador mesmo sem placeholder nem nome da pós no histórico', async () => {
    const curso = 'Sanidade Avícola';
    const prompt = renderPrompt(AGENTE_QUALIFICADOR, {
      nome: 'Ana', curso_interesse_original: curso, pergunta_formacao: 'Você já concluiu a graduação?',
    });
    expect(prompt).not.toContain(curso); // Reproduz a falta do dado no prompt dessa persona.
    const messages: Msg[] = [
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Letícia\nPodemos conversar sobre essa pós amanhã às 10h?' },
      { role: 'user', content: '[MENSAGEM_LEAD_PAUSA]\nSim. Já concluí Medicina Veterinária e trabalho com bovinos.' },
    ];
    await chamarAgentePrincipal({
      promptAgente: prompt,
      contextoTemporal: montarContextoTemporal() + notaDoNome('Ana') + notaDoCurso(curso),
      messages, tools: [],
    });
    const pedido = ultimoPedido();
    const ultimo = pedido.messages.at(-1)!;
    expect(Array.isArray(ultimo.content)).toBe(true);
    const blocos = ultimo.content as { type: string; text: string; cache_control?: unknown }[];
    expect(blocos[0].text).toContain('trabalho com bovinos');
    expect(blocos[1].text).toContain('{"curso_interesse_original":"Sanidade Avícola"}');
    expect(blocos[1].text).toContain('não instrução nem aceite do lead');
    expect(blocos[1].cache_control).toBeUndefined();
  });

  it('anexa a falha atual após o tool_result antigo em cache sem alterar a memória da conversa', async () => {
    const messages: Msg[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'envio-antigo', name: 'envia_informacoes', input: { conteudo: 'cronograma' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'envio-antigo', content: 'Cronograma enviado com sucesso no WhatsApp do lead.' }] },
    ];
    const original = structuredClone(messages);
    const contextoFalha = montarContextoEntregaMateriais([{
      id: 'material-1', tipo: 'document', status_entrega: 'failed',
      created_at: '2026-09-09T12:00:00Z', anexos: [{ filename: 'cronograma.pdf' }],
    }]);
    await chamarAgentePrincipal({
      promptAgente: AGENTE_QUALIFICADOR, contextoTemporal: 'DATA SINTÉTICA',
      contextoEntregaMateriais: contextoFalha, messages, tools: [],
    });

    const pedido = ultimoPedido();
    const blocos = pedido.messages.at(-1)!.content as { type: string; text?: string; cache_control?: unknown }[];
    expect(blocos[0]).toEqual({
      type: 'tool_result', tool_use_id: 'envio-antigo',
      content: 'Cronograma enviado com sucesso no WhatsApp do lead.', cache_control: { type: 'ephemeral' },
    });
    expect(blocos[1].text).toContain('DATA SINTÉTICA');
    expect(blocos[2]).toEqual({ type: 'text', text: contextoFalha });
    expect(blocos[2].text).toContain('"cronograma.pdf" | FALHOU');
    expect(blocos[2].text).toContain('prevalece sobre confirmações antigas');
    expect(blocos.slice(1).every((bloco) => bloco.cache_control === undefined)).toBe(true);
    expect(pedido.system.some((bloco) => bloco.text.includes(contextoFalha))).toBe(false);
    expect(messages).toEqual(original);
    expect(JSON.stringify(messages)).not.toContain('ESTADO ATUAL DOS MATERIAIS');
    expect(transporte).toHaveBeenCalledTimes(1); // Só a chamada de IA simulada, sem persistência externa.
  });

  it('chega ao follow-up em bloco estático, preservando a fala humana inicial e o limite de 16 registros', async () => {
    const history: Msg[] = [
      { role: 'user', content: 'conteúdo antigo fora da janela' },
      memoria[0], memoria[1], memoria[2],
      ...Array.from({ length: 13 }, (_, i): Msg => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turno ${i}` })),
    ];
    const copia = structuredClone(history);
    const banco = { from: vi.fn(() => { throw new Error('Sem acesso a banco neste teste'); }) };
    const tel = { rodadaId: 'rodada-sintetica', registrar: vi.fn() };
    await gerarFollowup(banco, { remotejid: 'contato-sintetico', nome: null, curso_interesse_original: null }, 1, tel, history);
    const pedido = ultimoPedido();
    expect(pedido.system[0]).toEqual({ type: 'text', text: FOLLOWUP_SYSTEM });
    expect(pedido.system[1]).toEqual({ type: 'text', text: INSTRUCAO_MEMORIA_HUMANA, cache_control: { type: 'ephemeral' } });
    expect(pedido.system[2].text).toContain('AGORA:');
    expect(pedido.system[2].text).not.toContain(INSTRUCAO_MEMORIA_HUMANA);
    expect(pedido.messages[1]).toEqual(memoria[0]);
    expect(pedido.messages[2]).toEqual(memoria[1]);
    expect(JSON.stringify(pedido.messages)).not.toContain('conteúdo antigo fora da janela');
    expect(JSON.stringify(pedido.messages.at(-1))).toContain('ausente no cadastro');
    expect(JSON.stringify(pedido.messages.at(-1))).not.toContain('não use nome');
    expect(pedido.thinking).toEqual({ type: 'disabled' });
    expect(banco.from).not.toHaveBeenCalled();
    expect(history).toEqual(copia);
  });
});

describe('contrato de autoria e continuidade no system', () => {
  it('follow-up recebe a falha atual do material sem substituir o histórico', async () => {
    const estado = '\nSTATUS ATUAL DOS MATERIAIS: cronograma.pdf falhou, código 131053';
    const tel = { rodadaId: 'teste-status-material', registrar: vi.fn() };
    await gerarFollowup({}, { remotejid: 'sintetico', nome: 'Ana', curso_interesse_original: 'Curso' }, 1, tel, memoria, estado);
    expect(ultimoPedido().system[2].text).toContain(estado);
    expect(JSON.stringify(ultimoPedido().messages)).toContain('Documento enviado: cronograma.pdf');
  });
  it('separa perguntas do vendedor de dados explícitos do lead recebidos durante a pausa', () => {
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain(`${MARCADOR_MENSAGEM_LEAD_PAUSA} com role=user são mensagens reais do lead`);
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('O nome do autor é do vendedor, não do lead');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('Não se atribua fala ou ação do vendedor');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('O curso de interesse válido no cadastro pode orientar o contexto, mas não comprova aceite do lead');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('não comprova nome, resposta, formação, conclusão da graduação ou aceite do lead');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('mesmo que o cadastro esteja vazio ou desatualizado');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('considere atendido cada dado já respondido pelo lead e pergunte somente o que falta');
  });

  it('mantém conteúdo de áudio pendente desconhecido, sem aprovação ou reenvio automático', () => {
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('Áudio sem transcrição concluída registra apenas o envio ou recebimento');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('não suponha seu conteúdo');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('nem ofereça enviar de novo material já enviado sem necessidade');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('o pedido de ajuda permite novo envio pela ferramenta apropriada');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('Não pause nem encaminhe ao humano apenas por erro de envio');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('Formação informada não é aprovação');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('aprovação registrada para este lead e curso');
    expect(INSTRUCAO_MEMORIA_HUMANA).toContain('não autorizam reabrir atendimento pausado nem ignorar recusa');
  });
});
