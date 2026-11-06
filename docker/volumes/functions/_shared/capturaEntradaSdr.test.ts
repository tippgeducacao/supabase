import { describe, expect, it, vi } from 'vitest';
import { capturarEntradaAgente, entradasMeta, iniciarCapturaWebhook, jidsDeEntrada } from './capturaEntradaSdr';
import { observadorDaRodada, observarSemInterromper } from '../crm-agente-sdr/capturaModelo';

const jid = '5511999991111@s.whatsapp.net';
const expira = () => new Date(Date.now() + 60_000).toISOString();
const evento = () => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: 'linha-teste' },
  messages: [{ id: 'wamid.teste', from: '551199991111', type: 'text', text: { body: 'Quero o cronograma' } },
    { id: 'wamid.outro', from: '5521999992222', text: { body: 'MENSAGEM_DE_OUTRA_PESSOA' } }],
  contacts: [{ wa_id: '551199991111', profile: { name: 'Pessoa teste' } }, { wa_id: '5521999992222', profile: { name: 'OUTRA_PESSOA' } }],
  statuses: [{ recipient_id: 'OUTRO_DESTINATARIO' }],
} }] }] });
function banco(configs: any[] = [{ remotejid: jid, capturar_ate: expira() }]) {
  const insert = vi.fn(async (_dados: unknown) => ({ error: null }));
  const consultar = vi.fn(async () => ({ data: configs, error: null }));
  return { insert, consultar, from: vi.fn(() => ({ insert, select: () => ({ in: () => ({ gt: consultar }), eq: () => ({ maybeSingle: async () => ({ data: configs[0] ?? null }) }) }) })) };
}

describe('captura desde o webhook', () => {
  it('guarda somente o lead com opt-in, desde o payload até o HTTP e o encaminhamento', async () => {
    const db = banco(); const original = evento();
    const captura = await iniciarCapturaWebhook(db, original, 'validada', 'application/json');
    captura.anotar('wamid.teste', { decisao: 'encaminhada', destino: 'crm-agente-sdr', payload: { conteudo: 'Quero o cronograma', id: 'wamid.teste' } });
    const resposta = Response.json({ ok: true, messages: 2 });
    await captura.finalizar(resposta); await captura.finalizar(resposta);
    expect(db.insert).toHaveBeenCalledTimes(1);
    const linhas = db.insert.mock.calls[0][0] as any;
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ tipo: 'entrada', remotejid: jid, pedido: { assinatura: 'validada' }, enviado: { decisao: 'encaminhada' }, resposta: { status_http: 200 }, origens: { mensagens_entrada: ['wamid.teste'] } });
    expect(JSON.stringify(linhas)).not.toMatch(/OUTRA_PESSOA|OUTRO_DESTINATARIO|wamid.outro/);
    expect(original.entry[0].changes[0].value.messages).toHaveLength(2);
    expect(await resposta.json()).toEqual({ ok: true, messages: 2 });
  });
  it('não grava captura ausente/expirada e nem consulta o banco em evento só de status', async () => {
    for (const config of [[], [{ remotejid: jid, capturar_ate: '2020-01-01' }]]) {
      const db = banco(config); const c = await iniciarCapturaWebhook(db, evento(), 'validada', null);
      await c.finalizar(Response.json({ ok: true })); expect(db.insert).not.toHaveBeenCalled();
    }
    const db = banco(); await iniciarCapturaWebhook(db, { entry: [{ changes: [{ field: 'messages', value: { statuses: [{}] } }] }] }, 'validada', null);
    expect(db.from).not.toHaveBeenCalled();
  });
  it('preserva falha de persistência/duplicidade e não transforma 503 em sucesso', async () => {
    const db = banco(); const c = await iniciarCapturaWebhook(db, evento(), 'validada', null);
    c.anotar('wamid.teste', { decisao: 'falha_ao_gravar', codigo_banco: '23503' });
    await c.finalizar(Response.json({ ok: false }, { status: 503 }));
    expect((db.insert.mock.calls[0][0] as any)[0]).toMatchObject({ enviado: { decisao: 'falha_ao_gravar' }, resposta: { status_http: 503 }, erro: 'HTTP 503 no recebimento' });
  });
  it('remove tokens de cabeçalhos, URLs de mídia e respostas JSON de Flow', async () => {
    const db = banco(); const c = await iniciarCapturaWebhook(db, evento(), 'validada', 'application/json');
    c.anotar('wamid.teste', { payload: { authorization: 'SEGREDO_A', token: 'SEGREDO_B',
      anexos: [{ url: 'https://exemplo.test/midia?token=SEGREDO_C&download=1' }],
      response_json: '{"flow_token":"SEGREDO_D","nota":9}' } });
    await c.finalizar(Response.json({ ok: true }));
    const texto = JSON.stringify(db.insert.mock.calls);
    expect(texto).not.toContain('SEGREDO'); expect(texto).toContain('download=1'); expect(texto).toContain('nota');
  });
  it('falha na consulta ou na gravação não interrompe o webhook', async () => {
    const db = banco(); db.consultar.mockRejectedValueOnce(new Error('fora'));
    await expect(iniciarCapturaWebhook(db, evento(), 'validada', null)).resolves.toBeDefined();
    const c = await iniciarCapturaWebhook(db, evento(), 'validada', null);
    db.insert.mockRejectedValueOnce(new Error('fora'));
    await expect(c.finalizar(Response.json({ ok: true }))).resolves.toBeUndefined();
  });
  it('registra o bloqueio real na entrada do João sem inventar uma saída para o buffer', async () => {
    const db = banco();
    await capturarEntradaAgente(db, { remotejid: jid, id: 'wamid.teste', conteudo: 'Oi' }, Response.json({ ok: true, skip: 'mensagem_recebida_em_pausa' }));
    expect(db.insert.mock.calls[0][0]).toMatchObject({ tipo: 'entrada', enviado: { decisao: 'mensagem_recebida_em_pausa', payload: null }, pedido: { body: { conteudo: 'Oi' } } });
  });
  it('liga modelo e ferramentas ao lote de mensagens que originou a rodada', async () => {
    const db = banco(); const observar = await observadorDaRodada(db, jid, 'rodada', 'qualificador', ['wamid.1', 'wamid.2']);
    await observarSemInterromper(observar, { tipo: 'ferramenta', pedido: {}, enviado: {}, provedor: 'interno' });
    expect(db.insert.mock.calls[0][0]).toMatchObject({ origens: { mensagens_entrada: ['wamid.1', 'wamid.2'] } });
  });
  it('reconhece a grafia da Meta sem juntar dois números distintos', () => {
    expect(jidsDeEntrada('551199991111')).toContain(jid);
    expect(jidsDeEntrada('12025550123')).toEqual(['12025550123@s.whatsapp.net']);
    expect(jidsDeEntrada('')).toEqual([]);
    expect(entradasMeta({ entry: {} })).toEqual([]);
  });
});
