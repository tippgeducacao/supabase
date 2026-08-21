import { describe, expect, it } from 'vitest';
import {
  blocoConfirmacao,
  corrigirCanal,
  ehDespedidaDeVerdade,
  despedidaDe,
  motivoDoEncerramento,
  temLinkDeMeet,
  tirarNomeInventado,
} from './guardas';

// Cada teste aqui aponta pra um cenário real da rodada de 20/08/2026.

describe('despedida por motivo', () => {
  it('lead sem graduação ouve o lato sensu, não a despedida de quem desistiu (q-01)', () => {
    const d = despedidaDe({ tool: 'pausa_ia', input: { tipo: 'sem_graduacao', motivo: 'Lead não possui graduação' } });
    expect(d).toContain('lato sensu');
    expect(d).not.toContain('agradeço sua preferência');
  });

  it('quem pede humano ouve que vai ser transferido (q-05)', () => {
    const d = despedidaDe({ tool: 'pausa_ia', input: { motivo: 'Lead pediu atendimento humano' } });
    expect(d).toBe('claro, já te passo pra alguém do time aqui.');
  });

  it('quem já é aluno ouve o engano assumido (q-04)', () => {
    const d = despedidaDe({ tool: 'pausa_ia', input: { motivo: 'Lead já é aluno matriculado' } });
    expect(d).toContain('desculpa a confusão');
  });

  it('pedido de ligação tem texto próprio', () => {
    expect(despedidaDe({ tool: 'pausa_ia', input: { motivo: 'Lead pediu ligação telefônica' } }))
      .toBe('beleza, já vou te ligar.');
  });

  it('desinteresse de verdade mantém a despedida antiga (q-07 passou)', () => {
    const d = despedidaDe({ tool: 'pausa_ia', input: { motivo: 'Lead demonstrou desinteresse' } });
    expect(d).toContain('agradeço sua preferência');
  });

  it('o tipo manda no motivo: sem_graduacao com motivo ambíguo não vira desinteresse', () => {
    // "Lead não possui graduação completa" é o motivo mais comum e é ambíguo entre quem
    // só tem ensino médio e quem ainda está cursando. Quem decide é o enum.
    expect(motivoDoEncerramento({ tool: 'pausa_ia', input: { tipo: 'sem_graduacao', motivo: 'qualquer coisa' } }))
      .toBe('sem_graduacao');
  });

  it('temporizador de próxima turma não é despedida de desistência', () => {
    expect(despedidaDe({ tool: 'temporizador_proxima_turma', input: {} })).toContain('próxima turma');
  });

  it('sem encerramento, não inventa despedida', () => {
    expect(despedidaDe(null)).toBeNull();
    expect(despedidaDe({ tool: 'consulta_disponibilidade', input: {} })).toBeNull();
  });

  // pausa_ia não é só despedida: cancelamento e remarcação passam por ela.
  it('cancelamento não vira despedida de desinteresse', () => {
    const d = despedidaDe({ tool: 'pausa_ia', input: { motivo: 'Lead pediu cancelamento ou remarcação' } });
    expect(d).toBe('tranquilo, já vou verificar isso pra vc aqui.');
  });

  it('motivo desconhecido preserva o texto do modelo em vez de chutar', () => {
    expect(despedidaDe({ tool: 'pausa_ia', input: { motivo: 'algo que ninguém previu' } })).toBeNull();
  });
});

describe('nem toda pausa é adeus', () => {
  // Medido no WhatsApp em 20/08: o convite da Escola grudou em 6 de 7 pedidos de ligação.
  // "beleza já vou te ligar" seguido de "antes de te deixar ir" se contradiz.
  it('quem pediu ligação NÃO está indo embora', () => {
    expect(ehDespedidaDeVerdade({ tool: 'pausa_ia', input: { motivo: 'Lead pediu ligação telefônica' } })).toBe(false);
  });

  it('quem pediu humano NÃO está indo embora', () => {
    expect(ehDespedidaDeVerdade({ tool: 'pausa_ia', input: { motivo: 'Lead pediu atendimento humano' } })).toBe(false);
  });

  it('cancelamento NÃO é adeus', () => {
    expect(ehDespedidaDeVerdade({ tool: 'pausa_ia', input: { motivo: 'Lead pediu cancelamento' } })).toBe(false);
  });

  it('desinteresse e sem graduação SÃO adeus', () => {
    expect(ehDespedidaDeVerdade({ tool: 'pausa_ia', input: { motivo: 'Lead demonstrou desinteresse' } })).toBe(true);
    expect(ehDespedidaDeVerdade({ tool: 'pausa_ia', input: { tipo: 'sem_graduacao' } })).toBe(true);
  });

  it('motivo desconhecido não conta como adeus', () => {
    expect(ehDespedidaDeVerdade({ tool: 'pausa_ia', input: { motivo: 'algo novo' } })).toBe(false);
    expect(ehDespedidaDeVerdade(null)).toBe(false);
  });
});

