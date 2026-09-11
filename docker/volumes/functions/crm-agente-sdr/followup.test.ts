import { describe, expect, it, vi } from 'vitest';

// A montagem de contexto é pura. Isola os módulos com env Deno e transporte, sem
// chamar provedor de IA, banco ou WhatsApp para verificar a autoria do histórico.
vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn(), MODELO_AGENTE: 'modelo-teste' }));
vi.mock('./saida.ts', () => ({ enviarResposta: vi.fn() }));
vi.mock('./spinFollowup.ts', () => ({ gerarFollowupSpin: vi.fn(), reservarAbordagemSpin: vi.fn() }));
vi.mock('./eventos.ts', () => ({ criarTelemetria: () => ({ rodadaId: 'teste-retorno', registrar: vi.fn() }), resumir: (valor: unknown) => valor }));

import { montarMensagensFollowup, processarFollowupLead, retencaoPendente, retornoPendente } from './followup';
import { INICIO_HISTORICO_HUMANO, MARCADOR_FOLLOWUP, type Msg } from './historico';
import { mensagemPreparada } from './historicoEntradaPausa';
import { chamarAnthropic } from './agente';
import { gerarFollowupSpin } from './spinFollowup';
import { enviarResposta } from './saida';

describe('memória humana na janela de contexto do follow-up', () => {
  it('preserva a fala humana que inicia os últimos 16 turnos, com autoria e sem ampliar a janela', () => {
    const historico: Msg[] = [
      { role: 'user', content: 'turno antigo fora do recorte' },
      { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Documento enviado: cronograma.pdf' },
      ...Array.from({ length: 15 }, (_, i): Msg => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turno recente ${i}`,
      })),
    ];
    const copia = structuredClone(historico);
    const mensagens = montarMensagensFollowup(historico, 2, 'ana', 'Sanidade Avícola');
    expect(mensagens[0]).toEqual({ role: 'user', content: INICIO_HISTORICO_HUMANO });
    expect(mensagens[1]).toEqual(historico[1]);
    expect(JSON.stringify(mensagens)).not.toContain('turno antigo fora do recorte');
    expect(mensagens.at(-1)?.content).toContain('2ª tentativa');
    expect(historico).toEqual(copia);
  });

  it('mantém áudio pendente como registro do vendedor mesmo sem fala do lead no recorte', () => {
    const mensagem: Msg = { role: 'assistant', content: '[ATENDIMENTO_HUMANO] Áudio enviado; transcrição pendente.' };
    const mensagens = montarMensagensFollowup([mensagem], 1, 'ana', 'Sanidade Avícola');
    expect(mensagens[0]).toEqual({ role: 'user', content: INICIO_HISTORICO_HUMANO });
    expect(mensagens[1]).toEqual(mensagem);
    expect(mensagens[2].role).toBe('user');
    expect(mensagens[2].content).toContain('INFORMAÇÕES DA TENTATIVA DE FOLLOW-UP');
  });
});

describe('resposta com mídia após a oferta de retenção', () => {
  const retencao: Msg = { role: 'assistant', content: 'quer que eu te chame quando abrir a próxima turma?' };

  it('reconhece arquivo e legenda preparados como uma resposta real do lead', () => {
    const resposta = mensagemPreparada({ arquivo: 'Análise do arquivo', mensagem: 'Sim, pode me avisar.' })!;
    expect(retencaoPendente([retencao, resposta])).toBe(false);
  });

  it.each([
    [{ type: 'tool_result', tool_use_id: 'tool-sintetica', content: 'resultado' }],
    [{ type: 'tool_result', tool_use_id: 'tool-sintetica', content: 'resultado' }, { type: 'text', text: 'contexto técnico' }],
  ])('não transforma retorno de ferramenta em resposta do lead: %j', (content) => {
    expect(retencaoPendente([retencao, { role: 'user', content }])).toBe(true);
  });
});

describe('espera pela escolha de quando retomar o contato', () => {
  const ausencia: Msg = { role: 'user', content: 'No momento, não estou podendo lhe atender. Assim que possível lhe responderei.' };
  const pergunta: Msg = { role: 'assistant', content: 'tranquilo, quando posso te chamar por aqui?' };

  it.each([
    'tranquilo, quando posso te chamar?',
    'qual é o melhor dia e horário pra eu te chamar por aqui?',
    'que horário fica melhor pra eu te chamar pelo WhatsApp?',
    'quando podemos retomar nossa conversa por aqui?',
    'quando posso retomar por aqui?',
    'qual o melhor período para entrar em contato de novo?',
    '[ATENDIMENTO_HUMANO] Letícia · 2026-09-11 19:00 UTC\nquando posso te chamar por aqui?',
  ])('aguarda uma resposta à pergunta explícita: %s', (content) => {
    expect(retornoPendente([ausencia, { role: 'assistant', content }])).toBe(true);
  });

  it.each([
    'quando posso te chamar no Meet?',
    'qual horário é melhor para agendar a reunião e te chamar?',
    'quando posso te chamar para uma ligação?',
    'posso te chamar amanhã às 17h?',
    'combinado, te chamo amanhã.',
    'quando podemos retomar o conteúdo do cronograma?',
    'qual horário fica melhor pra conversar com o monitor?',
    'quando você quer estudar essa disciplina?',
  ])('preserva os outros fluxos: %s', (content) => {
    expect(retornoPendente([ausencia, { role: 'assistant', content }])).toBe(false);
  });

  it('ignora pergunta antiga quando o atendente já confirmou uma data', () => {
    expect(retornoPendente([ausencia, pergunta, { role: 'assistant', content: 'ficou combinado para amanhã.' }])).toBe(false);
  });

  it.each([
    { role: 'user', content: 'pode me chamar amanhã' },
    { role: 'user', content: [{ type: 'text', text: 'agora posso conversar' }] },
    mensagemPreparada({ arquivo: 'Transcrição do áudio', mensagem: 'Pode me chamar amanhã.' })!,
  ] satisfies Msg[])('libera a avaliação quando o lead responde de verdade: %j', (resposta) => {
    expect(retornoPendente([ausencia, pergunta, resposta])).toBe(false);
  });

  it.each([
    { role: 'user', content: MARCADOR_FOLLOWUP },
    { role: 'user', content: '[CORRECAO_INTERNA_AUTO_IGNORE] Ajuste a resposta.' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'resultado' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'resultado' }, { type: 'text', text: 'contexto técnico' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'consulta', input: {} }] },
  ] satisfies Msg[])('não transforma marcadores ou ferramentas em resposta real: %j', (tecnica) => {
    expect(retornoPendente([ausencia, pergunta, tecnica])).toBe(true);
  });

  it('reconhece pergunta em blocos text e não altera o histórico', () => {
    const history: Msg[] = [ausencia, { role: 'assistant', content: [{ type: 'text', text: pergunta.content }] }];
    const copia = structuredClone(history);
    expect(retornoPendente(history)).toBe(true);
    expect(history).toEqual(copia);
    expect(retornoPendente([])).toBe(false);
  });

  it('o worker silencia antes de clássico ou SPIN, sem consumir toque ou alterar o lead', async () => {
    vi.clearAllMocks();
    const lead = { remotejid: '5511999990001@s.whatsapp.net', iniciar_atendimento: true,
      followup_ativado: true, pausa_ia: false, timestamp_mensagem: new Date(Date.now() - 20 * 60000).toISOString() };
    const alterar = vi.fn();
    const banco = {
      rpc: vi.fn(async () => ({ data: true, error: null })),
      from(tabela: string) {
        const q = {
          select: () => q, eq: () => q, in: () => q, order: () => q, delete: () => q,
          update: alterar,
          limit: async () => {
            if (tabela === 'crm_agente_sdr_buffer') return { data: [], error: null };
            if (tabela === 'cliente_ppg_leads_sdr') return { data: [lead], error: null };
            if (tabela === 'cliente_ppg_mensagens_sdr') return {
              data: [ausencia, pergunta].map((conversation_history, i) => ({ id: i + 1, conversation_history })), error: null,
            };
            throw new Error('Tabela inesperada: ' + tabela);
          },
          then: (resolve: (valor: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        return q;
      },
    };
    expect(await processarFollowupLead(banco, lead, 1)).toBe(false);
    expect(chamarAnthropic).not.toHaveBeenCalled();
    expect(gerarFollowupSpin).not.toHaveBeenCalled();
    expect(enviarResposta).not.toHaveBeenCalled();
    expect(alterar).not.toHaveBeenCalled();
  });
});
