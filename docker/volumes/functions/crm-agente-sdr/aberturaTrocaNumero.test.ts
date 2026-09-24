import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Jornada } from './fichaAtendimento';
import { registrarNaJornada } from './fichaAtendimento';
import { ABERTURAS_TROCA_NUMERO, concluirAbertura, enviarComAberturaNumero, reservarAbertura } from './aberturaTrocaNumero';
import { detectarTrocaDeNumero, sinalInerte } from './trocaDeNumero';

vi.mock('./fichaAtendimento', () => ({ registrarNaJornada: vi.fn() }));
const agora = '2026-09-24T15:00:00Z';
const sinal = (de = 'A', para = 'B', minuto = 1) => ({
  ...sinalInerte(para, 1, 'trocou'), trocou: true, contaAnterior: de,
  ultimaFalaAnteriorEm: `2026-09-24T14:${String(minuto).padStart(2, '0')}:00Z`,
  ultimaFalaAnteriorId: `${de}-${minuto}`,
});

describe('abertura por ocorrência de troca', () => {
  it('A→B→A→B→C alterna três frases e permite voltar a contas já apresentadas', () => {
    let jornada: Jornada = { coleta: { graduacao: 'Medicina Veterinária' } };
    const variacoes: number[] = [];
    for (const [i, [de, para]] of [['A', 'B'], ['B', 'A'], ['A', 'B'], ['B', 'C']].entries()) {
      const r = reservarAbertura(jornada, sinal(de, para, i + 1), `rodada-${i}`, agora);
      expect(r.registro).not.toBeNull();
      variacoes.push(r.registro!.variacao);
      jornada = concluirAbertura(r.jornada, r.registro!, 'enviada', agora);
      expect(reservarAbertura(jornada, sinal(de, para, i + 1), 'retry', agora).registro).toBeNull();
    }
    expect(variacoes).toEqual([0, 1, 2, 0]);
    expect(jornada.coleta?.graduacao).toBe('Medicina Veterinária');
    expect(jornada.aberturas_numero?.eventos).toHaveLength(4);
  });
  it('falha comprovada permite repetir a tentativa com a mesma variação', () => {
    const inicial = reservarAbertura({}, sinal(), 'primeira', agora);
    const liberada = concluirAbertura(inicial.jornada, inicial.registro!, 'pendente', agora);
    const retry = reservarAbertura(liberada, sinal(), 'segunda', agora);
    expect(retry.registro).toMatchObject({ variacao: 0, interacao_id: 'segunda' });
    expect(retry.jornada.aberturas_numero?.sequencia).toBe(1);
    // Uma resposta atrasada da primeira tentativa não altera a segunda.
    expect(concluirAbertura(retry.jornada, inicial.registro!, 'incerta', agora)).toEqual(retry.jornada);
  });
  it.each(['reservada', 'incerta', 'enviada'] as const)('estado %s impede reapresentar na mesma ocorrência', estado => {
    const r = reservarAbertura({}, sinal(), 'uma', agora);
    const j = concluirAbertura(r.jornada, r.registro!, estado, agora);
    expect(reservarAbertura(j, sinal(), 'outra', agora).registro).toBeNull();
  });
  it('turno comum e sinal antigo não criam abertura', () => {
    expect(reservarAbertura({}, sinalInerte('A', 1, 'conversa_continua_aqui'), 'r', agora).registro).toBeNull();
    const recente = reservarAbertura({}, sinal('A', 'B', 20), 'r', agora);
    expect(reservarAbertura(recente.jornada, sinal('C', 'B', 5), 'r2', agora).registro).toBeNull();
  });
  it('inbounds sem resposta não escondem a abertura; template isolado não muda a conta da conversa', () => {
    const linhas = [
      { wa_account_id: 'A', direcao: 'outbound', tipo: 'text', created_at: agora, wa_message_id: 'fala-A' },
      { wa_account_id: 'B', direcao: 'outbound', tipo: 'template', created_at: '2026-09-24T15:01:00Z' },
      { wa_account_id: 'B', direcao: 'inbound', tipo: 'text', created_at: '2026-09-24T15:02:00Z' },
      { wa_account_id: 'B', direcao: 'inbound', tipo: 'text', created_at: '2026-09-24T15:03:00Z' },
    ];
    expect(detectarTrocaDeNumero(linhas, 'B', { somenteSaidas: true })).toMatchObject({ trocou: true, ultimaFalaAnteriorId: 'fala-A' });
    expect(detectarTrocaDeNumero(linhas, 'A', { somenteSaidas: true }).trocou).toBe(false);
  });
});