describe('correção de canal', () => {
  it('“te mandei aqui, oh” vira referência ao whats (cron-04)', () => {
    const r = corrigirCanal('Consegui te mandar aqui, oh: cronograma completo do curso.');
    expect(r.texto).toContain('no seu whats');
    expect(r.texto).not.toMatch(/aqui,\s*oh/);
    expect(r.trocou).toBe(true);
  });

  it('“ali em cima” também (cron-04)', () => {
    expect(corrigirCanal('O material já te mandei ali em cima.').texto)
      .toBe('O material já te mandei no seu whats.');
  });

  it('não mexe em fala que já cita o canal certo', () => {
    const t = 'acabei de mandar o cronograma completo no seu whats, dá uma olhada com calma.';
    const r = corrigirCanal(t);
    expect(r.texto).toBe(t);
    expect(r.trocou).toBe(false);
  });
});

describe('nome inventado', () => {
  it('tira o nome que o visitante nunca disse (q-03)', () => {
    const r = tirarNomeInventado('tranquilo, bruno. te deixo por aqui então.', 'Gustavo Teste');
    expect(r.texto).toBe('tranquilo. te deixo por aqui então.');
    expect(r.removidos).toEqual(['bruno']);
  });

  it('mantém o nome certo do lead', () => {
    const t = 'beleza, gustavo, vou ver os horários.';
    expect(tirarNomeInventado(t, 'Gustavo Teste').texto).toBe(t);
  });

  it('mantém o nome certo mesmo com caixa diferente', () => {
    const t = 'Show, Marina, deu certo.';
    expect(tirarNomeInventado(t, 'marina souza').removidos).toEqual([]);
  });

  // Segundo formato, achado no reteste de 20/08: o nome ABRE a frase.
  it('tira o nome inventado que abre a frase (reteste cron-03)', () => {
    const r = tirarNomeInventado('Márcia, sua formação já é atendida, dá pra seguir.', 'Gustavo Teste');
    expect(r.texto).toBe('sua formação já é atendida, dá pra seguir.');
    expect(r.removidos).toEqual(['Márcia']);
  });

  // Caso REAL de 21/08/2026: a lead se chamava Flávia, o João escreveu "vitória, então
  // segue assim:" e ela respondeu "e não me chamo vitória". A guarda anterior exigia
  // inicial maiúscula — e o João escreve tudo em caixa baixa por regra de persona, então
  // ela pedia justamente o que ele nunca produz.
  it('pega o nome inventado em MINÚSCULA abrindo a frase (caso Flávia)', () => {
    const r = tirarNomeInventado(
      'vitória, então segue assim: como a pós é lato sensu, a matrícula pede a graduação.',
      'Flávia',
    );
    expect(r.removidos).toEqual(['vitória']);
    expect(r.texto).toMatch(/^então segue assim/);
  });

  it('mantém o nome do lead abrindo a frase', () => {
    const t = 'Gustavo, sua formação já é atendida.';
    expect(tirarNomeInventado(t, 'Gustavo Teste').texto).toBe(t);
  });

  it('não come interjeição que abre a frase', () => {
    for (const t of ['Prontinho, segue o link.', 'Show, vamos lá.', 'Bacana, faz sentido.']) {
      expect(tirarNomeInventado(t, 'Gustavo').texto).toBe(t);
    }
  });

  it('não come palavra comum depois da saudação', () => {
    const t = 'beleza, então vamos ver os horários de hoje.';
    expect(tirarNomeInventado(t, 'Gustavo').texto).toBe(t);
  });
});

describe('bloco de confirmação da reunião', () => {
  const resultado = 'Agendamento confirmado. id: abc-123, data: 20/08/2026 14:30, '
    + 'monitor: Suéli, link: https://meet.google.com/zfd-friv-kgc';

  it('monta o bloco com data, monitor e link do retorno da tool (ag-07)', () => {
    const b = blocoConfirmacao(resultado);
    expect(b).toContain('20/08/2026 14:30');
    expect(b).toContain('Suéli');
    expect(b).toContain('https://meet.google.com/zfd-friv-kgc');
  });

  it('não monta bloco quando o agendamento falhou', () => {
    expect(blocoConfirmacao('Erro ao agendar: Vendedor sem id_calendar cadastrado')).toBeNull();
  });

  it('não monta bloco com link vazio', () => {
    expect(blocoConfirmacao('Agendamento confirmado. id: x, data: hoje, monitor: y, link: ')).toBeNull();
  });

  it('detecta quando o modelo já mandou o link sozinho', () => {
    expect(temLinkDeMeet(['pronto', 'link: https://meet.google.com/abc-defg-hij'])).toBe(true);
    expect(temLinkDeMeet(['tá tudo certo com sua reunião marcada pra hoje às 14h30'])).toBe(false);
  });
});
