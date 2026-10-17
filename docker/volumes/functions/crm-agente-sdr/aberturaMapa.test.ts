import { describe, expect, it } from 'vitest';
import { aberturaMapaLigada, blocoDaAbertura, comPassoDoMapa, faseDaAbertura } from './aberturaMapa';
import { LUNA_PERSONA_ABERTURA } from './prompts-luna';

// Mapa de Cannabis como está em sdr_carreira_mapa_* (16/10/2026), recortado.
const MAPA = {
  grupo: 'cannabis',
  ramos: [
    { ramo: 'contratado', nome: 'Veterinário contratado de clínica ou plantonista', vinculos: ['clt'], sinais: ['plantão'], argumento: null,
      ponte_convite: 'como a pós te leva a ser a referência em cannabis na sua região', ordem: 1 },
    { ramo: 'dono', nome: 'Dono de clínica ou veterinário que faz atendimento a domicílio', vinculos: ['proprietario', 'autonomo'], sinais: null, argumento: null,
      ponte_convite: 'como a pós te leva a ser a referência em cannabis na sua região', ordem: 2 },
  ],
  perguntas: [
    { ramo: '*', etapa: 'divide', texto: 'Hoje você é contratado de uma clínica, tem a sua própria clínica ou faz atendimento a domicílio?', ordem: 1 },
    { ramo: 'contratado', etapa: 'carreira', texto: 'Os tutores já te perguntaram se você prescreve?', ordem: 1 },
    { ramo: 'contratado', etapa: 'carreira', texto: 'Você quer sair do plantão?', ordem: 3 },
    { ramo: 'dono', etapa: 'carreira', texto: 'Você quer oferecer um serviço que os concorrentes da sua região ainda não têm?', ordem: 3 },
    { ramo: 'contratado', etapa: 'ganho', texto: 'Quanto você cobra hoje por consulta?', ordem: 1 },
    { ramo: '*', etapa: 'prioridade', texto: 'Por que você está buscando essa pós agora?', ordem: 2 },
  ],
} as any;

const TEMPLATE = 'Oii Dani Tudo bem?\n\nMe fala, você já atua na área clínica e prescreve Cannabis Medicinal?\n\nConsegue me retornar?';
const h = (...m: [string, string][]) => m.map(([role, content]) => ({ role, content })) as any;

describe('a fase antes do convite', () => {
  it('caso Dani: depois do template, ainda cabe pergunta, e a que divide vai junto', () => {
    const hist = h(['assistant', TEMPLATE], ['user', 'Olá bom dia'], ['user', 'Não prescrevo']);
    const f = faseDaAbertura(MAPA, hist, { jornada: {} })!;
    expect(f).toMatchObject({ fase: 'perguntar', feitas: 0, perfil: null });
    const b = blocoDaAbertura(MAPA, f, hist);
    expect(b).toContain('CONHECER A PESSOA');
    expect(b).toContain('"Hoje você é contratado de uma clínica');
    expect(b).toContain('"Os tutores já te perguntaram se você prescreve?"');
    expect(b).toContain('ponte do convite: "como a pós te leva');
  });

  it('quem ainda não atua: as perguntas de momento do mapa (caso Lua)', () => {
    const hist = h(['assistant', TEMPLATE], ['user', 'Não, quero começar']);
    const b = blocoDaAbertura(MAPA, faseDaAbertura(MAPA, hist, { jornada: {} })!, hist);
    expect(b).toContain('ainda não atua nessa área');
    expect(b).toContain('"Por que você está buscando essa pós agora?"');
  });

  it('pergunta feita sai da lista; com duas feitas é hora da abertura, sem perguntas', () => {
    const uma = h(['assistant', TEMPLATE], ['user', 'Não prescrevo'],
      ['assistant', 'certo. e hoje vc é contratada de uma clínica, tem a sua própria clínica ou faz atendimento a domicílio?'], ['user', 'sou contratada']);
    const f1 = faseDaAbertura(MAPA, uma, { jornada: {} })!;
    expect(f1).toMatchObject({ fase: 'perguntar', feitas: 1 });
    expect(blocoDaAbertura(MAPA, f1, uma)).not.toContain('a pergunta que divide');
    const duas = [...uma, ...h(['assistant', 'bacana. os tutores já te perguntaram se vc prescreve?'], ['user', 'sim, várias vezes'])];
    const f2 = faseDaAbertura(MAPA, duas, { vinculo_trabalho: 'clt' })!;
    expect(f2).toMatchObject({ fase: 'abertura', feitas: 2 });
    expect(f2.perfil?.ramo).toBe('contratado');
    const b = blocoDaAbertura(MAPA, f2, duas);
    expect(b).toContain('HORA DA ABERTURA');
    expect(b).not.toContain('perguntas de carreira');
    expect(b).not.toContain('Dono de clínica');
  });

  it('perfil conhecido: sem a pergunta que divide, só as do perfil', () => {
    const hist = h(['assistant', TEMPLATE], ['user', 'tenho minha clínica']);
    const b = blocoDaAbertura(MAPA, faseDaAbertura(MAPA, hist, { vinculo_trabalho: 'proprietario' })!, hist);
    expect(b).not.toContain('a pergunta que divide');
    expect(b).toContain('concorrentes da sua região');
    expect(b).not.toContain('Os tutores já te perguntaram');
  });

  it('convite já feito ou vendedor na conversa: o mapa sai de cena', () => {
    expect(faseDaAbertura(MAPA, h(['assistant', TEMPLATE], ['user', 'oi'],
      ['assistant', 'a gente tá fechando o primeiro lote promocional da pós em cannabis… é uma conversa rápida no meet com um monitor especialista'], ['user', 'ok']), {})).toBeNull();
    expect(faseDaAbertura(MAPA, h(['assistant', TEMPLATE], ['assistant', '[ATENDIMENTO_HUMANO] Welinton · podemos falar agora?']), {})).toBeNull();
    expect(faseDaAbertura(MAPA, [], {})).toBeNull();
  });
});

