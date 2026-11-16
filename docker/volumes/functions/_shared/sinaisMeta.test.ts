import { describe, expect, it } from 'vitest';
import { sinaisMetaDe } from './sinaisMeta';

describe('sinais do navegador para a Meta', () => {
  it('guarda fbc, fbp, IP e user agent válidos', () => {
    expect(sinaisMetaDe({
      fbc: 'fb.1.1731770000000.IwAR2abcDEF_ghi-123', fbp: 'fb.1.1731700000000.123456789',
      ip: '200.1.2.3', user_agent: 'Mozilla/5.0 (iPhone)',
    })).toEqual({
      fbc: 'fb.1.1731770000000.IwAR2abcDEF_ghi-123', fbp: 'fb.1.1731700000000.123456789',
      ip_address: '200.1.2.3', user_agent: 'Mozilla/5.0 (iPhone)',
    });
  });

  it('IPv6 vale; lixo, placeholder e IP impossível não gravam', () => {
    expect(sinaisMetaDe({ ip: '2804:14c:5b:8000::1' })).toEqual({ ip_address: '2804:14c:5b:8000::1' });
    expect(sinaisMetaDe({ fbc: '{{fbc}}', fbp: 'undefined', ip: '999.1.1.1', user_agent: 'x' })).toEqual({});
    expect(sinaisMetaDe(null)).toEqual({});
  });
});
