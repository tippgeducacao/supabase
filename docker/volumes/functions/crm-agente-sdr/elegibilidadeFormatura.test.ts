import { describe, expect, it } from 'vitest';
import {
  avaliarConclusao,
  blocoElegibilidadeFormatura,
  decidirPrazoEstudante,
  instrucaoPerguntarConclusao,
  lerConclusao,
  limiteFormatura,
  limiteFormaturaFormatado,
} from './elegibilidadeFormatura.ts';

// Régua (usuário, 2026-08-06): elegível quem conclui a graduação em até 3 meses OU até
// 31/12 do ano corrente — o que for MAIOR. "Quem se forma em dezembro já pode conhecer a
// pós." Aritmética de calendário quebra nas bordas, então elas estão todas aqui.

/** Instante UTC equivalente a uma hora de Brasília (UTC-3). */
const brt = (iso: string) => new Date(`${iso}-03:00`);

const emDias = (agora: Date) => {
  const base = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  return Math.round((limiteFormatura(agora).getTime() - base.getTime()) / 86_400_000);
};

describe('limiteFormatura', () => {
  it('em agosto, alcança 31/12 do ano corrente (o caso que motivou a mudança)', () => {
    expect(limiteFormaturaFormatado(brt('2026-08-06T12:00:00'))).toBe('31/12/2026');
  });

  it('quem se forma em dezembro é elegível; quem se forma no ano seguinte, não', () => {
    const agora = brt('2026-08-06T12:00:00');
    const limite = limiteFormatura(agora);
    expect(new Date(Date.UTC(2026, 11, 15)) <= limite).toBe(true);  // 15/12/2026 entra
    expect(new Date(Date.UTC(2027, 2, 1)) <= limite).toBe(false);   // 01/03/2027 não
  });

  it('no início do ano a janela cobre o ano inteiro', () => {
    expect(limiteFormaturaFormatado(brt('2026-01-01T09:00:00'))).toBe('31/12/2026');
    expect(limiteFormaturaFormatado(brt('2027-01-31T09:00:00'))).toBe('31/12/2027');
  });

  // ⚠️ O PISO É O CORAÇÃO DA RÉGUA: sem ele, "até dezembro" ficaria MAIS restritiva que os
  // 90 dias antigos a cada fim de ano (em 20/12 sobrariam 10 dias) e quem se forma em
  // fevereiro passaria a ser recusado — regressão silenciosa, todo mês de novembro.
  it('nunca fica mais restritiva que os 3 meses antigos, em nenhuma data do ano', () => {
    for (let mes = 0; mes < 12; mes++) {
      for (const dia of [1, 15, 28]) {
        const agora = new Date(Date.UTC(2026, mes, dia, 15, 0, 0));
        expect(emDias(agora)).toBeGreaterThanOrEqual(89); // 3 meses ≈ 89-92 dias
      }
    }
  });

  it('no fim do ano o piso de 3 meses assume e atravessa a virada', () => {
    expect(limiteFormaturaFormatado(brt('2026-10-15T09:00:00'))).toBe('15/01/2027');
    expect(limiteFormaturaFormatado(brt('2026-12-20T09:00:00'))).toBe('20/03/2027');
  });

  it('vira o ano junto com Brasília, não com o UTC', () => {
    // 31/12/2026 23:00 BRT = 01/01/2027 02:00 UTC. Se lesse UTC, o ano seria 2027 e a
    // janela pularia para 31/12/2027 — quase um ano a mais, em silêncio.
    expect(limiteFormaturaFormatado(brt('2026-12-31T23:00:00'))).toBe('31/03/2027');
  });

  it('sobrevive a mês de 31 dias e a ano bissexto', () => {
    expect(limiteFormaturaFormatado(brt('2026-10-31T09:00:00'))).toBe('31/01/2027');
    expect(limiteFormaturaFormatado(brt('2028-02-29T09:00:00'))).toBe('31/12/2028');
  });
});

