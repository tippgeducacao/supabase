import { beforeAll, describe, expect, it, vi } from 'vitest';

let autorizarN8n: typeof import('./rotasN8n').autorizarN8n;
let ehAcaoN8n: typeof import('./rotasN8n').ehAcaoN8n;
let tratarMidiaN8n: typeof import('./rotasN8n').tratarMidiaN8n;

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  ({ autorizarN8n, ehAcaoN8n, tratarMidiaN8n } = await import('./rotasN8n'));
});

const cfg = { ativo: true, url: 'https://n8n/webhook/sdr-luna/entrada', segredo: 'segredo-certo', telefones: ['5546988166051'] };

describe('rotas do agente no n8n', () => {
  it('só aceita ação conhecida', () => {
    expect(ehAcaoN8n('midia')).toBe(true);
    expect(ehAcaoN8n('executar')).toBe(false);
    expect(ehAcaoN8n(null)).toBe(false);
  });

  it('segredo errado, ausente ou desvio desligado = 401', () => {
    expect(autorizarN8n(cfg, 'errado', '5546988166051')).toEqual({ ok: false, status: 401, erro: 'unauthorized' });
    expect(autorizarN8n(cfg, null, '5546988166051')).toMatchObject({ status: 401 });
    expect(autorizarN8n({ ...cfg, ativo: false }, 'segredo-certo', '5546988166051')).toMatchObject({ status: 401 });
    expect(autorizarN8n({ ...cfg, segredo: '' }, '', '5546988166051')).toMatchObject({ status: 401 });
    expect(autorizarN8n(null, 'segredo-certo', '5546988166051')).toMatchObject({ status: 401 });
  });

  it('segredo certo mas lead fora da lista de teste = 403 (lead de verdade não passa)', () => {
    expect(autorizarN8n(cfg, 'segredo-certo', '5511999998888')).toEqual({ ok: false, status: 403, erro: 'telefone_fora_do_teste' });
  });

  it('segredo certo e telefone de teste, com ou sem o 9º dígito', () => {
    expect(autorizarN8n(cfg, 'segredo-certo', '554688166051@s.whatsapp.net')).toEqual({ ok: true });
  });

  it('texto volta como veio, com o tipo (sem chamar o Gemini)', async () => {
    expect(await tratarMidiaN8n({ tipo: 'text', conteudo: 'opa, tudo bem' })).toEqual({ tipo: 'text', mensagem: 'opa, tudo bem' });
    expect(await tratarMidiaN8n({ conteudo: 'sem tipo' })).toEqual({ tipo: 'text', mensagem: 'sem tipo' });
  });
});
