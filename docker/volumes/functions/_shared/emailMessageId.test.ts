import { describe, expect, it } from 'vitest';
import { extrairMessageIds, headersDeMensagemGmail, montarHeadersResposta, normalizarMessageId } from './emailMessageId';

describe('identidade RFC de mensagem', () => {
  it('normaliza delimitadores e domínio sem mudar a parte local', () => {
    expect(normalizarMessageId('  AbC@EXAMPLE.COM ')).toBe('<AbC@example.com>');
    expect(normalizarMessageId('<AbC@example.com>')).toBe('<AbC@example.com>');
  });
  it.each([null, undefined, 42, '', 'gmail-api-id', 'resend-uuid', '<a@b> <c@d>', '<a@b>\r\nBcc: alvo@example.com', '<a b@c>', '<a@@b>'])('não inventa nem aceita injeção de header: %s', (valor) => {
    expect(normalizarMessageId(valor)).toBeNull();
  });
  it('extrai a cadeia dobrada sem duplicar o pai e descarta lixo externo', () => {
    expect(montarHeadersResposta('<Pai@EXAMPLE.COM>', '<raiz@x>\r\n\t<Pai@example.com> <raiz@x>')).toEqual({
      inReplyTo: '<Pai@example.com>', references: '<raiz@x> <Pai@example.com>',
    });
    expect(extrairMessageIds('<ok@x>\r\nBcc: fora@x')).toEqual(['<ok@x>']);
  });
  it('sem Message-ID real não transforma References ou Gmail ID em pai', () => {
    expect(montarHeadersResposta('19ff123456', '<raiz@x>')).toBeNull();
  });
  it('lê os headers oficiais independentemente de caixa', () => {
    expect(headersDeMensagemGmail({ headers: [{ name: 'Message-ID', value: '<real@X>' }, { name: 'REFERENCES', value: '<pai@x>' }] }))
      .toEqual({ messageId: '<real@x>', references: '<pai@x>' });
    expect(headersDeMensagemGmail(null)).toEqual({ messageId: null, references: null });
  });
});
