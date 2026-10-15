import { describe, expect, it } from 'vitest';
import {
  deveEnviarTi, lerBloco, naJanelaComercial, periodoComercial, TETO_MENSAGEM, textoComercial,
  textoFeedbackTi, timeTiCompleto, type BlocoComercial, type RelatoTi,
} from './relatoriosGrupo';

const bloco = (o: Partial<BlocoComercial> = {}): BlocoComercial => ({
  comparecidas: 0, semResultado: 0, vendas: 0, vendasPos: 0, vendasRapidas: 0, ...o,
});

const relato = (o: Partial<RelatoTi> = {}): RelatoTi => ({
  nome: 'Fulano', dia_util: true, dispensado_motivo: null, registrado: false,
  descricao: null, andamento: null, anexos: 0, ...o,
});

describe('naJanelaComercial', () => {
  it('sai das 08:00 às 11:59 e em nenhuma outra hora', () => {
    expect(naJanelaComercial(7)).toBe(false);
    expect(naJanelaComercial(8)).toBe(true);
    expect(naJanelaComercial(11)).toBe(true);
    expect(naJanelaComercial(12)).toBe(false);
  });
});

describe('periodoComercial', () => {
  it('terça a sábado: ontem', () => {
    expect(periodoComercial('2026-10-15')).toEqual({ ini: '2026-10-14', fim: '2026-10-14' }); // qui
    expect(periodoComercial('2026-10-17')).toEqual({ ini: '2026-10-16', fim: '2026-10-16' }); // sáb
  });
  it('domingo não sai', () => {
    expect(periodoComercial('2026-10-18')).toBeNull();
  });
  it('segunda: sábado + domingo', () => {
    expect(periodoComercial('2026-10-19')).toEqual({ ini: '2026-10-17', fim: '2026-10-18' });
  });
});

describe('lerBloco', () => {
  it('lê o jsonb do placar e das pendências', () => {
    const b = lerBloco(
      { reunioes_comparecidas: 12, matriculas: 5, matriculas_pos: 4, matriculas_rapidas: 1, reunioes_avaliadas: 20 },
      { sem_resultado: 3, proximas: 9 },
    );
    expect(b).toEqual({ comparecidas: 12, semResultado: 3, vendas: 5, vendasPos: 4, vendasRapidas: 1 });
  });
  it('resposta vazia vira zero, não NaN', () => {
    expect(lerBloco(null, undefined)).toEqual(bloco());
  });
});

describe('textoComercial', () => {
  it('ontem em cima, semana parcial embaixo', () => {
    // Quinta 15/10 às 8h: ontem = quarta 14/10, que é o 1º dia da semana 14/10 → 20/10.
    const t = textoComercial({ ini: '2026-10-14', fim: '2026-10-14' }, '2026-10-14',
      bloco({ comparecidas: 12, semResultado: 3, vendas: 5, vendasPos: 4, vendasRapidas: 1 }),
      bloco({ comparecidas: 12, semResultado: 3, vendas: 5, vendasPos: 4, vendasRapidas: 1 }));
    expect(t).toContain('*Quarta, 14/10*');
    expect(t).toContain('✅ Reuniões comparecidas: *12*');
    expect(t).toContain('⏳ Reuniões sem resultado marcado: *3*');
    expect(t).toContain('💰 Vendas: *5* (4 pós · 1 curso/módulo)');
    expect(t).toContain('qua 14/10 a ter 20/10 (parcial, até ontem)');
    expect(t.indexOf('Quarta, 14/10')).toBeLessThan(t.indexOf('Semana comercial'));
  });
  it('na quarta de manhã a semana sai fechada', () => {
    const t = textoComercial({ ini: '2026-10-13', fim: '2026-10-13' }, '2026-10-07', bloco(), bloco());
    expect(t).toContain('*Terça, 13/10*');
    expect(t).toContain('qua 07/10 a ter 13/10 (semana fechada)');
  });
  it('segunda: o fim de semana junto', () => {
    const t = textoComercial({ ini: '2026-10-17', fim: '2026-10-18' }, '2026-10-14', bloco(), bloco());
    expect(t).toContain('📊 *Comercial — resumo do fim de semana*');
    expect(t).toContain('*Sábado, 17/10 e domingo, 18/10*');
    expect(t).toContain('qua 14/10 a ter 20/10 (parcial, até ontem)');
  });
  it('só pós: não mostra a quebra', () => {
    const t = textoComercial({ ini: '2026-10-13', fim: '2026-10-13' }, '2026-10-07', bloco({ vendas: 2, vendasPos: 2 }), bloco());
    expect(t).toContain('💰 Vendas: *2*\n');
  });
});

