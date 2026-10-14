import { describe, expect, it } from 'vitest';
import { avaliarEvidenciaSemGraduacao, respostaCurtaLigada } from './evidenciaFormacao.ts';
import type { Msg } from './historico.ts';

const ia = (texto: string): Msg => ({ role: 'assistant', content: texto });
const lead = (texto: string): Msg => ({ role: 'user', content: texto });
const comCitacao = (pergunta: string, resposta: string) => lead(`[Em resposta à mensagem: "${pergunta}"] ${resposta}`);
const ok = (h: Msg[]) => avaliarEvidenciaSemGraduacao(h, { respostaCurta: true });

// Caso Marciano (14/10/2026): quatro perguntas seguidas porque a guarda barrou o encerramento.
const MARCIANO: Msg[] = [
  lead('Receber Cronograma'),
  lead('11 horas'),
  ia('certo, 11h de hoje é para a conversa com o monitor, no horário de brasília. pra eu te enviar o cronograma, vc chegou a cursar alguma graduação? se sim, qual curso e já concluiu?'),
  comCitacao('certo, 11h de hoje é para a conversa com o monitor…', 'Não'),
  ia('certo. vc está cursando alguma graduação atualmente ou tem apenas ensino médio/técnico?'),
  lead('Sim estou parado'),
  ia('certo. quando vc diz que está parado, chegou a iniciar uma graduação e interrompeu, ou nunca cursou uma?'),
  comCitacao('certo. quando vc diz que está parado, chegou a iniciar uma graduação e interrompeu, ou nunca cursou uma?', 'Nunca nem uma'),
];

describe('resposta curta à pergunta de graduação', () => {
  it('caso Marciano: "Nunca nem uma" responde "…ou nunca cursou uma?"', () => {
    expect(ok(MARCIANO)).toMatchObject({ autorizada: true, motivo: 'resposta_a_pergunta' });
    // Sem a chave, segue como hoje: barrado.
    expect(avaliarEvidenciaSemGraduacao(MARCIANO).autorizada).toBe(false);
  });

  it('"Não" a "vc chegou a cursar alguma graduação?" já bastava', () => {
    expect(ok(MARCIANO.slice(0, 4)).autorizada).toBe(true);
  });

  it.each(['nunca', 'Nenhuma', 'nunca fiz', 'só ensino médio', 'apenas o ensino médio', 'tenho só o técnico'])('vale: %s', (r) => {
    expect(ok([ia('vc chegou a cursar alguma faculdade?'), lead(r)]).autorizada).toBe(true);
  });

  it('confirmação negativa: "sim" a "vc nunca iniciou uma graduação…?"', () => {
    expect(ok([ia('só pra confirmar, vc nunca iniciou uma graduação e não está cursando nenhuma atualmente?'), lead('Sim')]).autorizada).toBe(true);
    expect(ok([ia('só pra confirmar, vc nunca iniciou uma graduação e não está cursando nenhuma atualmente?'), lead('isso')]).autorizada).toBe(true);
  });

  it('pergunta com duas saídas: "sim" ou "não" não decidem', () => {
    const p = ia('vc está cursando alguma graduação atualmente ou tem apenas ensino médio/técnico?');
    expect(ok([p, lead('Sim')]).autorizada).toBe(false);
    expect(ok([p, lead('Não')]).autorizada).toBe(false);
    expect(ok([p, lead('Sim estou parado')]).autorizada).toBe(false);
    expect(ok([p, lead('só ensino médio')]).autorizada).toBe(true);
  });

  it('"não" a "tem graduação?" fica de fora: pode vir de quem ainda está cursando', () => {
    expect(ok([ia('vc tem graduação?'), lead('não')]).autorizada).toBe(false);
    expect(ok([ia('vc já concluiu alguma graduação?'), lead('Não')]).autorizada).toBe(false);
    expect(ok([ia('vc tem graduação?'), lead('nunca')]).autorizada).toBe(true);
  });

  it('caso Angélica: "nenhuma" sobre área de atuação não é falta de graduação', () => {
    expect(ok([ia('e em que área vc atua hoje?'), lead('nenhuma')]).autorizada).toBe(false);
    expect(ok([ia('vc trabalha com bovinos ou aves?'), lead('nenhuma')]).autorizada).toBe(false);
  });

  it('qualquer fala com curso, semestre ou estudo continua bloqueando', () => {
    expect(ok([lead('faço técnico e estou no 2 semestre'), ia('vc chegou a cursar alguma graduação?'), lead('nunca')]).autorizada).toBe(false);
    expect(ok([ia('vc chegou a cursar alguma graduação?'), lead('não, estou cursando')]).autorizada).toBe(false);
  });

  it('resposta longa, pergunta de volta ou fala de vendedor não contam', () => {
    expect(ok([ia('vc chegou a cursar alguma graduação?'), lead('não sei se conta mas fiz uns cursos online de gestão no ano passado')]).autorizada).toBe(false);
    expect(ok([ia('vc chegou a cursar alguma graduação?'), lead('nunca?')]).autorizada).toBe(false);
    expect(ok([ia('[ATENDIMENTO_HUMANO] Erika · vc chegou a cursar alguma graduação?'), lead('não')]).autorizada).toBe(false);
    expect(ok([lead('não')]).autorizada).toBe(false);
  });

  it('a chave: desligada por padrão; liga para todos ou só para o telefone de ensaio', async () => {
    const cfg = (data: unknown) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) }) });
    expect(await respostaCurtaLigada(cfg({ sem_graduacao_resposta_curta: false, sem_graduacao_resposta_curta_telefones: [] }), '5546988166051')).toBe(false);
    expect(await respostaCurtaLigada(cfg({ sem_graduacao_resposta_curta: true, sem_graduacao_resposta_curta_telefones: [] }), '5511999990000')).toBe(true);
    expect(await respostaCurtaLigada(cfg({ sem_graduacao_resposta_curta: false, sem_graduacao_resposta_curta_telefones: ['5546988166051'] }), '554688166051')).toBe(true);
  });
});

