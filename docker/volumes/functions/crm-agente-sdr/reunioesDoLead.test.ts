import { describe, expect, it } from 'vitest';
import {
  agendamentoFeito, carregarReunioesDoLead, notaDasReunioes, quandoEmBrasilia, reuniaoMarcadaNaAgenda, situacaoDaReuniao,
  trocarNotaDasReunioes, type ReuniaoDoLead,
} from './reunioesDoLead';
import { afirmaReuniaoSemCriar } from './travasDeterministicas';

// "Agora" = 30/09/2026 12:00 em Brasília (15:00 UTC).
const AGORA = new Date('2026-09-30T15:00:00Z');
const r = (o: Partial<ReuniaoDoLead>): ReuniaoDoLead => ({
  id: 'x', status: 'agendado', resultado_reuniao: null, data_agendamento: '2026-09-30T18:00:00Z', monitor: 'Leticia',
  origem: 'API SDR', mudou_em: null, mudou_por: null, ...o,
});

describe('situação da reunião pela agenda', () => {
  it('cada status/resultado vira uma situação', () => {
    expect(situacaoDaReuniao(r({}), AGORA)).toBe('marcada');
    expect(situacaoDaReuniao(r({ data_agendamento: '2026-09-29T18:00:00Z' }), AGORA)).toBe('passou_sem_registro');
    expect(situacaoDaReuniao(r({ status: 'atrasado', data_agendamento: '2026-09-29T18:00:00Z' }), AGORA)).toBe('passou_sem_registro');
    expect(situacaoDaReuniao(r({ status: 'cancelado', resultado_reuniao: 'nao_compareceu' }), AGORA)).toBe('cancelada');
    // Remarcar atualiza a MESMA linha: com data futura, é a reunião de pé (achado da revisão de 30/09).
    expect(situacaoDaReuniao(r({ status: 'remarcado' }), AGORA)).toBe('marcada');
    expect(situacaoDaReuniao(r({ status: 'remarcado', data_agendamento: '2026-09-28T18:00:00Z' }), AGORA)).toBe('passou_sem_registro');
    expect(situacaoDaReuniao(r({ status: 'remarcado', resultado_reuniao: 'compareceu_nao_comprou' }), AGORA)).toBe('compareceu');
    // Começou há 3 min, sem resultado: está acontecendo (o lead pode estar entrando na sala).
    expect(situacaoDaReuniao(r({ data_agendamento: '2026-09-30T14:57:00Z' }), AGORA)).toBe('em_andamento');
    // 30 min de reunião + 10 de folga já passaram (caso Julimara): não afirma nada até 2 h do início.
    expect(situacaoDaReuniao(r({ status: 'atrasado', data_agendamento: '2026-09-30T14:00:00Z' }), AGORA)).toBe('horario_encerrado');
    expect(situacaoDaReuniao(r({ data_agendamento: '2026-09-30T14:00:00Z', data_fim_agendamento: '2026-09-30T15:30:00Z' }), AGORA)).toBe('em_andamento');
    expect(situacaoDaReuniao(r({ data_agendamento: '2026-09-30T12:30:00Z' }), AGORA)).toBe('passou_sem_registro');
    expect(situacaoDaReuniao(r({ status: 'finalizado_venda', resultado_reuniao: 'comprou' }), AGORA)).toBe('comprou');
    expect(situacaoDaReuniao(r({ status: 'realizado', resultado_reuniao: 'nao_compareceu' }), AGORA)).toBe('nao_compareceu');
    expect(situacaoDaReuniao(r({ status: 'agendado', resultado_reuniao: 'nao_compareceu' }), AGORA)).toBe('nao_compareceu');
    expect(situacaoDaReuniao(r({ status: 'realizado', resultado_reuniao: 'compareceu_nao_comprou' }), AGORA)).toBe('compareceu');
    expect(situacaoDaReuniao(r({ status: 'realizado', resultado_reuniao: 'reuniao_desqualificada' }), AGORA)).toBe('desqualificada');
    expect(situacaoDaReuniao(r({ status: 'realizado', resultado_reuniao: 'nao_validada' }), AGORA)).toBe('realizada');
  });

  it('data em Brasília, com o ano só quando não é o atual', () => {
    expect(quandoEmBrasilia('2026-09-24T18:30:00Z', AGORA)).toBe('24/09 (quinta) 15h30');
    expect(quandoEmBrasilia('2026-09-30T18:00:00Z', AGORA)).toBe('30/09 (quarta) 15h');
    expect(quandoEmBrasilia('2025-03-02T13:00:00Z', AGORA)).toBe('02/03/2025 (domingo) 10h');
    expect(quandoEmBrasilia(null, AGORA)).toBe('data não informada');
  });
});

