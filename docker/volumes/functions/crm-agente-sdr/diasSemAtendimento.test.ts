import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blocoConviteAgenda, carregarDiasSemAtendimento, fraseConviteAgenda, limparCacheDiasSemAtendimento, montarContextoTemporal,
  variantesConviteAgenda,
} from './contexto';

// Caso Beatriz (10/10/2026, sábado): segunda 12/10 era feriado. A agenda devolvia zero horário e a IA
// pediu para a lead "me chamar na segunda pra conferir os horários de terça".
const FERIADO = [{ data: '2026-10-12', motivo: 'feriado' }];
const SABADO_DEPOIS_DO_EXPEDIENTE = { dia: 6, hora: 12, minuto: 55, iso: '2026-10-10' };

describe('dias sem atendimento no contexto da IA', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('o convite pula o feriado: sábado à tarde aponta para terça, não segunda', () => {
    expect(fraseConviteAgenda(SABADO_DEPOIS_DO_EXPEDIENTE)).toBe('procuro um encaixe pra segunda-feira cedo, no primeiro horário?');
    expect(fraseConviteAgenda(SABADO_DEPOIS_DO_EXPEDIENTE, FERIADO)).toBe('procuro um encaixe pra terça-feira cedo, no primeiro horário?');
    expect(blocoConviteAgenda(SABADO_DEPOIS_DO_EXPEDIENTE, FERIADO)).toContain('"procuro um encaixe pra terça-feira cedo, no primeiro horário?"');
  });

  it('no próprio feriado não existe "ainda hoje": o convite vai para amanhã', () => {
    const segundaDeManha = { dia: 1, hora: 10, minuto: 0, iso: '2026-10-12' };
    expect(fraseConviteAgenda(segundaDeManha)).toBe('procuro um encaixe pra ainda hoje?');
    expect(fraseConviteAgenda(segundaDeManha, FERIADO)).toBe('procuro um encaixe pra amanhã cedo, no primeiro horário?');
  });

  it('véspera de feriado depois do expediente: amanhã está fechado, vai para o dia seguinte', () => {
    // domingo 11/10: sem a lista, "amanhã" (segunda); com o feriado, terça.
    const domingo = { dia: 0, hora: 10, minuto: 0, iso: '2026-10-11' };
    expect(fraseConviteAgenda(domingo)).toBe('procuro um encaixe pra amanhã cedo, no primeiro horário?');
    expect(fraseConviteAgenda(domingo, FERIADO)).toBe('procuro um encaixe pra terça-feira cedo, no primeiro horário?');
  });

  it('o calendário marca o dia fechado e o aviso diz o próximo dia com atendimento', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T15:55:00Z')); // sábado, 12:55 em Brasília
    const comFeriado = montarContextoTemporal(FERIADO);
    expect(comFeriado).toContain('• 12/10/2026 (2026-10-12) = Segunda-feira — SEM ATENDIMENTO (feriado)');
    expect(comFeriado).toContain('• 13/10/2026 (2026-10-13) = Terça-feira\n');
    expect(comFeriado).toContain('DIAS SEM ATENDIMENTO (exceção à grade acima): segunda-feira, 12/10/2026 (feriado).');
    expect(comFeriado).toContain('O próximo dia com atendimento depois de hoje é terça-feira, 13/10/2026.');
    expect(comFeriado).toContain('Próximo disponível: terça-feira a partir das 09:30.');
    // Sem a lista, o dia fechado não aparece e o próximo atendimento segue sendo a segunda.
    const semLista = montarContextoTemporal();
    expect(semLista).not.toContain('SEM ATENDIMENTO');
    expect(semLista).toContain('Próximo disponível: segunda-feira a partir das 09:30.');
    expect(montarContextoTemporal([])).toBe(semLista);
  });

  it('"dois dias à frente" conta só dia com atendimento, e a data-limite vem pronta', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T15:55:00Z')); // sábado
    // Semana normal: domingo não conta; o limite é a terça (segunda e terça são os dois dias).
    const normal = montarContextoTemporal();
    expect(normal).toContain('ATÉ QUANDO OFERECER A CONVERSA: até terça-feira, 13/10/2026 (2026-10-13).');
    expect(normal).toContain('Nunca peça ao lead para te chamar outro dia para conferir a agenda.');
    // Com o feriado na segunda: terça e quarta são os dois dias, e a terça que a lead pediu está dentro.
    expect(montarContextoTemporal(FERIADO)).toContain('ATÉ QUANDO OFERECER A CONVERSA: até quarta-feira, 14/10/2026 (2026-10-14).');
    // Quinta à tarde: sexta e sábado.
    vi.setSystemTime(new Date('2026-10-08T18:00:00Z'));
    expect(montarContextoTemporal()).toContain('ATÉ QUANDO OFERECER A CONVERSA: até sábado, 10/10/2026 (2026-10-10).');
  });

  it('no dia do feriado o contexto diz que hoje não tem atendimento', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T13:00:00Z')); // segunda, 10:00 em Brasília
    const texto = montarContextoTemporal(FERIADO);
    expect(texto).toContain('⚠️ HOJE NÃO TEM ATENDIMENTO (feriado). Próximo atendimento: amanhã (terça-feira) a partir das 09:30.');
    expect(texto).toContain('SOMENTE PARA A CONVERSA COM O MONITOR: nenhum');
  });

  it('dia fechado fora dos próximos 7 dias não gera aviso', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T15:55:00Z'));
    expect(montarContextoTemporal([{ data: '2026-11-02', motivo: 'feriado' }])).not.toContain('DIAS SEM ATENDIMENTO');
  });

  it('recesso longo: o próximo atendimento só vale dentro do que a lista de dias fechados enxerga', () => {
    // 14 dias fechados seguidos a partir de amanhã: nenhum dia aberto dentro do alcance.
    const recesso = Array.from({ length: 14 }, (_, i) => ({ data: new Date(Date.UTC(2026, 11, 24 + i)).toISOString().slice(0, 10), motivo: 'recesso' }));
    const vespera = { dia: 3, hora: 21, minuto: 0, iso: '2026-12-23' };
    expect(fraseConviteAgenda(vespera, recesso)).toBe('procuro um encaixe pro nosso próximo dia de atendimento?');
    expect(new Set(variantesConviteAgenda(vespera, recesso)).size).toBe(3);
  });
});

