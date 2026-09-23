import { describe, expect, it } from 'vitest';
import {
  classificarErroIa, decidirAcao, duracao, horaSP, LIMIAR_FALHAS, resumirFalhas, telefoneParaEnvio,
  textoAlerta, textoVoltou, type ResumoFalhas,
} from './alertaIa';

// Texto real gravado em crm_agente_sdr_eventos.erro no apagão de 22/09/2026.
const CREDITO = 'Anthropic: HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

describe('classificarErroIa', () => {
  it('reconhece o crédito zerado da Anthropic', () => {
    expect(classificarErroIa(CREDITO)).toEqual({ provedor: 'anthropic', motivo: 'sem_credito' });
  });
  it('reconhece quota esgotada da OpenAI (429 insufficient_quota)', () => {
    expect(classificarErroIa('OpenAI: HTTP 429: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}'))
      .toEqual({ provedor: 'openai', motivo: 'sem_credito' });
  });
  it('reconhece saldo do DeepSeek (402)', () => {
    expect(classificarErroIa('deepseek: HTTP 402: {"error":{"message":"Insufficient Balance"}}'))
      .toEqual({ provedor: 'deepseek', motivo: 'sem_credito' });
  });
  it('reconhece chave inválida', () => {
    expect(classificarErroIa('Anthropic: HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))
      .toEqual({ provedor: 'anthropic', motivo: 'chave_invalida' });
    expect(classificarErroIa('OpenAI: HTTP 401: {"error":{"code":"invalid_api_key"}}'))
      .toEqual({ provedor: 'openai', motivo: 'chave_invalida' });
  });
  it('reconhece conta bloqueada (403)', () => {
    expect(classificarErroIa('Anthropic: HTTP 403: {"error":{"type":"permission_error","message":"x"}}'))
      .toEqual({ provedor: 'anthropic', motivo: 'conta_bloqueada' });
  });
  it('ignora o que se cura sozinho: sobrecarga, rate limit comum, 400 de pedido, erro do Meta', () => {
    expect(classificarErroIa('Anthropic: HTTP 529: {"error":{"type":"overloaded_error"}}')).toBeNull();
    expect(classificarErroIa('OpenAI: HTTP 429: {"error":{"type":"rate_limit_exceeded"}}')).toBeNull();
    expect(classificarErroIa('Anthropic: HTTP 400: {"error":{"message":"messages: text content blocks must be non-empty"}}')).toBeNull();
    expect(classificarErroIa('HTTP 422: {"error":"(#130429) Rate limit hit"}')).toBeNull();
    expect(classificarErroIa(null)).toBeNull();
  });
});

describe('resumirFalhas', () => {
  it('agrupa por provedor, conta rodadas e leads distintos e acha primeira/última', () => {
    const r = resumirFalhas([
      { erro: CREDITO, remotejid: 'a', criado_em: '2026-09-22T13:05:00Z' },
      { erro: CREDITO, remotejid: 'a', criado_em: '2026-09-22T13:04:00Z' },
      { erro: CREDITO, remotejid: 'b', criado_em: '2026-09-22T13:09:00Z' },
      { erro: 'Anthropic: HTTP 529: overloaded', remotejid: 'c', criado_em: '2026-09-22T13:09:30Z' },
    ]);
    expect([...r.keys()]).toEqual(['anthropic']);
    expect(r.get('anthropic')).toEqual({
      provedor: 'anthropic', motivo: 'sem_credito', n: 3, leads: 2,
      primeira: '2026-09-22T13:04:00Z', ultima: '2026-09-22T13:09:00Z',
    });
  });
});

const AGORA = Date.parse('2026-09-22T14:00:00Z');
const falhas = (n: number): ResumoFalhas => ({
  provedor: 'anthropic', motivo: 'sem_credito', n, leads: n,
  primeira: '2026-09-22T13:52:00Z', ultima: '2026-09-22T13:59:00Z',
});

describe('decidirAcao (dedupe e recuperação)', () => {
  it('primeira rajada acima do limiar alerta', () => {
    expect(decidirAcao({ falhas: falhas(LIMIAR_FALHAS), estado: undefined, ultimoSucesso: null, agora: AGORA })).toBe('alertar');
  });
  it('uma falha só não alerta', () => {
    expect(decidirAcao({ falhas: falhas(1), estado: undefined, ultimoSucesso: null, agora: AGORA })).toBe('nada');
  });
  it('não repete dentro de 1 h e lembra depois de 1 h', () => {
    const estado = { provedor: 'anthropic', falhando_desde: '2026-09-22T13:04:00Z', ultima_falha_em: '2026-09-22T13:59:00Z', ultimo_alerta_em: '2026-09-22T13:05:00Z' };
    expect(decidirAcao({ falhas: falhas(30), estado, ultimoSucesso: null, agora: AGORA })).toBe('nada');
    expect(decidirAcao({ falhas: falhas(30), estado: { ...estado, ultimo_alerta_em: '2026-09-22T12:59:00Z' }, ultimoSucesso: null, agora: AGORA })).toBe('lembrar');
  });
  it('voltou exige janela limpa E uma chamada bem-sucedida depois da última falha', () => {
    const estado = { provedor: 'anthropic', falhando_desde: '2026-09-22T10:04:00Z', ultima_falha_em: '2026-09-22T13:40:00Z', ultimo_alerta_em: '2026-09-22T13:05:00Z' };
    expect(decidirAcao({ falhas: undefined, estado, ultimoSucesso: '2026-09-22T13:45:00Z', agora: AGORA })).toBe('voltou');
    // sem tráfego (madrugada): não afirma que voltou
    expect(decidirAcao({ falhas: undefined, estado, ultimoSucesso: null, agora: AGORA })).toBe('nada');
    // ainda pingando falha isolada: não voltou
    expect(decidirAcao({ falhas: falhas(1), estado, ultimoSucesso: '2026-09-22T13:45:00Z', agora: AGORA })).toBe('nada');
  });
  it('esquece em silêncio depois de 24 h sem falha nem sucesso', () => {
    const estado = { provedor: 'openai', falhando_desde: '2026-09-21T10:00:00Z', ultima_falha_em: '2026-09-21T11:00:00Z', ultimo_alerta_em: '2026-09-21T10:00:00Z' };
    expect(decidirAcao({ falhas: undefined, estado, ultimoSucesso: null, agora: AGORA })).toBe('esquecer');
  });
  it('sem estado falhando e sem falha: nada', () => {
    expect(decidirAcao({ falhas: undefined, estado: undefined, ultimoSucesso: null, agora: AGORA })).toBe('nada');
  });
});

describe('textos', () => {
  it('alerta traz provedor, motivo, hora de Brasília e onde resolver — nunca o corpo do erro', () => {
    const t = textoAlerta(falhas(12), '2026-09-22T13:04:00Z', false);
    expect(t).toContain('IA FORA DO AR — Anthropic');
    expect(t).toContain('sem crédito');
    expect(t).toContain('22/09 10:04');
    expect(t).toContain('12 rodadas em 12 leads');
    expect(t).toContain('console.anthropic.com');
    expect(t).not.toContain('credit balance');
    expect(textoAlerta(falhas(12), '2026-09-22T13:04:00Z', true)).toContain('AINDA FORA');
  });
  it('voltou traz a duração e os números do apagão', () => {
    const t = textoVoltou('anthropic', '2026-09-22T13:04:00Z', '2026-09-22T19:47:00Z', 867, 268);
    expect(t).toContain('IA VOLTOU');
    expect(t).toContain('22/09 10:04 a 22/09 16:47 (6h43)');
    expect(t).toContain('867 rodadas morreram em 268 leads');
  });
  it('horaSP e duração', () => {
    expect(horaSP('2026-09-23T02:30:00Z')).toBe('22/09 23:30');
    expect(duracao('2026-09-22T13:00:00Z', '2026-09-22T13:40:00Z')).toBe('40 min');
    expect(duracao('2026-09-22T13:00:00Z', '2026-09-22T15:00:00Z')).toBe('2h');
  });
});

describe('telefoneParaEnvio', () => {
  it('normaliza para 55 + DDD + número', () => {
    expect(telefoneParaEnvio('(46) 99999-1234')).toBe('5546999991234');
    expect(telefoneParaEnvio('+55 46 9999-1234')).toBe('554699991234');
  });
  it('recusa vazio, placeholder e DDD impossível', () => {
    expect(telefoneParaEnvio(null)).toBeNull();
    expect(telefoneParaEnvio('00000000000')).toBeNull();
    expect(telefoneParaEnvio('0999991234')).toBeNull();
    expect(telefoneParaEnvio('123')).toBeNull();
  });
});
