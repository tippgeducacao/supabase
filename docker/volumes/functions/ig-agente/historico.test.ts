import { describe, expect, it } from 'vitest';
import { VERSAO_REGRA_ELEGIBILIDADE } from '../crm-agente-sdr/elegibilidadeAgendamento';
import {
  atrasoEntreBaloesMs, inicioDaJanela, JANELA_HISTORICO_MS, MAX_MENSAGENS_HISTORICO,
  montarHistoricoIg, telefoneTesteIg, ultimaElegibilidadeTeste,
} from './historico';

const linha = (direcao: string, conteudo: string | null, tipo = 'text') =>
  ({ direcao, tipo, conteudo, created_at: '2026-09-24T12:00:00Z' });

describe('montarHistoricoIg: a conversa do direct como o João lê', () => {
  it('lead = user, nossa saída (IA, humano pelo app ou sistema) = assistant', () => {
    expect(montarHistoricoIg([
      linha('outbound', 'oi, sou da ppgvet'),
      linha('inbound', 'oi! quero saber da pós'),
    ])).toEqual([
      { role: 'assistant', text: 'oi, sou da ppgvet' },
      { role: 'user', text: 'oi! quero saber da pós' },
    ]);
  });

  it('reação não é fala', () => {
    expect(montarHistoricoIg([linha('inbound', '❤️', 'reaction'), linha('inbound', 'oi')]))
      .toEqual([{ role: 'user', text: 'oi' }]);
  });

  it('mídia sem texto entra descrita, para o João não responder ao vazio', () => {
    const h = montarHistoricoIg([linha('inbound', null, 'audio'), linha('inbound', null, 'image'), linha('inbound', null, 'ig_reel')]);
    expect(h.map((t) => t.text)).toEqual([
      '[mandou um áudio, que não dá para ouvir por aqui]',
      '[mandou uma imagem]',
      '[compartilhou um post do Instagram]',
    ]);
  });

  it('resposta a story leva o contexto', () => {
    expect(montarHistoricoIg([linha('inbound', 'que legal', 'story_reply')]))
      .toEqual([{ role: 'user', text: '[respondendo a um story] que legal' }]);
  });

  it(`guarda só as últimas ${MAX_MENSAGENS_HISTORICO}`, () => {
    const muitas = Array.from({ length: 60 }, (_, i) => linha('inbound', `m${i}`));
    const h = montarHistoricoIg(muitas);
    expect(h).toHaveLength(MAX_MENSAGENS_HISTORICO);
    expect(h[h.length - 1].text).toBe('m59');
  });
});

describe('inicioDaJanela', () => {
  const agora = new Date('2026-09-24T12:00:00Z');
  it('sem reset = últimas 24 h', () => {
    expect(inicioDaJanela(null, agora)).toBe(new Date(agora.getTime() - JANELA_HISTORICO_MS).toISOString());
  });
  it('reset recente vence as 24 h', () => {
    expect(inicioDaJanela('2026-09-24T11:00:00Z', agora)).toBe('2026-09-24T11:00:00.000Z');
  });
  it('reset antigo não amplia a janela', () => {
    expect(inicioDaJanela('2026-09-01T00:00:00Z', agora)).toBe('2026-09-23T12:00:00.000Z');
  });
});

describe('ultimaElegibilidadeTeste', () => {
  const estado = (decisao: string, curso = 'Sanidade Avícola') =>
    ({ elegibilidade_teste: { curso, decisao, motivo: 'x', regra_versao: VERSAO_REGRA_ELEGIBILIDADE } });

  it('pega a última decisão válida registrada', () => {
    expect(ultimaElegibilidadeTeste([estado('pendente'), { nome: 'consulta_objecoes' }, estado('aprovado')]))
      .toMatchObject({ decisao: 'aprovado', curso: 'Sanidade Avícola' });
  });
  it('ignora versão velha da regra e lixo', () => {
    expect(ultimaElegibilidadeTeste([{ elegibilidade_teste: { curso: 'X', decisao: 'aprovado', regra_versao: 'v0' } }])).toBeNull();
    expect(ultimaElegibilidadeTeste(null)).toBeNull();
    expect(ultimaElegibilidadeTeste('[]')).toBeNull();
  });
});

describe('telefoneTesteIg', () => {
  it('é sintético (000…), com 11 dígitos, e estável por IGSID', () => {
    const t = telefoneTesteIg('1234567890123456');
    expect(t).toBe('00090123456');
    expect(t).toMatch(/^000\d{8}$/);
    expect(telefoneTesteIg('1234567890123456')).toBe(t);
    expect(telefoneTesteIg('')).toBe('00000000000');
  });
});

describe('atrasoEntreBaloesMs', () => {
  it('fica entre 1,2 s e 4 s', () => {
    expect(atrasoEntreBaloesMs('oi')).toBe(1_200);
    expect(atrasoEntreBaloesMs('x'.repeat(500))).toBe(4_000);
  });
});
