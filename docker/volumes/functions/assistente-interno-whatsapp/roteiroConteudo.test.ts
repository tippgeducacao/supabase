import { describe, expect, it } from 'vitest';
import {
  aulasDaNoite, chaveAoVivo, chaveRoteiro, diaPorExtenso, encurtar, escolherTopicos, horarioLegivel,
  itensDoDia, limparIdeias, naJanelaAoVivo, naJanelaRoteiro, promptIdeias, textoAoVivo, textoRoteiro,
  type AulaDoDia, type DadosRoteiro, type ItemGrade,
} from './roteiroConteudo';

// Currículo real (ped_professores.curriculo_topicos) da aula de 13/10/2026.
const TOPICOS_DANIELA = [
  { titulo: 'Formação', texto: 'Zootecnista com domínio consolidado em nutrição e manejo de gado de corte.' },
  { titulo: 'Titulação', texto: 'Doutora com especialização em exigências nutricionais, formulação de dietas e manejo reprodutivo.' },
  { titulo: 'Atuação em Campo', texto: 'Dimensiona exigências nutricionais para engorda, terminação e confinamento.' },
  { titulo: 'Expertise Prática', texto: 'Coordena aplicação do NASEM 2016.' },
  { titulo: 'Nas Aulas', texto: 'Conecta formulação dietética a desempenho reprodutivo e produtivo.' },
];

const AULA: AulaDoDia = {
  id: 'a1',
  titulo: 'Indicadores Zootécnicos para Gado de Corte',
  horario: '19:00 - 22:00',
  curso: 'Reprodução, Nutrição e Gestão de Bovinos',
  professor: 'Daniela Wetzel Gastal',
  titulacao: 'Doutora',
  topicos: escolherTopicos(TOPICOS_DANIELA),
  ementa: 'Objetivos e metas da Bovinocultura de Corte. Indicadores zootecnicos: Idade ao Primeiro Parto.',
};

const GRADE: ItemGrade[] = [
  { dia_semana: 2, ordem: 2, quando: '19h às 22h', o_que: 'Print de um slide', formato: 'stories', quem: 'você' },
  { dia_semana: 2, ordem: 1, quando: 'Durante o dia', o_que: 'Aquecimento da aula', formato: 'stories', quem: 'você' },
  { dia_semana: 3, ordem: 1, quando: 'Manhã', o_que: 'Carrossel técnico', formato: 'carrossel', quem: 'marketing' },
];

function dados(ymd: string, extra: Partial<DadosRoteiro> = {}): DadosRoteiro {
  return {
    apelido: 'Rafa', ymd, itens: itensDoDia(GRADE, ymd), cards: [], acompanhaAulas: true,
    aulasHoje: [], aulasOntem: [], ...extra,
  };
}

describe('datas e janelas', () => {
  it('escreve o dia por extenso', () => {
    expect(diaPorExtenso('2026-10-13')).toBe('terça-feira, 13/10');
    expect(diaPorExtenso('2026-10-18')).toBe('domingo, 18/10');
  });
  it('roteiro sai das 7h às 10h59; lembrete das 19h30 às 21h59', () => {
    expect(naJanelaRoteiro(6 * 60 + 59)).toBe(false);
    expect(naJanelaRoteiro(7 * 60)).toBe(true);
    expect(naJanelaRoteiro(11 * 60)).toBe(false);
    expect(naJanelaAoVivo(19 * 60 + 29)).toBe(false);
    expect(naJanelaAoVivo(19 * 60 + 30)).toBe(true);
    expect(naJanelaAoVivo(22 * 60)).toBe(false);
  });
  it('uma chave por dono e por dia', () => {
    expect(chaveRoteiro('4699321082', '2026-10-13')).toBe('roteiro:4699321082:2026-10-13');
    expect(chaveAoVivo('4699321082', '2026-10-13')).toBe('aovivo:4699321082:2026-10-13');
  });
});

describe('grade do dia', () => {
  it('filtra pelo dia da semana e ordena', () => {
    expect(itensDoDia(GRADE, '2026-10-13').map((i) => i.o_que)).toEqual(['Aquecimento da aula', 'Print de um slide']);
    expect(itensDoDia(GRADE, '2026-10-16')).toEqual([]);
  });
});

describe('currículo do professor', () => {
  it('prefere atuação em campo e aulas; deixa a titulação de fora', () => {
    expect(escolherTopicos(TOPICOS_DANIELA)).toEqual([
      'Dimensiona exigências nutricionais para engorda, terminação e confinamento.',
      'Conecta formulação dietética a desempenho reprodutivo e produtivo.',
    ]);
  });
  it('aguenta currículo vazio ou malformado', () => {
    expect(escolherTopicos(null)).toEqual([]);
    expect(escolherTopicos([{ titulo: 'Titulação', texto: 'Mestre' }, { foo: 1 }])).toEqual([]);
  });
});

