import { beforeAll, describe, expect, it, vi } from 'vitest';

let autorizarN8n: typeof import('./rotasN8n').autorizarN8n;
let ehAcaoN8n: typeof import('./rotasN8n').ehAcaoN8n;
let tratarMidiaN8n: typeof import('./rotasN8n').tratarMidiaN8n;
let r: typeof import('./rotasN8n');
let chamarAnthropic: typeof import('./agente').chamarAnthropic;
let toolConcluida: typeof import('./encerramento').toolConcluida;

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  r = await import('./rotasN8n');
  ({ autorizarN8n, ehAcaoN8n, tratarMidiaN8n } = r);
  ({ chamarAnthropic } = await import('./agente'));
  ({ toolConcluida } = await import('./encerramento'));
});

const cfg = { ativo: true, url: 'https://n8n/webhook/sdr-luna/entrada', segredo: 'segredo-certo', telefones: ['5546988166051'] };

describe('rotas do agente no n8n', () => {
  it('só aceita ação conhecida', () => {
    expect(ehAcaoN8n('midia')).toBe(true);
    expect(ehAcaoN8n('rodada')).toBe(true);
    expect(ehAcaoN8n('ferramenta')).toBe(true);
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

  it('a Luna sai pelo webhook do n8n, com o segredo no cabeçalho; o resto do provedor é o mesmo', async () => {
    const luna = { nome: 'openai', formato: 'openai' as const, base: 'https://api.openai.com', chave: 'sk-x', modelo: 'gpt-5.6-luna', esforco: 'high' };
    const viaN8n = r.provedorPeloN8n(luna, { ...cfg, url: 'https://n8n/webhook/sdr-luna/entrada/' });
    expect(viaN8n).toMatchObject({ base: 'https://n8n/webhook/sdr-luna', modelo: 'gpt-5.6-luna', esforco: 'high', chave: 'n8n',
      cabecalhos: { 'x-ppg-sdr-segredo': 'segredo-certo' } });
    // Claude (formato anthropic) não muda: o n8n só atende a Luna.
    const claude = { nome: 'deepseek', formato: 'anthropic' as const, base: 'b', chave: 'c' };
    expect(r.provedorPeloN8n(claude, cfg)).toBe(claude);

    const transporte = vi.fn(async () => new Response(JSON.stringify({ output: [], usage: {} }), { status: 200 }));
    vi.stubGlobal('fetch', transporte);
    await chamarAnthropic({ model: 'x', max_tokens: 10, system: [], messages: [{ role: 'user', content: 'oi' }] }, {}, viaN8n, 5_000);
    const [url, init] = transporte.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://n8n/webhook/sdr-luna/v1/responses');
    expect((init.headers as Record<string, string>)['x-ppg-sdr-segredo']).toBe('segredo-certo');
    expect(JSON.parse(String(init.body)).model).toBe('gpt-5.6-luna');
  });

  it('ctx vai e volta em JSON (o Map de materiais inclusive) e só o que a ferramenta pode mudar volta', () => {
    const ctx: any = { remotejid: '5546988166051@s.whatsapp.net', telefone: '5546988166051', waAccountId: 'conta', leadId: 'l', oportunidadeId: null,
      enviosMateriais: new Map([['k', { ok: true }]]) };
    const ida = JSON.parse(JSON.stringify(r.ctxParaJson(ctx)));
    expect(ida.enviosMateriais).toEqual([['k', { ok: true }]]);
    const volta = r.ctxDeJson({ ...ida, telefone: '5511999999999', waAccountId: 'outra', compatibilidadeIndisponivel: true,
      enviosMateriais: [['k', { ok: true }], ['k2', { ok: false }]] })!;
    expect(volta.enviosMateriais).toBeInstanceOf(Map);
    r.aplicarMudancasDoCtx(ctx, volta);
    expect(ctx.compatibilidadeIndisponivel).toBe(true);
    expect(ctx.enviosMateriais.size).toBe(2);
    expect(ctx.telefone).toBe('5546988166051'); // telefone e conta nunca vêm do n8n
    expect(ctx.waAccountId).toBe('conta');
    expect(r.ctxDeJson({ telefone: 'x' })).toBeNull();
  });

  it('ferramenta pelo n8n: devolve o output tratado com o id da chamada; falha vira erro que não conta como feita', async () => {
    const ctx: any = { remotejid: '5546988166051@s.whatsapp.net', telefone: '5546988166051', waAccountId: null, leadId: null, oportunidadeId: null };
    const chamada = { id: 'call_1', name: 'pausa_ia', input: { motivo: 'x' } };
    const ok = vi.fn(async () => new Response(JSON.stringify({ output: { id: 'outro', resultado: 'pausado' }, ctx: { ...ctx, perguntaFormacaoPendente: 'p?' } })));
    const out = await r.executarFerramentaPeloN8n(cfg, chamada, ctx, ok as unknown as typeof fetch);
    expect(out).toEqual({ id: 'call_1', resultado: 'pausado' });
    expect(ctx.perguntaFormacaoPendente).toBe('p?');
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://n8n/webhook/sdr-luna/ferramenta');
    expect(JSON.parse(String(init.body)).chamada).toEqual(chamada);

    const falha = vi.fn(async () => new Response('x', { status: 500 }));
    const erro = await r.executarFerramentaPeloN8n(cfg, chamada, ctx, falha as unknown as typeof fetch);
    expect(erro).toMatchObject({ id: 'call_1', status: 'erro' });
    expect(toolConcluida(erro)).toBe(false);
  });

  it('lote do n8n vira itens do buffer, com conta/persona do lote quando a mensagem não traz', () => {
    const lote = { remotejid: '5546988166051@s.whatsapp.net', telefone: '554688166051', wa_account_id: 'conta', agente_ia_persona: 'qualificador',
      lead_id: 'lead', oportunidade_id: 'op',
      mensagens: [{ id: 'm1', conteudo: 'oi', timestamp: 1 }, { id: 'm2', conteudo: 'foto', arquivo: 'descrição', wa_account_id: 'outra' }, null] };
    const itens = r.itensDoLoteN8n(lote);
    expect(itens).toEqual([
      { mensagem: 'oi', msg_id: 'm1', timestamp: 1, wa_account_id: 'conta', agente_ia_persona: 'qualificador', lead_id: 'lead', oportunidade_id: 'op' },
      { mensagem: 'foto', arquivo: 'descrição', msg_id: 'm2', timestamp: null, wa_account_id: 'outra', agente_ia_persona: 'qualificador', lead_id: 'lead', oportunidade_id: 'op' },
    ]);
    expect(r.payloadDaMensagem(lote, itens[0])).toMatchObject({ direcao: 'inbound', from_me: false, id: 'm1', conteudo: 'oi',
      remotejid: lote.remotejid, telefone: lote.telefone, wa_account_id: 'conta' });
    expect(r.itensDoLoteN8n({})).toEqual([]);
  });

  it('remotejid e telefone do mesmo número, com ou sem o 9º dígito', () => {
    expect(r.mesmoTelefone('5546988166051@s.whatsapp.net', '554688166051')).toBe(true);
    expect(r.mesmoTelefone('5546988166051@s.whatsapp.net', '5511999998888')).toBe(false);
    expect(r.mesmoTelefone('', '')).toBe(false);
  });
});
