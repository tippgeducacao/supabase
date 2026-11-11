import { describe, expect, it } from 'vitest';
import { CANVA_CALLBACK_URI, gerarPkce, stateNovo, tituloBase64, urlDeAutorizacao } from './canvaApi';

const deB64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe('canvaApi — Abrir com Canva (11/11/2026)', () => {
  it('PKCE: verifier no formato do RFC e challenge = SHA-256 base64url do verifier', async () => {
    const { verifier, challenge } = await gerarPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const esperado = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(esperado);
  });

  it('state tem 64 hex (é o que o callback aceita)', () => {
    expect(stateNovo()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('URL de autorização: S256, escopos com %20 e o callback cadastrado', () => {
    const u = urlDeAutorizacao('cid', 'st', 'ch');
    expect(u.startsWith('https://www.canva.com/api/oauth/authorize?')).toBe(true);
    expect(u).toContain('code_challenge_method=S256');
    expect(u).toContain('scope=design%3Acontent%3Awrite%20profile%3Aread');
    expect(u).not.toContain('+');
    expect(new URL(u).searchParams.get('redirect_uri')).toBe(CANVA_CALLBACK_URI);
  });

  it('título: UTF-8 em base64, acento preservado, corte em 50 caracteres', () => {
    expect(deB64(tituloBase64('Proposta PROP-2026-0008 · Formação de Líderes'))).toBe('Proposta PROP-2026-0008 · Formação de Líderes');
    expect(Array.from(deB64(tituloBase64('Ç'.repeat(80)))).length).toBe(50);
    expect(deB64(tituloBase64('   '))).toBe('Proposta PPGVET');
  });
});