describe('leitura dos dias sem atendimento', () => {
  beforeEach(() => limparCacheDiasSemAtendimento());

  it('lê da função do banco, guarda por 5 minutos e descarta linha malformada', async () => {
    const rpc = vi.fn(async () => ({ data: [{ data: '2026-10-12', motivo: ' feriado ' }, { data: 'lixo', motivo: 'x' }, { data: '2026-10-15', motivo: null }], error: null }));
    const dias = await carregarDiasSemAtendimento({ rpc }, 1_000);
    expect(dias).toEqual([{ data: '2026-10-12', motivo: 'feriado' }, { data: '2026-10-15', motivo: null }]);
    // 14 dias: o mesmo alcance da busca do próximo atendimento (com 10, o 11º ao 14º dia pareciam abertos).
    expect(rpc).toHaveBeenCalledWith('fn_sdr_api_dias_sem_atendimento', { p_dias: 14 });
    await carregarDiasSemAtendimento({ rpc }, 1_000 + 4 * 60_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    await carregarDiasSemAtendimento({ rpc }, 1_000 + 6 * 60_000);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('falha de leitura não derruba a conversa: sem cache devolve lista vazia; com cache, a última boa', async () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    const quebrado = { rpc: async () => ({ data: null, error: { message: 'fora do ar' } }) };
    expect(await carregarDiasSemAtendimento(quebrado, 1_000)).toEqual([]);
    await carregarDiasSemAtendimento({ rpc: async () => ({ data: [{ data: '2026-10-12', motivo: 'feriado' }], error: null }) }, 2_000);
    expect(await carregarDiasSemAtendimento(quebrado, 2_000 + 10 * 60_000)).toEqual([{ data: '2026-10-12', motivo: 'feriado' }]);
    erro.mockRestore();
  });
});

describe('consulta de agenda avança para o próximo dia com horário', () => {
  let T: typeof import('./tools');
  beforeAll(async () => {
    vi.stubGlobal('Deno', { env: { get: () => '' } });
    T = await import('./tools');
  });
  beforeEach(() => limparCacheDiasSemAtendimento());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.stubGlobal('Deno', { env: { get: () => '' } }); });

  const slot = (inicioUtc: string, vendedor = 'Erika') => ({ inicio: inicioUtc, vendedor_id: vendedor === 'Erika' ? 'v1' : 'v2', vendedor_nome: vendedor });
  const banco = {
    rpc: async () => ({ data: [{ data: '2026-10-12', motivo: 'feriado' }], error: null }),
    from: () => { const q: any = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: { formacao_academica: 'Medicina Veterinária' }, error: null }) }; return q; },
  };
  const ctx: any = { remotejid: '5511999999999@s.whatsapp.net', telefone: '5511999999999', waAccountId: null, leadId: null, oportunidadeId: null };
  const chamadas: URLSearchParams[] = [];
  const agenda = (responder: (p: URLSearchParams) => unknown[]) => vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(u, 'http://sdr-api.teste'); // nos testes a URL da sdr-api é relativa
    chamadas.push(url.searchParams);
    return { ok: true, status: 200, json: async () => ({ data: { slots: responder(url.searchParams) } }) };
  }));
  const sabado = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-10T15:55:00Z')); };
  const consultar = (input: Record<string, unknown>, contexto: any = ctx) =>
    T.executarTool(banco, { id: 'c1', name: 'consulta_disponibilidade', input: { curso_escolhido: 'CANNABIS', ...input } }, contexto, { comDados: true }) as Promise<any>;
  beforeEach(() => { chamadas.length = 0; });

  it('feriado na segunda: devolve os horários de terça e diz o motivo', async () => {
    sabado();
    agenda((p) => p.get('data') === '2026-10-12' ? []
      : p.get('de') ? [slot('2026-10-13T12:30:00Z', 'Ana'), slot('2026-10-13T13:00:00Z', 'Ana'), slot('2026-10-14T12:30:00Z', 'Ana')]
      : [slot('2026-10-13T17:00:00Z'), slot('2026-10-13T17:30:00Z')]); // terça, agenda da dona do contato
    const r = await consultar({ data_desejada: '2026-10-12', periodo_desejado: 'qualquer' });
    expect(r.dados.situacao).toBe('ok');
    expect(r.dados.avanco).toEqual({ tipo: 'outro_dia', data_pedida: '2026-10-12', dia_semana_pedido: 'segunda-feira', fechado_por: 'feriado' });
    expect(r.resultado).toContain('Em segunda-feira, dia 2026-10-12, não há horário para a conversa com o monitor porque não temos atendimento nesse dia (feriado).');
    expect(r.resultado).toContain('O próximo dia com horário é terça-feira, dia 2026-10-13');
    expect(r.resultado).toContain('Nunca peça ao lead para te chamar outro dia para conferir a agenda');
    // 2ª consulta: os 8 dias seguintes SEM o telefone (a equipe toda); 3ª: o dia achado, COM o telefone.
    expect(chamadas).toHaveLength(3);
    expect(chamadas[1].get('de')).toBe('2026-10-13T00:00:00-03:00');
    expect(chamadas[1].get('ate')).toBe('2026-10-20T23:59:59-03:00');
    expect(chamadas[1].get('telefone')).toBeNull();
    expect(chamadas[2].get('data')).toBe('2026-10-13');
    expect(chamadas[2].get('telefone')).toBe('5511999999999');
    // Os horários oferecidos são os da dona do contato naquele dia.
    expect(r.slots_raw.map((s: any) => `${s.data} ${s.horario} ${s.vendedor_nome}`)).toEqual(['2026-10-13 14:00 Erika', '2026-10-13 14:30 Erika']);
  });

  it('dono do contato sem agenda na semana: o primeiro dia é o da equipe, não o primeiro dia dele', async () => {
    sabado();
    // A equipe tem vaga na terça; o dono do contato só na segunda seguinte.
    agenda((p) => p.get('data') === '2026-10-12' ? []
      : p.get('de') ? [slot('2026-10-13T12:30:00Z', 'Ana'), slot('2026-10-13T13:00:00Z', 'Ana')]
      : [slot('2026-10-13T12:30:00Z', 'Ana'), slot('2026-10-13T13:00:00Z', 'Ana')]); // no dia, a agenda já cai na equipe
    const r = await consultar({ data_desejada: '2026-10-12' });
    expect(r.slots_raw.map((s: any) => s.data)).toEqual(['2026-10-13', '2026-10-13']);
    expect(r.resultado).toContain('O próximo dia com horário é terça-feira, dia 2026-10-13');
  });

  it('webchat (sem telefone): duas consultas bastam', async () => {
    sabado();
    agenda((p) => p.get('data') ? [] : [slot('2026-10-13T12:30:00Z', 'Ana')]);
    const r = await consultar({ data_desejada: '2026-10-12' }, { ...ctx, canal: 'webchat' });
    expect(chamadas).toHaveLength(2);
    expect(chamadas.every((p) => p.get('telefone') === null)).toBe(true);
    expect(r.slots_raw).toHaveLength(1);
  });

  it('"só depois das 20h" sem vaga: vêm os horários mais PRÓXIMOS do pedido, não os mais cedo do dia', async () => {
    sabado();
    const doDia = ['12:30', '13:00', '13:30', '14:00', '14:30', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '21:00', '21:30', '22:00', '22:30']
      .map((h) => slot(`2026-10-13T${h}:00Z`)); // 09:30 … 19:30 em Brasília
    agenda((p) => p.get('horario_inicio') ? [] : doDia);
    const r = await consultar({ data_desejada: '2026-10-13', horario_inicio_desejado: '20:00' });
    expect(r.dados.avanco.tipo).toBe('outro_periodo');
    expect(chamadas).toHaveLength(2);
    expect(chamadas[1].get('limite')).toBe('40');
    expect(r.slots_raw.map((s: any) => s.horario)).toEqual(['16:30', '17:00', '18:00', '18:30', '19:00', '19:30']);
    expect(r.resultado).toContain('os horários abaixo são os mais próximos do MESMO dia');
    // Não é ordem cega: se o lead só pode no período pedido, a IA consulta o dia seguinte nesse período.
    expect(r.resultado).toContain('Se ele só pode no período pedido, consulte agora o próximo dia nesse mesmo período.');
    expect(r.resultado).not.toContain('Ofereça estes horários AGORA');
  });

  it('pediu de manhã e só tem à tarde: os primeiros da tarde', async () => {
    sabado();
    agenda((p) => p.get('periodo') === 'manhã' ? [] : ['17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '21:00', '22:00'].map((h) => slot(`2026-10-13T${h}:00Z`)));
    const r = await consultar({ data_desejada: '2026-10-13', periodo_desejado: 'manhã' });
    expect(r.slots_raw.map((s: any) => s.horario)).toEqual(['14:30', '15:00', '15:30', '16:00', '16:30', '17:00']);
  });

  it('dia com horário segue igual: uma consulta só e nenhum aviso de avanço', async () => {
    sabado();
    agenda(() => [slot('2026-10-13T12:30:00Z')]);
    const r = await consultar({ data_desejada: '2026-10-13' });
    expect(chamadas).toHaveLength(1);
    expect(r.dados.avanco).toBeUndefined();
    expect(r.resultado).not.toContain('não há horário');
  });

  it('nada nos dias seguintes: "sem horário" conferido, sem mandar o lead chamar depois', async () => {
    sabado();
    agenda(() => []);
    const r = await consultar({ data_desejada: '2026-10-12' });
    expect(r.dados.situacao).toBe('sem_horario');
    expect(r.dados.avanco).toBeUndefined();
    expect(r.dados.avanco_falhou).toBeUndefined();
    expect(r.resultado).toContain('Nenhum horário disponível');
    expect(r.resultado).toContain('Os 8 dias seguintes também foram conferidos e não têm horário.');
    expect(r.resultado).toContain('Não peça ao lead para te chamar outro dia para conferir a agenda');
  });

  it('falha no avanço: não vira erro técnico, mas também NÃO afirma que os dias seguintes foram conferidos', async () => {
    sabado();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n === 1) return { ok: true, status: 200, json: async () => ({ data: { slots: [] } }) };
      return { ok: false, status: 500, json: async () => ({ error: 'caiu' }) };
    }));
    const r = await consultar({ data_desejada: '2026-10-12' });
    expect(r.dados.situacao).toBe('sem_horario');
    expect(r.dados.avanco_falhou).toBe(true);
    expect(r.erro).toBeUndefined();
    expect(n).toBe(3); // o avanço tem a mesma nova tentativa da consulta principal
    expect(r.resultado).toContain('Os dias seguintes NÃO foram conferidos');
    expect(r.resultado).toContain('Consulte agora o próximo dia com atendimento');
    expect(r.resultado).not.toContain('também foram conferidos');
  });

  it('o texto só de fatos (IA de aula) traz o avanço e não dá ordem', () => {
    const d: any = {
      situacao: 'ok', hoje: { iso: '2026-10-10', display: 'sábado, 10/10/2026' }, data_pedida: '2026-10-12', formacao_checada: true,
      horarios: [{ data: '2026-10-13', dia_semana: 'terça-feira', horario: '09:30', display: '09h30', vendedor_id: 'v1', vendedor_nome: 'Erika' }],
      avanco: { tipo: 'outro_dia', data_pedida: '2026-10-12', dia_semana_pedido: 'segunda-feira', fechado_por: 'feriado' },
    };
    const fatos = T.textoDisponibilidadeSoFatos(d);
    expect(fatos.startsWith('Em segunda-feira, dia 2026-10-12, não há horário')).toBe(true);
    expect(fatos).toContain('- 09h30 de terça-feira, dia 2026-10-13');
    expect(fatos).not.toContain('Ofereça');
    const semHorario = { ...d, situacao: 'sem_horario', horarios: [], avanco: undefined };
    expect(T.textoDisponibilidadeSoFatos(semHorario)).toContain('Também não há nos 8 dias seguintes.');
    expect(T.textoDisponibilidadeSoFatos({ ...semHorario, avanco_falhou: true })).toContain('Os dias seguintes não foram conferidos');
  });
});
