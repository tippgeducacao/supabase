import { describe, expect, it } from 'vitest';
import { camposFaltando, corpoParaFicha, ehTeste, escolherRota, etiquetaDoPayload } from './roteador';

const rota = (site: string, formulario: string, pos: string, evento = '', id = `${site}/${formulario}/${pos}/${evento}`) =>
  ({ site, formulario, pos, evento, curso: null, integration_id: id });

describe('roteador dos sites', () => {
  const rotas = [
    rota('*', '*', '*', '*', 'reserva'),
    rota('ppgvet', 'pos', 'mifv', '', 'form-pos-mifv'),
    rota('escola', 'pos', 'sa', '', 'form-lp-sa'),
    rota('*', 'pos', 'crcv', '', 'crcv-geral'),
    rota('ppgvet', 'evento', 'rngb', 'simposio', 'rngb-simposio'),
  ];
  const escolher = (p: Record<string, unknown>) => escolherRota(rotas, etiquetaDoPayload(p))?.integration_id;

  it('acha a rota exata, sem diferenciar maiúscula nem espaço', () => {
    expect(escolher({ site: 'PPGVET ', formulario: 'pos', pos: 'MIFV' })).toBe('form-pos-mifv');
    expect(escolher({ site: 'escola', formulario: 'pos', pos: 'sa' })).toBe('form-lp-sa');
  });

  it('a mesma pós em outro site não pega a rota do site errado', () => {
    expect(escolher({ site: 'escola', formulario: 'pos', pos: 'mifv' })).toBe('reserva');
  });

  it('curinga de site vale para todos; evento só casa o próprio evento', () => {
    expect(escolher({ site: 'ppg', formulario: 'pos', pos: 'crcv' })).toBe('crcv-geral');
    expect(escolher({ site: 'ppgvet', formulario: 'evento', pos: 'rngb', evento: 'simposio' })).toBe('rngb-simposio');
    expect(escolher({ site: 'ppgvet', formulario: 'evento', pos: 'rngb', evento: 'outro' })).toBe('reserva');
  });

  it('pós nova sem rota cai na reserva; sem reserva, null', () => {
    expect(escolher({ site: 'ppgvet', formulario: 'pos', pos: 'nova' })).toBe('reserva');
    expect(escolherRota(rotas.slice(1), etiquetaDoPayload({ site: 'x', formulario: 'pos', pos: 'nova' }))).toBeNull();
  });

  it('teste pela flag ou pelo e-mail reservado', () => {
    expect(ehTeste({ teste: true })).toBe(true);
    expect(ehTeste({ teste: 'true' })).toBe(true);
    expect(ehTeste({ email: 'QA@Teste.PPGVET.com.br' })).toBe(true);
    expect(ehTeste({ email: 'maria@gmail.com' })).toBe(false);
    expect(ehTeste({ email: 'x@naoteste.ppgvet.com.br.evil' })).toBe(false);
  });

  it('newsletter não exige WhatsApp; pós exige', () => {
    expect(camposFaltando({ site: 'blog', formulario: 'newsletter', nome: 'a', email: 'b' })).toEqual([]);
    expect(camposFaltando({ site: 'ppgvet', formulario: 'pos', nome: 'a', email: 'b' })).toEqual(['whatsapp']);
  });

  it('a ficha recebe os nomes antigos e a trava de reenvio, sem a flag de teste', () => {
    const corpo = corpoParaFicha(
      { teste: false, nome: 'Maria', email: 'm@x.com', profissao: 'Zootecnista', referrer: 'https://www.google.com/', id_envio: 'abc', cidade: 'Ampére' },
      { curso: 'Medicina Integrativa' },
    );
    expect(corpo).toMatchObject({
      eu_sou: 'Zootecnista', curso: 'Medicina Integrativa', Nome: 'Maria', E_mail: 'm@x.com',
      Referral_Source: 'https://www.google.com/', dados_completos: { id: 'abc' }, Cidade_do_usuario: 'Ampére',
    });
    expect(corpo).not.toHaveProperty('teste');
  });
});