describe('registro durável integrado ao envio', () => {
  let jornada: Jornada;
  const registrar = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks(); jornada = {};
    vi.mocked(registrarNaJornada).mockImplementation(async (_b, _t, mutar) => { jornada = mutar(jornada); return jornada; });
  });
  const args = () => ({ banco: {} as Parameters<typeof registrarNaJornada>[0], telefone: '5546999999999', interacaoId: 'rodada', sinal: sinal(), texto: 'qual área você quer aprofundar?', registrar });
  it('confirma no primeiro aceite e o follow-up seguinte não repete a abertura', async () => {
    const enviar = vi.fn(async (_texto, controle) => {
      expect(jornada.aberturas_numero?.eventos[0].estado).toBe('reservada');
      await controle?.primeiroAceite();
      return { aceitos: 1, canal: 'audio' as const, estado: 'aceito' as const };
    });
    const r = await enviarComAberturaNumero({ ...args(), enviar });
    expect(r.texto).toBe(`${ABERTURAS_TROCA_NUMERO[0]}\n\n${args().texto}`);
    expect(jornada.aberturas_numero?.eventos[0].estado).toBe('enviada');
    enviar.mockImplementation(async () => ({ aceitos: 1, canal: 'audio', estado: 'aceito' }));
    const seguinte = await enviarComAberturaNumero({ ...args(), interacaoId: 'followup', enviar });
    expect(seguinte.texto).toBe(args().texto);
  });
  it.each(['cancelado', 'falhou'] as const)('envio %s mantém aviso pendente, sem consumir outra frase', async estado => {
    await enviarComAberturaNumero({ ...args(), enviar: async () => ({ aceitos: 0, canal: 'texto', estado }) });
    expect(jornada.aberturas_numero?.eventos[0].estado).toBe('pendente');
    expect(jornada.aberturas_numero?.sequencia).toBe(1);
  });
  it('transporte incerto não autoriza duplicar apresentação', async () => {
    await enviarComAberturaNumero({ ...args(), enviar: async () => ({ aceitos: 0, canal: 'audio', estado: 'desconhecido' }) });
    expect(jornada.aberturas_numero?.eventos[0].estado).toBe('incerta');
  });
  it('queda depois de parte aceita preserva confirmação; queda antes mantém incerteza', async () => {
    const erro = new Error('conexão encerrada');
    await expect(enviarComAberturaNumero({ ...args(), enviar: async () => { throw erro; } })).rejects.toThrow(erro);
    expect(jornada.aberturas_numero?.eventos[0].estado).toBe('incerta');
    jornada = {};
    await expect(enviarComAberturaNumero({ ...args(), enviar: async (_texto, controle) => {
      await controle?.primeiroAceite(); throw erro;
    } })).rejects.toThrow(erro);
    expect(jornada.aberturas_numero?.eventos[0].estado).toBe('enviada');
  });
  it('memória indisponível preserva resposta sem aviso não controlado', async () => {
    vi.mocked(registrarNaJornada).mockRejectedValue(new Error('offline'));
    const enviar = vi.fn(async () => ({ aceitos: 1, canal: 'texto' as const, estado: 'aceito' as const }));
    await enviarComAberturaNumero({ ...args(), enviar });
    expect(enviar).toHaveBeenCalledExactlyOnceWith(args().texto);
  });
});
