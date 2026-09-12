import { describe, expect, it } from 'vitest';
import { corpoEventoB2B, hashConteudoB2B, idEventoB2B, reuniaoCancelada, type ReuniaoB2B } from './regras';

const reuniao: ReuniaoB2B = {
  id: 'b9c0c32b-4ac8-49a9-a200-e0702e8d2a11', vendedor_id: '2ff91bd6-aeed-4a73-9300-2b2983beed92',
  data_agendamento: '2026-09-14T11:00:00-03:00', data_fim_agendamento: '2026-09-14T12:00:00-03:00',
  status: 'agendado', nome_empresa: 'Empresa de exemplo', produto_b2b: 'Formação',
  pos_graduacao_interesse: null, nome_decisor: null, link_reuniao: 'https://meet.google.com/abc-defg-hij',
  google_event_id: null, updated_at: '2026-09-12T12:00:00Z',
};

describe('espelho da reunião B2B na agenda pessoal', () => {
  it('repetição usa o mesmo ID, reatribuição e restauração usam outro', () => {
    const id = idEventoB2B(reuniao.id, reuniao.vendedor_id);
    expect(idEventoB2B(reuniao.id, reuniao.vendedor_id)).toBe(id);
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(idEventoB2B(reuniao.id, reuniao.vendedor_id, 1)).not.toBe(id);
    expect(idEventoB2B(reuniao.id, reuniao.id)).not.toBe(id);
  });
  it('preserva horário Brasília e o link manual, sem convidar terceiros', () => {
    const corpo = corpoEventoB2B(reuniao);
    expect(corpo.start).toEqual({ dateTime: '2026-09-14T14:00:00.000Z', timeZone: 'America/Sao_Paulo' });
    expect(corpo.end).toEqual({ dateTime: '2026-09-14T15:00:00.000Z', timeZone: 'America/Sao_Paulo' });
    expect(corpo.location).toBe(reuniao.link_reuniao);
    expect(corpo.attendees).toBeUndefined();
    expect(corpo.extendedProperties).toEqual({ private: { ppg_agendamento_id: reuniao.id, ppg_responsavel_id: reuniao.vendedor_id } });
  });
  it('o hash muda ao reagendar ou editar link, sem depender do carimbo técnico', async () => {
    const hash = await hashConteudoB2B(corpoEventoB2B(reuniao));
    expect(await hashConteudoB2B(corpoEventoB2B({ ...reuniao, updated_at: '2026-09-13T12:00:00Z' }))).toBe(hash);
    expect(await hashConteudoB2B(corpoEventoB2B({ ...reuniao, data_fim_agendamento: '2026-09-14T13:00:00-03:00' }))).not.toBe(hash);
    expect(await hashConteudoB2B(corpoEventoB2B({ ...reuniao, link_reuniao: 'https://meet.google.com/outro' }))).not.toBe(hash);
  });
  it('cancela apenas estados de retirada, preservando histórico e remarcações', () => {
    for (const status of ['cancelado', 'cancelada', 'desmarcado', 'desqualificado']) expect(reuniaoCancelada(status)).toBe(true);
    for (const status of ['agendado', 'reagendado', 'remarcado', 'realizado', 'concluido']) expect(reuniaoCancelada(status)).toBe(false);
  });
  it('recusa intervalo inválido antes de chamar o Google', () => {
    expect(() => corpoEventoB2B({ ...reuniao, data_fim_agendamento: reuniao.data_agendamento })).toThrow('início e fim');
  });
});