describe('timeTiCompleto', () => {
  it('espera o último que devia', () => {
    const linhas = [relato({ nome: 'A', registrado: true }), relato({ nome: 'B' })];
    expect(timeTiCompleto(linhas)).toBe(false);
    linhas[1].registrado = true;
    expect(timeTiCompleto(linhas)).toBe(true);
  });
  it('quem está dispensado não segura a mensagem', () => {
    expect(timeTiCompleto([
      relato({ nome: 'A', registrado: true }),
      relato({ nome: 'B', dispensado_motivo: 'bloqueio' }),
    ])).toBe(true);
  });
  it('dia sem trabalho do TI ou ninguém devendo: não manda', () => {
    expect(timeTiCompleto([relato({ dia_util: false, registrado: true })])).toBe(false);
    expect(timeTiCompleto([relato({ dispensado_motivo: 'bloqueio' })])).toBe(false);
    expect(timeTiCompleto([])).toBe(false);
  });
});

describe('deveEnviarTi', () => {
  const faltando = [relato({ nome: 'A', registrado: true }), relato({ nome: 'B' })];
  it('time completo sai na hora, qualquer horário', () => {
    expect(deveEnviarTi([relato({ registrado: true })], 9, true)).toBe(true);
  });
  it('faltando alguém: espera até o meio-dia', () => {
    expect(deveEnviarTi(faltando, 11, true)).toBe(false);
    expect(deveEnviarTi(faltando, 12, true)).toBe(true);
  });
  it('meio-dia de domingo/feriado não fecha (o dia cobrado ainda vai ser perguntado)', () => {
    expect(deveEnviarTi(faltando, 12, false)).toBe(false);
  });
  it('ninguém devendo (todos dispensados): não manda', () => {
    expect(deveEnviarTi([relato({ dispensado_motivo: 'bloqueio' })], 15, true)).toBe(false);
  });
});

describe('textoFeedbackTi', () => {
  it('fechado ao meio-dia: quem enviou e quem faltou', () => {
    const t = textoFeedbackTi('2026-10-14', [
      relato({ nome: 'Carlos', registrado: true, descricao: 'fiz A' }),
      relato({ nome: 'Gabriel' }),
      relato({ nome: 'Gustavo' }),
    ]);
    expect(t).toContain('*1 de 3* enviaram até o meio-dia.');
    expect(t).toContain('⏳ *Não enviou:* Gabriel · Gustavo');
    expect(t).not.toContain('Todo o time');
  });
  it('ninguém enviou até o meio-dia', () => {
    const t = textoFeedbackTi('2026-10-14', [relato({ nome: 'A' }), relato({ nome: 'B' })]);
    expect(t).toContain('Ninguém enviou até o meio-dia (0 de 2).');
    expect(t).toContain('⏳ *Não enviou:* A · B');
  });
  it('um bloco por pessoa com FEITO e EM ANDAMENTO · VAI FAZER', () => {
    const t = textoFeedbackTi('2026-10-14', [
      relato({ nome: 'Carlos', registrado: true, descricao: '- fiz A\n\n\n\n- fiz B  ', andamento: '- vou fazer C', anexos: 2 }),
      relato({ nome: 'Gabriel', registrado: true, descricao: 'corrigi o bug X' }),
      relato({ nome: 'Gustavo', dispensado_motivo: 'bloqueio' }),
    ]);
    expect(t).toContain('🖥️ *Feedback do TI — Quarta, 14/10*');
    expect(t).toContain('Todo o time enviou (2 de 2).');
    expect(t).toContain('👤 *Carlos*\n✅ *FEITO*\n- fiz A\n\n- fiz B\n\n🔄 *EM ANDAMENTO · VAI FAZER*\n- vou fazer C\n📎 2 anexos');
    // Relato sem o 2º campo (anterior a 13/10) sai só com o FEITO.
    expect(t).toContain('👤 *Gabriel*\n✅ *FEITO*\ncorrigi o bug X');
    expect(t.split('EM ANDAMENTO').length).toBe(2);
    expect(t).toContain('_Dispensado: Gustavo (agenda bloqueada ou férias)_');
  });
  it('dispensado que enviou mesmo assim entra como enviado', () => {
    const t = textoFeedbackTi('2026-10-14', [relato({ nome: 'A', registrado: true, descricao: 'x' })]);
    expect(t).not.toContain('Dispensado');
  });
  it('não passa do teto do WhatsApp', () => {
    const t = textoFeedbackTi('2026-10-14', [relato({ registrado: true, descricao: 'a'.repeat(TETO_MENSAGEM + 500) })]);
    expect(t.length).toBeLessThan(65_536);
    expect(t).toContain('continua na tela Feedback do TI');
  });
});
