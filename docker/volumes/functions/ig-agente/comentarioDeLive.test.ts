import { describe, expect, it } from 'vitest';
import { decidirAberturaPorComentario, ehRespostaAComentario } from './comentarioDeLive';

describe('decidirAberturaPorComentario: quando a IA abre a conversa de quem comentou na live', () => {
  it('pessoa nova, ou parada antes de dizer a formação: abre', () => {
    expect(decidirAberturaPorComentario({ etapa: null, jaRespondeuComentario: false })).toEqual({ abre: true });
    expect(decidirAberturaPorComentario({ etapa: 'boas_vindas', jaRespondeuComentario: false })).toEqual({ abre: true });
    expect(decidirAberturaPorComentario({ etapa: 'pergunta_formacao', jaRespondeuComentario: false })).toEqual({ abre: true });
  });

  it.each(['pergunta_curso', 'pergunta_data_formacao', 'pergunta_interesse', 'pergunta_whatsapp', 'escola_enviada', 'whatsapp_enviado', 'encerrada'])(
    'roteiro já passou da formação (%s): não pergunta de novo',
    (etapa) => {
      expect(decidirAberturaPorComentario({ etapa, jaRespondeuComentario: false }))
        .toEqual({ abre: false, motivo: 'roteiro_em_andamento' });
    },
  );

  it('uma abertura por pessoa: já respondeu um comentário dela → não manda outra', () => {
    expect(decidirAberturaPorComentario({ etapa: 'pergunta_formacao', jaRespondeuComentario: true }))
      .toEqual({ abre: false, motivo: 'ja_respondeu_comentario' });
  });
});

describe('ehRespostaAComentario', () => {
  const base = { direcao: 'outbound', status_entrega: 'sent', metadata: { resposta_privada: true } };
  it('saída nossa, que não falhou, marcada como resposta privada (da IA ou do SDR)', () => {
    expect(ehRespostaAComentario(base)).toBe(true);
    expect(ehRespostaAComentario({ ...base, metadata: { resposta_privada: true, origem: 'humano' } })).toBe(true);
  });
  it('o que falhou, o que é DM comum e o que veio da pessoa não contam', () => {
    expect(ehRespostaAComentario({ ...base, status_entrega: 'failed' })).toBe(false);
    expect(ehRespostaAComentario({ ...base, metadata: { origem: 'ia' } })).toBe(false);
    expect(ehRespostaAComentario({ ...base, direcao: 'inbound' })).toBe(false);
    expect(ehRespostaAComentario(null)).toBe(false);
  });
});
