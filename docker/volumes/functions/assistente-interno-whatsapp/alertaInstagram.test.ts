import { describe, expect, it } from 'vitest';
import {
  AVISAR_ANTES_DIAS, REPETIR_TOKEN_H, decidirAcaoToken, duracaoLonga, precisaAviso, textoAlertaToken, textoVoltouToken,
  type ContaToken,
} from './alertaInstagram';

const AGORA = Date.parse('2026-11-26T13:00:00Z'); // 26/11 10:00 BRT
const H = 3_600_000;

function conta(p: Partial<ContaToken> = {}): ContaToken {
  return {
    id: 'c1', username: 'ppgvet_oficial', agente_ia_ativo: true,
    token_status: 'ok', token_erro: null, token_falhando_desde: null, token_alerta_em: null,
    token_expira_em: '2027-01-20T00:00:00Z', ...p,
  };
}

describe('precisaAviso', () => {
  it('token morto sempre pede aviso', () => {
    expect(precisaAviso(conta({ token_status: 'morto' }), AGORA)).toBe(true);
  });
  it('renovação falhando só pede aviso perto do vencimento', () => {
    const longe = new Date(AGORA + (AVISAR_ANTES_DIAS + 3) * 86_400_000).toISOString();
    const perto = new Date(AGORA + (AVISAR_ANTES_DIAS - 1) * 86_400_000).toISOString();
    expect(precisaAviso(conta({ token_status: 'renovacao_falhou', token_expira_em: longe }), AGORA)).toBe(false);
    expect(precisaAviso(conta({ token_status: 'renovacao_falhou', token_expira_em: perto }), AGORA)).toBe(true);
    expect(precisaAviso(conta({ token_status: 'renovacao_falhou', token_expira_em: null }), AGORA)).toBe(true);
  });
  it('ok e nunca checado não pedem aviso', () => {
    expect(precisaAviso(conta(), AGORA)).toBe(false);
    expect(precisaAviso(conta({ token_status: null }), AGORA)).toBe(false);
  });
});

describe('decidirAcaoToken', () => {
  const morto = { token_status: 'morto', token_falhando_desde: '2026-11-23T14:28:59Z' } as const;

  it('1ª vez morto → alertar', () => {
    expect(decidirAcaoToken(conta(morto), AGORA)).toBe('alertar');
  });
  it('conta com IA: lembra só depois do intervalo', () => {
    const recente = new Date(AGORA - (REPETIR_TOKEN_H - 1) * H).toISOString();
    const antigo = new Date(AGORA - REPETIR_TOKEN_H * H).toISOString();
    expect(decidirAcaoToken(conta({ ...morto, token_alerta_em: recente }), AGORA)).toBe('nada');
    expect(decidirAcaoToken(conta({ ...morto, token_alerta_em: antigo }), AGORA)).toBe('lembrar');
  });
  it('conta sem IA: um aviso só, sem lembrete', () => {
    const antigo = new Date(AGORA - 48 * H).toISOString();
    expect(decidirAcaoToken(conta({ ...morto, agente_ia_ativo: false }), AGORA)).toBe('alertar');
    expect(decidirAcaoToken(conta({ ...morto, agente_ia_ativo: false, token_alerta_em: antigo }), AGORA)).toBe('nada');
  });
  it('voltou depois de avisar → voltou; voltou sem aviso → limpa em silêncio', () => {
    const alerta = new Date(AGORA - H).toISOString();
    expect(decidirAcaoToken(conta({ token_falhando_desde: '2026-11-23T14:28:59Z', token_alerta_em: alerta }), AGORA)).toBe('voltou');
    expect(decidirAcaoToken(conta({ token_falhando_desde: '2026-11-23T14:28:59Z' }), AGORA)).toBe('limpar');
  });
  it('tudo certo → nada', () => {
    expect(decidirAcaoToken(conta(), AGORA)).toBe('nada');
  });
});

describe('textos', () => {
  const agoraIso = new Date(AGORA).toISOString();

  it('alerta da conta com IA fala da Flávia, do impacto e de como resolver', () => {
    const t = textoAlertaToken(conta({ token_status: 'morto', token_falhando_desde: '2026-11-23T14:28:59Z' }),
      { respostas: 49, pessoas: 38 }, false, agoraIso);
    expect(t).toContain('🚨 *INSTAGRAM SEM ACESSO — @ppgvet_oficial*');
    expect(t).toContain('23/11 11:28');
    expect(t).toContain('há 2 dias');
    expect(t).toContain('Flávia');
    expect(t).toContain('49 respostas recusadas para 38 pessoas');
    expect(t).toContain('trocar-token.sh ppgvet_oficial');
    expect(t).toContain(`Novo aviso em ${REPETIR_TOKEN_H} h`);
  });
  it('lembrete tem outro título; conta sem IA não fala da Flávia nem de novo aviso', () => {
    const c = conta({ username: 'ppgvet.avesesuinos', agente_ia_ativo: false, token_status: 'morto', token_falhando_desde: '2026-09-06T19:19:40Z' });
    expect(textoAlertaToken(conta({ token_status: 'morto' }), null, true, agoraIso)).toContain('AINDA SEM ACESSO');
    const t = textoAlertaToken(c, { respostas: 0, pessoas: 0 }, false, agoraIso);
    expect(t).not.toContain('Flávia');
    expect(t).not.toContain('Novo aviso');
    expect(t).not.toContain('recusada');
  });
  it('renovação falhando avisa a data do vencimento', () => {
    const t = textoAlertaToken(conta({ token_status: 'renovacao_falhou', token_expira_em: '2026-11-30T15:00:00Z', token_erro: 'timeout' }),
      null, false, agoraIso);
    expect(t).toContain('RENOVAÇÃO DO ACESSO FALHOU');
    expect(t).toContain('30/11');
    expect(t).toContain('timeout');
  });
  it('voltou traz o período e o que não saiu', () => {
    const t = textoVoltouToken(conta({ token_falhando_desde: '2026-11-23T14:28:59Z' }), { respostas: 1, pessoas: 1 }, agoraIso);
    expect(t).toContain('✅ *INSTAGRAM VOLTOU — @ppgvet_oficial*');
    expect(t).toContain('23/11 11:28 a 26/11 10:00');
    expect(t).toContain('1 resposta não saiu para 1 pessoa');
  });
  it('duracaoLonga', () => {
    expect(duracaoLonga('2026-11-26T12:30:00Z', agoraIso)).toBe('30 min');
    expect(duracaoLonga('2026-11-26T10:00:00Z', agoraIso)).toBe('3h');
    expect(duracaoLonga('2026-11-26T09:45:00Z', agoraIso)).toBe('3h15');
    expect(duracaoLonga('2026-11-23T14:28:59Z', agoraIso)).toBe('2 dias');
  });
});
