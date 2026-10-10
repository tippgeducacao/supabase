import { describe, expect, it } from 'vitest';
import { alertaDeFalhaDeConta, statusProvaEntrega } from './alertaEntrega';

describe('alertaDeFalhaDeConta', () => {
  it('131042 (pagamento) acende o alerta da conta', () => {
    // Erro real da BM02 em 10/10/2026.
    const a = alertaDeFalhaDeConta([{ code: 131042, title: 'Business eligibility payment issue' }]);
    expect(a?.codigo).toBe('131042');
    expect(a?.titulo).toMatch(/pagamento/);
  });

  it('bloqueio da conta (131031 e 368) também acende', () => {
    expect(alertaDeFalhaDeConta([{ code: 131031 }])?.codigo).toBe('131031');
    expect(alertaDeFalhaDeConta([{ code: '368' }])?.codigo).toBe('368');
  });

  it('falha de UM destinatário não acende faixa vermelha', () => {
    expect(alertaDeFalhaDeConta([{ code: 131026, title: 'Message undeliverable' }])).toBeNull();
    expect(alertaDeFalhaDeConta([{ code: 131047 }])).toBeNull();
    expect(alertaDeFalhaDeConta([{ code: 131049 }])).toBeNull();
  });

  it('payload sem erros ou malformado não quebra', () => {
    expect(alertaDeFalhaDeConta(undefined)).toBeNull();
    expect(alertaDeFalhaDeConta({ code: 131042 })).toBeNull();
    expect(alertaDeFalhaDeConta([null])).toBeNull();
  });

  it('descrição é fixa por código (o dedup do alerta aberto depende dela)', () => {
    expect(alertaDeFalhaDeConta([{ code: 131042, message: 'x' }])?.descricao)
      .toBe(alertaDeFalhaDeConta([{ code: 131042, message: 'y' }])?.descricao);
  });
});

describe('statusProvaEntrega', () => {
  it('só entregue/lida provam que a conta voltou', () => {
    expect(statusProvaEntrega('delivered')).toBe(true);
    expect(statusProvaEntrega('read')).toBe(true);
    expect(statusProvaEntrega('sent')).toBe(false);
    expect(statusProvaEntrega('failed')).toBe(false);
  });
});
