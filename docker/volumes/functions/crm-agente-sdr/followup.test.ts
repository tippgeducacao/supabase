import { describe, expect, it, vi } from 'vitest';

// A montagem de contexto é pura. Isola os módulos com env Deno e transporte, sem
// chamar provedor de IA, banco ou WhatsApp para verificar a autoria do histórico.
vi.mock('./agente.ts', () => ({ chamarAnthropic: vi.fn(), MODELO_AGENTE: 'modelo-teste' }));
vi.mock('./saida.ts', () => ({ enviarResposta: vi.fn() }));

import { montarMensagensFollowup, retencaoPendente } from './followup';
import { INICIO_HISTORICO_HUMANO, type Msg } from './historico';
import { mensagemPreparada } from './historicoEntradaPausa';

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
