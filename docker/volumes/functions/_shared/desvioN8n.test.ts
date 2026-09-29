import { beforeEach, describe, expect, it } from 'vitest';
import { _limparCacheDesvioN8n, carregarDesvioN8n, telefoneCanonico, vaiParaN8n } from './desvioN8n';

const cfg = { ativo: true, url: 'https://n8n/webhook/sdr-luna/entrada', segredo: 's', telefones: ['5546988166051'] };
const cliente = (linha: unknown, erro = false) => {
  let leituras = 0;
  return {
    get leituras() { return leituras; },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { leituras++; return erro ? { data: null, error: { message: 'x' } } : { data: linha, error: null }; } }) }) }),
  };
};

describe('desvio de telefones de teste para o n8n', () => {
  beforeEach(() => _limparCacheDesvioN8n());

  it('casa o número com ou sem o 9º dígito e em formato remotejid', () => {
    expect(telefoneCanonico('554688166051')).toBe('5546988166051');
    expect(vaiParaN8n(cfg, '554688166051')).toBe(true);
    expect(vaiParaN8n(cfg, '5546988166051@s.whatsapp.net')).toBe(true);
    expect(vaiParaN8n(cfg, '5511988166051')).toBe(false); // mesmo final, outro DDD
  });

  it('desligado, sem URL ou sem segredo: ninguém vai para o n8n', () => {
    expect(vaiParaN8n({ ...cfg, ativo: false }, '5546988166051')).toBe(false);
    expect(vaiParaN8n({ ...cfg, url: '' }, '5546988166051')).toBe(false);
    expect(vaiParaN8n({ ...cfg, segredo: '' }, '5546988166051')).toBe(false);
    expect(vaiParaN8n(null, '5546988166051')).toBe(false);
  });

  it('lê uma vez e usa o cache por 60 s; falha de leitura = sem desvio', async () => {
    const c = cliente({ ativo: true, entrada_url: cfg.url, segredo: 's', telefones: cfg.telefones });
    await carregarDesvioN8n(c, 1_000);
    await carregarDesvioN8n(c, 30_000);
    expect(c.leituras).toBe(1);
    await carregarDesvioN8n(c, 70_000);
    expect(c.leituras).toBe(2);
    _limparCacheDesvioN8n();
    expect(await carregarDesvioN8n(cliente(null, true))).toBeNull();
  });
});
