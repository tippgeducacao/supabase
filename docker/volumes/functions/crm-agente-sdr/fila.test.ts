import { describe, expect, it } from 'vitest';
import {
  chaveJanelaAberta,
  chaveResgateTemplate,
  chaveTemplate,
  concorrenciaWorker,
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

  it('mantém micro-lotes mesmo quando o chamador pede um lote grande', () => {
    expect(limiteWorker('janela_aberta', 200)).toBe(5);
    expect(limiteWorker('template', 200)).toBe(10);
    expect(concorrenciaWorker('janela_aberta', 5)).toBe(5);
    expect(concorrenciaWorker('template', 10)).toBe(3);
  });
});
