import { describe, expect, it } from 'vitest';
import { FIGURINHA_FOLLOWUP_URL, figurinhaNaJanela, motivoSemFigurinha } from './followupFigurinha';
import { chaveFigurinha, chaveJanelaAberta } from './fila';

const AGORA = Date.parse('2026-10-10T15:00:00.000Z');
const lead = (extra: Record<string, unknown> = {}) => ({
  followup_ativado: true, iniciar_atendimento: true, modo_recontato: false, pausa_ia: false,
  atendimento_finalizado: false, agendado: false, jornada: {}, ...extra,
});
const estado = (extra: Record<string, unknown> = {}) => ({
  lead: lead(), elapsedMin: 40, toquesFeitos: 1, enviadosNoCiclo: 1, agora: AGORA, ...extra,
});

describe('figurinha dos 37 min no follow-up de janela aberta', () => {
  it('só entra entre 37 e 60 min, com o toque de 15 min já consumido', () => {
    expect(figurinhaNaJanela(36.9, 1)).toBe(false);
    expect(figurinhaNaJanela(37, 1)).toBe(true);
    expect(figurinhaNaJanela(59.9, 1)).toBe(true);
    // A partir de 1h é o toque de texto; figurinha atrasada não é recuperada.
    expect(figurinhaNaJanela(60, 1)).toBe(false);
    expect(figurinhaNaJanela(40, 0)).toBe(false);
    expect(figurinhaNaJanela(40, 2)).toBe(false);
  });

  it('envia para o lead elegível que recebeu o follow-up de 15 min', () => {
    expect(motivoSemFigurinha(estado())).toBeNull();
  });

  it('não envia se o modelo ficou em silêncio no toque de 15 min', () => {
    expect(motivoSemFigurinha(estado({ enviadosNoCiclo: 0 }))).toBe('toque_de_15min_sem_envio');
  });

  it('respeita pausa, reunião marcada, recontato e esteira desligada', () => {
    for (const extra of [{ pausa_ia: true }, { agendado: true }, { modo_recontato: true }, { followup_ativado: false },
      { atendimento_finalizado: true }, { iniciar_atendimento: false }]) {
      expect(motivoSemFigurinha(estado({ lead: lead(extra) }))).toBe('lead_fora_da_esteira');
    }
  });

  it('persona aula segue só com texto', () => {
    expect(motivoSemFigurinha(estado({ lead: lead({ contexto_campanha: { persona: 'aula' } }) }))).toBe('persona_aula');
  });

  it('não repete a figurinha para o mesmo lead em menos de 7 dias', () => {
    const haDias = (dias: number) => lead({ jornada: { figurinha_followup: { enviado_em: new Date(AGORA - dias * 86_400_000).toISOString() } } });
    expect(motivoSemFigurinha(estado({ lead: haDias(6.9) }))).toBe('ja_recebeu_recentemente');
    expect(motivoSemFigurinha(estado({ lead: haDias(7.1) }))).toBeNull();
  });

  it('a chave da fila é uma por silêncio do lead e não colide com os toques de texto', () => {
    const jid = '5511999990000@s.whatsapp.net';
    expect(chaveFigurinha(jid, '2026-10-10T12:00:00Z')).toBe(chaveFigurinha(jid, '2026-10-10T12:00:00.000+00:00'));
    expect(chaveFigurinha(jid, '2026-10-10T12:00:00Z')).not.toBe(chaveFigurinha(jid, '2026-10-10T13:00:00Z'));
    expect(chaveFigurinha(jid, '2026-10-10T12:00:00Z')).not.toBe(chaveJanelaAberta(jid, 1, '2026-10-10T12:00:00Z'));
  });

  it('a figurinha é um webp público do Storage', () => {
    expect(FIGURINHA_FOLLOWUP_URL).toMatch(/^https:\/\/.+\/whatsapp-anexos\/stickers\/.+\.webp$/);
  });
});
