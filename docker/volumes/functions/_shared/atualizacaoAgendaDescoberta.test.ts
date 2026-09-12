import { describe, expect, it } from 'vitest';
import { atualizacaoAgendaDescoberta } from './atualizacaoAgendaDescoberta';

describe('atualizacaoAgendaDescoberta', () => {
  it.each([true, false])('preserva a seleção existente %s ao redescobrir a agenda', (selected) => {
    const existente = { selected, display_name: 'Nome antigo' };
    const descoberta = { selected: !selected, display_name: 'Nome atual', is_active: true };

    expect({ ...existente, ...atualizacaoAgendaDescoberta(descoberta) }).toEqual({
      selected,
      display_name: 'Nome atual',
      is_active: true,
    });
    expect(descoberta.selected).toBe(!selected);
  });

  it('preserva em conjunto as credenciais e os escopos usados pela caixa Gmail', () => {
    const existente = {
      oauth_access_token: 'token-gmail-teste',
      oauth_refresh_token: 'refresh-gmail-teste',
      oauth_token_expires_at: '2026-09-12T15:00:00Z',
      scopes: 'gmail.send gmail.readonly',
    };
    const descoberta = {
      oauth_access_token: 'token-calendar-teste',
      oauth_refresh_token: 'refresh-calendar-teste',
      oauth_token_expires_at: '2026-09-12T16:00:00Z',
      scopes: 'calendar',
      display_name: 'Agenda compartilhada',
    };

    expect({ ...existente, ...atualizacaoAgendaDescoberta(descoberta, true) }).toEqual({
      ...existente,
      display_name: 'Agenda compartilhada',
    });
    expect(descoberta.scopes).toBe('calendar');
  });

  it('atualiza credenciais e escopos juntos quando a linha não é usada por caixa Gmail', () => {
    const descoberta = {
      oauth_access_token: 'token-calendar-teste',
      oauth_refresh_token: 'refresh-calendar-teste',
      oauth_token_expires_at: '2026-09-12T16:00:00Z',
      scopes: 'calendar calendar.events',
      selected: false,
    };

    const atualizacao = atualizacaoAgendaDescoberta(descoberta);
    expect(atualizacao).toEqual({
      oauth_access_token: descoberta.oauth_access_token,
      oauth_refresh_token: descoberta.oauth_refresh_token,
      oauth_token_expires_at: descoberta.oauth_token_expires_at,
      scopes: descoberta.scopes,
    });
    expect(descoberta).toHaveProperty('selected', false);
  });
});