describe('nota das reuniões no contexto', () => {
  it('caso Marwin: a da Suéli cancelada e a das 15h passou para a Amanda', () => {
    const nota = notaDasReunioes([
      r({ status: 'cancelado', monitor: 'Suéli', mudou_em: '2026-09-30T12:09:00Z', mudou_por: 'Flávia' }),
      r({ monitor: 'Amanda', origem: 'WhatsApp' }),
    ], AGORA);
    expect(nota).toContain('- 30/09 (quarta) 15h com Suéli: CANCELADA em 30/09 (quarta) 9h09 (Flávia).');
    expect(nota).toContain('- 30/09 (quarta) 15h com Amanda: MARCADA.');
    expect(nota).not.toContain('Não há reunião marcada agora');
  });

  it('sem nenhuma de pé, diz com todas as letras', () => {
    const nota = notaDasReunioes([r({ status: 'cancelado' }), r({ status: 'realizado', resultado_reuniao: 'nao_compareceu', data_agendamento: '2026-09-20T18:00:00Z' })], AGORA);
    expect(nota).toContain('CANCELADA');
    expect(nota).toContain('o lead NÃO COMPARECEU');
    expect(nota).toContain('Não há reunião marcada agora');
  });

  it('lead sem reunião ou leitura falha: nota vazia (a conversa não muda)', () => {
    expect(notaDasReunioes([], AGORA)).toBe('');
    expect(notaDasReunioes(null, AGORA)).toBe('');
    expect(reuniaoMarcadaNaAgenda(null, AGORA)).toBeNull();
    expect(reuniaoMarcadaNaAgenda([], AGORA)).toBe(false);
    expect(reuniaoMarcadaNaAgenda([r({})], AGORA)).toBe(true);
  });

  it('leitura: manda o lead só se for uuid; erro vira null (fail-open)', async () => {
    const chamadas: any[] = [];
    const banco = (resp: any) => ({ rpc: async (nome: string, p: any) => { chamadas.push([nome, p]); return resp; } });
    expect(await carregarReunioesDoLead(banco({ data: [r({})], error: null }), '5546988166051', 'nao-e-uuid')).toHaveLength(1);
    expect(chamadas[0]).toEqual(['crm_sdr_reunioes_do_lead', { p_telefone: '5546988166051', p_lead_id: null, p_limite: 5 }]);
    expect(await carregarReunioesDoLead(banco({ data: null, error: { message: 'x' } }), '5546988166051', null)).toBeNull();
  });
});

describe('trava de reunião afirmada, com a agenda', () => {
  const historicoComAgendamento = [
    { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't', content: JSON.stringify({ agendamento_id: 'a1', resultado: 'Agendamento confirmado' }) }] },
  ];
  const fala = 'sua conversa com o monitor segue marcada para hoje às 15h.';

  it('reunião do histórico cancelada na agenda: a fala é barrada', () => {
    expect(afirmaReuniaoSemCriar(fala, historicoComAgendamento, false, { marcadaNaAgenda: false })).toBe(true);
  });

  it('reunião de pé na agenda, ou criada nesta rodada: passa', () => {
    expect(afirmaReuniaoSemCriar(fala, historicoComAgendamento, false, { marcadaNaAgenda: true })).toBe(false);
    expect(afirmaReuniaoSemCriar(fala, historicoComAgendamento, false, { marcadaNaAgenda: false, agendouNestaRodada: true })).toBe(false);
  });

  it('sem a agenda (leitura falhou): a regra de sempre (o histórico vale)', () => {
    expect(afirmaReuniaoSemCriar(fala, historicoComAgendamento, false)).toBe(false);
    expect(afirmaReuniaoSemCriar(fala, historicoComAgendamento, false, { marcadaNaAgenda: null })).toBe(false);
    expect(afirmaReuniaoSemCriar(fala, [], false)).toBe(true);
  });

  it('as frases dos casos reais são reconhecidas; convite de aula não', () => {
    for (const f of ['então tá certinho, te espero às 15h30', 'show, marwin. então já te espero às 15h com a suéli. até lá',
      'sua conversa com o monitor segue marcada para hoje às 15h.', 'a reunião continua confirmada pra amanhã']) {
      expect(afirmaReuniaoSemCriar(f, [], false), f).toBe(true);
    }
    for (const f of ['show, te espero amanhã às 19h na aula. no dia a dia, vc trabalha com o quê?',
      'te espero na live de quinta às 20h', 'vamos marcar sua conversa pra garantir essa condição?']) {
      expect(afirmaReuniaoSemCriar(f, [], false), f).toBe(false);
    }
  });

});