describe('blocoElegibilidadeFormatura', () => {
  it('entrega a data pronta ao modelo e o proíbe de calcular de cabeça', () => {
    const bloco = blocoElegibilidadeFormatura(brt('2026-08-06T12:00:00'));
    expect(bloco).toContain('31/12/2026');
    expect(bloco).toMatch(/não calcule/i);
  });

  it('avisa que a régua é interna e não pode ser citada ao lead', () => {
    expect(blocoElegibilidadeFormatura()).toMatch(/NUNCA cite ao lead/i);
  });

  // Com a régua nova o caminho "aprovado" ficou MUITO mais comum (antes quase todo
  // estudante era recusado), e no 1º teste de comportamento o agente escorregou:
  // "show, sua formação atende sim, dezembro tá dentro do prazo certinho" — dois laudos
  // proibidos numa frase só. O bloco carrega a proibição com o anti-exemplo real.
  it('proíbe comentar o resultado da checagem, com o anti-exemplo real', () => {
    const bloco = blocoElegibilidadeFormatura();
    expect(bloco).toMatch(/PROIBIDO/);
    expect(bloco).toMatch(/atende/i);
    expect(bloco).toMatch(/dentro do prazo/i);
    expect(bloco).toMatch(/ERRADO:/);
  });

  it('avisa que número de semestre não é data de conclusão (caso Edinara)', () => {
    const bloco = blocoElegibilidadeFormatura();
    expect(bloco).toMatch(/semestre/i);
    expect(bloco).toMatch(/mês e ano|mes e ano/i);
  });
});

// ── Caso Edinara (2026-08-13) ───────────────────────────────────────────────
// Ela respondeu "2 semestre" à pergunta "quando fica pronta essa conclusão", o modelo leu
// como "segundo semestre de 2026" e agendou uma aluna do 1º ano. A régua de data estava
// certa; o que faltava era alguém dizer que aquilo NÃO ERA UMA DATA.

const AGO = brt('2026-08-13T10:00:00'); // limite = 31/12/2026

describe('lerConclusao', () => {
  it('número de semestre/período/ano é POSIÇÃO NO CURSO, nunca data', () => {
    for (const resposta of [
      '2 semestre', '2º semestre', 'segundo semestre', 'tô no 5º período',
      'estou no 1 ano', 'quarta fase', 'último ano', '6º semestre',
    ]) {
      expect(lerConclusao(resposta, AGO).tipo, resposta).toBe('posicao_no_curso');
    }
  });

  it('com ANO explícito volta a ser data, mesmo falando de semestre', () => {
    const casos: [string, string][] = [
      ['termino em 2027.1', '2027-06-30'],
      ['2026.2', '2026-12-31'],
      ['concluo no 2º semestre de 2027', '2027-12-31'],
      ['12/2026', '2026-12-31'],
      ['2026-12', '2026-12-31'],
      ['dez/2026', '2026-12-31'],
      ['dezembro de 2026', '2026-12-31'],
      ['só me formo em 2028', '2028-12-31'],
    ];
    for (const [resposta, iso] of casos) {
      const l = lerConclusao(resposta, AGO);
      expect(l.tipo, resposta).toBe('data');
      expect(l.tipo === 'data' && l.data.toISOString().slice(0, 10), resposta).toBe(iso);
    }
  });

  it('duração só conta com marcador explícito — "2 semestre" não vira "faltam 2 semestres"', () => {
    const doisAnos = lerConclusao('conclui em uns 2 anos', AGO);
    expect(doisAnos.tipo).toBe('data');
    expect(doisAnos.tipo === 'data' && doisAnos.data.toISOString().slice(0, 10)).toBe('2028-08-31');
    expect(lerConclusao('faltam 6 meses', AGO).tipo).toBe('data');
    expect(lerConclusao('daqui uns três semestres', AGO).tipo).toBe('data');
    // sem marcador, o mesmo número continua sendo posição no curso
    expect(lerConclusao('2 semestres', AGO).tipo).toBe('posicao_no_curso');
  });

  it('mês sem ano é este ano, ou o próximo se o mês já passou', () => {
    const dez = lerConclusao('dezembro', AGO);
    expect(dez.tipo === 'data' && dez.data.toISOString().slice(0, 10)).toBe('2026-12-31');
    const mar = lerConclusao('em março', AGO);
    expect(mar.tipo === 'data' && mar.data.toISOString().slice(0, 10)).toBe('2027-03-31');
  });

  it('o que não dá pra cravar fica ilegível (vira pergunta, não chute)', () => {
    for (const resposta of ['', 'ano que vem', 'logo', 'to acabando', 'ainda vai demorar']) {
      expect(lerConclusao(resposta, AGO).tipo, resposta).toBe('ilegivel');
    }
  });
});

