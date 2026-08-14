// Testes das réguas PURAS do cliente Resend (rodam no vitest, sem runtime Deno).
// Cobrem o que quebra silenciosamente em produção: erro devolvido no corpo em vez de
// exceção, retry de 429/5xx, idempotência e rejeição de webhook mal assinado.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// O módulo lê Deno.env dentro das funções (nunca no topo), então basta um stub.
const envFake: Record<string, string> = {
  RESEND_API_KEY: 'chave-de-teste',
  EMAIL_UNSUB_SECRET: 'segredo-de-descadastro',
};
(globalThis as any).Deno = { env: { get: (k: string) => envFake[k] } };

const {
  assinaturaSvixValida,
  assinarDescadastro,
  chaveIdempotencia,
  conferirDescadastro,
  enviarEmail,
  formatarFrom,
  tagSegura,
} = await import('./resend.ts');

const EMAIL_BASE = {
  from: 'PPG <no-reply@mail.exemplo.com>',
  to: 'aluno@exemplo.com',
  subject: 'Assunto',
  html: '<p>oi</p>',
};

/** Resposta fake no formato que o fetch devolve. */
function resposta(status: number, corpo: unknown) {
  return new Response(JSON.stringify(corpo), { status });
}

describe('cliente Resend — envio', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete envFake.RESEND_DRY_RUN;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Avança os timers do backoff enquanto a promise do envio está pendente. */
  async function correrComBackoff<T>(p: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return await p;
  }

  it('devolve ok e o id quando o Resend aceita', async () => {
    const fetchFake = vi.fn().mockResolvedValue(resposta(200, { id: 'email_123' }));
    vi.stubGlobal('fetch', fetchFake);

    const r = await correrComBackoff(enviarEmail(EMAIL_BASE));

    expect(r.ok).toBe(true);
    expect(r.data?.id).toBe('email_123');
    expect(r.tentativas).toBe(1);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('trata erro devolvido NO CORPO — a API não lança exceção', async () => {
    const fetchFake = vi.fn().mockResolvedValue(
      resposta(422, { name: 'validation_error', message: 'domínio não verificado' }),
    );
    vi.stubGlobal('fetch', fetchFake);

    const r = await correrComBackoff(enviarEmail(EMAIL_BASE));

    // O perigo real é assumir sucesso: ok tem que ser false e a mensagem preservada.
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.codigo).toBe('validation_error');
    expect(r.erro).toContain('domínio não verificado');
    // 422 é erro do chamador: repetir só repetiria o erro.
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('repete em 429 com backoff e devolve sucesso quando a segunda tentativa passa', async () => {
    const fetchFake = vi.fn()
      .mockResolvedValueOnce(resposta(429, { name: 'rate_limit_exceeded', message: 'devagar' }))
      .mockResolvedValueOnce(resposta(200, { id: 'email_apos_retry' }));
    vi.stubGlobal('fetch', fetchFake);

    const r = await correrComBackoff(enviarEmail(EMAIL_BASE));

    expect(fetchFake).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    expect(r.data?.id).toBe('email_apos_retry');
    expect(r.tentativas).toBe(2);
  });

  it('desiste depois do teto de tentativas e sinaliza rateLimited para o chamador pausar', async () => {
    // mockImplementation, não mockResolvedValue: o corpo de um Response só pode ser
    // lido UMA vez, então reusar a mesma instância faria a 2ª tentativa falhar por
    // "body already read" e mascarar o status real.
    const fetchFake = vi.fn().mockImplementation(() => resposta(429, { name: 'rate_limit_exceeded' }));
    vi.stubGlobal('fetch', fetchFake);

    const r = await correrComBackoff(enviarEmail(EMAIL_BASE));

    expect(fetchFake).toHaveBeenCalledTimes(3);
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
  });

  it('repete em 5xx', async () => {
    const fetchFake = vi.fn()
      .mockResolvedValueOnce(resposta(503, { message: 'indisponível' }))
      .mockResolvedValueOnce(resposta(200, { id: 'ok' }));
    vi.stubGlobal('fetch', fetchFake);

    await correrComBackoff(enviarEmail(EMAIL_BASE));
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it('NÃO repete invalid_idempotent_request — mesma chave com payload diferente é bug de quem chamou', async () => {
    const fetchFake = vi.fn().mockResolvedValue(
      resposta(409, { name: 'invalid_idempotent_request', message: 'payload diferente' }),
    );
    vi.stubGlobal('fetch', fetchFake);

    const r = await correrComBackoff(enviarEmail(EMAIL_BASE, { idempotencyKey: 'campanha/1' }));

    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(r.codigo).toBe('invalid_idempotent_request');
  });

  it('repete concurrent_idempotent_requests — a primeira ainda está em voo', async () => {
    const fetchFake = vi.fn()
      .mockResolvedValueOnce(resposta(409, { name: 'concurrent_idempotent_requests' }))
      .mockResolvedValueOnce(resposta(200, { id: 'ok' }));
    vi.stubGlobal('fetch', fetchFake);

    await correrComBackoff(enviarEmail(EMAIL_BASE, { idempotencyKey: 'campanha/1' }));
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it('manda o header Idempotency-Key quando recebe a chave', async () => {
    const fetchFake = vi.fn().mockResolvedValue(resposta(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchFake);

    await correrComBackoff(enviarEmail(EMAIL_BASE, { idempotencyKey: 'password-reset/user_123' }));

    const headers = fetchFake.mock.calls[0][1].headers;
    expect(headers['Idempotency-Key']).toBe('password-reset/user_123');
  });

  it('corta a chave de idempotência em 256 chars (limite do Resend)', async () => {
    const fetchFake = vi.fn().mockResolvedValue(resposta(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchFake);

    await correrComBackoff(enviarEmail(EMAIL_BASE, { idempotencyKey: 'a'.repeat(400) }));

    expect(fetchFake.mock.calls[0][1].headers['Idempotency-Key']).toHaveLength(256);
  });

  it('no modo seco não chama a API e devolve um id simulado', async () => {
    envFake.RESEND_DRY_RUN = 'true';
    const fetchFake = vi.fn();
    vi.stubGlobal('fetch', fetchFake);

    const r = await enviarEmail(EMAIL_BASE);

    expect(fetchFake).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.data?.id).toMatch(/^dry-run-/);
  });
});

describe('chave de idempotência', () => {
  it('usa o formato <tipo>/<id> e é estável para a mesma entidade', () => {
    expect(chaveIdempotencia('password-reset', 'user_123')).toBe('password-reset/user_123');
    expect(chaveIdempotencia('campanha', 'envio_1'))
      .toBe(chaveIdempotencia('campanha', 'envio_1'));
    expect(chaveIdempotencia('campanha', 'envio_1'))
      .not.toBe(chaveIdempotencia('campanha', 'envio_2'));
  });
});

describe('cabeçalho From e tags', () => {
  it('sem nome, manda só o endereço', () => {
    expect(formatarFrom(null, 'a@b.com')).toBe('a@b.com');
  });

  it('com nome ASCII, usa aspas', () => {
    expect(formatarFrom('Secretaria', 'a@b.com')).toBe('"Secretaria" <a@b.com>');
  });

  it('com acento, codifica em RFC 2047 — acento cru no header quebra o envio', () => {
    const from = formatarFrom('Secretaria Acadêmica', 'a@b.com');
    expect(from).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b\.com>$/);
    expect(from).not.toContain('ê');
  });

  it('sanitiza tag: o Resend recusa valor não-ASCII com 422 e o e-mail inteiro não sai', () => {
    expect(tagSegura('campanha de captação')).toBe('campanha_de_capta__o');
    expect(tagSegura('abc-123_XYZ')).toBe('abc-123_XYZ');
    expect(tagSegura('x'.repeat(300))).toHaveLength(256);
  });
});

describe('descadastro (HMAC do próprio e-mail)', () => {
  it('aceita o token que ele mesmo assinou', async () => {
    const token = await assinarDescadastro('aluno@exemplo.com');
    expect(await conferirDescadastro('aluno@exemplo.com', token)).toBe(true);
  });

  it('normaliza caixa e espaços — o link não pode falhar por maiúscula', async () => {
    const token = await assinarDescadastro('aluno@exemplo.com');
    expect(await conferirDescadastro('  Aluno@Exemplo.COM ', token)).toBe(true);
  });

  it('recusa token de OUTRO e-mail — senão dava para descadastrar terceiros', async () => {
    const token = await assinarDescadastro('aluno@exemplo.com');
    expect(await conferirDescadastro('outro@exemplo.com', token)).toBe(false);
  });

  it('recusa token vazio ou adulterado', async () => {
    expect(await conferirDescadastro('aluno@exemplo.com', '')).toBe(false);
    expect(await conferirDescadastro('aluno@exemplo.com', 'f'.repeat(32))).toBe(false);
  });
});

describe('assinatura Svix do webhook', () => {
  const SEGREDO_B64 = btoa('segredo-do-webhook-resend');
  const SEGREDO = `whsec_${SEGREDO_B64}`;
  const CORPO = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e_1' } });
  const ID = 'msg_2abc';
  const TS = '1700000000';
  const AGORA = Number(TS) * 1000;

  async function assinar(id: string, ts: string, corpo: string, segredoB64: string) {
    const chave = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(segredoB64), (c) => c.charCodeAt(0)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const d = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(`${id}.${ts}.${corpo}`));
    return btoa(String.fromCharCode(...new Uint8Array(d)));
  }

  it('aceita assinatura correta', async () => {
    const sig = await assinar(ID, TS, CORPO, SEGREDO_B64);
    const ok = await assinaturaSvixValida(
      { id: ID, timestamp: TS, signature: `v1,${sig}` }, CORPO, SEGREDO, AGORA,
    );
    expect(ok).toBe(true);
  });

  it('aceita quando o header traz várias assinaturas (rotação de segredo)', async () => {
    const sig = await assinar(ID, TS, CORPO, SEGREDO_B64);
    const ok = await assinaturaSvixValida(
      { id: ID, timestamp: TS, signature: `v1,assinatura-velha v1,${sig}` }, CORPO, SEGREDO, AGORA,
    );
    expect(ok).toBe(true);
  });

  it('REJEITA assinatura inválida — senão qualquer um forja um bounce e bloqueia um endereço', async () => {
    const ok = await assinaturaSvixValida(
      { id: ID, timestamp: TS, signature: 'v1,YXNzaW5hdHVyYS1mYWxzYQ==' }, CORPO, SEGREDO, AGORA,
    );
    expect(ok).toBe(false);
  });

  it('REJEITA corpo adulterado com assinatura do corpo original', async () => {
    const sig = await assinar(ID, TS, CORPO, SEGREDO_B64);
    const adulterado = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e_1' } });
    const ok = await assinaturaSvixValida(
      { id: ID, timestamp: TS, signature: `v1,${sig}` }, adulterado, SEGREDO, AGORA,
    );
    expect(ok).toBe(false);
  });

  it('REJEITA evento fora da janela de 5 min (replay)', async () => {
    const sig = await assinar(ID, TS, CORPO, SEGREDO_B64);
    const ok = await assinaturaSvixValida(
      { id: ID, timestamp: TS, signature: `v1,${sig}` }, CORPO, SEGREDO, AGORA + 10 * 60 * 1000,
    );
    expect(ok).toBe(false);
  });

  it('REJEITA quando falta qualquer header svix', async () => {
    const sig = await assinar(ID, TS, CORPO, SEGREDO_B64);
    expect(await assinaturaSvixValida({ id: null, timestamp: TS, signature: `v1,${sig}` }, CORPO, SEGREDO, AGORA)).toBe(false);
    expect(await assinaturaSvixValida({ id: ID, timestamp: null, signature: `v1,${sig}` }, CORPO, SEGREDO, AGORA)).toBe(false);
    expect(await assinaturaSvixValida({ id: ID, timestamp: TS, signature: null }, CORPO, SEGREDO, AGORA)).toBe(false);
  });
});