describe('achados da revisão adversarial (30/09)', () => {
  it('remarcada para o futuro: a nota diz MARCADA no horário novo e não diz que não há reunião', () => {
    const nota = notaDasReunioes([r({ status: 'remarcado', data_agendamento: '2026-10-02T21:00:00Z', monitor: 'Erika Costa',
      mudou_em: '2026-09-29T19:44:00Z', mudou_por: 'Erika Costa' })], AGORA);
    expect(nota).toContain('- 02/10 (sexta) 18h com Erika Costa: MARCADA (horário alterado para este em 29/09 (terça) 16h44 (Erika Costa); vale este, não o do histórico).');
    expect(nota).not.toContain('Não há reunião marcada agora');
    expect(reuniaoMarcadaNaAgenda([r({ status: 'remarcado', data_agendamento: '2026-10-02T21:00:00Z' })], AGORA)).toBe(true);
  });

  it('reunião acontecendo agora conta como de pé', () => {
    const lista = [r({ data_agendamento: '2026-09-30T14:57:00Z' })];
    expect(notaDasReunioes(lista, AGORA)).toContain('ACONTECENDO AGORA');
    expect(notaDasReunioes(lista, AGORA)).not.toContain('Não há reunião marcada agora');
    expect(reuniaoMarcadaNaAgenda(lista, AGORA)).toBe(true);
  });

  it('só conta como agendou quando a reunião foi criada/remarcada de fato', () => {
    expect(agendamentoFeito('confirmar_agendamento', { agendamento_id: 'a1', resultado: 'Agendamento confirmado.' })).toBe(true);
    expect(agendamentoFeito('confirmar_agendamento', { agendamento_id: null, resultado: 'Erro ao agendar: HTTP 422' })).toBe(false);
    expect(agendamentoFeito('confirmar_agendamento', { resultado: 'NÃO FEITO: horário fora da agenda. Nada foi agendado.', trava: 'horario' })).toBe(false);
    expect(agendamentoFeito('confirmar_agendamento', { agendamento_id: 'a1', status: 'erro' })).toBe(false);
    expect(agendamentoFeito('remarcar_agendamento', { resultado: 'Reunião remarcada. Novo horário: 01/10 às 10:00.' })).toBe(true);
    expect(agendamentoFeito('remarcar_agendamento', { resultado: 'Nenhum agendamento ativo encontrado para este lead.' })).toBe(false);
    expect(agendamentoFeito('remarcar_agendamento', { resultado: 'Não consegui remarcar (409).' })).toBe(false);
    expect(agendamentoFeito('remarcar_agendamento', { resultado: 'Erro ao remarcar: timeout' })).toBe(false);
    expect(agendamentoFeito('consulta_disponibilidade', { agendamento_id: 'x' })).toBe(false);
  });

});

describe('achados da 2ª revisão (30/09)', () => {
  it('caso Julimara: horário encerrado sem resultado — a nota não afirma nada e a trava segue a regra de sempre', () => {
    const lista = [r({ status: 'atrasado', data_agendamento: '2026-09-30T14:00:00Z', monitor: 'Amanda' })];
    const nota = notaDasReunioes(lista, AGORA);
    expect(nota).toContain('o horário terminou e a equipe ainda não registrou o resultado');
    expect(nota).not.toContain('ACONTECENDO AGORA');
    expect(nota).not.toContain('Não há reunião marcada agora');
    expect(reuniaoMarcadaNaAgenda(lista, AGORA)).toBeNull();
  });

  it('caso Americo: horário mudado sem virar remarcado também avisa que vale o novo', () => {
    const nota = notaDasReunioes([r({ data_agendamento: '2026-09-30T21:30:00Z', monitor: 'Amanda', mudou_em: '2026-09-30T18:51:00Z', mudou_por: 'Amanda' })], AGORA);
    expect(nota).toContain('- 30/09 (quarta) 18h30 com Amanda: MARCADA (horário alterado para este em 30/09 (quarta) 15h51 (Amanda); vale este, não o do histórico).');
  });

  it('caso Evelise: remarcada depois de comparecer é a continuação, não a primeira reunião adiada', () => {
    const nota = notaDasReunioes([r({ status: 'remarcado', data_agendamento: '2026-10-01T19:30:00Z', monitor: 'Erika Costa',
      mudou_em: '2026-09-28T20:57:00Z', mudou_por: 'Erika Costa', compareceu_antes: true })], AGORA);
    expect(nota).toContain('MARCADA (o lead JÁ COMPARECEU à reunião anterior; esta é a continuação/fechamento marcada pela equipe para este horário).');
  });

  it('o cabeçalho não põe a agenda acima de combinado mais novo da equipe', () => {
    expect(notaDasReunioes([r({})], AGORA)).toContain('Se a equipe combinou outra coisa com o lead DEPOIS, na conversa, não afirme horário: siga a equipe');
  });

  it('nota velha é trocada depois de confirmar/remarcar; sem nota antes, a nova entra no fim', () => {
    expect(trocarNotaDasReunioes('AGORA: 12h\n\nNOTA VELHA\n\nDOSSIÊ', '\n\nNOTA VELHA', '\n\nNOTA NOVA')).toBe('AGORA: 12h\n\nNOTA NOVA\n\nDOSSIÊ');
    expect(trocarNotaDasReunioes('AGORA: 12h', '', '\n\nNOTA NOVA')).toBe('AGORA: 12h\n\nNOTA NOVA');
    expect(trocarNotaDasReunioes('AGORA: 12h', '', '')).toBe('AGORA: 12h');
    expect(trocarNotaDasReunioes('custa $& e $1', '', '\n\nR$ 10 $&')).toBe('custa $& e $1\n\nR$ 10 $&');
  });
});
