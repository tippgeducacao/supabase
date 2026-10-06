import { describe, expect, it } from 'vitest';
import { blocoCarreira, carregarCarreiraPorNome } from './carreiraPos';

const linhas = [
  { perfil: 'plantonista', moeda: 'preco', pergunta_dor: 'ainda precisaria do plantão?', ponte_convite: 'como encaixa no plantão', observacao: null },
  { perfil: 'outra_area', moeda: null, pergunta_dor: null, ponte_convite: null, observacao: 'exclusiva para médico-veterinário' },
];

describe('bloco CARREIRA', () => {
  it('cada perfil com sinais, pergunta de dor e ponte; objeções da pós no fim', () => {
    const b = blocoCarreira({ linhas, objecoes: [{ objecao: 'não tenho tempo', resposta: 'quase tudo é gravado' }] }, 'Cannabis');
    expect(b).toContain('CARREIRA — Cannabis');
    expect(b).toContain('- plantonista (faz plantão) · PERGUNTA DE DOR: "ainda precisaria do plantão?" · PONTE: como encaixa no plantão');
    expect(b).toContain('- outra_area (formação fora das aceitas pela pós) · exclusiva para médico-veterinário');
    expect(b).toContain('- "não tenho tempo": quase tudo é gravado');
  });

  it('sem dados, sem bloco; falha de leitura não derruba', async () => {
    expect(blocoCarreira(null, 'x')).toBe('');
    const quebrado = { from: () => { throw new Error('fora'); } };
    expect(await carregarCarreiraPorNome(quebrado as any, 'Cannabis')).toBeNull();
    expect(await carregarCarreiraPorNome(quebrado as any, '')).toBeNull();
  });
});

describe('objeção da pós pelo tipo', () => {
  it('devolve a resposta da pós; sem tipo ou sem pós, null', async () => {
    const { objecaoDaPos } = await import('./carreiraPos');
    const banco = { from: (t: string) => {
      const q: any = { select: () => q, eq: () => q, order: () => q, limit: async () => t === 'cursos'
        ? { data: [{ id: 'c1' }], error: null }
        : { data: [{ objecao: 'tá caro', resposta: 'a conversa é pra vc decidir com calma' }], error: null } };
      return q;
    } };
    expect(await objecaoDaPos(banco as any, 'PÓS | CANNABIS', 'objecao_financeira')).toEqual({ objecao: 'tá caro', resposta: 'a conversa é pra vc decidir com calma' });
    expect(await objecaoDaPos(banco as any, 'PÓS | CANNABIS', '')).toBeNull();
    expect(await objecaoDaPos(banco as any, '', 'objecao_financeira')).toBeNull();
  });
});

describe('objeção de tempo: reunião ou pós', () => {
  it('fala sobre estudar = pós; depois do convite = conversa', async () => {
    const { sobreDaObjecaoDeTempo } = await import('./carreiraPos');
    expect(sobreDaObjecaoDeTempo('eu gostaria mas to sem tempo', 'topa conhecer a pós numa conversa rápida no meet com o monitor?')).toBe('conversa');
    expect(sobreDaObjecaoDeTempo('não tenho tempo pra estudar', 'topa uma conversa no meet?')).toBe('pos');
    expect(sobreDaObjecaoDeTempo('to sem tempo', 'o que mais te chamou atenção na aula?')).toBe('pos');
    expect(sobreDaObjecaoDeTempo('sem tempo pra reunião', 'qual sua área?')).toBe('conversa');
  });
});

describe('perfis próprios da pós (06/10/2026)', () => {
  const proprias = [
    { perfil: 'outra_frente', nome: 'Vet de outra frente', sinais: ['nunca trabalhei com aves'], base: 'quer_entrar', ordem: 2,
      moeda: 'territorio', pergunta_dor: null, ponte_convite: 'como entrar no mercado de ovos', observacao: null, perguntas: [] },
    { perfil: 'produtor_granja', nome: 'Produtor de ovos', sinais: ['tenho granja'], base: 'clinica_propria', ordem: 1,
      moeda: 'preco', pergunta_dor: 'anota a postura?', ponte_convite: 'comandar a granja por número', observacao: null,
      perguntas: [{ pergunta: 'vc anota a postura todo dia?', lacuna: 'sem indicador', se_sim: 'e vira taxa?', se_nao: 'entendi.' }] },
    { perfil: 'estudante', moeda: null, pergunta_dor: null, ponte_convite: null, observacao: 'ainda cursa' },
    { perfil: 'quer_entrar', moeda: 'territorio', pergunta_dor: 'genérica', ponte_convite: 'genérica', observacao: null },
  ];

  it('a busca oferece os perfis da pós, na ordem, com as falas; estudante e outra_area sempre', async () => {
    const { toolBuscaCarreira } = await import('./carreiraPos');
    const perfil = toolBuscaCarreira(proprias).input_schema.properties.perfil;
    expect(perfil.enum).toEqual(['produtor_granja', 'outra_frente', 'estudante', 'outra_area']);
    expect(perfil.description).toContain('produtor_granja: Produtor de ovos (fala como: "tenho granja")');
    for (const p of perfil.enum) expect(perfil.description).toContain(`${p}:`);
  });

  it('sem perfis próprios, os 9 genéricos', async () => {
    const { toolBuscaCarreira, SINAIS_DO_PERFIL } = await import('./carreiraPos');
    expect(toolBuscaCarreira(linhas).input_schema.properties.perfil.enum).toEqual(Object.keys(SINAIS_DO_PERFIL));
    expect(toolBuscaCarreira(null).input_schema.required).toEqual(['perfil']);
  });

  it('perfil fora da tabela cai no próprio de quem quer entrar; estudante não cai', async () => {
    const { linhaDoPerfil } = await import('./carreiraPos');
    expect(linhaDoPerfil(proprias, 'produtor_granja')?.perfil).toBe('produtor_granja');
    expect(linhaDoPerfil(proprias, 'industria_rt')?.perfil).toBe('outra_frente');
    expect(linhaDoPerfil(proprias, 'outra_area')).toBeNull();
    expect(linhaDoPerfil(proprias, 'estudante')?.perfil).toBe('estudante');
    expect(linhaDoPerfil(linhas, 'contratado')).toBeNull();
  });

  it('perguntas de indagação; linha antiga vira uma pergunta só', async () => {
    const { perguntasDaLinha } = await import('./carreiraPos');
    expect(perguntasDaLinha(proprias[1] as any)).toHaveLength(1);
    expect(perguntasDaLinha(proprias[1] as any)[0].se_sim).toBe('e vira taxa?');
    expect(perguntasDaLinha(linhas[0] as any)).toEqual([{ pergunta: 'ainda precisaria do plantão?' }]);
    expect(perguntasDaLinha(linhas[1] as any)).toEqual([]);
  });

  it('vínculos de trabalho: os 6 aprovados', async () => {
    const { VINCULOS_TRABALHO } = await import('./carreiraPos');
    expect(Object.keys(VINCULOS_TRABALHO)).toEqual(['clt', 'autonomo', 'consultor', 'proprietario', 'servidor_publico', 'sem_trabalho']);
  });
});