describe('ajustes do replay das 176 rodadas barradas (14/10/2026)', () => {
  it('a última fala nossa foi do vendedor: a regra não decide', () => {
    const h: Msg[] = [
      ia('vc nunca cursou uma graduação?'),
      ia('[ATENDIMENTO_HUMANO] Welinton · [Transcrição do áudio] Vou arquivar o seu contato e quando tiver mais perto de se formar a gente entra em contato, tá?'),
      lead('Isso'),
    ];
    expect(ok(h).autorizada).toBe(false);
  });

  it.each(['Eu nem tenho faculdade', 'boa tarde, não tenho curso superior amigo, vou agradecer', 'mais eu n tenho graduação',
    'não eu só trabalho de roça eu nunca fiz faculdade não porque não deu', 'bom dia. eu não tenho nenhuma formação não, entendeu'])(
    'declaração dentro de uma resposta mais longa: %s', (r) => {
      expect(ok([ia('vc chegou a cursar alguma graduação?'), lead(r)]).autorizada).toBe(r.includes('vou agradecer') ? false : true);
    });

  it('"ainda", "cursar" ou "vou" na resposta tiram do caso', () => {
    expect(ok([ia('vc chegou a cursar alguma graduação?'), lead('agradeço pela oportunidade, mas não possuo graduação ainda')]).autorizada).toBe(false);
    expect(ok([ia('vc chegou a cursar alguma graduação?'), lead('não, mas tenho interesse em cursar veterinária')]).autorizada).toBe(false);
  });

  it('"não tenho graduação" a "qual é a sua graduação?" fica de fora (pode ser estudante)', () => {
    expect(ok([ia('certo. qual é a sua graduação?'), lead('não tenho graduação')]).autorizada).toBe(false);
    expect(ok([ia('certo. qual é a sua graduação?'), lead('ensino médio completo')]).autorizada).toBe(true);
  });
});