describe('o passo 1 do prompt da Luna', () => {
  it('troca a abertura imediata por conhecer a pessoa, com a frase do lote intacta', () => {
    const { prompt, trocou } = comPassoDoMapa(LUNA_PERSONA_ABERTURA);
    expect(trocou).toBe(true);
    expect(prompt).toContain('1. **Antes da abertura, conheça a pessoa.**');
    expect(prompt).toContain('   > a gente tá fechando o primeiro lote promocional {{ $json.curso_com_artigo }}, e eu queria te mostrar a condição');
    expect(prompt).not.toContain('a mesma resposta traz a reação, a abertura inteira e o convite');
    expect(prompt).toContain('2. **Aceitou a conversa com o monitor');
  });

  it('prompt sem o passo fica igual', () => {
    expect(comPassoDoMapa('outro prompt')).toEqual({ prompt: 'outro prompt', trocou: false });
  });

  it('a chave: desligada por padrão; liga para todos ou só para o telefone de ensaio', async () => {
    const banco = (data: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
    expect(await aberturaMapaLigada(banco({ abertura_mapa: false, abertura_mapa_telefones: [] }), '5546988166051')).toBe(false);
    expect(await aberturaMapaLigada(banco({ abertura_mapa: true, abertura_mapa_telefones: [] }), '5511999990000')).toBe(true);
    expect(await aberturaMapaLigada(banco({ abertura_mapa: false, abertura_mapa_telefones: ['5546988166051'] }), '554688166051')).toBe(true);
    expect(await aberturaMapaLigada(banco(null, { message: 'x' }), '5546988166051')).toBe(false);
  });
});

describe('a contagem de perguntas antes do convite (caso Franciele)', () => {
  it('follow-up, robô e "fico no aguardo" não contam; só a pergunta que respondeu ao lead', () => {
    const hist = h(['assistant', TEMPLATE],
      ['user', 'Olá, agradeço o seu contato. Sua mensagem será respondida assim que possível, deixe uma mensagem resumindo como posso te ajudar'],
      ['assistant', 'fico no aguardo'],
      ['user', '[INTERNAL_MARKER_FOLLOWUP_AUTO_IGNORE]'], ['assistant', 'Franciele, pode conversar agora?'],
      ['user', 'Bom dia, tudo bem?'], ['assistant', 'bom dia, tudo bem por aqui. hoje vc é contratado de uma clínica, tem sua própria clínica ou faz atendimento a domicílio?'],
      ['user', 'Eu sou plantonista. Faço atendimento domiciliar tbm']);
    expect(faseDaAbertura(MAPA, hist, { jornada: {} })).toMatchObject({ fase: 'perguntar', feitas: 1 });
  });
});