describe('avaliarConclusao', () => {
  it('CASO EDINARA: "2 semestre" não aprova, nem com o modelo mandando uma data pronta', () => {
    // O modelo converteu por conta própria para "12/2026" — e é justamente esse chute que
    // o veredito precisa ignorar, porque a resposta do lead não era uma data.
    expect(avaliarConclusao('2 semestre', '12/2026', AGO).veredito).toBe('indeterminado');
  });

  it('quem se forma dentro da janela é apto; depois dela, fora do prazo', () => {
    expect(avaliarConclusao('dezembro de 2026', null, AGO).veredito).toBe('apto');
    expect(avaliarConclusao('termino em 2027.1', null, AGO).veredito).toBe('fora_do_prazo');
    expect(avaliarConclusao('conclui em uns 2 anos', null, AGO).veredito).toBe('fora_do_prazo');
  });

  it('usa o normalizado do modelo quando o bruto não fecha sozinho', () => {
    expect(avaliarConclusao('to terminando', '11/2026', AGO).veredito).toBe('apto');
    expect(avaliarConclusao(null, '06/2028', AGO).veredito).toBe('fora_do_prazo');
    expect(avaliarConclusao(null, null, AGO).veredito).toBe('indeterminado');
  });
});

// A decisão inteira, do jeito que o executor (tools.ts) e o mock do harness
// (crm-agente-sdr-simular) a consomem — os dois chamam ESTA função, e é isso que impede o
// mock de aprovar o que a produção reprova (a armadilha que já pegou o harness 4 vezes).
describe('decidirPrazoEstudante', () => {
  const decidir = (input: Record<string, unknown>) => decidirPrazoEstudante(input, AGO).acao;

  it('lead formado (contexto normal ou ausente) não passa por aqui', () => {
    expect(decidir({ contexto_qualificacao: 'normal' })).toBe('segue');
    expect(decidir({})).toBe('segue');
    expect(decidir({ contexto_qualificacao: 'correcao_sem_formacao' })).toBe('segue');
  });

  it('CASO EDINARA: "estudante_apto" + "2 semestre" vira pergunta, não aprovação', () => {
    const d = decidirPrazoEstudante({
      contexto_qualificacao: 'estudante_apto',
      conclusao_graduacao_bruta: '2 semestre',
      conclusao_graduacao: '12/2026', // o chute do modelo, que o código ignora
    }, AGO);
    expect(d.acao).toBe('pergunta_data');
    expect(d.acao === 'pergunta_data' && d.porque).toBe('posicao_no_curso');
  });

  it('o código tem a palavra final: "apto" com data fora da janela reprova assim mesmo', () => {
    expect(decidir({
      contexto_qualificacao: 'estudante_apto',
      conclusao_graduacao_bruta: 'termino em 2028',
    })).toBe('reprova');
  });

  it('e liberta quem o modelo classificou errado pro outro lado', () => {
    expect(decidir({
      contexto_qualificacao: 'estudante_fora_do_prazo',
      conclusao_graduacao_bruta: 'me formo em dezembro de 2026',
    })).toBe('segue');
  });

  // Assimetria proposital: exigir data pra RECUSAR abriria um buraco novo — o lead fora do
  // prazo passaria a ser aprovado sempre que o modelo esquecesse o parâmetro.
  it('reprovar nunca exige a data; aprovar sempre exige', () => {
    expect(decidir({ contexto_qualificacao: 'estudante_fora_do_prazo' })).toBe('reprova');
    expect(decidir({ contexto_qualificacao: 'estudante_apto' })).toBe('pergunta_data');
  });

  it('estudante apto com data legível segue pro julgamento de ÁREA (a matriz)', () => {
    expect(decidir({
      contexto_qualificacao: 'estudante_apto',
      conclusao_graduacao_bruta: 'termino em dezembro',
      conclusao_graduacao: '12/2026',
    })).toBe('segue');
  });

  it('a instrução de pergunta nunca vaza a régua interna pro lead', () => {
    for (const porque of ['posicao_no_curso', 'sem_data'] as const) {
      const txt = instrucaoPerguntarConclusao(porque);
      expect(txt).toMatch(/mês e o ano/i);
      expect(txt).toMatch(/PROIBIDO oferecer horário/i);
      expect(txt).toMatch(/Nunca cite "prazo"/);
    }
    expect(instrucaoPerguntarConclusao('posicao_no_curso')).toMatch(/NÃO deduza/);
    expect(instrucaoPerguntarConclusao('sem_data')).not.toMatch(/NÃO deduza/);
  });
});
