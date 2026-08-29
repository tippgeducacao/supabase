import { describe, expect, it } from 'vitest';
import { extrairReferral } from './waProviders.ts';

/**
 * CLIQUE-PARA-WHATSAPP: o anúncio que abriu a conversa.
 *
 * O que este teste protege é uma informação que **não se recupera**: a Meta manda
 * o `referral` só na PRIMEIRA mensagem da conversa e nunca reenvia. Enquanto os
 * dois webhooks descartavam o bloco, a campanha de WhatsApp era invisível —
 * medido em 28/08/2026: 4 campanhas ativas desde 24/07, R$ 3.347,00 gastos,
 * 1.650 cliques, 993 pessoas atendidas e ZERO leads com campanha.
 *
 * Os dois dialetos existem de verdade: a API oficial manda `referral` pronto; a
 * Uazapi (Baileys) manda `contextInfo.externalAdReply`, com o nome do campo
 * variando entre versões do provedor.
 */
describe('extrairReferral — o anúncio que abriu a conversa', () => {
  it('lê o formato da API oficial da Meta', () => {
    const r = extrairReferral({
      from: '5546999990001',
      referral: {
        source_url: 'https://fb.me/abc',
        source_id: '120247929875010355',
        source_type: 'ad',
        headline: 'Pós em Clínica e Cirurgia',
        body: 'Inscrições abertas',
        ctwa_clid: 'ARxyz123',
      },
    });
    expect(r?.sourceId).toBe('120247929875010355');
    expect(r?.ctwaClid).toBe('ARxyz123');
    expect(r?.sourceType).toBe('ad');
    expect(r?.headline).toBe('Pós em Clínica e Cirurgia');
  });

  it('lê o formato da Uazapi (externalAdReply)', () => {
    const r = extrairReferral({
      contextInfo: {
        externalAdReply: {
          sourceId: '120247929875010355',
          sourceUrl: 'https://fb.me/abc',
          sourceType: 'ad',
          title: 'Pós em Clínica e Cirurgia',
          body: 'Inscrições abertas',
          ctwaClid: 'ARxyz123',
        },
      },
    });
    expect(r?.sourceId).toBe('120247929875010355');
    expect(r?.ctwaClid).toBe('ARxyz123');
    expect(r?.headline).toBe('Pós em Clínica e Cirurgia');
  });

  /**
   * ⚠️ O nome do campo VARIA entre versões do provedor. É por isso que a lista de
   * caminhos é longa: uma atualização da Uazapi não pode matar a régua em
   * silêncio — que é exatamente como esta informação se perderia de novo.
   */
  it('aceita as variações snake_case do mesmo campo', () => {
    const r = extrairReferral({
      externalAdReply: { source_id: '999', ctwa_clid: 'CLID9' },
    });
    expect(r?.sourceId).toBe('999');
    expect(r?.ctwaClid).toBe('CLID9');
  });

  it('acha o bloco quando ele vem aninhado em message.contextInfo', () => {
    const r = extrairReferral({
      message: { contextInfo: { externalAdReply: { sourceId: '777' } } },
    });
    expect(r?.sourceId).toBe('777');
  });

  /**
   * ⚠️ Título e corpo SOZINHOS não são anúncio: qualquer link compartilhado numa
   * conversa gera esse card de prévia. Atribuir campanha a partir dele daria
   * crédito de mídia paga a uma conversa que não veio de anúncio nenhum.
   */
  it('card de prévia de link (sem id e sem clid) NÃO é anúncio', () => {
    const r = extrairReferral({
      contextInfo: {
        externalAdReply: { title: 'Notícia qualquer', body: 'resumo', sourceUrl: 'https://g1.com' },
      },
    });
    expect(r).toBeNull();
  });

  it('conversa comum não inventa anúncio', () => {
    expect(extrairReferral({ from: '5546999990001', text: { body: 'oi' } })).toBeNull();
    expect(extrairReferral(null)).toBeNull();
    expect(extrairReferral(undefined)).toBeNull();
    expect(extrairReferral('texto')).toBeNull();
  });

  it('só o clid, sem ad id, ainda vale — é rastro suficiente para conciliar', () => {
    const r = extrairReferral({ referral: { ctwa_clid: 'ARonly' } });
    expect(r?.ctwaClid).toBe('ARonly');
    expect(r?.sourceId).toBeNull();
    // sem source_type declarado, assume 'ad': só quem clicou num anúncio tem clid
    expect(r?.sourceType).toBe('ad');
  });

  it('respeita o source_type declarado — post orgânico não é anúncio pago', () => {
    const r = extrairReferral({
      referral: { source_id: '555', source_type: 'post' },
    });
    expect(r?.sourceType).toBe('post');
  });

  it('id vazio ou só espaço não vira atribuição', () => {
    expect(extrairReferral({ referral: { source_id: '   ' } })).toBeNull();
    expect(extrairReferral({ referral: { source_id: '' } })).toBeNull();
  });

  it('corta URL absurdamente longa em vez de estourar a coluna', () => {
    const r = extrairReferral({
      referral: { source_id: '1', source_url: 'https://x.com/' + 'a'.repeat(5000) },
    });
    expect(r?.sourceUrl?.length).toBeLessThanOrEqual(2048);
  });
});
