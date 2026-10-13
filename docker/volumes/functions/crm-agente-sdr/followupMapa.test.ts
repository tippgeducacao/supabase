import { describe, expect, it } from 'vitest';
import type { MapaCarreira } from './carreiraPos';
import { dadosDoToque, escopoDoMapa, falaDoToque, followupMapaLigado, ramoDoLead, soRetomadasConcretas, toqueDoMapa, usadosDoMapa } from './followupMapa';

// Recorte do mapa do Wellinton que está no banco (grupo avicultura), com os textos literais.
const MAPA: MapaCarreira = {
  grupo: 'avicultura',
  ramos: [
    { ramo: 'contratado', nome: 'Contratado (CLT) de agroindústria', vinculos: ['clt', 'servidor'], sinais: null,
      argumento: 'plano de carreira', ponte_convite: 'como essa pós se encaixa no seu momento', ordem: 1 },
    { ramo: 'dono_granja', nome: 'Produtor, dono de granja', vinculos: ['dono', 'autonomo'], sinais: null,
      argumento: 'resultado do lote', ponte_convite: 'como a pós ajuda no resultado do seu lote', ordem: 2 },
  ],
  perguntas: [
    { ramo: '*', etapa: 'divide', texto: 'Hoje você trabalha em agroindústria ou tem a sua granja?', ordem: 0 },
    { ramo: 'contratado', etapa: 'carreira', texto: 'Na empresa onde você trabalha, eles valorizam quem estuda? Quem tem pós cresce mais rápido aí dentro?', ordem: 1 },
    { ramo: 'contratado', etapa: 'carreira', texto: 'A empresa tem plano de carreira? Você sabe o que precisa pra subir de cargo?', ordem: 2 },
    { ramo: 'contratado', etapa: 'ganho', texto: 'Quanto você acha que um supervisor ou gerente ganha a mais do que você hoje?', ordem: 3 },
    { ramo: 'dono_granja', etapa: 'carreira', texto: 'Qual é o seu maior desafio hoje: sanidade, manejo, resultado do lote ou gestão do pessoal?', ordem: 1 },
    { ramo: '*', etapa: 'prioridade', texto: 'O que pesa mais pra você hoje?', ordem: 9 },
  ],
};
const CLT = { vinculo_trabalho: 'clt', jornada: {} };
const SEM = new Set<string>();

describe('o que cada toque leva do mapa', () => {
  it('toque 1 e toques 5 a 7 não são do mapa', () => {
    for (const t of [1, 5, 6, 7]) expect(toqueDoMapa(MAPA, CLT, t, SEM)).toBeNull();
  });

  it('perfil conhecido: carreira no 2, ganho no 3, ponte do convite no 4', () => {
    expect(toqueDoMapa(MAPA, CLT, 2, SEM)).toMatchObject({ id: 'contratado:carreira:1', etapa: 'carreira', ramo: 'contratado',
      texto: 'Na empresa onde você trabalha, eles valorizam quem estuda? Quem tem pós cresce mais rápido aí dentro?' });
    expect(toqueDoMapa(MAPA, CLT, 3, SEM)).toMatchObject({ id: 'contratado:ganho:3', etapa: 'ganho' });
    expect(toqueDoMapa(MAPA, CLT, 4, SEM)).toMatchObject({ id: 'contratado:ponte', etapa: 'ponte', texto: 'como essa pós se encaixa no seu momento' });
  });

  it('perfil sem pergunta de ganho: o toque 3 leva outra de carreira, sem repetir a já enviada', () => {
    const dono = { vinculo_trabalho: 'dono', jornada: {} };
    expect(toqueDoMapa(MAPA, dono, 3, SEM)?.id).toBe('dono_granja:carreira:1');
    expect(toqueDoMapa(MAPA, dono, 3, new Set(['dono_granja:carreira:1']))).toBeNull();
    expect(toqueDoMapa(MAPA, CLT, 2, new Set(['contratado:carreira:1']))?.id).toBe('contratado:carreira:2');
  });

  it('a pergunta de prioridade não entra no follow-up', () => {
    const todas = new Set(['contratado:carreira:1', 'contratado:carreira:2', 'contratado:ganho:3']);
    expect(toqueDoMapa(MAPA, CLT, 2, todas)).toBeNull();
    expect(toqueDoMapa(MAPA, CLT, 3, todas)).toBeNull();
  });

  it('sem saber como ele trabalha: só a pergunta que divide, uma vez, no toque 2', () => {
    const semPerfil = { vinculo_trabalho: null, jornada: {} };
    expect(toqueDoMapa(MAPA, semPerfil, 2, SEM)).toMatchObject({ id: '*:divide:0', etapa: 'divide', ramo: null });
    expect(toqueDoMapa(MAPA, semPerfil, 2, new Set(['*:divide:0']))).toBeNull();
    expect(toqueDoMapa(MAPA, semPerfil, 3, SEM)).toBeNull();
    expect(toqueDoMapa(MAPA, semPerfil, 4, SEM)).toBeNull();
  });

  it('o ramo decidido numa conversa vale mais que o vínculo', () => {
    expect(ramoDoLead(MAPA, { vinculo_trabalho: 'clt', jornada: { ramo_carreira: 'dono_granja' } })?.ramo).toBe('dono_granja');
    expect(ramoDoLead(MAPA, { vinculo_trabalho: 'consultor', jornada: {} })).toBeNull();
  });

  it('só conta como usado o que é deste mapa', () => {
    const jornada = { followup_carreira: [
      { escopo: escopoDoMapa('avicultura'), pergunta_id: 'contratado:carreira:1' },
      { escopo: 'sanidade_avicola', pergunta_id: 'sanidade_avicola:objetivo' },
      { escopo: escopoDoMapa('bovinos'), pergunta_id: 'autonomo:carreira:1' },
    ] };
    expect([...usadosDoMapa(jornada, 'avicultura')]).toEqual(['contratado:carreira:1']);
    expect(usadosDoMapa(null, 'avicultura').size).toBe(0);
  });
});

