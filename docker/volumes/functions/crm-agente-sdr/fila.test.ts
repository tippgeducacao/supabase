import { describe, expect, it } from 'vitest';
import {
  chaveJanelaAberta,
  chaveResgateTemplate,
  chaveTemplate,
  concorrenciaWorker,
  enfileirarAteTeto,
  limiteWorker,
} from './fila';

describe('política da fila de follow-up', () => {
  it('deduplica a janela aberta pela mensagem âncora e pelo estágio', () => {
    const a = chaveJanelaAberta('551199@s.whatsapp.net', 2, '2026-08-13T10:00:00Z');
    const b = chaveJanelaAberta('551199@s.whatsapp.net', 2, '2026-08-13T10:00:00.000Z');
    const c = chaveJanelaAberta('551199@s.whatsapp.net', 3, '2026-08-13T10:00:00Z');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('deduplica template por toque e âncora', () => {
    expect(chaveTemplate('lead', 1, '2026-08-01T00:00:00Z'))
      .toBe('template:lead:1:2026-08-01T00:00:00.000Z');
    expect(chaveTemplate('lead', 2, '2026-08-01T00:00:00Z'))
      .not.toBe(chaveTemplate('lead', 1, '2026-08-01T00:00:00Z'));
  });

  it('usa o dia de Brasília na chave diária de resgate', () => {
    expect(chaveResgateTemplate('lead', new Date('2026-08-14T01:30:00Z')))
      .toBe('template-resgate:lead:2026-08-13');
  });

  // 09 e 10/10/2026: 15 leads de teste já enfileirados ocupavam as 10 vagas de todo tick.
  it('o teto conta só o que entrou na fila: quem já está lá não gasta vaga', async () => {
    const jaNaFila = new Set(Array.from({ length: 15 }, (_, i) => `teste-${i}`));
    const lotes: number[] = [];
    const banco = {
      from: () => ({
        upsert: (linhas: { dedupe_key: string }[]) => ({
          select: () => {
            lotes.push(linhas.length);
            const novas = linhas.filter((l) => !jaNaFila.has(l.dedupe_key));
            novas.forEach((l) => jaNaFila.add(l.dedupe_key));
            return Promise.resolve({ data: novas.map((_, id) => ({ id })), error: null });
          },
        }),
      }),
    };
    const item = (chave: string) => ({
      tipo: 'janela_aberta' as const, remotejid: chave, toque: 1,
      referencia_em: '2026-10-10T12:00:00.000Z', dedupe_key: chave, payload: {},
    });
    const itens = [
      ...Array.from({ length: 15 }, (_, i) => item(`teste-${i}`)),
      ...Array.from({ length: 17 }, (_, i) => item(`real-${i}`)),
    ];
    expect(await enfileirarAteTeto(banco, itens, 10)).toBe(10);
    // Os 10 primeiros reais entram, na ordem; os 7 restantes ficam para o próximo tick.
    expect([...jaNaFila].filter((c) => c.startsWith('real-'))).toEqual(Array.from({ length: 10 }, (_, i) => `real-${i}`));
    expect(lotes).toEqual([10, 10, 5]);
    expect(await enfileirarAteTeto(banco, itens, 10)).toBe(7);
    expect(await enfileirarAteTeto(banco, itens, 10)).toBe(0);
  });

  it('mantém micro-lotes mesmo quando o chamador pede um lote grande', () => {
    expect(limiteWorker('janela_aberta', 200)).toBe(5);
    expect(limiteWorker('template', 200)).toBe(10);
    expect(concorrenciaWorker('janela_aberta', 5)).toBe(5);
    expect(concorrenciaWorker('template', 10)).toBe(3);
  });
});