describe('horário e texto curto', () => {
  it('lê o horário da aula', () => {
    expect(horarioLegivel('19:00 - 22:00')).toBe('19h às 22h');
    expect(horarioLegivel('19:30')).toBe('19h30');
    expect(horarioLegivel('a combinar')).toBe('a combinar');
    expect(horarioLegivel(null)).toBeNull();
  });
  it('só aula que começa à noite ganha o lembrete', () => {
    const pratico = { ...AULA, id: 'p', horario: '08:00 - 18:00' };
    const semHora = { ...AULA, id: 's', horario: null };
    expect(aulasDaNoite([pratico, semHora, AULA]).map((a) => a.id)).toEqual(['a1']);
  });
  it('corta sem partir palavra', () => {
    expect(encurtar('uma frase bem comprida para cortar', 15)).toBe('uma frase bem…');
    expect(encurtar('curta', 15)).toBe('curta');
    expect(encurtar('   ', 15)).toBeNull();
  });
});

describe('mensagem das 7h', () => {
  it('terça com aula: grade, aula com currículo e ementa, Planner vazio e ideias', () => {
    const t = textoRoteiro(dados('2026-10-13', { aulasHoje: [AULA] }), '1. *Ideia*\nGancho.');
    expect(t).toContain('☀️ Bom dia, Rafa! Seu roteiro de hoje, terça-feira, 13/10:');
    expect(t).toContain('• *Durante o dia:* Aquecimento da aula _(stories · você)_');
    expect(t).toContain('*Aula de hoje* (Reprodução, Nutrição e Gestão de Bovinos, 19h às 22h)');
    expect(t).toContain('Com Daniela Wetzel Gastal, doutora');
    expect(t).toContain('• Dimensiona exigências nutricionais');
    expect(t).toContain('_Ementa:_ Objetivos e metas');
    expect(t).toContain('*No Planner:* nada lançado para o seu perfil hoje.');
    expect(t).toContain('*Ideias do dia*\n1. *Ideia*\nGancho.');
    expect(t).not.toContain('—');
  });
  it('terça sem aula avisa; quem não acompanha pós não recebe o aviso', () => {
    expect(textoRoteiro(dados('2026-10-13'), null)).toContain('não achei aula da pós no cronograma de hoje');
    expect(textoRoteiro(dados('2026-10-13', { acompanhaAulas: false }), null)).not.toContain('não achei aula');
  });
  it('quarta lembra que o carrossel sai da aula de ontem', () => {
    const t = textoRoteiro(dados('2026-10-14', { aulasOntem: [AULA] }), null);
    expect(t).toContain('*Carrossel de hoje:* sai da aula de ontem, Indicadores Zootécnicos para Gado de Corte, com Daniela Wetzel Gastal.');
  });
  it('lista o que o marketing lançou no Planner, com formato e status', () => {
    const t = textoRoteiro(dados('2026-10-16', { cards: [{ title: 'Photo dump', format: 'carrossel', status: 'review_initial' }] }), null);
    expect(t).toContain('*No Planner para hoje*\n• Carrossel: Photo dump (aprovação inicial)');
  });
  it('sem ideias da IA, a grade sai assim mesmo', () => {
    expect(textoRoteiro(dados('2026-10-13'), null)).toContain('As ideias do dia não vieram desta vez');
  });
});

describe('lembrete das 19h30', () => {
  it('cita a aula e quem dá', () => {
    expect(textoAoVivo('Rafa', AULA)).toBe('🎥 Rafa, a aula começou: *Indicadores Zootécnicos para Gado de Corte*, com Daniela Wetzel Gastal. Hora do print de um slide nos stories, com a chamada para a pós.');
  });
});

describe('ideias da IA', () => {
  it('o pedido leva a grade, a aula e o currículo, e proíbe inventar', () => {
    const { system, user } = promptIdeias(dados('2026-10-13', { aulasHoje: [AULA] }));
    expect(system).toContain('exatamente 3 ideias');
    expect(system).toContain('Não invente fato');
    expect(user).toContain('Aula da pós hoje à noite (Reprodução, Nutrição e Gestão de Bovinos): Indicadores Zootécnicos para Gado de Corte.');
    expect(user).toContain('Quem dá a aula: Daniela Wetzel Gastal, doutora.');
    expect(user).toContain('- Durante o dia: Aquecimento da aula (stories)');
  });
  it('limpa a moldura, o travessão e o negrito de markdown', () => {
    const bruto = 'Aqui estão as 3 ideias:\n\n1. **Chegada** — mostra a equipe\nGancho forte.';
    expect(limparIdeias(bruto)).toBe('1. *Chegada*, mostra a equipe\nGancho forte.');
    expect(limparIdeias('')).toBeNull();
  });
});