describe('a fala que sai', () => {
  const toque = toqueDoMapa(MAPA, CLT, 2, SEM)!;
  const ponte = toqueDoMapa(MAPA, CLT, 4, SEM)!;

  it('contexto do modelo + a pergunta como veio: passa', () => {
    const m = 'bacana, Kamila, você atua numa integradora. na empresa onde vc trabalha, eles valorizam quem estuda? quem tem pós cresce mais rápido aí dentro?';
    expect(falaDoToque(m, toque, 'Kamila', 'a pós em sanidade avícola')).toEqual({ fala: m, literalReposto: false });
  });

  it('o modelo trocou a pergunta: vai a literal, só com o nome', () => {
    const r = falaDoToque('Kamila, o que faria você se sentir mais valorizada no trabalho?', toque, 'Kamila', 'a pós em sanidade avícola');
    expect(r.literalReposto).toBe(true);
    expect(r.fala).toBe('Kamila, na empresa onde você trabalha, eles valorizam quem estuda? Quem tem pós cresce mais rápido aí dentro?');
  });

  it('silêncio do modelo é respeitado', () => {
    expect(falaDoToque('  ', toque, 'Kamila', '')).toEqual({ fala: '', literalReposto: false });
  });

  it('ponte: o convite precisa falar do monitor e não pode trazer horário nem preço', () => {
    const ok = 'Kamila, quer conhecer a pós em sanidade avícola numa conversa rápida no meet com o monitor? ele te mostra como essa pós se encaixa no seu momento.';
    expect(falaDoToque(ok, ponte, 'Kamila', 'a pós em sanidade avícola').literalReposto).toBe(false);
    for (const ruim of ['Kamila, a pós se encaixa no seu momento. vamos marcar?', 'tenho 19h com o monitor, pode ser?', 'o monitor te mostra por R$ 300']) {
      const r = falaDoToque(ruim, ponte, 'Kamila', 'a pós em sanidade avícola');
      expect(r.literalReposto).toBe(true);
      expect(r.fala).toBe('Kamila, quer conhecer a pós em sanidade avícola numa conversa rápida no meet com o monitor? ele te mostra como essa pós se encaixa no seu momento.');
    }
    expect(falaDoToque('x', ponte, '', '').fala).toBe('quer conhecer a pós numa conversa rápida no meet com o monitor? ele te mostra como essa pós se encaixa no seu momento.');
  });

  it('os dados do toque levam o que ele contou e a pergunta do mapa, sem o argumento interno', () => {
    const d = dadosDoToque(toque, 'Kamila', 'a pós em sanidade avícola', { area_atuacao: 'integradora de frango' });
    expect(d).toContain('"pergunta_do_mapa":"Na empresa onde você trabalha');
    expect(d).toContain('"o_que_ele_ja_contou":{"area_atuacao":"integradora de frango"}');
    expect(d).not.toContain('plano de carreira');
    expect(dadosDoToque(ponte, '', '', null)).toContain('"ponte_do_convite":"como essa pós se encaixa no seu momento"');
  });
});

describe('fora do mapa e a chave', () => {
  it('toques 1 e 5 a 7: sobra só o que retoma algo concreto', () => {
    const plano = { escopo: 'x', perguntas: [{ id: 'x:objetivo' }], retomadas: [
      { id: 'retomada:agenda_interesse', tipo: 'agenda' }, { id: 'retomada:geral_duvida', tipo: 'geral' },
      { id: 'retomada:geral_experiencia', tipo: 'geral' }, { id: 'retomada:geral_material', tipo: 'geral' },
    ] };
    const r = soRetomadasConcretas(plano);
    expect(r.perguntas).toEqual([]);
    expect(r.retomadas.map((x) => x.id)).toEqual(['retomada:agenda_interesse', 'retomada:geral_material']);
    expect(r.escopo).toBe('x');
  });

  it('desligada por padrão; liga para todos ou só para o telefone de ensaio', async () => {
    const banco = (data: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
    expect(await followupMapaLigado(banco({ followup_mapa: false, followup_mapa_telefones: [] }), '5546988166051')).toBe(false);
    expect(await followupMapaLigado(banco({ followup_mapa: true, followup_mapa_telefones: [] }), '5511999990000')).toBe(true);
    const soTeste = banco({ followup_mapa: false, followup_mapa_telefones: ['5546988166051'] });
    expect(await followupMapaLigado(soTeste, '554688166051@s.whatsapp.net')).toBe(true);
    expect(await followupMapaLigado(soTeste, '5534988525202')).toBe(false);
    expect(await followupMapaLigado(banco(null, { message: 'x' }), '5546988166051')).toBe(false);
  });
});
